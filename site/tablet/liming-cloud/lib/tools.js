// 给平板 AI 的三个工具（设计 §5.2）：cloud_run 派活或接着做、cloud_tell 补充要求、cloud_machines 看两台现状。
// 看进度、列任务、停止直接用原生的 job_output、job_list、job_kill。参数和输出都是标准 JSON Schema（required 写数组）。
import { ACTIVE_STATUSES, DEFAULT_MAX_PER_MACHINE, beijingHHMM, chooseMachine } from './selector.js';
import { receiptView, toolCard } from './tool-card.js';

// li、li2 上 web 配置的模型（site/tablet/dsh-tablet-profile.yml 的 xin-gateway 线路）；单测核对两边一致
export const CLOUD_MODELS = Object.freeze(['deepseek-v4.1-flash', 'glm-5.4', 'kimi-k3.1-pro']);
const ACTIVE = new Set(ACTIVE_STATUSES);

const RUN_DESCRIPTION = [
  '把一件事交给云电脑（li 或 li2）在后台做，立即返回任务号，不等做完。',
  '适合：长任务、写代码和编译、查资料写报告、要用云端浏览器的事；STM32 编译烧录相关的会自动派到 li。',
  '派之前不用问站长，派完继续和站长聊。不填 machine 时自动挑机器（冷却的不用、醒着的优先、闲的优先），挑选理由在返回里，可以照搬给站长。',
  '看进度用 job_output（job_id 是返回的 jobId），列任务用 job_list，停止用 job_kill；做完会自动通知你。',
  '要在原来的任务上接着做，填 continue_of（原任务号），或者用 cloud_tell。',
].join('\n');

const text = s => [{ type: 'text', text: s }];

function projectSlug(raw) {
  if (typeof raw !== 'string') return undefined;
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return slug || undefined;
}

function titleOf(task) {
  const first = String(task).split('\n').map(s => s.trim()).find(Boolean) || '云端任务';
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}

function describeState(status, now) {
  if (!status || !status.known) return `状态未知${status && status.reason ? `（${status.reason}）` : ''}`;
  if (status.cooldownUntil && status.cooldownUntil > now) return `冷却到 ${beijingHHMM(status.cooldownUntil)}，这之前叫不醒`;
  if (status.awake) return Number.isFinite(status.remainingMin) ? `醒着，本轮还能跑约 ${status.remainingMin} 分钟` : '醒着';
  return '睡着（派活会叫醒它，约 40 秒）';
}

