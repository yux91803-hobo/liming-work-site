// 后台干活时的补充、前台的 <手上的事>、后台主动回原聊天说一句（docs/superpowers/specs/2026-11-17-xin-steer-design.md）：
// 交给模型时怎么说、什么时候附 <手上的事>（纯函数），以及 createSteerOps（补充 taskTell、主动说一句）。
// 只引 node:crypto：控制器的读写都由 vm-agent.mjs 传进来（它的行数有基线、只许往下；网站给云电脑装控制器时每个模块一个子请求，免费套餐有上限）。
import crypto from 'node:crypto';
// 参考 Muse Code「Steer the active turn（在下一个安全的模型步骤加进去）/ Queue for the next turn」、
// Codex codex-rs 的 turn/steer 和「这一轮收尾时还有待处理的输入就接着处理」。
const lines = items => (items || []).map(x => typeof x === 'string' ? x : x?.text).filter(Boolean)
  .map(x => '- ' + String(x).replace(/\s+/g, ' ').trim()).join('\n');

// Gemini 后台下一步之前：放在这次请求的最前面
export const STEER_HEAD = '【兄弟刚补充了要求】';
export const steerBlock = items => STEER_HEAD + '（按先后，以最后一条为准）\n' + lines(items) +
  '\n正在跑的命令照常做完；还没做的步骤按新要求重新判断；之前查到的结果也按新要求重新筛一遍；最后给的结果只按新要求。';
// 交了结果（或者问了问题）以后，这一轮还有没送进去的补充：不结束，带着补充再走一步
export const LATE_STEER = '你刚才交了结果，但兄弟又补充了要求：按补充检查并调整结果（之前查到的也按新要求重新筛一遍），做完再返回 final。';
export const LATE_STEER_MAX = 3;
// 同一轮里换执行入口（额度用完、卡住）：新模型从头开始，这一轮收到的补充一起交给它
export const handoverBlock = items => '兄弟在你之前那个执行入口干活时补充过（按先后，以最后一条为准）：\n' + lines(items) +
  '\n按这些要求做；之前查到的结果也按新要求重新筛一遍。';
// 下一轮开头：这一轮没正常做完（超时、断线、重启、停下）以后接着做
export const heldBlock = items => '兄弟之前补充过（按先后，以最后一条为准）：\n' + lines(items);

// tell 回执里的 delivery：补充怎么接（前台按它说话，只说一次）
export const DELIVERY = {
  now: '补充已经送进它正在做的这一轮：下一步就按新要求来，之前查到的也会按新要求重新筛一遍。',
  next: '这一轮中途接不了补充：这一轮跑完就按补充接着做。',
  start: '它还没开始（或者正等着接着做）：开始的时候一起带上。',
  reply: '它在等兄弟回话：这句当回复，接着做了。',
  resumed: '已经接着做了，开头带上了之前的补充。',
  ended: '这件事已经结束，没有接着做。'
};

/* 前台：兄弟这句可能是在补充、改主意、要停或要接着做手上的事时，才在他的话前面附上 <手上的事>（§3）。
   只认说法，不看词重不重合：正式站联调里「只回复 陀螺 茶壶 贝壳，不要执行命令，也不要等待后台」和派活的原话共用「回复、后台、执行」，
   照词重合附上就回到 #117 的老路（每轮都带进行中，DeepSeek 把任何一句都答成进度）。没附时前台还能 xin task list。 */
