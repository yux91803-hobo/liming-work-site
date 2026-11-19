// Model catalogue, reasoning-effort levels and the executor router (who does which kind of work).
import * as runtime from './vm-runtime.mjs';

/* ---------- 思考强度 ----------
   只给模型真正支持的档位（网关 /v1/models 的 reasoning_efforts）：
   - Harness / Codex 的 DeepSeek V4.1 Flash：off / low / high / max（off 发 none）。
   - Harness / Codex 的 GLM-5.3 Flash、GLM-5.3，以及 Codex 的 Kimi K3.1 Pro：low / high / max（不能关）。网关遇到不认识的档会换成 high，所以只发这三个。
   - Claude Code：--effort low / medium / high / xhigh / max。
   默认都是 high。网页传来的不在这个模型的档位里（以前的 auto、空的）就用默认；每一轮都明确带上，不靠各家自己的默认。 */
export const CLAUDE_EFFORT = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], def: 'high' };
export function effortSpec(agent, model) {
  return agent === 'harness' ? harnessModel(model) : agent === 'codex' ? codexModel(model) : CLAUDE_EFFORT;
}
export function resolveEffort(agent, model, effort) {
  const m = effortSpec(agent, model);
  return m.efforts.includes(effort) ? effort : m.def;
}

export const HARNESS_WIN = 1000000;   // 网关 /v1/models 的真实 context_length，三种模型均为 100 万
export const HARNESS_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', win: HARNESS_WIN, image: true, efforts: ['off', 'low', 'high', 'max'], def: 'high' },
  { id: 'glm-5.3', name: 'GLM-5.3', win: HARNESS_WIN, image: true, efforts: ['low', 'high', 'max'], def: 'high' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', win: HARNESS_WIN, image: false, efforts: ['low', 'high', 'max'], def: 'high' }
];
export function harnessModel(id) { return HARNESS_MODELS.find(m => m.id === id) || HARNESS_MODELS[0]; }

// 线路：本地网关（WorkBuddy），每轮显式传入当前模型。
export const HARNESS_ROUTE = { provider: 'xin-gateway', name: 'WorkBuddy 网关', api: 'openai-responses', baseURL: 'http://127.0.0.1:8788/v1', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash',
  efforts: ['off', 'low', 'high', 'max'], def: 'high' };

/* ---------- Codex 的线路 ----------
   和 Harness 一样每一轮自己带：走小芯电脑上的本地网关（responses 协议），不靠 ~/.codex/config.toml 里写的模型和网关。
   用哪个模型（CODEX_MODELS 里的几个）由下面的路由器每一轮挑（见「默认模式」），同一个对话中途换也行。
   key：~/.xin/codex.key（单独给 Codex 的），没有就用 Harness 那把（~/.xin/harness.key）；起的时候用环境变量 XIN_CODEX_KEY 交给它（线路里写的是 env_key）。
   模型资料：Codex 要每个模型的上限、能不能看图等资料，网关的新模型它不认识；
   照着 ~/.codex/config.toml 里 model_catalog_json 那份资料复制一份到 ~/.xin/codex-models.json，补上这几个模型（照抄 DeepSeek 那条改名字和上限），每轮用 -c 指过去。
   看不了图的模型（glm-5.3-flash）：图片不用 -i 给，只在消息里写路径。 */
export const CODEX_ROUTE = { provider: 'xin-gateway', name: 'WorkBuddy 网关', baseURL: 'http://127.0.0.1:8788/v1', wire: 'responses' };
export const CODEX_MODELS = [
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', win: 1000000, image: false, efforts: ['low', 'high', 'max'], def: 'high' },
  { id: 'glm-5.3', name: 'GLM-5.3', win: 1000000, image: true, efforts: ['low', 'high', 'max'], def: 'high' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', win: 1000000, image: true, efforts: ['low', 'high', 'max'], def: 'high' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', win: 1000000, image: true, efforts: ['off', 'low', 'high', 'max'], def: 'high' }
];
export function codexModel(id) { return CODEX_MODELS.find(m => m.id === id) || CODEX_MODELS[0]; }   // 起 Codex 用：不认识的照样按第一个开工
// 只用来显示名字：认得后台的 Gemini（Antigravity）和前台的 Opus；不认识的原样显示编号，不冒充成列表里第一个（审查问题 13）
const OTHER_NAMES = Object.fromEntries(Object.entries(runtime.AGY_CATALOG).map(([id, m]) => [id, m.name]));   // Hydrogen、Neon、Argon
export function modelLabel(id) { const m = CODEX_MODELS.find(x => x.id === id) || HARNESS_MODELS.find(x => x.id === id); return m ? m.name : OTHER_NAMES[id] || String(id || '未知模型'); }
// 用量页按来源分（站长 2026-11-16：「把网关和谷歌的分开」）：Google = Antigravity 的 Gemini；网关 = 小芯电脑上 WorkBuddy 网关的模型；其他（以前的 Claude 之类）
export function modelSource(id) {
  id = String(id || '');
  if (id === runtime.AGY_MODEL || /^gemini/i.test(id)) return 'google';
  if (CODEX_MODELS.some(m => m.id === id) || HARNESS_MODELS.some(m => m.id === id) || /^(?:glm|kimi|deepseek|qwen)/i.test(id)) return 'gateway';
  return 'other';
}

