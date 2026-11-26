// 平板密钥存储：读写 ~/.liming-cloud/secrets.json（强制目录 700、文件 600、原子写）。
// 严格执行最小权限底线：拒绝写入含 machines:delete / machines:write 或非法结构的数据，
// 按机器返回 SSH 目标与只读 InstaBox key；任何报错不回显密钥原文。
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CLOUD_DIR, ensurePrivateDir, writeFileAtomic } from './ledger.js';
import { redactText } from './redact.js';

export const SECRETS_SCHEMA_VERSION = 1;

const MACHINE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SSH_TARGET_RE = /^(?:ssh\s+)?(ibssh_[A-Za-z0-9._~+=-]+@[A-Za-z0-9][A-Za-z0-9.-]*)$/;
const READ_KEY_RE = /^[^\s\x00-\x1f]{8,256}$/;

const FORBIDDEN_KEYS = new Set([
  'writeKey',
  'write_key',
  'leaseKey',
  'lease_key',
  'deleteKey',
  'delete_key',
  'adminKey',
  'admin_key',
  'allowDelete',
  'allow_delete',
]);

const FORBIDDEN_SCOPES = new Set(['machines:delete', 'machines:write']);

export class SecretsError extends Error {
  constructor(code, message) {
    super(redactText(message));
    this.name = 'SecretsError';
    this.code = code;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function parseSshTarget(raw) {
  if (typeof raw !== 'string') {
    throw new SecretsError('SECRETS_INVALID_SSH_TARGET', 'SSH 目标必须是字符串');
  }
  const trimmed = raw.replace(/\r/g, '').trim();
  const match = SSH_TARGET_RE.exec(trimmed);
  if (!match) {
    throw new SecretsError('SECRETS_INVALID_SSH_TARGET', 'SSH 目标格式非法：应为 ibssh_<令牌>@<主机>');
  }
  return match[1];
}

function normalizeScopes(rawScopes, label) {
  if (rawScopes === undefined || rawScopes === null) return ['machines:read'];
  const list = Array.isArray(rawScopes)
    ? rawScopes
    : (typeof rawScopes === 'string' ? rawScopes.split(/[\s,]+/).filter(Boolean) : null);
  if (!list) {
    throw new SecretsError('SECRETS_INVALID_SCHEMA', `${label} 的 scopes 必须是字符串数组`);
  }
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new SecretsError('SECRETS_INVALID_SCHEMA', `${label} 包含非法 scope 项`);
    }
    const lower = item.trim().toLowerCase();
    if (FORBIDDEN_SCOPES.has(lower) || lower.includes('delete') || lower.includes('write')) {
      throw new SecretsError(
        'SECRETS_FORBIDDEN_SCOPE',
        `拒绝在平板 secrets.json 保存含高权限标记（${lower}）的配置，仅允许只读权限`,
      );
    }
    out.push(lower);
  }
  return out;
}

function assertNoForbiddenMarkers(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (/machines:delete|machines:write/i.test(value)) {
      throw new SecretsError('SECRETS_FORBIDDEN_SCOPE', '拒绝保存包含 machines:delete 或 machines:write 标记的密钥配置');
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenMarkers(item, seen);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(k)) {
      throw new SecretsError('SECRETS_FORBIDDEN_FIELD', `平板 secrets.json 禁止包含字段 ${k}`);
    }
    assertNoForbiddenMarkers(v, seen);
  }
}

function normalizeMachineEntry(machine, raw) {
  if (!MACHINE_NAME_RE.test(machine)) {
    throw new SecretsError('SECRETS_INVALID_MACHINE', `非法机器名：${machine}`);
  }
  if (!isPlainObject(raw)) {
    throw new SecretsError('SECRETS_INVALID_SCHEMA', `机器 ${machine} 的配置必须是对象`);
  }
  assertNoForbiddenMarkers(raw);
  const scopes = normalizeScopes(raw.scopes ?? raw.permissions, machine);

  let sshTarget = null;
  if (raw.sshTarget !== undefined && raw.sshTarget !== null && raw.sshTarget !== '') {
    sshTarget = parseSshTarget(raw.sshTarget);
  }

  let sshPort = 22;
  if (raw.sshPort !== undefined && raw.sshPort !== null) {
    if (!Number.isInteger(raw.sshPort) || raw.sshPort < 1 || raw.sshPort > 65535) {
      throw new SecretsError('SECRETS_INVALID_SCHEMA', `机器 ${machine} 的 sshPort 非法`);
    }
    sshPort = raw.sshPort;
  }

  let readKey = null;
  if (raw.readKey !== undefined && raw.readKey !== null && raw.readKey !== '') {
    if (typeof raw.readKey !== 'string' || !READ_KEY_RE.test(raw.readKey.trim())) {
      throw new SecretsError('SECRETS_INVALID_READ_KEY', `机器 ${machine} 的只读 key 格式非法`);
    }
    readKey = raw.readKey.trim();
  }

  return { sshTarget, sshPort, readKey, scopes };
}

