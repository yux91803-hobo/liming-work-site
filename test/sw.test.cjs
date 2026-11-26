// site/sw.js：小芯的推送通知 2026-11-26 随小芯删了。以前注册过它的浏览器下次检查更新时会装上新版，
// 新版装上就接管、退订推送、注销自己，不拦截任何请求。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function load() {
  const listeners = {}, calls = [];
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { calls.push('skipWaiting'); return Promise.resolve(); },
    registration: {
      pushManager: { getSubscription: async () => ({ unsubscribe: async () => { calls.push('unsubscribe'); return true; } }) },
      unregister: async () => { calls.push('unregister'); return true; },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../site/sw.js'), 'utf8'), { self });
  return { listeners, calls };
}

test('sw.js 只剩自注销：装上就接管，激活时退订推送、注销自己；不再处理推送和通知点击，也不拦截请求', async () => {
  const { listeners, calls } = load();
  assert.deepEqual(Object.keys(listeners).sort(), ['activate', 'install']);
  listeners.install({ waitUntil() {} });
  let done;
  listeners.activate({ waitUntil(p) { done = p; } });
  await done;
  assert.deepEqual(calls, ['skipWaiting', 'unsubscribe', 'unregister']);
});
