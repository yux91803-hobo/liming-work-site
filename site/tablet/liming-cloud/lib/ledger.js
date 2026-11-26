// 平板云端任务台账：持久化 ~/.liming-cloud/tasks.json（目录 700、文件 600、原子写、带版本号与迁移钩子）。
// 仅保存任务元数据、发件箱与同步游标，不存云端对话正文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { redactText } from './redact.js';

export const LEDGER_SCHEMA_VERSION = 1;
export const DEFAULT_CLOUD_DIR = path.join(os.homedir(), '.liming-cloud');
export const DEFAULT_REMOTE_WORKSPACE = '/data/workspace/tablet';

export const TASK_STATUSES = Object.freeze([
  'dispatching',
  'running',
  'stopping',
  'completed',
  'failed',
  'interrupted',
  'stopped',
]);

export const NOTICE_STATES = Object.freeze(['none', 'pending', 'confirmed']);
export const OUTBOX_STATUSES = Object.freeze(['pending', 'acked', 'failed']);
export const OUTBOX_MODES = Object.freeze(['queue', 'steer']);

const TASK_STATUS_SET = new Set(TASK_STATUSES);
const NOTICE_STATE_SET = new Set(NOTICE_STATES);
const OUTBOX_STATUS_SET = new Set(OUTBOX_STATUSES);
const OUTBOX_MODE_SET = new Set(OUTBOX_MODES);

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const MACHINE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class LedgerError extends Error {
  constructor(code, message) {
    super(redactText(message));
    this.name = 'LedgerError';
    this.code = code;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

export function ensurePrivateDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  fs.chmodSync(dir, mode);
}

// 原子写：同目录临时文件 -> 落盘 fsync -> 强制 600 -> rename 替换 -> 目录 fsync（尽力）。
export function writeFileAtomic(filePath, content, { dirMode = 0o700, fileMode = 0o600, beforeRename } = {}) {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir, dirMode);
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fileMode);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tmpPath, fileMode);
    if (typeof beforeRename === 'function') beforeRename(tmpPath);
    fs.renameSync(tmpPath, filePath);
    try {
      const dfd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch {}
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function isValidTaskId(taskId) {
  return typeof taskId === 'string' && TASK_ID_RE.test(taskId);
}

export function generateTaskId({ now = Date.now } = {}) {
  const ts = Math.max(0, Math.floor(Number(now()))).toString(36);
  return `t_${ts}_${randomBytes(4).toString('hex')}`;
}

export function cloudSessionIdForTask(taskId) {
  if (!isValidTaskId(taskId)) {
    throw new LedgerError('LEDGER_INVALID_TASK_ID', `无效任务编号：${String(taskId)}`);
  }
  return `tablet-${taskId}`;
}

// 由任务标题与任务编号生成纯 ASCII 项目目录名（带确定性短编号），杜绝路径穿越。
export function projectDirName(title, taskId) {
  if (!isValidTaskId(taskId)) {
    throw new LedgerError('LEDGER_INVALID_TASK_ID', `无效任务编号：${String(taskId)}`);
  }
  const alnum = taskId.toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = (alnum.slice(-8) || '0000').slice(0, 8);
  const rawSlug = typeof title === 'string'
    ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
    : '';
  const prefix = rawSlug || 'task';
  const name = `${prefix}-${suffix}`;
  if (!PROJECT_NAME_RE.test(name)) {
    throw new LedgerError('LEDGER_INVALID_PROJECT', `无法生成合法项目目录名：${name}`);
  }
  return name;
}

export function resolveProjectCwd(projectName, workspaceRoot = DEFAULT_REMOTE_WORKSPACE) {
  if (typeof projectName !== 'string' || projectName.length === 0) {
    throw new LedgerError('LEDGER_INVALID_PROJECT', '项目目录名不能为空');
  }
  if (
    projectName.includes('/') ||
    projectName.includes('\\') ||
    projectName.includes('\0') ||
    projectName.includes('..') ||
    projectName.startsWith('.') ||
    !PROJECT_NAME_RE.test(projectName)
  ) {
    throw new LedgerError('LEDGER_INVALID_PROJECT', `非法项目目录名（仅允许纯 ASCII 小写字母、数字与短横线）：${projectName}`);
  }
  const cleanRoot = path.posix.resolve(String(workspaceRoot || DEFAULT_REMOTE_WORKSPACE));
  const resolved = path.posix.resolve(cleanRoot, projectName);
  if (path.posix.dirname(resolved) !== cleanRoot || !resolved.startsWith(`${cleanRoot}/`)) {
    throw new LedgerError('LEDGER_PATH_TRAVERSAL', `项目目录越界：${projectName}`);
  }
  return resolved;
}

function validateOutboxEntry(entry, index) {
  if (!isPlainObject(entry)) {
    throw new LedgerError('LEDGER_INVALID_OUTBOX', `发件箱条目 #${index} 不是对象`);
  }
  if (typeof entry.requestId !== 'string' || entry.requestId.trim() === '') {
    throw new LedgerError('LEDGER_INVALID_OUTBOX', `发件箱条目 #${index} 缺少 requestId`);
  }
  if (typeof entry.sessionId !== 'string' || entry.sessionId.trim() === '') {
    throw new LedgerError('LEDGER_INVALID_OUTBOX', `发件箱条目 #${index} 缺少 sessionId`);
  }
  if (typeof entry.cwd !== 'string' || entry.cwd.trim() === '') {
    throw new LedgerError('LEDGER_INVALID_OUTBOX', `发件箱条目 #${index} 缺少 cwd`);
  }
  if (typeof entry.text !== 'string' || entry.text.length === 0) {
    throw new LedgerError('LEDGER_INVALID_OUTBOX', `发件箱条目 #${index} 缺少消息正文`);
  }
  if (!OUTBOX_MODE_SET.has(entry.mode)) {
    throw new LedgerError('LEDGER_INVALID_OUTBOX', `发件箱条目 #${index} mode 非法：${entry.mode}`);
  }
  if (!OUTBOX_STATUS_SET.has(entry.status)) {
    throw new LedgerError('LEDGER_INVALID_OUTBOX', `发件箱条目 #${index} status 非法：${entry.status}`);
  }
}

function newOutboxEntry(task, entry, createdAt) {
  return {
    requestId: entry.requestId,
    sessionId: entry.sessionId || task.cloudSessionId,
    cwd: entry.cwd || task.cwd,
    text: entry.text,
    mode: entry.mode || 'queue',
    status: 'pending',
    createdAt: entry.createdAt ?? createdAt,
    ackedAt: null,
    attempts: 0,
    lastError: null,
  };
}

function validateTaskRecord(task, key) {
  if (!isPlainObject(task)) {
    throw new LedgerError('LEDGER_CORRUPT', `台账任务 ${key} 结构非法`);
  }
  if (!isValidTaskId(task.taskId) || (key && task.taskId !== key)) {
    throw new LedgerError('LEDGER_CORRUPT', `台账任务编号不一致：${key}`);
  }
  if (typeof task.machine !== 'string' || !MACHINE_RE.test(task.machine)) {
    throw new LedgerError('LEDGER_CORRUPT', `台账任务 ${task.taskId} 机器名非法`);
  }
  if (task.cloudSessionId !== cloudSessionIdForTask(task.taskId)) {
    throw new LedgerError('LEDGER_CORRUPT', `台账任务 ${task.taskId} 云端对话编号不符合确定性约定`);
  }
  if (!TASK_STATUS_SET.has(task.status)) {
    throw new LedgerError('LEDGER_CORRUPT', `台账任务 ${task.taskId} 状态非法：${task.status}`);
  }
  if (!NOTICE_STATE_SET.has(task.noticeState)) {
    throw new LedgerError('LEDGER_CORRUPT', `台账任务 ${task.taskId} 通知状态非法：${task.noticeState}`);
  }
  if (!Number.isInteger(task.lastSeq) || task.lastSeq < 0) {
    throw new LedgerError('LEDGER_CORRUPT', `台账任务 ${task.taskId} lastSeq 非法`);
  }
  if (!Array.isArray(task.outbox)) {
    throw new LedgerError('LEDGER_CORRUPT', `台账任务 ${task.taskId} outbox 必须是数组`);
  }
  task.outbox.forEach(validateOutboxEntry);
}

function validateLedgerDoc(doc) {
  if (!isPlainObject(doc)) {
    throw new LedgerError('LEDGER_CORRUPT', '台账顶层必须是 JSON 对象');
  }
  if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) {
    throw new LedgerError('LEDGER_CORRUPT', `台账版本号非法：${doc.schemaVersion}`);
  }
  if (doc.schemaVersion > LEDGER_SCHEMA_VERSION) {
    throw new LedgerError(
      'LEDGER_UNSUPPORTED_VERSION',
      `台账版本 v${doc.schemaVersion} 高于当前插件支持的 v${LEDGER_SCHEMA_VERSION}，拒绝覆盖`,
    );
  }
  if (!isPlainObject(doc.tasks)) {
    throw new LedgerError('LEDGER_CORRUPT', '台账 tasks 必须是对象');
  }
  for (const [k, task] of Object.entries(doc.tasks)) {
    validateTaskRecord(task, k);
  }
}