/* ---------- 默认模式（Codex 自动）：路由器 ----------
   网页上「天启模式」关着（默认）时，新对话用 Codex：用户不选模型和思考强度。思考强度一律最高（AUTO_EFFORT），
   模型由这里挑——模型（小芯）可以提议，路由器负责校验：
   - 前台聊天（用户直接聊的那个小芯）按 chat 类别：默认 DeepSeek V4.1 Flash（快、能看图）。
     同一个对话里不按难度来回换模型：换了模型缓存就用不上，又慢又贵。按活挑模型放在派后台任务那一步（kind）。
   - 用户点名（「用 Kimi」「换成 GLM-5.3」）：只管这一句 / 这个任务（namedModel）。
   - 校验：不认识的模型不用；要看图的只给能看图的（glm-5.3-flash 看不了图）；avoid 里的不用（刚失败的、被检查的那个）。
   - 模型还没开始干活就报错（网关限流、模型挂了）：runner 换 fallbacks 里的下一个再试一次；已经执行过命令、说过话的不重试，免得重复做。
   候选顺序是起步时的猜测，不是排名：按 model-stats.jsonl 里的实际记录（用了谁、多久、成没成）手动调，不让程序自己改。 */
export const AUTO_EFFORT = 'max';
// 站长 11-19：杂活、查资料、看图、每日任务、电脑维护用 DeepSeek；Kimi 只写代码（含前端）；GLM 只写代码和检查。
// 写代码、难题、检查、查资料先交给 Antigravity（下面的 agyPick），这里是它用不了时的网关候选
export const ROUTES = {
  chat: ['deepseek-v4.1-flash'],   // 前台聊天
  quick: ['deepseek-v4.1-flash'],                                              // 简单杂活：看文件、跑几条命令、整理
  code: ['glm-5.3', 'kimi-k3.1-pro', 'deepseek-v4.1-flash'],                   // 写代码、改代码、编译、调试
  research: ['deepseek-v4.1-flash'],                                           // 查资料、读文档、写长一点的说明
  hard: ['glm-5.3', 'kimi-k3.1-pro', 'deepseek-v4.1-flash'],                   // 难题：复杂代码、疑难 bug、方案设计
  vision: ['deepseek-v4.1-flash'],                                             // 看图
  review: ['glm-5.3', 'deepseek-v4.1-flash'],                                  // 检查别的任务的结果（会避开被检查的那个模型）
  daily: ['deepseek-v4.1-flash'],                                              // 每日任务
  system: ['deepseek-v4.1-flash']                                              // 电脑维护：不进容器，直接在电脑上查、修
};
/* 后台先用哪个 Antigravity 模型（站长 11-19）：写代码、难题 → Neon（Gemini 池），Gemini 池用完 → Argon；检查、查资料 → Argon（Argon 池）。
   杂活、每日任务、电脑维护、看图不用 Antigravity，走上面的网关路由表。
   poolOk(pool)：这个池现在能不能用（派任务的地方按额度记录判断）；avoid：不能用的模型（检查要避开被检查任务的作者）。 */
