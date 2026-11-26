// 统一密钥与凭据脱敏器：屏蔽 SSH 令牌、InstaBox key、网关 key、DSH 会话 Cookie 与启动 token。
// 供日志、报错、工具返回与测试输出共用，零外部依赖。

const REDACTED = '[REDACTED]';

const SECRET_PATTERNS = [
  { re: /(\b(?:x-dsh-auth-token|x-api-key)\s*[:=]\s*)([^\s;,)"'\r\n]+)/gi, replace: '$1[REDACTED]' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, replace: 'Bearer [REDACTED]' },
  { re: /\bibssh_[A-Za-z0-9._~+=-]+/g, replace: 'ibssh_[REDACTED]' },
  { re: /\bibk_[A-Za-z0-9._~+=-]+/g, replace: 'ibk_[REDACTED]' },
  { re: /\bsk-[A-Za-z0-9._~+=-]+/g, replace: 'sk-[REDACTED]' },
  { re: /(?<![A-Za-z0-9_-])dsh-auth-[A-Za-z0-9_-]+(?:=[^;\s"',)\]}]+)?/g, replace: 'dsh-auth-[REDACTED]' },
  { re: /((?:^|[?&;\s"'({[,]))token=([^\s&#;"',)\]}]+)/gi, replace: '$1token=[REDACTED]' },
];

const SENSITIVE_KEY_RE = /^(?:token|launchToken|launch_token|cookie|cookieHeader|cookie_header|setCookie|set_cookie|authorization|apiKey|api_key|readKey|read_key|writeKey|write_key|leaseKey|lease_key|deleteKey|delete_key|secret|password|sshTarget|ssh_target|sshToken|ssh_token)$/i;

function normalizeExtras(extraSecrets) {
  if (!extraSecrets) return [];
  const raw = typeof extraSecrets === 'function' ? extraSecrets() : extraSecrets;
  if (!Array.isArray(raw) && !(raw instanceof Set)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.length >= 4) out.push(item);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

export function redactText(input, extraSecrets) {
  if (input === null || input === undefined) return '';
  let text = typeof input === 'string' ? input : String(input);
  for (const secret of normalizeExtras(extraSecrets)) {
    if (text.includes(secret)) text = text.split(secret).join(REDACTED);
  }
  for (const { re, replace } of SECRET_PATTERNS) {
    text = text.replace(re, replace);
  }
  return text;
}

export function redactValue(value, extraSecrets, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, extraSecrets);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return redactError(value, extraSecrets);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, extraSecrets, seen));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = REDACTED;
    } else {
      out[k] = redactValue(v, extraSecrets, seen);
    }
  }
  return out;
}

export function redactError(err, extraSecrets) {
  if (!(err instanceof Error)) {
    return new Error(redactText(err, extraSecrets));
  }
  const clean = new Error(redactText(err.message || err.name, extraSecrets));
  clean.name = err.name || 'Error';
  if (err.code !== undefined) clean.code = err.code;
  if (err.status !== undefined) clean.status = err.status;
  if (err.kind !== undefined) clean.kind = err.kind;
  if (err.retryable !== undefined) clean.retryable = err.retryable;
  if (err.detail !== undefined) clean.detail = redactText(err.detail, extraSecrets);
  if (err.details !== undefined) clean.details = redactValue(err.details, extraSecrets);
  if (typeof err.stack === 'string') clean.stack = redactText(err.stack, extraSecrets);
  return clean;
}

export function createRedactingLogger(logger, extraSecrets) {
  const wrap = (level) => (...args) => {
    const fn = logger?.[level];
    if (typeof fn !== 'function') return;
    const safeArgs = args.map(arg => (typeof arg === 'string' ? redactText(arg, extraSecrets) : redactValue(arg, extraSecrets)));
    try { fn.apply(logger, safeArgs); } catch {}
  };
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
  };
}