const CUE = new RegExp([
  '刚才', '刚刚', '之前(?:那|让|说|叫)', '(?:那|这)(?:件事|个任务|个活|件活)', '那活',
  '你(?:在|还在)(?:查|做|弄|写|画|改|找|跑|整理|核对)', '(?:查|做|弄|写|画|跑)(?:到哪|得怎么样|完了吗|好了吗)', '进度', '怎么样了',
  '补充', '改(?:成|为|一下)', '换成', '别(?:列|查|做|管|弄|算|写|画|加|放|搞|动)', '不用(?:列|查|做|管|写|画|加|搞)', '不要(?:列|查|做|写|画|加|搞)',
  '只(?:要|查|列|留|看|写|做|保留|算)', '加上', '去掉', '再加', '也加', '顺便', '另外(?:查|做|加)',
  '算了', '不做了', '别做了', '停下', '停掉', '先停', '继续', '接着(?:做|查|弄|来|干)'
].join('|'));
export const mentionsWork = text => CUE.test(String(text || '').slice(0, 2000));
// 兄弟这一句是不是明确要接着做（停了、做完、没做成的事）。要不要重新开工是他拿主意：控制器按他的原话判断，不只看前台模型带没带 --continue
// （2026-11-20 正式站联调：「那件事再加一条：名单按字母顺序排」被前台带上 --continue，停下的任务又跑起来了）。
// 照 Codex 的做法：要不要批准由程序判定（codex-rs/core/src/safety.rs），模型只能申请。说「别继续」「先不用接着做」不算。
const GO_ON = /继续|接着(?:做|查|弄|来|干|写|画|改|跑|整理|核对|搞)|恢复|重新(?:开始|做|跑|来)|重做|重跑|再(?:跑|做)一(?:遍|次)|\b(?:continue|resume|go on|carry on)\b/i;
const NOT_GO_ON = /(?:别|不要|不用|先别|暂时不|不必|无需|不)(?:再)?(?:继续|接着)/;
export const saysContinue = text => { const s = String(text || '').slice(0, 2000); return GO_ON.test(s) && !NOT_GO_ON.test(s); };
// <手上的事> 里每件事补充现在怎么接
export const HAND_MODE = {
  now: '补充能接进正在做的这一轮，它下一步就按新要求来',
  next: '这一轮中途接不了补充，要等这一轮跑完再按补充接着做',
  start: '还没开始（或正等着接着做），补充会在开始时一起带上',
  reply: '在等兄弟回话',
  busy: '正在停下',
  ended: '已经结束，兄弟明确说继续才接着做（用 --continue）'
};

export const NOTE_UNCONFIRMED_TEXT = '状态进程暂时不可用，刚才那句还没确认转告成功；请继续当前工作，重要发现请一并写进最后的结果。';
const BATCH_RE = /^[a-zA-Z0-9_-]{4,80}$/;
const STEER_UNSENT = new Set(['owner_unavailable', 'state_busy', 'state_draining']);
const STEER_UNKNOWN = new Set(['owner_unavailable', 'state_disconnected', 'state_timeout', 'state_client_failed']);
const steerSleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
// 仅用于具备批次/编号幂等保证的插话认领、确认与后台主动说/提问：保持同一批号重送，不进通用 LOCKED_REPORTS 白名单。
export function retrySteerCall(fn, { deadlineMs = Number(process.env.XIN_STEER_RETRY_MS) || 8000, clock = () => performance.now(), sleep = steerSleep } = {}) {
  const start = clock(); let failure;
  for (let i = 0; ; i++) {
    const remaining = deadlineMs - (clock() - start);
    if (i && remaining <= 0) throw failure;
    try { return fn(Math.max(1, Math.ceil(remaining))); }
    catch (e) {
      const retryable = e && (e.executed === false && STEER_UNSENT.has(e.code) || e.executed === 'unknown' && STEER_UNKNOWN.has(e.code));
      if (!retryable) throw e;
      failure = e;
      const left = deadlineMs - (clock() - start);
      if (left <= 0) throw failure;
      sleep(Math.min(50 * 2 ** Math.min(i, 5), 500, left));
    }
  }
}
export function createExecutorSteerBridge({ run, sid, model = '', lockedCall, onUnacked }) {
  let seq = 0;
  const reportId = step => 'agy-' + crypto.createHash('sha256').update(JSON.stringify([run, model, step])).digest('hex').slice(0, 32);
  const noteDeadline = () => Number(process.env.XIN_NOTE_RETRY_MS) || 15000;
  return {
    take(claim) {
      const batch = BATCH_RE.test(claim || '') ? claim : 'steer-batch-' + (++seq);
      try { const r = retrySteerCall(left => lockedCall('tasks', 'steer_take', { run, claim: batch }, { deadlineMs: left })); return Array.isArray(r?.steers) ? r.steers : []; }
      catch { return []; }
    },
    ack(claim) {
      if (!BATCH_RE.test(claim || '')) return false;
      try { const r = retrySteerCall(left => lockedCall('tasks', 'steer_ack', { run, claim, state: 'accepted' }, { deadlineMs: left })); if (!r?.error) return true; }
      catch {}
      onUnacked?.(claim);
      return false;
    },
    note(text, stepId) {
      const id = reportId(stepId || 'note-' + (++seq));
      try { const r = retrySteerCall(left => lockedCall('tasks', 'task_note', { sid, run, id, text }, { deadlineMs: left }), { deadlineMs: noteDeadline() }); return r && !r.error ? r.msg || '' : ''; }
      catch { return ''; }
    },
    ask(question, stepId) {
      const id = reportId(stepId || 'ask-' + (++seq));
      return retrySteerCall(left => lockedCall('tasks', 'task_ask', { sid, run, id, question }, { deadlineMs: left }), { deadlineMs: noteDeadline() });
    }
  };
}