const AGY_PLAN = { code: [runtime.AGY_NEON, runtime.AGY_ARGON], hard: [runtime.AGY_NEON, runtime.AGY_ARGON], review: [runtime.AGY_ARGON], research: [runtime.AGY_ARGON] };
export function agyPick({ kind, poolOk = () => true, avoid = [] } = {}) {
  return (AGY_PLAN[kind] || []).find(id => poolOk(runtime.agyPool(id)) && !avoid.includes(id)) || null;
}
// 先用的是 Neon 时，Argon 池能用就排在网关候选前面（运行中 Gemini 池用完、卡住时换过去）；其余没有 Antigravity 候选
export function agyNext({ kind, model, poolOk = () => true, avoid = [] } = {}) {
  const plan = AGY_PLAN[kind] || [], i = plan.indexOf(model);
  return i < 0 ? [] : plan.slice(i + 1).filter(id => poolOk(runtime.agyPool(id)) && !avoid.includes(id));
}
export function backgroundRoute({kind, want, named, images, avoid = [], plugins = [], daily, agyAvailable, poolOk}) {
  const automatic = !named && !daily && !images && !plugins.length && agyAvailable;
  const preferred = automatic ? agyPick({kind, poolOk, avoid}) : null;
  const imageKind = images && !['review','code','hard'].includes(kind) ? 'vision' : kind;
  const result = route({kind:imageKind, want:preferred || want, named, images, avoid});
  if (preferred) result.fallbacks = [...new Set([...agyNext({kind, model:preferred, poolOk, avoid}), ...result.fallbacks])];
  return result;
}
export const KIND_NAMES = { chat: '聊天', quick: '杂活', code: '写代码', research: '查资料', hard: '难题', vision: '看图', review: '检查', daily: '每日任务', system: '电脑维护' };
// 用户点名：「用 / 换成 / 让 … 模型」或者「模型 来做 / 来看 …」。Flash 要排在同名的前面
export const MODEL_ALIAS = [
  // 站长 11-19：泛指的 Gemini、Antigravity 交给后台写代码的 Neon；点名 Hydrogen、Flash 才用 Hydrogen（Gemini 3.8 Flash 13 日起不用）；Argon 照点名。
  // 具体的排在泛指的前面：「Gemini 4 Hydrogen」「Gemini 3.8 Flash」不能被泛指的 Gemini 先认走
  [runtime.AGY_NEON, '(?:gemini[\\s-]*4[\\s-]*)?neon'],
  [runtime.AGY_ARGON, '(?:gemini[\\s-]*4[\\s-]*)?argon'],
  [runtime.AGY_MODEL, '(?:gemini[\\s-]*4[\\s-]*)?hydrogen|gemini(?:[\\s-]*[\\d.]+)?[\\s-]*flash(?:[\\s-]*high)?'],
  [runtime.AGY_NEON, 'antigravity\\b|agy\\b|gemini(?:[\\s-]*[\\d.]+)?(?:[\\s-]*high)?'],
  ['glm-5.3-flash', 'glm[\\s-]*(?:5(?:\\.3)?)?[\\s-]*flash|智谱\\s*flash'],
  ['glm-5.3', 'glm(?:[\\s-]*5(?:\\.3)?)?|智谱'],
  ['kimi-k3.1-pro', 'kimi(?:[\\s-]*k?3(?:\\.1)?)?(?:[\\s-]*pro)?|月之暗面'],
  ['deepseek-v4.1-flash', 'deep[\\s-]*seek(?:[\\s-]*v?4(?:\\.1)?)?(?:[\\s-]*flash)?|深度求索']
].map(([id, src]) => [id,
  new RegExp('(?:用|换成|换到|换个|改用|切到|切换到|让|交给|使用)\\s*(?:一下|下)?\\s*(?:' + src + ')', 'i'),
  new RegExp('(?:' + src + ')\\s*(?:来|去)(?:做|写|答|回答|看|检查|查|弄|干|处理|想|算|改|试|跑)', 'i')]);
export function namedModel(text) {
  const clauses = String(text || '').slice(0, 4000).replace(/```[\s\S]*?```|`[^`]*`|「[^」]*」|“[^”]*”|"[^"]*"/g, '').split(/[。；;\n]/);
  for (const t of clauses) {
    if (/如果|假如|假设|的话|会不会|是否|能不能|为什么|怎么|如何|有人说|他说|她说|比如|例如|不要|别用|不用|不想用|[?？]/.test(t)) continue;
    for (const [id, a, b] of MODEL_ALIAS) if (a.test(t) || b.test(t)) return id;
  }
  return null;
}
// o：{kind, want（提议的模型）, named（want 是用户点名的）, images（要看图）, avoid（不要用的模型）}
// 回 {model, why, kind, fallbacks, note}：why = named（用户点名）/ picked（小芯提议）/ 类别名（按类别挑的）
export function route(o = {}) {
  const kind = ROUTES[o.kind] ? o.kind : 'chat', avoid = o.avoid || [];
  const known = id => CODEX_MODELS.some(m => m.id === id)||runtime.isAgyModel(id);
  const fits = id => known(id) && (!runtime.isAgyModel(id)||kind!=='chat') && (!o.images || !runtime.isAgyModel(id)&&codexModel(id).image);
  const order = ROUTES[kind].filter(id => fits(id) && !avoid.includes(id));
  let model = null, why = kind, note = '';
  if (o.want) {
    const w = String(o.want);
    if(kind==='review'&&o.named&&avoid.includes(w))return {model:null,why:'named',kind,fallbacks:[],error:'independent_review_model',note:'指定模型是被复核任务的实际作者，不能作为独立复核模型，请选择其他模型。'};
    if (fits(w) && (o.named && kind!=='review' || !avoid.includes(w))) { model = w; why = o.named ? 'named' : 'picked'; }
    else if (known(w)) note = modelLabel(w) + (o.images && (runtime.isAgyModel(w) || !codexModel(w).image) ? ' 看不了图' : ' 这次不合适') + '，换成了别的';
    else note = '没有叫 ' + w.slice(0, 40) + ' 的模型，按类别挑了一个';
  }
  // 候选全被排除了（比如要看图、能看图的又都在 avoid 里）：退回能用的第一个
  if (!model) model = order[0] || (kind==='review'?null:CODEX_MODELS.filter(m => !o.images || m.image).map(m => m.id)[0] || CODEX_MODELS[0].id);
  if(!model)return {model:null,why,kind,fallbacks:[],error:'no_independent_model',note:'没有可用的独立复核模型；可用候选均属于实际作者或不支持当前附件。'};
  return { model, why, kind, fallbacks: order.filter(x => x !== model), note };
}