export function validateSecretsDoc(raw) {
  if (!isPlainObject(raw)) {
    throw new SecretsError('SECRETS_INVALID_SCHEMA', 'secrets.json 顶层必须是对象');
  }
  assertNoForbiddenMarkers(raw);
  const version = raw.schemaVersion === undefined ? SECRETS_SCHEMA_VERSION : raw.schemaVersion;
  if (!Number.isInteger(version) || version < 1 || version > SECRETS_SCHEMA_VERSION) {
    throw new SecretsError('SECRETS_UNSUPPORTED_VERSION', `不支持的 secrets.json 版本：${version}`);
  }
  if (!isPlainObject(raw.machines)) {
    throw new SecretsError('SECRETS_INVALID_SCHEMA', 'secrets.json 缺少有效的 machines 对象');
  }
  const machines = {};
  for (const [name, entry] of Object.entries(raw.machines)) {
    machines[name] = normalizeMachineEntry(name, entry);
  }
  return { schemaVersion: SECRETS_SCHEMA_VERSION, machines };
}

export function createSecretsStore(options = {}) {
  const dir = options.dir || (options.filePath ? path.dirname(options.filePath) : DEFAULT_CLOUD_DIR);
  const filePath = options.filePath || path.join(dir, 'secrets.json');
  const beforeRename = options.beforeRename;

  function inspectPermissions() {
    const dirMode = fs.existsSync(dir) ? (fs.statSync(dir).mode & 0o777) : null;
    const fileMode = fs.existsSync(filePath) ? (fs.statSync(filePath).mode & 0o777) : null;
    return {
      dirMode,
      fileMode,
      secure: (dirMode === null || (dirMode & 0o077) === 0) && (fileMode === null || (fileMode & 0o077) === 0),
    };
  }

  function load({ strictPermissions = false } = {}) {
    if (!fs.existsSync(filePath)) {
      return { schemaVersion: SECRETS_SCHEMA_VERSION, machines: {} };
    }
    if (strictPermissions) {
      const perm = inspectPermissions();
      if (!perm.secure) {
        throw new SecretsError(
          'SECRETS_INSECURE_PERMISSIONS',
          `secrets.json 权限过宽（dir=${perm.dirMode?.toString(8)}, file=${perm.fileMode?.toString(8)}），要求 700/600`,
        );
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new SecretsError('SECRETS_CORRUPT', `无法解析 secrets.json：${err.message}`);
    }
    return validateSecretsDoc(parsed);
  }

  function save(doc) {
    const normalized = validateSecretsDoc(doc);
    ensurePrivateDir(dir, 0o700);
    writeFileAtomic(filePath, JSON.stringify(normalized, null, 2) + '\n', {
      dirMode: 0o700,
      fileMode: 0o600,
      beforeRename,
    });
    return normalized;
  }

  function getMachine(machine, opts) {
    const doc = load(opts);
    if (!Object.hasOwn(doc.machines, machine)) return null;
    return { machine, ...doc.machines[machine] };
  }

  function setMachine(machine, entry) {
    const doc = load();
    doc.machines[machine] = normalizeMachineEntry(machine, entry);
    save(doc);
    return { machine, ...doc.machines[machine] };
  }

  function listMachines(opts) {
    const doc = load(opts);
    return Object.keys(doc.machines).sort();
  }

  function knownSecrets() {
    try {
      const doc = load();
      const out = [];
      for (const m of Object.values(doc.machines)) {
        if (m.sshTarget) {
          out.push(m.sshTarget);
          const at = m.sshTarget.indexOf('@');
          if (at > 0) out.push(m.sshTarget.slice(0, at));
        }
        if (m.readKey) out.push(m.readKey);
      }
      return out;
    } catch {
      return [];
    }
  }

  return {
    dir,
    filePath,
    load,
    save,
    getMachine,
    setMachine,
    listMachines,
    inspectPermissions,
    knownSecrets,
  };
}
