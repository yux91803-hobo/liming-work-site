/* sw.js — 以前只管小芯的「做完提醒」（推送通知）。2026-11-26 小芯删了，这一版只做一件事：
   以前注册过它的浏览器下次检查更新时装上这一版，接管后退订推送、注销自己。没有 fetch 处理，不拦截、不缓存任何请求。
   （Chrome 文档推荐的「kill switch」做法：直接删掉 sw.js 的话，已经装好的旧版会一直留在浏览器里。） */
'use strict';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(self.registration.pushManager.getSubscription()
    .then(function (s) { return s && s.unsubscribe(); })
    .catch(function () {})
    .then(function () { return self.registration.unregister(); }));
});
