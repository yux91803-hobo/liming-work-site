/* sw.js — 只管小芯的「做完提醒」：收到小芯电脑发来的推送就弹通知，点通知打开聊天。
   没有 fetch 处理：不拦截、不缓存任何请求，对网站别的部分没有影响。推送内容的格式见 site/xin/vm-agent.mjs 的 pushAll。 */
'use strict';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (er) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '小芯', {
    body: d.body || '', tag: d.tag || 'xin', renotify: true, lang: 'zh-CN',
    icon: '/icons/icon-192.png', data: { url: d.url || '/#xin', sid: d.sid || '' }
  }));
});

// 点通知：网站已经开着就切过去、打开那段对话；没开就新开一个
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var data = e.notification.data || {}, url = new URL(data.url || '/#xin', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        c.postMessage({ type: 'xin-open', sid: data.sid || '' });
        return c.focus();
      }
    }
    return self.clients.openWindow ? self.clients.openWindow(url) : null;
  }));
});