export function createLedger(options = {}) {
  const dir = options.dir || (options.filePath ? path.dirname(options.filePath) : DEFAULT_CLOUD_DIR);
  const filePath = options.filePath || path.join(dir, 'tasks.json');
  const workspaceRoot = options.workspaceRoot || DEFAULT_REMOTE_WORKSPACE;
  const migrations = options.migrations || {};
  const now = options.now || Date.now;
  const beforeRename = options.beforeRename;

  let lockChain = Promise.resolve();

  function withLock(fn) {
    const next = lockChain.then(() => fn(), () => fn());
    lockChain = next.then(() => {}, () => {});
    return next;
  }

  function emptyDoc() {
    return { schemaVersion: LEDGER_SCHEMA_VERSION, tasks: {} };
  }

  function load() {
    if (!fs.existsSync(filePath)) return emptyDoc();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new LedgerError('LEDGER_CORRUPT', `读取台账 JSON 失败：${err.message}`);
    }
    if (!isPlainObject(parsed) || !Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 0) {
      throw new LedgerError('LEDGER_CORRUPT', `台账版本号缺失或非法：${parsed?.schemaVersion}`);
    }
    if (parsed.schemaVersion === 0 && typeof migrations[0] !== 'function') {
      throw new LedgerError('LEDGER_CORRUPT', `台账版本号非法：${parsed.schemaVersion}`);
    }
    if (parsed.schemaVersion > LEDGER_SCHEMA_VERSION) {
      throw new LedgerError(
        'LEDGER_UNSUPPORTED_VERSION',
        `台账版本 v${parsed.schemaVersion} 高于当前支持版本 v${LEDGER_SCHEMA_VERSION}，已拒绝读取与覆写`,
      );
    }
    let current = parsed;
    while (current.schemaVersion < LEDGER_SCHEMA_VERSION) {
      const migrate = migrations[current.schemaVersion];
      if (typeof migrate !== 'function') {
        throw new LedgerError(
          'LEDGER_MIGRATION_MISSING',
          `缺少从台账 v${current.schemaVersion} 迁移到 v${current.schemaVersion + 1} 的迁移函数`,
        );
      }
      current = migrate(cloneJson(current));
      if (!isPlainObject(current) || !Number.isInteger(current.schemaVersion)) {
        throw new LedgerError('LEDGER_MIGRATION_INVALID', '台账迁移函数返回了无效结构');
      }
    }
    validateLedgerDoc(current);
    return cloneJson(current);
  }

  function save(doc) {
    validateLedgerDoc(doc);
    const payload = JSON.stringify(doc, null, 2) + '\n';
    writeFileAtomic(filePath, payload, { dirMode: 0o700, fileMode: 0o600, beforeRename });
    return cloneJson(doc);
  }

  function init() {
    ensurePrivateDir(dir, 0o700);
    if (!fs.existsSync(filePath)) {
      return save(emptyDoc());
    }
    const doc = load();
    // 若通过迁移升级到了当前版本，落盘新版本。
    const rawVersion = JSON.parse(fs.readFileSync(filePath, 'utf8')).schemaVersion;
    if (rawVersion < LEDGER_SCHEMA_VERSION) {
      return save(doc);
    }
    return doc;
  }

  function createTask(input, firstMessage) {
    if (!isPlainObject(input)) {
      throw new LedgerError('LEDGER_INVALID_TASK', '创建任务参数必须是对象');
    }
    const taskId = input.taskId ? String(input.taskId) : generateTaskId({ now });
    if (!isValidTaskId(taskId)) {
      throw new LedgerError('LEDGER_INVALID_TASK_ID', `任务编号非法：${taskId}`);
    }
    const machine = String(input.machine || '').trim();
    if (!MACHINE_RE.test(machine)) {
      throw new LedgerError('LEDGER_INVALID_MACHINE', `机器名非法：${machine}`);
    }
    const title = String(input.title || '').trim() || `任务 ${taskId}`;
    const project = (input.project !== undefined && input.project !== null)
      ? String(input.project)
      : projectDirName(title, taskId);
    const cwd = resolveProjectCwd(project, workspaceRoot);
    if (input.cwd !== undefined && path.posix.resolve(String(input.cwd)) !== cwd) {
      throw new LedgerError('LEDGER_PATH_TRAVERSAL', `显式 cwd 与项目目录不一致：${input.cwd}`);
    }
    const ts = Number(now());
    const status = input.status || 'dispatching';
    const noticeState = input.noticeState || 'none';
    const record = {
      taskId,
      tabletSessionId: input.tabletSessionId ? String(input.tabletSessionId) : '',
      machine,
      cloudSessionId: cloudSessionIdForTask(taskId),
      project,
      cwd,
      title,
      status,
      createdAt: ts,
      startedAt: status === 'running' ? ts : null,
      endedAt: null,
      updatedAt: ts,
      lastSeq: 0,
      outbox: [],
      stopRequest: null,
      noticeState,
      noticeMeta: null,
      summary: typeof input.summary === 'string' ? redactText(input.summary) : '',
      jobId: input.jobId || null,
      lastError: null,
    };
    if (firstMessage) {
      record.outbox.push(newOutboxEntry(record, firstMessage, ts));
      record.runRequestIds = [firstMessage.requestId];
      record.model = input.model || null;
      record.modelSelected = false;
    }
    const doc = load();
    if (Object.hasOwn(doc.tasks, taskId)) {
      throw new LedgerError('LEDGER_DUPLICATE_TASK', `任务已存在：${taskId}`);
    }
    doc.tasks[taskId] = record;
    save(doc);
    return cloneJson(record);
  }

  function getTask(taskId) {
    const doc = load();
    return Object.hasOwn(doc.tasks, taskId) ? cloneJson(doc.tasks[taskId]) : null;
  }

  function listTasks(filter = {}) {
    const doc = load();
    const statuses = Array.isArray(filter.statuses) ? new Set(filter.statuses) : null;
    return Object.values(doc.tasks)
      .filter(task => {
        if (filter.machine && task.machine !== filter.machine) return false;
        if (filter.status && task.status !== filter.status) return false;
        if (statuses && !statuses.has(task.status)) return false;
        if (filter.tabletSessionId && task.tabletSessionId !== filter.tabletSessionId) return false;
        return true;
      })
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneJson);
  }

  function updateTask(taskId, mutator) {
    const doc = load();
    if (!Object.hasOwn(doc.tasks, taskId)) {
      throw new LedgerError('LEDGER_TASK_NOT_FOUND', `找不到任务：${taskId}`);
    }
    const current = cloneJson(doc.tasks[taskId]);
    const next = typeof mutator === 'function' ? (mutator(current) || current) : { ...current, ...mutator };
    next.taskId = taskId;
    next.cloudSessionId = cloudSessionIdForTask(taskId);
    next.updatedAt = Number(now());
    doc.tasks[taskId] = next;
    save(doc);
    return cloneJson(next);
  }

  function appendOutboxEntry(taskId, entry, updateRun) {
    return updateTask(taskId, task => {
      const existing = task.outbox.find(item => item.requestId === entry.requestId);
      if (existing) return task;
      const message = newOutboxEntry(task, entry, Number(now()));
      task.outbox.push(message);
      if (updateRun) return updateRun(task, message);
      return task;
    });
  }

  function updateOutboxEntry(taskId, requestId, mutator) {
    return updateTask(taskId, task => {
      const idx = task.outbox.findIndex(item => item.requestId === requestId);
      if (idx === -1) {
        throw new LedgerError('LEDGER_OUTBOX_NOT_FOUND', `任务 ${taskId} 找不到发件箱条目 ${requestId}`);
      }
      const cur = task.outbox[idx];
      const next = typeof mutator === 'function' ? (mutator(cur) || cur) : { ...cur, ...mutator };
      task.outbox[idx] = next;
      return task;
    });
  }

  return {
    dir,
    filePath,
    workspaceRoot,
    init,
    load,
    save,
    createTask,
    getTask,
    listTasks,
    updateTask,
    appendOutboxEntry,
    updateOutboxEntry,
    withLock,
  };
}