export function createSteerOps({ metaF, sessF, findTask, taskSummary, saveTask, scheduleNow, cleanupFinishedTask, listTasks, emit, isTask, isFinished, lastRun, TASK_STATUS, runDone, taskVersion,
  readJ, writeJ, journal, rid, okId, cut, runtime, BASE, namedModel, callContext = () => ({}) }) {
  // 用户（或前台）给任务补充要求：在做就等这一步做完接着做；还没开始就并进要求；做完了、停了、在等确认就接着做
  function taskTell(a) {
    const t = findTask(a);
    if (!t) return { error: 'no_task', msg: '找不到这个任务' };
    const expectedApproval = t.publication ? t.publication.id || 'publish' : t.approval?.id;
    if (a.approvalId !== undefined && a.approvalId !== expectedApproval || a.decision && !t.approval && !t.publication && !t.browserStep)
      return { error: 'stale_approval', msg: '这次确认已结束或已变化，请刷新任务后核对' };
    if (t.approval) {
      if (t.approval.kind !== 'input' && !['approve', 'deny'].includes(a.decision)) return { error: 'needs_decision', msg: '请点「批准」或「拒绝」' };
      if (t.approval.kind === 'input' && !String(a.text || '').trim()) return { error: 'empty', msg: '请回复问题' };
      const r = lastRun(t), m = readJ(metaF(r));
      if (!m || runDone(r)) return { error: 'ended', msg: '这一轮已经结束，不能再批准' };
      m.approvalReplies = { ...(m.approvalReplies || {}), [t.approval.id]: t.approval.kind === 'input' ? String(a.text).slice(0,4000) : a.decision }; writeJ(metaF(r), m);
      delete t.approval; t.question = ''; t.status = 'running'; saveTask(t);
      return { ok: true, msg: a.decision === 'approve' ? '已批准' : '已拒绝', task: taskSummary(t) };
    }
    if (t.publication) {
      if (!['approve', 'deny'].includes(a.decision)) return { error: 'needs_decision', msg: '结果涉及删除或覆盖冲突，请明确选择是否允许' };
      if (t.publication.id && a.approvalId !== t.publication.id) return { error: 'stale_approval', msg: '这份写回清单已变化，请刷新任务后核对新的清单' };
      if (a.decision === 'approve') {
        try {
          const publication = runtime.publishWorkspace(t, BASE, t.publication);
          if (publication.pending) {
            t.publication = publication; t.question = '写回内容有变化，尚未执行。请核对下面的新文件清单，批准这次写回吗？'; saveTask(t);
            return { ok: true, msg: '写回清单或文件内容有变化，尚未执行，请核对新清单后再批准', task: taskSummary(t) };
          }
          t.publicationReceipt = publication;
          if(t.web){t.preview=runtime.publishWebPreview(t,BASE,readJ(metaF(lastRun(t)),{}).webCheck);t.result.text='我画好了，点下面的预览就能看。';t.stage='ready';}
        }
        catch (e) { return { error: 'conflict', msg: e.message }; }
        t.status = 'done'; t.result.ok = true;
      } else { t.status = 'stopped'; t.result.ok = false; t.result.text += '\n原项目未更改，任务副本保留。'; }
      delete t.publication; t.question = ''; t.endedAt = Date.now(); t.result.at = Date.now(); t.frontSeen = false; cleanupFinishedTask(t);saveTask(t); scheduleNow();
      return { ok: true, msg: a.decision === 'approve' ? '结果已写回' : '已保留原文件', task: taskSummary(t) };
    }
    if(t.status==='stopping')return {error:'busy',msg:'任务正在停止，退出后再继续'};
    // 同一编号再来一次（断线重送、前台同一轮重放）：只算一次，回第一次的回执（Muse Code「duplicate message IDs are deduplicated」）
    const id = /^[a-zA-Z0-9_-]{8,80}$/.test(a.clientId || '') ? a.clientId : rid('u'), seen = (t.tells || []).find(x => x.id === id);
    if (seen) return { ok: true, duplicate: true, delivery: seen.delivery, msg: '这句补充已经收到了', task: taskSummary(t) };
    const told = delivery => { t.tells = (t.tells || []).concat([{ id, delivery, at: Date.now() }]).slice(-32); return delivery; };
    // 等站长登录（docs/xin-browser-v2-design.md 第 6 节）：「已登录，继续」把网站加进任务，下一轮浏览器带上它的登录；「跳过登录」不加；直接回话当普通回复
    let decided = '';
    if (t.browserStep) {
      const site = t.browserStep.site;
      if (a.decision === 'approve') { t.sites = [...new Set((t.sites || []).concat(site))]; decided = '站长同意用 ' + site + ' 的登录（这一轮浏览器已经带上了），接着做。'; }
      else if (a.decision === 'deny') decided = '站长不用 ' + site + ' 的登录。别换别的办法登录；做不了的部分写进结果。';
      delete t.browserStep;
    }
    const text = decided || String(a.text || '').trim().slice(0, 4000) || '接着做';
    t.transientRetries = 0;
    if(t.tkind==='review'&&t.status==='waiting'){const requested=namedModel(text);if(requested){t.requestedModel=requested;t.requestedNamed=true;}}
    if (t.status === 'running') {
      const r = lastRun(t), m = r && readJ(metaF(r));
      // 能进这一轮的（Codex app-server、Gemini 后台）记进这一轮的 steers，模型下一步就拿到；接不了的等这一轮跑完
      if (steerable(r, m) && !t.pendingQuestion) {
        m.steers = (m.steers || []).concat([{ id, text, at: Date.now(), state: 'pending' }]);
        writeJ(metaF(r), m); told('now'); saveTask(t);
        return { ok: true, delivery: 'now', msg: '补充已经送进任务 ' + t.no + ' 正在做的这一轮：它下一步就按新要求来，之前查到的也会按新要求重新筛一遍', task: taskSummary(t) };
      }
      t.inbox = (t.inbox || []).concat([{ id, text, at: Date.now() }]);
      if(t.pendingQuestion){delete t.pendingQuestion;t.question='';}
      told('next'); saveTask(t);
      return { ok: true, delivery: 'next', msg: '记下了：任务 ' + t.no + ' 这一轮跑完就按你说的接着做', task: taskSummary(t) };
    }
    if (t.status === 'queued' && !(t.runs && t.runs.length)) {
      t.goal += '\n补充：' + text; told('start'); saveTask(t);
      return { ok: true, delivery: 'start', msg: '任务 ' + t.no + ' 还没开始，补充的要求并进去了', task: taskSummary(t) };
    }
    if (t.status === 'queued') { t.next = (t.next ? t.next + '\n' : '') + '用户又说：' + text; t.nextShow = (t.nextShow ? t.nextShow + '\n' : '') + text; told('start'); saveTask(t); return { ok: true, delivery: 'start', msg: '记下了：任务 ' + t.no + ' 接着做的时候一开始就带上', task: taskSummary(t) }; }
    // 做完、停了、没做成：前台转过来的补充先记下，不重新开工；站长明确说继续（--continue）才接着做（站长 2026-11-17）。
    // 完成事件里让原工作接着改、网页任务详情里的「接着做」不经过这里。
    if (isFinished(t) && a.front && !a.resume) {
      t.inbox = (t.inbox || []).concat([{ id, text, at: Date.now() }]); told('ended'); saveTask(t);
      return { ok: true, ended: true, delivery: 'ended', status: t.status, result: cut(t.result ? t.result.text : '', 1500),
        msg: '任务 ' + t.no + '「' + t.title + '」' + TASK_STATUS[t.status] + '，没有接着做。先告诉兄弟它现在的状态和要点，问他要不要接着做；他明确说继续，再用 xin task tell ' + t.no + ' --continue 话。这句补充已经记下，接着做时会带上。', task: taskSummary(t) };
    }
    const waiting = t.status === 'waiting', interrupted = waiting && /中途断了/.test(t.question || '') || t.result?.err === '中途断了两次';
    const expired = t.expired; delete t.expired;
    if (isFinished(t)) { if(t.status==='done') { t.workspace = null; t.started = false; t.agentSid = null; } t.deadline = null; t.validationRetries = 0; delete t.publicationError; }
    const active = lastRun(t);
    if (active && !runDone(active)) {
      t.inbox = (t.inbox || []).concat([{ id, text, at: Date.now() }]);
      if(t.pendingQuestion||t.status==='waiting'){delete t.pendingQuestion;t.question='';t.status='running';}
      told('next'); saveTask(t);
      return { ok: true, delivery: 'next', msg: '已收到，当前进程退出后接着做', task: taskSummary(t) };
    }
    // 停下前压着的补充（干活时收到、这一轮没正常做完带下来的、停下以后前台记下的）跟这句一起交给模型，这句放最后、以它为准；
    // 不留在收件箱里等这一轮做完再翻出来重新开工（站长回「不用了」后任务又被旧补充叫起来，2026-11-12）。
    // 参考 Codex codex-rs/core/src/session/input_queue.rs：补充一次取完、和下一轮一起交出去。
    const held = (t.inbox || []).map(x => x.text).filter(Boolean);
    Object.assign(t, { next: (held.length ? heldBlock(held) + '\n' : '') + (waiting || expired ? '用户回复：' : '用户又说：') + text + (waiting && t.question ? '\n（你之前问的是：' + t.question + '）' : expired?.question ? '\n（你之前问的是：' + expired.question + '）' : '') + (held.length ? '\n以用户最后的回复为准。' : ''), nextShow: text,
      inbox: [], status: 'queued', queuedAt: Date.now(), question: '', frontSeen: true });
    if (waiting) t.deadline = null;
    if (interrupted) t.resumes = 0;
    const delivery = told(waiting ? 'reply' : 'resumed');
    saveTask(t);
    scheduleNow();
    return { ok: true, delivery, msg: '任务 ' + t.no + ' 接着做了', task: taskSummary(readJ(sessF(t.sid)) || t) };
  }
  // 这一轮现在能不能把补充送进去（docs/superpowers/specs/2026-11-17-xin-steer-design.md §1）：Codex app-server 的轮次、Gemini 后台的轮次能；
  // 模型这一步已经做完（在检查网页、编译核验）、这一轮已经结束或正在停、执行方式不支持（exec）的不能，等这一轮跑完再接着做。
  function steerable(r, m) { return !!(r && m && !runDone(r) && !m.stopped && !m.modelDone && (m.transport === 'app-server' || m.transport === 'antigravity')); }
  // 补充现在怎么接（前台的 <手上的事> 按它写；tell 的回执 delivery 和它对得上时，前台预先写好的那句话才算数）
  function tellMode(t) {
    if (!t) return '';
    if (t.status === 'stopping') return 'busy';
    if (isFinished(t)) return 'ended';
    if (t.status === 'waiting' || t.approval || t.publication || t.browserStep) return 'reply';
    if (t.status === 'queued') return 'start';
    const r = lastRun(t), m = r && readJ(metaF(r));
    return steerable(r, m) && !t.pendingQuestion ? 'now' : 'next';
  }
  // 前台：兄弟这句可能是在补充、改主意、要停或要接着做时，在他的话前面附上 <手上的事>（docs/superpowers/specs/2026-11-17-xin-steer-design.md §3）：
  // 这个对话里没做完的、两小时内做完或停下的，最多 6 件，每件写补充现在怎么接；modes 记进这一轮，tell 时对照前台预先写好的那句话。
  // 不相关的一句不附：#117 每轮都带进行中，DeepSeek 把任何一句都答成进度。
  function handNotes(sid, text, all) {
    if (!mentionsWork(text)) return null;
    all = all || listTasks();
    const now = Date.now(), mine = all.filter(t => t.parent === sid && !t.dailyDate && (!isFinished(t) || now - (t.endedAt || 0) < 2 * 3600e3))
      .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0)).slice(0, 6);
    if (!mine.length) return null;
    const modes = {}, lines = [];
    for (const x of mine) {
      const t = readJ(sessF(x.sid)) || x, mode = tellMode(t), ask = String(t.userRequest || t.goal || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const state = t.status === 'running' ? '在做（' + Math.max(1, Math.round((now - (t.startedAt || t.created)) / 60e3)) + ' 分钟）' : TASK_STATUS[t.status] || t.status;
      modes[t.no] = mode;
      lines.push('- 任务 ' + t.no + '「' + t.title + '」' + state + '：' + HAND_MODE[mode] + (mode === 'reply' && t.question ? '（问的是：' + cut(t.question, 120) + '）' : '') + (ask && ask !== t.title ? '。兄弟当时说：' + ask : ''));
    }
    return { text: '<手上的事>\n' + lines.join('\n') + '\n</手上的事>', modes };
  }
  /* ---------- 后台主动回原聊天说一句（docs/superpowers/specs/2026-11-17-xin-steer-design.md §4） ----------
     Meta Muse：「comes back when something changes or when it needs approval」「notifies you only when something is meaningfully new or needs your input」。
     后台 xin task note / action=note：记下来，NOTE_WAIT 之内同一件事后面的合成一条；每件事最多 NOTE_MAX 条，超了只进过程。
     发之前看还有没有用：任务已经不在说这句的那一轮（做完、停了、没做成、接着做了下一轮）就不发，最终结果先到了就不再冒一句「我正在核对」。
     原对话正在回话时等它说完。发法：在原对话里直接记一轮说完的话，不起模型、不推送（最终结果照旧推送）。 */
  const NOTE_WAIT_MS = () => Number(process.env.XIN_NOTE_WAIT_MS) || 20000;
  const NOTE_MAX = 3;
  function taskNote(a) {
    const t = readJ(sessF(a.sid)), m = okId(a.run, 'r') && readJ(metaF(a.run));
    if (!isTask(t) || !m || m.sid !== t.sid || lastRun(t) !== a.run || m.stopped || m.ended || t.status !== 'running') return { error: 'stale', msg: '这一轮已经结束，没有转告。' };
    const text = String(a.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) return { error: 'empty', msg: '要说的话是空的' };
    const id = /^[a-zA-Z0-9_-]{8,80}$/.test(a.id || '') ? a.id : rid('n');
    if ((t.noteIds || []).includes(id)) return { ok: true, duplicate: true, msg: t.noteMsgs?.[id] || '已经转告了，接着做。' };
    t.noteIds = (t.noteIds || []).concat(id).slice(-32);
    emit(a.run, { t: 'note', text, at: Date.now() });   // 工作台的过程里看得到
    let msg;
    if (!t.parent) msg = '这件事不是从聊天里派的，记在过程里了；接着做。';
    else if (t.noteRow && journal.appendNote(t.noteRow, text)) msg = '和刚才那条合成一条转告兄弟；接着做。';
    else if ((t.notesSent || 0) >= NOTE_MAX) msg = '这件事已经主动说过 ' + NOTE_MAX + ' 次了，这条只记在过程里；后面的发现写进最后的结果。接着做。';
    else {
      const row = 'note-' + crypto.createHash('sha256').update(t.sid + ':' + id).digest('hex').slice(0, 26);
      journal.enqueueHandoff({ id: row, parent: t.parent, task: t.sid, version: taskVersion(t), payload: { kind: 'note', no: t.no, texts: [text] }, nextAt: Date.now() + NOTE_WAIT_MS() });
      t.noteRow = row; t.notesSent = (t.notesSent || 0) + 1;
      msg = '记下了，过一会儿回原聊天告诉兄弟（这期间相关的发现会合成一条）；接着做。';
    }
    t.noteMsgs = Object.fromEntries(Object.entries({ ...(t.noteMsgs || {}), [id]: msg }).filter(([k]) => t.noteIds.includes(k)));
    saveTask(t);
    return { ok: true, msg };
  }
  // 交接队列到点（vm-agent.mjs 的 pumpHandoffs，在原对话的锁里）：还有用、对话空着就在原对话里记一轮说完的话
  function noteStart(h, t, s) {
    if (!t || taskVersion(t) !== h.version || t.status !== 'running') { journal.settleHandoff(h.id, 'superseded'); return {}; }
    const last = lastRun(s); if (last && !runDone(last)) return { waiting: true };
    if (journal.pendingLaunches().some(j => j.sid === s.sid && j.lane === 0)) return { waiting: true };
    const text = cut((h.payload.texts || []).join('\n'), 800), at = Date.now(), run = rid('r'), note = { sid: t.sid, no: t.no };
    writeJ(metaF(run), { run, sid: s.sid, agent: s.agent, started: at, kind: 'note', note, reply: text, ended: at });
    emit(run, { t: 'text', text, note }); emit(run, { t: 'done', ok: true, stopped: false, code: 0, ms: 0 });
    s.runs.push(run); s.updated = at; writeJ(sessF(s.sid), s);
    journal.settleHandoff(h.id, 'delivered');
    return { run };
  }
  // 这个对话最近主动说的话：网页在看这个对话时按 run 画出来（刷新以后由历史画）
  function recentNotes(sid) {
    const s = okId(sid, 's') && readJ(sessF(sid)); if (!s || isTask(s)) return [];
    return (s.runs || []).slice(-8).map(r => readJ(metaF(r))).filter(m => m?.kind === 'note' && Date.now() - m.started < 6 * 3600e3)
      .map(m => ({ run: m.run, text: m.reply, at: m.started, task: m.note }));
  }
  function steerAck(a) {
    const m = okId(a.run, 'r') && readJ(metaF(a.run)); if (!m) return { error: 'no_run' };
    const attempt = callContext().attempt || null;
    const batch = BATCH_RE.test(a.claim || '');
    const targets = batch
      ? (m.steers || []).filter(x => ['pending', 'next'].includes(x.state) && x.claim?.id === a.claim && (x.claim.attempt || null) === attempt)
      : (m.steers || []).filter(x => x.id === a.id);
    if (!targets.length) return { ok: true };
    const at = Date.now(), nextState = a.state || 'accepted';
    let changed = false;
    for (const q of targets) {
      const fresh = q.state !== 'accepted' && nextState === 'accepted';
      if (q.state !== nextState || q.claim || a.error) changed = true;
      q.state = nextState;
      if (nextState === 'accepted' && !q.acceptedAt) q.acceptedAt = at;
      if (!batch) delete q.claim;
      if (a.error) q.error = cut(a.error, 200);
      // 后台任务：补充送进去的那一刻在这一轮的过程里显示成兄弟的一句话（对话里的插话在 steer 时已经显示了）
      if (m.task && fresh && !q.shown) { q.shown = true; emit(a.run, { t: 'user', text: q.text, at, steer: true, clientId: q.id }); }
    }
    if (changed) writeJ(metaF(a.run), m);
    return { ok: true };
  }
  // Gemini 后台或前台查资料下一步之前取走还没送的补充：带 claim 时先认领（保持 pending，模型步真正完成后再由 steer_ack 标成 accepted，
  // 参考 openai/codex#40805 与 #32627 区分未送达、处理中和已吸收三阶段）；不带 claim 时保留旧的立即消费兼容行为。
  function steerTake(a) {
    const m = okId(a.run, 'r') && readJ(metaF(a.run)), t = m && readJ(sessF(m.sid)), front = !!t && !isTask(t) && t.agent === 'codex';
    if (!m || !(isTask(t) || front) || lastRun(t) !== a.run || m.stopped || m.ended) return { steers: [] };
    const claim = BATCH_RE.test(a.claim || '') ? a.claim : null, attempt = callContext().attempt || null;
    if (!claim) {
      const take = (m.steers || []).filter(x => x.state === 'pending');
      if (!take.length) return { steers: [] };
      const at = Date.now();
      for (const q of take) {
        const shown = q.shown;
        Object.assign(q, { state: 'accepted', acceptedAt: at, shown: true }); delete q.claim;
        if (!front && !shown) emit(a.run, { t: 'user', text: q.text, at, steer: true, clientId: q.id });
      }
      writeJ(metaF(a.run), m);
      return { steers: take.map(q => ({ id: q.id, text: q.text, at: q.at })) };
    }
    // Keep the original batch identity after ACK so an old retry cannot claim newer input.
    const existing = (m.steers || []).filter(x => x.claim?.id === claim && (x.claim.attempt || null) === attempt);
    const take = existing.length ? existing.filter(x => x.state === 'pending')
      : (m.steers || []).filter(x => x.state === 'pending' && (!x.claim || (x.claim.attempt || null) !== attempt));
    if (!take.length) return { steers: [] };
    if (!existing.length) {
      const at = Date.now();
      for (const q of take) {
        q.claim = { id: claim, attempt, at };
        if (!front && !q.shown) { q.shown = true; emit(a.run, { t: 'user', text: q.text, at, steer: true, clientId: q.id }); }
      }
      writeJ(metaF(a.run), m);
    }
    return { steers: take.map(q => ({ id: q.id, text: q.text, at: q.at })) };
  }
  // 换入口需要原补充的完整快照。新 runner 到成功收尾才确认，旧 runner 保留原协议。
  function steerHandover(a) {
    const m = okId(a.run, 'r') && readJ(metaF(a.run)), t = m && readJ(sessF(m.sid));
    if (!m || !isTask(t) || lastRun(t) !== a.run || m.stopped) return { steers: [] };
    const at = Date.now(), fresh = (m.steers || []).filter(x => x.state === 'pending' || x.state === 'next');
    const claim = BATCH_RE.test(a.claim || '') ? a.claim : null, attempt = callContext().attempt || null;
    if (fresh.length) {
      for (const q of fresh) {
        const shown = q.shown;
        if (claim) { q.state = 'pending'; q.claim = {id:claim, attempt, at}; q.shown = true; }
        else { Object.assign(q, { state: 'accepted', acceptedAt: at, shown: true }); delete q.claim; }
        if (!shown) emit(a.run, { t: 'user', text: q.text, at, steer: true, clientId: q.id });
      }
      writeJ(metaF(a.run), m);
    }
    return { steers: (m.steers || []).filter(x => x.state === 'accepted' || claim && x.claim?.id === claim).map(q => ({ id:q.id, text:q.text, at:q.at })), ...(claim && fresh.length ? {claim} : {}) };
  }
  return { taskTell, tellMode, handNotes, taskNote, noteStart, recentNotes, steerAck, steerTake, steerHandover };
}