export function createCloudTools({ runner, ledger, remote, readStatus, settings = () => ({}), now = Date.now }) {
  const limit = () => {
    const n = Number(settings().maxConcurrentPerMachine);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_PER_MACHINE;
  };
  async function statuses() {
    return Promise.all(remote.machines().map(async name => ({ name, status: await readStatus(name).catch(err => ({ known: false, reason: String(err && err.message || err) })) })));
  }
  const toolCallOf = exec => (exec && exec.callId ? { callId: exec.callId, rootCallId: exec.rootCallId || exec.callId } : undefined);

  const cloudRun = {
    name: 'cloud_run',
    description: RUN_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: '要云电脑做的事，写清楚目标和要交回什么。' },
        machine: { type: 'string', enum: ['li', 'li2'], description: '点名用哪台；一般不填，自动挑。' },
        project: { type: 'string', description: '项目名（英文小写、数字、短横线），同名项目会回到原来那台。' },
        continue_of: { type: 'string', description: '接着哪个任务做（任务号），在原来的云端对话里继续。' },
        model: { type: 'string', enum: [...CLOUD_MODELS], description: '云端用哪个模型；不填用那台的默认模型（DeepSeek V4.1 Flash）。' },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          taskId: { type: 'string' },
          jobId: { type: 'string' },
          machine: { type: 'string' },
          project: { type: 'string' },
          reason: { type: 'string' },
          warning: { type: 'string' },
        },
        required: ['ok', 'reason'],
      },
      render: (_args, v) => text(v.ok
        ? `已交给 ${v.machine}：任务 ${v.taskId}${v.project ? `，项目 ${v.project}` : ''}，后台任务 ${v.jobId}。挑选理由：${v.reason}${v.warning ? `。提醒：${v.warning}` : ''}`
        : `没派出去：${v.reason}`),
      presentationMeta: toolCard((_args, v) => receiptView(v)),
    },
    async execute(args, exec) {
      const task = String(args.task || '').trim();
      if (!task) return { ok: false, reason: 'task 不能为空' };
      if (args.continue_of) {
        const r = await runner.tell(String(args.continue_of), task, { toolCall: toolCallOf(exec) });
        if (!r.ok) return { ok: false, reason: r.reason };
        const t = ledger.getTask(r.taskId);
        return { ok: true, taskId: t.taskId, jobId: r.jobId, machine: t.machine, project: t.project, reason: `${t.machine}：接着 ${t.taskId} 做，在原来的云端对话里` };
      }
      const project = projectSlug(args.project);
      const choice = chooseMachine({
        machines: await statuses(),
        tasks: ledger.listTasks(),
        task,
        machine: args.machine || null,
        project: project || null,
        maxPerMachine: limit(),
        now: now(),
      });
      if (!choice.ok) return { ok: false, reason: choice.reason };
      const t = runner.dispatch({
        machine: choice.machine,
        title: titleOf(task),
        project,
        text: task,
        tabletSessionId: exec && exec.agent && exec.agent.id ? String(exec.agent.id) : '',
        model: args.model || null,
        toolCall: toolCallOf(exec),
      });
      return { ok: true, taskId: t.taskId, jobId: t.jobId, machine: t.machine, project: t.project, reason: choice.reason, ...(choice.warning ? { warning: choice.warning } : {}) };
    },
  };

  const cloudTell = {
    name: 'cloud_tell',
    description: '给云端任务补充要求。这一轮还在跑就插进去；任务已经做完或停了，就在原来的云端对话里接着做（开新一轮、登记新的后台任务）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: '任务号（cloud_run 返回的 taskId）。' },
        text: { type: 'string', description: '补充的话。' },
      },
      required: ['task_id', 'text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          taskId: { type: 'string' },
          mode: { type: 'string' },
          delivered: { type: 'boolean' },
          jobId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, v) => text(!v.ok ? `没送到：${v.reason}`
        : v.mode === 'steer' ? `已插进任务 ${v.taskId} 正在跑的这一轮${v.delivered ? '' : '（暂时连不上，连上后补发）'}`
          : `任务 ${v.taskId} 在原来的云端对话里接着做，后台任务 ${v.jobId}`),
    },
    async execute(args, exec) {
      const said = String(args.text || '').trim();
      if (!said) return { ok: false, reason: 'text 不能为空' };
      const r = await runner.tell(String(args.task_id || ''), said, { toolCall: toolCallOf(exec) });
      if (!r.ok) return { ok: false, reason: r.reason, ...(r.taskId ? { taskId: r.taskId } : {}) };
      return { ok: true, taskId: r.taskId, mode: r.mode, delivered: r.delivered, ...(r.jobId ? { jobId: r.jobId } : {}) };
    },
  };

  const cloudMachines = {
    name: 'cloud_machines',
    description: '看两台云电脑的现状：醒着没有、本轮还能跑多久、冷却到几点、平板在那台的任务、做过的项目。只读，不会叫醒机器。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          machines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                state: { type: 'string' },
                remainingMin: { type: 'number' },
                activeTasks: { type: 'number' },
                projects: { type: 'array', items: { type: 'string' } },
              },
              required: ['name', 'state', 'activeTasks', 'projects'],
            },
          },
        },
        required: ['machines', 'limit'],
      },
      render: (_args, v) => text(v.machines.length
        ? v.machines.map(m => `${m.name}：${m.state}；平板任务 ${m.activeTasks} 个（上限 ${v.limit}）${m.projects.length ? `；做过 ${m.projects.join('、')}` : ''}`).join('\n')
        : '还没配置云电脑（重跑一次平板装机脚本）'),
    },
    async execute() {
      const t = now();
      const tasks = ledger.listTasks();
      const machines = (await statuses()).map(({ name, status }) => {
        const mine = tasks.filter(x => x.machine === name);
        return {
          name,
          state: describeState(status, t),
          ...(status && status.known && Number.isFinite(status.remainingMin) ? { remainingMin: status.remainingMin } : {}),
          activeTasks: mine.filter(x => ACTIVE.has(x.status)).length,
          projects: [...new Set(mine.map(x => x.project))].slice(-8),
        };
      });
      return { machines, limit: limit() };
    },
  };

  return [cloudRun, cloudTell, cloudMachines];
}
