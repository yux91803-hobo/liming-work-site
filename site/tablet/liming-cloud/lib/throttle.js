// 推给 DSH Go 的数据：合并高频变化，两次之间至少隔 250 毫秒（≤ 4 次每秒），最后一次的数据一定推出去；
// 推之前量一下大小，超过 32 KiB 就用 fit 裁（桥接也会限，但超了会被丢，所以自己先裁好）。
export const MAX_EMIT_BYTES = 32 * 1024;

export function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

export function createThrottledEmitter(emit, { intervalMs = 250, maxBytes = MAX_EMIT_BYTES, fit = null, now = Date.now } = {}) {
  let last = -Infinity;
  let timer = null;
  let pending;
  let has = false;
  let closed = false;
  function flush() {
    timer = null;
    if (closed || !has) return;
    let data = pending;
    has = false;
    pending = undefined;
    if (fit && byteLength(data) > maxBytes) data = fit(data, maxBytes);
    last = now();
    try { emit(data); } catch {}
  }
  return {
    push(data) {
      if (closed) return;
      pending = data;
      has = true;
      if (timer) return;
      const wait = last + intervalMs - now();
      if (wait <= 0) flush();
      else { timer = setTimeout(flush, wait); timer.unref?.(); }
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
