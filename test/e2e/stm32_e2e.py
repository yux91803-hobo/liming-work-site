"""STM32 学习台端到端测试（需要 python playwright + chromium）
先 npm run dev，再 python3 test/e2e/stm32_e2e.py [http://localhost:5173]"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173'
TOOL = BASE + '/tools/stm32/'
INSTR = """
  window.__rs = 0;
  const R = history.replaceState.bind(history);
  history.replaceState = function () { window.__rs++; return R.apply(null, arguments); };
"""
results, errors, local_fail = [], [], []

def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (('  — ' + str(detail)) if detail != '' else ''), flush=True)

async def page(b, w=1280, h=860, mobile=False, theme='light'):
    ctx = await b.new_context(viewport={'width': w, 'height': h}, has_touch=mobile, is_mobile=mobile)
    await ctx.add_init_script(INSTR + "try{if(!localStorage.getItem('lm.theme'))localStorage.setItem('lm.theme','%s')}catch(e){}" % theme)
    # 小芯的「叛逆」是随机的（不肯睡、偏要走回去），测试里关掉，免得结果时好时坏
    await ctx.add_init_script("addEventListener('load', function () { if (window.LimingXin) LimingXin.obedient = true; })")
    pg = await ctx.new_page()
    # 网站自己的资源失败才算问题；外部地图瓦片等第三方资源不计
    pg.on('response', lambda r: local_fail.append('%d %s' % (r.status, r.url)) if r.status >= 400 and r.url.startswith(BASE) else None)
    # ERR_ABORTED 是页面跳走时浏览器主动取消的请求，不算失败
    pg.on('requestfailed', lambda r: local_fail.append('%s %s' % (r.failure, r.url)) if r.url.startswith(BASE) and 'ERR_ABORTED' not in (r.failure or '') else None)
    pg.on('pageerror', lambda e: errors.append('pageerror ' + pg.url + ' :: ' + str(e)))
    pg.on('console', lambda m: errors.append('console.error ' + m.text) if m.type == 'error' else None)
    return pg

async def tool_frame(pg):
    for _ in range(120):
        for f in pg.frames:
            if '/tools/stm32/' in f.url:
                try:
                    if await f.evaluate("document.documentElement.classList.contains('ready')"): return f
                except Exception: pass
        await pg.wait_for_timeout(100)
    raise RuntimeError('stm32 iframe not ready')

async def wait_img(f, timeout=10000):
    await f.wait_for_function("(() => { const i = document.querySelector('.viewer.on .zoom-content img'); return i && i.naturalWidth > 0; })()", timeout=timeout)

# ---------- 小芯聊天：假的 /api/xin（不连云电脑） ----------
XIN_HIST = [
    {'t': 'user', 'text': '编译 main.c'},
    {'t': 'text', 'text': '好的：\n\n```c\nint main(void) { return 0; }\n```'},
    {'t': 'text', 'text': '编好了：`/data/workspace/blink/build/app.hex`'},
    {'t': 'tool', 'id': 'item_1', 'name': 'Bash', 'detail': 'arm-none-eabi-gcc -c main.c'},
    {'t': 'tool_end', 'id': 'item_1', 'ok': False, 'out': 'main.c:1: error: boom'},
    {'t': 'done', 'ok': False, 'code': 1, 'ms': 3000},
]
# 对话的用量：上下文（最近一次请求 / 上限）、累计消耗、缓存命中（vm-agent 的 sessionUsage）
XIN_USE_HIST = {'ctx': 120342, 'win': 258400, 'input': 3699260, 'cached': 3567104, 'output': 28753, 'total': 3728013}
XIN_USE_LIVE = {'ctx': 30500, 'win': 258400, 'input': 61000, 'cached': 48800, 'output': 1200, 'total': 62200}
XIN_LIVE = [
    [{'t': 'user', 'text': '看看工作目录'}, {'t': 'status', 'text': 'Model metadata for `deepseek` not found. Defaulting to fallback metadata'}, {'t': 'text', 'text': '收到，我看看。'}, {'t': 'tool', 'id': 'item_1', 'name': 'Bash', 'detail': 'ls /data/workspace'}],
    [],
    [{'t': 'tool_end', 'id': 'item_1', 'ok': True, 'out': 'blink'}, {'t': 'xin', 'act': 'dance', 'arg': ''}, {'t': 'mem', 'text': '用户在做 blink 点灯'}, {'t': 'text', 'text': '里面有一个 blink 目录。'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 4000, 'effort': 'max', 'usage': XIN_USE_LIVE, 'model': 'glm-5.3', 'why': 'chat', 'from': 'deepseek-v4.1-flash'}],
]

# 后台任务：前台派分身的一轮（卡片），分身那边的过程
XIN_LIVE_TASK = [
    [{'t': 'user', 'text': '编译一下 blink，后台做'}, {'t': 'text', 'text': '交给我的分身去弄啦，好了告诉你～'},
     {'t': 'task', 'sid': 'stask00001', 'no': 1, 'title': '编译 LED', 'kind': 'code', 'model': 'glm-5.3', 'why': 'code', 'status': 'running', 'after': []}],
    [{'t': 'done', 'ok': True, 'code': 0, 'ms': 6000, 'model': 'deepseek-v4.1-flash', 'why': 'chat'}],
]
XIN_TASK_RUN = [{'t': 'user', 'text': '编译 blink 工程'}, {'t': 'text', 'text': '我先看看工程。'},
                {'t': 'tool_end', 'id': 'c1', 'name': 'Bash', 'detail': "/bin/bash -lc 'make'", 'ok': True, 'out': 'arm-none-eabi-gcc -c main.c\nbuild/app.hex'},
                {'t': 'text', 'text': '编好了：`/data/workspace/blink/build/app.hex`'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 95000}]
TASK_CARD_JS = """(() => { const c = document.querySelector('.xc-task'); return [c.querySelector('.xc-task-h b').textContent, c.querySelector('.xc-task-st').textContent, c.querySelector('.xc-task-m').textContent,
  c.querySelector('.xc-task-a').textContent, [...c.querySelectorAll('.xc-task-btn')].map(b => b.textContent), c.classList.contains('st-running'),
  !document.querySelector('.xc-tstrip').hidden, document.querySelector('.xc-tstrip').textContent] })()"""
TASK_RES_JS = """(() => { const r = document.querySelector('.xc-tres'); return [r.querySelector('.xc-tres-h').textContent, r.querySelector('.xc-md').textContent, r.querySelector('.xc-tres-f span').textContent,
  !!r.querySelector('.xc-path'), document.querySelector('.xc-msgs').lastElementChild === r, document.querySelector('.xc-task .xc-task-st').textContent,
  [...document.querySelectorAll('.xc-task .xc-task-btn')].map(b => b.textContent), document.querySelector('.xc-tstrip').hidden] })()"""
TASK_CENTER_JS = """(() => { const p = document.querySelector('.xc-sess'); return [[...p.querySelectorAll('.xc-set-h')].map(e => e.textContent), [...p.querySelectorAll('.xc-tl-i b')].map(e => e.textContent),
  [...p.querySelectorAll('.xc-tl-m')].map(e => e.textContent), [...p.querySelectorAll('.xc-tl-from')].map(e => e.textContent), p.querySelector('.xc-dailyst').textContent,
  [...p.querySelectorAll('.xc-tv-st li')].map(e => e.textContent)] })()"""
TASK_SHEET_JS = """(() => { const s = document.querySelector('.xc-sheet'); return [s.querySelector('.xc-sh-hd b').textContent, s.querySelector('.xc-tk-meta').textContent, s.querySelector('.xc-tk-dir a').textContent,
  s.querySelector('.xc-tk-ask').textContent, [...s.querySelectorAll('.xc-tk-cmd code')].map(c => c.textContent), s.querySelector('.xc-tk-cmd pre').textContent.includes('app.hex'),
  [...s.querySelectorAll('.xc-tk-say')].map(e => e.textContent), s.querySelector('.xc-tk-in').placeholder, s.querySelector('.xc-tk-act .xc-btn').textContent] })()"""

W = '/data/workspace'
def _ent(name, d=False, size=0): return {'name': name, 'dir': d, 'size': size, 'mtime': 1762214400000}
XIN_FILES = {
    W: {'path': W, 'dir': True, 'work': W, 'entries': [_ent('blink', True), _ent('notes.md', size=12)], 'more': 0},
    W + '/blink': {'path': W + '/blink', 'dir': True, 'work': W, 'entries': [_ent('build', True), _ent('main.c', size=30)], 'more': 0},
    W + '/blink/build': {'path': W + '/blink/build', 'dir': True, 'work': W, 'entries': [_ent('app.bin', size=876), _ent('app.hex', size=2544)], 'more': 0},
    W + '/blink/build/app.hex': {'path': W + '/blink/build/app.hex', 'dir': False, 'work': W, 'size': 2544, 'mtime': 1762214400000, 'text': ':020000040800F2\n:1000000000500020ED010008F5010008F7010008D0\n'},
    W + '/blink/main.c': {'path': W + '/blink/main.c', 'dir': False, 'work': W, 'size': 30, 'mtime': 1762214400000, 'text': '#include "stm32f10x.h"\nint main(void)\n{\n    GPIOA->ODR ^= 1u << 0;\n}\n'},
    W + '/blink/build/app.bin': {'path': W + '/blink/build/app.bin', 'dir': False, 'work': W, 'size': 876, 'mtime': 1762214400000, 'binary': True},
}

XIN_MOVE = {'name': '打招呼', 'frames': [{'armR': 'up', 'face': 'hap', 't': 250}, {'armR': 'wave', 'face': 'hap', 't': 250}, {'armR': 'up', 't': 250}]}
XIN_BOND = {'score': 52, 'level': 2, 'name': '好朋友', 'next': 80, 'log': [{'at': 1762214400000, 'd': 1, 'why': '陪我聊天'}, {'at': 1762214300000, 'd': -1, 'why': '你凶我'}]}
XIN_LIVE_BOND = [
    [{'t': 'user', 'text': '学个转圈'}, {'t': 'text', 'text': '好，我编一个。'}],
    [{'t': 'move', 'name': '转圈', 'frames': [{'face': 'side', 't': 200}, {'face': 'back', 't': 200}, {'face': 'side', 'sx': 1, 't': 200}]},
     {'t': 'bond', 'd': 2, 'why': '你教我新动作', 'score': 54, 'level': 2, 'name': '好朋友', 'next': 80, 'log': []},
     {'t': 'text', 'text': '学会啦！'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 3000}],
]
import base64, time
PUSH_KEY = base64.urlsafe_b64encode(b'\x04' + bytes(range(64))).decode().rstrip('=')
# 浏览器里的推送换成假的：记下订阅了什么
FAKE_PUSH = """
  if (window.PushManager) {
    window.__sub = null;
    PushManager.prototype.subscribe = function (opts) {
      window.__subOpts = opts;
      window.__sub = { endpoint: 'https://push.example.com/send/abc', options: opts,
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; },
        unsubscribe() { window.__sub = null; return Promise.resolve(true); } };
      return Promise.resolve(window.__sub);
    };
    PushManager.prototype.getSubscription = function () { return Promise.resolve(window.__sub); };
  }
"""

# 面板里这一轮做完了：「正在输入」收起、没在发也没在跑
CHAT_DONE = "!document.querySelector('.xc-typing') && !LimingXinChat.state.run && !LimingXinChat.state.sending"

async def xin_mock(pg, authed=False, live=None):
    live = live or XIN_LIVE
    st = {'authed': authed, 'polls': 0, 'sent': None, 'ops': [], 'mem': '# 小芯的记事本\n\n- 2026-11-04：用户在学定时器\n',
          'greet': None, 'daily': '- 看看网关今天签到成没成，没成就补签\n', 'daily_args': None, 'renamed': None, 'forgot': None, 'download': None,
          'push_sub': None, 'push_unsub': None, 'push_test': 0, 'history_sid': None}
    async def handle(route):
        req = route.request
        path = req.url.split('/api/xin/')[1].split('?')[0]
        def ok(body): return route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
        if path == 'me': return await ok({'enabled': True, 'authed': st['authed']})
        if path == 'file':
            from urllib.parse import urlparse, parse_qs
            st['download'] = parse_qs(urlparse(req.url).query).get('path', [''])[0]
            return await route.fulfill(status=200, content_type='application/octet-stream', body=XIN_FILES[W + '/blink/build/app.hex']['text'],
                                       headers={'Content-Disposition': "attachment; filename=\"app.hex\"; filename*=UTF-8''app.hex"})
        if path == 'upload':   # 发文件：记下名字和大小，回一个在小芯电脑上的路径（upload_delay：传得慢）
            from urllib.parse import urlparse, parse_qs
            name = parse_qs(urlparse(req.url).query).get('name', [''])[0]
            st.setdefault('uploads', []).append({'name': name, 'size': len(req.post_data_buffer or b''), 'xin': req.headers.get('x-xin')})
            if st.get('upload_delay'): await asyncio.sleep(st['upload_delay'])
            img = name.lower().rsplit('.', 1)[-1] in ('png', 'jpg', 'jpeg', 'gif', 'webp')
            return await ok({'ok': True, 'data': {'path': '/data/workspace/uploads/20261106/003005-ab12-' + name, 'name': name, 'size': len(req.post_data_buffer or b''), 'image': img}})
        body = json.loads(req.post_data or '{}')
        if path == 'login':
            st['authed'] = body.get('password') == 'pw-ok-123456'
            return await ok({'ok': True})
        op, args = body.get('op'), body.get('args') or {}
        st['ops'].append(op)
        if op == 'status': return await ok({'ok': True, 'data': {'name': 'li', 'state': 'running'}})
        if op == 'wake': return await ok({'ok': True, 'data': {'state': 'running', 'action': 'none'}})
        if op == 'memory': return await ok({'ok': True, 'data': {'text': st['mem'], 'size': len(st['mem'])}})
        if op == 'greet': return await ok({'ok': True, 'data': st['greet'] or {'warming': False}})
        if op == 'bond': return await ok({'ok': True, 'data': st.get('bond') or {'score': 0, 'level': 0, 'name': '刚认识', 'next': 15, 'log': []}})
        if op == 'bond_play':
            st['played'] = args
            return await ok({'ok': True, 'data': {'delta': 1, 'score': 53, 'info': dict(XIN_BOND, score=53)}})
        if op == 'moves': return await ok({'ok': True, 'data': {'moves': []}})
        if op == 'daily_get': return await ok({'ok': True, 'data': {'text': st['daily'], 'last': {'date': '2026-11-04', 'run': 'rdaily00001', 'sid': 'shist00001', 'ok': True}, 'done': None, 'today': '2026-11-04'}})
        if op == 'daily_set':
            st['daily'] = args.get('text', '')
            return await ok({'ok': True, 'data': {'ok': True}})
        if op == 'daily':
            st['daily_args'] = args
            return await ok({'ok': True, 'data': {'sid': 'shist00001', 'run': 'rdaily00002', 'agent': 'codex'}})
        if op == 'memory_set':
            st['mem'] = args.get('text', '')
            return await ok({'ok': True, 'data': {'ok': True}})
        if op == 'tasks':
            ts = st.get('tasks') or []
            live_ = [t for t in ts if t['status'] in ('queued', 'running')]
            if args.get('all'):
                return await ok({'ok': True, 'data': {'tasks': ts, 'active': [t for t in ts if t['status'] in ('queued', 'running', 'waiting')], 'recent': [], 'bg': len(live_),
                                                      'titles': {'snew000001': '编译一下 blink'}, 'daily': {'last': {'date': '2026-11-06', 'run': 'rdaily00001', 'sid': 'shist00001', 'ok': True}, 'done': None, 'today': '2026-11-06'},
                                                      'stats': [{'agent': 'codex', 'model': 'glm-5.3', 'n': 4, 'ok': 3, 'ms': 0, 'fails': 1, 'fellBack': 1, 'avgMs': 150000}, {'agent': 'harness', 'model': 'deepseek-v4.1-flash', 'n': 2, 'ok': 2, 'ms': 0, 'fails': 0, 'fellBack': 0, 'avgMs': 20000}]}})
            return await ok({'ok': True, 'data': {'tasks': [t for t in ts if t.get('parent') == args.get('sid')], 'active': [t for t in ts if t['status'] in ('queued', 'running', 'waiting')], 'recent': [], 'bg': len(live_)}})
        if op in ('task_stop', 'task_tell'):
            st[op] = args
            t = next((x for x in st.get('tasks') or [] if x['sid'] == args.get('sid')), None)
            if t: t['status'] = 'stopped' if op == 'task_stop' else 'queued'
            return await ok({'ok': True, 'data': {'ok': True, 'msg': '任务 1 接着做了', 'task': t}})
        if op == 'history' and str(args.get('sid', '')).startswith('stask'):
            t = next((x for x in st.get('tasks') or [] if x['sid'] == args['sid']), {})
            return await ok({'ok': True, 'data': {'session': {'sid': args['sid'], 'agent': 'codex'}, 'task': dict(t, goal='编译 blink 工程'), 'runs': [{'run': 'rtask00001', 'started': 1, 'done': True, 'events': XIN_TASK_RUN}], 'active': None}})
        if op == 'history': st['history_sid'] = args.get('sid')
        if op == 'history': return await ok({'ok': True, 'data': {'session': {'sid': args['sid'], 'agent': 'claude' if args['sid'] == 'sold000001' else 'codex'}, 'usage': XIN_USE_HIST if args['sid'] == 'shist00001' else None, 'runs': [{'run': 'rhist00001', 'events': XIN_HIST, 'done': True}], 'active': None}})
        if op == 'sessions' and st.get('many'):   # 对话很多：当前的 shist00001 排在第 7 个
            return await ok({'ok': True, 'data': {'sessions': [{'sid': 's%09d' % i if i != 6 else 'shist00001', 'agent': 'codex', 'title': '对话 %d' % (i + 1), 'turns': 1, 'updated': 0} for i in range(st['many'])]}})
        if op == 'sessions': return await ok({'ok': True, 'data': {'sessions': [{'sid': 'shist00001', 'agent': 'codex', 'title': '编译 main.c', 'turns': 1, 'updated': 0},
                                                                         {'sid': 'sold000001', 'agent': 'claude', 'title': '旧对话', 'turns': 2, 'updated': 0}]}})
        if op == 'files': return await ok({'ok': True, 'data': XIN_FILES.get(args.get('path') or W, {'error': 'not_found', 'msg': '没有这个文件'})})
        if op == 'push_key': return await ok({'ok': True, 'data': {'key': PUSH_KEY, 'subs': 0}})
        if op == 'screen':
            st.setdefault('screen', []).append(args)
            ctl = bool(args.get('control'))
            return await ok({'ok': True, 'data': {'url': BASE + '/icons/icon-192.png?' + ('ctl=1' if ctl else 'view=1'), 'expiresAt': '2026-11-05T03:00:00Z', 'control': ctl, 'terminal': True}})
        if op == 'screen_off': return await ok({'ok': True, 'data': {'ok': True}})
        if op in ('push_sub', 'push_unsub'):
            st[op] = args
            return await ok({'ok': True, 'data': {'ok': True, 'subs': 1 if op == 'push_sub' else 0}})
        if op == 'push_test':
            st['push_test'] += 1
            return await ok({'ok': True, 'data': {'ok': True, 'results': [{'status': 201}]}})
        if op == 'rename':
            st['renamed'] = args
            return await ok({'ok': True, 'data': {'ok': True}})
        if op == 'plugins':
            st['plugins_agent'] = args.get('agent')
            if args.get('agent') == 'harness':
                return await ok({'ok': True, 'data': {'plugins': [dict(p) for p in st.setdefault('harness_plugins', [{'name': 'purge', 'desc': '提示词与规则管理，下一句生效', 'on': True}])], 'merged': []}})
            if args.get('agent') == 'claude': return await ok({'ok': True, 'data': {'plugins': [], 'merged': []}})
            return await ok({'ok': True, 'data': {'plugins': [dict(p) for p in st.setdefault('plugins', [
                {'name': 'rea', 'desc': '逆向分析（Ghidra）', 'cmd': 'run', 'on': False},
                {'name': 'playwright', 'desc': '', 'cmd': 'npx', 'on': True}])], 'merged': []}})
        if op == 'plugin_set':
            st.setdefault('plugin_set', []).append(args)
            for p in st.get('harness_plugins' if args.get('agent') == 'harness' else 'plugins', []):
                if p['name'] == args.get('name'): p['on'] = bool(args.get('on'))
            return await ok({'ok': True, 'data': {'ok': True, 'name': args.get('name'), 'on': bool(args.get('on'))}})
        if op == 'archive':
            st.setdefault('archived', []).append(args)
            return await ok({'ok': True, 'data': {'ok': True}})
        if op == 'forget':
            st['forgot'] = args
            return await ok({'ok': True, 'data': {'ok': True}})
        if op == 'send':
            # send_waking：前几次说电脑在睡（网页隔 1 秒再发）；send_delay：送到小芯电脑要多久
            # send_busy：模拟上一句还在跑（多标签），回软错误，网页应恢复输入、不要当成发送成功
            if st.get('send_waking'):
                st['send_waking'] -= 1
                return await ok({'ok': False, 'state': 'waking', 'msg': '唤醒中…', 'retryAfter': 1})
            if st.get('send_busy'):
                st['send_busy'] -= 1
                st['busy_args'] = args
                sid = args.get('sid') or 'snew000001'
                return await ok({'ok': True, 'data': {'error': 'busy', 'msg': '上一句还没做完，请稍后再试', 'run': 'rbusy00001', 'sid': sid}})
            if st.get('send_delay'): await asyncio.sleep(st['send_delay'])
            st['sent'] = args
            return await ok({'ok': True, 'data': {'sid': 'snew000001', 'run': 'rlive00001', 'agent': args.get('agent') or 'codex'}})
        if op == 'poll':
            i = min(st['polls'], len(live) - 1); st['polls'] += 1
            evs = live[i] if st['polls'] <= len(live) else []
            return await ok({'ok': True, 'data': {'events': evs, 'off': args.get('off', 0) + len(evs), 'done': st['polls'] >= len(live)}})
        return await ok({'ok': False, 'state': 'error', 'msg': 'mock'})
    await pg.route('**/api/xin/**', handle)
    return st

# 用鼠标把首页的小芯拖进某张卡片。小芯会自己走来走去、跳舞：先等它站定再按下去，
# 按空了（它刚好挪开）就再来一次，最多 4 次；拖进去以后卡片对应的工具会打开
async def drag_xin_into(pg, card_id):
    for attempt in range(4):
        try: await pg.wait_for_function("LimingXin.mode === 'idle'", timeout=8000)
        except Exception: pass
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(), cx = r.x + r.width / 2; for (let yy = r.y; yy < r.bottom; yy++) { const e = document.elementFromPoint(cx, yy); if (e && LimingXin.el.contains(e)) return [cx, yy + 2]; } return null; })()")
        if not r:
            await pg.wait_for_timeout(500); continue
        c = await pg.evaluate("(() => { const r = document.querySelector('.card[data-id=%s]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()" % card_id)
        await pg.mouse.move(*r); await pg.mouse.down()
        for i in range(1, 13):
            await pg.mouse.move(r[0] + (c[0] - r[0]) * i / 12, r[1] + (c[1] - r[1]) * i / 12); await pg.wait_for_timeout(30)
        await pg.mouse.up()
        for _ in range(20):
            if await pg.evaluate("document.body.classList.contains('tool-open')"): return
            await pg.wait_for_timeout(100)
    raise RuntimeError('拖了 4 次都没把小芯拖进 ' + card_id)

async def stm32_operation_regressions(b):
    for w in [1280, 390]:
        for embedded in [False, True]:
            pg = await page(b, w, 844, mobile=w == 390)
            prefix = f'{w} ' + ('工具箱' if embedded else '独立页')
            await pg.goto((BASE + '/stm32' if embedded else TOOL) + '?v=topic&t=usart')
            f = await tool_frame(pg) if embedded else pg
            await f.wait_for_selector('html.ready')
            for mode in ['reg', 'hal', 'cd']:
                await f.evaluate('(cv) => STM.app.navigate({v:"topic",t:"usart",sec:"code",cv})', mode)
                states = []
                for sec in ['points', 'pins', 'regs', 'figs']:
                    await f.locator(f'.snav-i[href*="sec={sec}"]').click()
                    states.append(await f.evaluate('(s) => [STM.app.route().sec === s, !document.getElementById("s-"+s).hidden]', sec))
                    await pg.wait_for_function('(s) => new URLSearchParams(location.search).get("sec") === s', arg=sec)
                    await f.locator('.snav-i[href*="sec=code"]').click()
                    states.append(await f.evaluate('(cv) => [STM.app.route().sec === "code", document.querySelector(".cseg-b.on").dataset.k === cv]', mode))
                check(prefix + f'：{mode} 代码模式能切出全部分页，再切回来保留模式与地址', all(all(s) for s in states), states)

            await f.evaluate('STM.app.navigate({v:"topic",t:"i2c",sec:"code",cv:"reg",cx:"i2chw",cf:"main.c"})')
            states = []
            for sec in ['pins', 'points', 'regs', 'figs']:
                await f.locator(f'.snav-i[href*="sec={sec}"]').click()
                states.append(await f.evaluate('(s) => STM.app.route().sec === s', sec))
                await f.locator('.snav-i[href*="sec=code"]').click()
                states.append(await f.evaluate('STM.app.route().cx === "i2chw" && STM.app.route().cf === "main.c" && document.querySelector(".ftab.on").textContent === "main.c"'))
            check(prefix + '：硬件 I2C 的驱动和 main.c 不会被其他分页重置', all(states), states)

            await pg.goto((BASE + '/stm32' if embedded else TOOL) + '?v=topic&t=usart&sec=code&cv=reg&cf=usart.c')
            f = await tool_frame(pg) if embedded else pg
            await f.wait_for_selector('html.ready')
            await f.locator('.ftab').filter(has_text='main.c').click()
            await f.evaluate('window.scrollTo(0, Math.min(650,document.scrollingElement.scrollHeight-innerHeight-30))')
            before = await f.evaluate('({file:document.querySelector(".ftab.on").textContent,y:scrollY,cf:STM.app.route().cf})')
            await pg.keyboard.press('Control+k')
            await f.locator('.search-in').fill('USART_BRR'); await f.wait_for_selector('.search-it')
            await pg.keyboard.press('Enter'); await f.wait_for_selector('.sheet.on')
            source = await f.evaluate('STM.app.route().cf === "main.c" && STM.app.route().sec === "code"')
            await f.evaluate('STM.app.navigate({sch:"board-01"})'); await wait_img(f)
            await pg.locator('.panel.show .back').click() if embedded else await f.locator('.vw-x').click()
            await f.wait_for_function('!STM.app.route().sch')
            sheet = await f.locator('.sheet.on').count() == 1
            await pg.go_back(); await f.wait_for_function('!STM.app.route().reg')
            after = await f.evaluate('({file:document.querySelector(".ftab.on").textContent,y:scrollY,cf:STM.app.route().cf,sec:STM.app.route().sec})')
            check(prefix + '：main.c 查寄存器再看图，逐层返回保留文件与阅读位置', source and sheet and before['cf'] == 'main.c' and after['file'] == after['cf'] == 'main.c' and after['sec'] == 'code' and abs(after['y'] - before['y']) <= 2, (before, source, sheet, after))
            await pg.wait_for_function('new URLSearchParams(location.search).get("cf") === "main.c"')
            await pg.reload(); f = await tool_frame(pg) if embedded else pg
            await f.wait_for_selector('html.ready')
            check(prefix + '：刷新仍打开刚选择的代码文件', await f.locator('.ftab.on').inner_text() == 'main.c')
            if embedded:
                await f.locator('.snav-i[href*="sec=points"]').click()
                await pg.wait_for_function('new URLSearchParams(location.search).get("sec") === "points"')
                await pg.goto(BASE + '/')
                label = await pg.locator('.card[data-id=stm32] .go').inner_text()
                check(prefix + '：工具箱继续位置显示实际分页，不被保留的代码模式覆盖', 'USART 要点' in label, label)
            await pg.context.close()

    for w in [390, 768]:
        pg = await page(b, w, 844, mobile=True)
        await pg.goto(BASE + '/stm32?v=topic&t=usart'); f = await tool_frame(pg)
        await pg.wait_for_function('document.querySelector(".panel.show")._depth === 1')
        for native in [False, True]:
            await f.locator('.bar-menu').click()
            await pg.wait_for_function('document.querySelector(".panel.show")._depth === 2')
            await pg.go_back() if native else await pg.locator('.panel.show .back').click()
            await f.wait_for_function('!document.documentElement.classList.contains("drawer")')
            await pg.wait_for_function('document.querySelector(".panel.show")._depth === 1 && history.state.sub')
            check(f'{w}：' + ('浏览器返回' if native else '工具箱返回') + '先收目录，留在 USART 外设页', await f.evaluate('STM.app.route().t === "usart"'))
        await pg.go_back(); await f.wait_for_selector('.boardh')
        await pg.wait_for_function('document.querySelector(".panel.show")._depth === 0 && !history.state.sub')
        await f.locator('.bar-menu').click()
        await pg.wait_for_function('document.querySelector(".panel.show")._depth === 1')
        await pg.go_back(); await f.wait_for_function('!document.documentElement.classList.contains("drawer")')
        check(f'{w}：首页目录返回只收目录，学习台保持打开', await f.evaluate('STM.app.route().v === "home"') and await pg.locator('.panel.show').count() == 1)
        await pg.wait_for_function('document.querySelector(".panel.show")._depth === 0 && !history.state.sub')
        await f.locator('.bar-menu').click(); await f.evaluate('STM.app.openSearch()')
        await pg.wait_for_function('document.querySelector(".panel.show")._depth === 2')
        await pg.go_back(); await f.wait_for_function('!document.querySelector(".search")')
        first = await f.evaluate('document.documentElement.classList.contains("drawer") && STM.app.route().v === "home"')
        await pg.wait_for_function('document.querySelector(".panel.show")._depth === 1 && history.state.sub')
        await pg.go_back(); await f.wait_for_function('!document.documentElement.classList.contains("drawer")')
        check(f'{w}：目录上搜索，返回依次关搜索、收目录，页面不退', first and await pg.locator('.panel.show').count() == 1)
        await pg.wait_for_function('document.querySelector(".panel.show")._depth === 0 && !history.state.sub')
        await f.locator('.bar-menu').click(); await f.locator('.scrim').click(position={'x': w - 16, 'y': 80})
        await f.evaluate('STM.app.openSearch()')
        await f.locator('.search-in').fill('USART_BRR'); await f.wait_for_selector('.search-it')
        await pg.keyboard.press('Enter'); await f.wait_for_selector('.sheet.on')
        await pg.wait_for_function('document.querySelector(".panel.show")._depth > 0 && history.state.sub')
        await pg.go_back(); await f.wait_for_function('!STM.app.route().reg')
        await pg.wait_for_function('document.querySelector(".panel.show")._depth === 0 && !history.state.sub')
        check(f'{w}：快速收目录后搜索，返回仍只关寄存器且没有多余历史', await f.evaluate('STM.app.route().v === "home"') and await pg.locator('.panel.show').count() == 1)
        await pg.locator('.panel.show .back').click()
        await pg.wait_for_function('!document.body.classList.contains("tool-open")')
        check(f'{w}：所有临时层关闭后，再返回正常退出学习台', await pg.evaluate('location.pathname === "/"'))
        await pg.context.close()

async def stm32_audit_regressions(b):
    for w in [1280, 390]:
        pg = await page(b, w, 844, mobile=w == 390)
        await pg.goto(TOOL + '?v=topic&t=gpio'); await pg.wait_for_selector('html.ready')
        await pg.evaluate('STM.app.openSearch()')
        await pg.evaluate("""(() => {
          const i = document.querySelector('.search-in'); i.value = 'PA9';
          i.dispatchEvent(new Event('input', {bubbles:true}));
          i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',isComposing:true,keyCode:229,bubbles:true,cancelable:true}));
        })()""")
        st = await pg.evaluate("[STM.app.route().t, !!document.querySelector('.search')]")
        check(f'{w}：输入法确认候选词的回车不会提前跳转', st == ['gpio', True], st)
        await pg.evaluate("""(() => {
          const i = document.querySelector('.search-in'); i.value = 'PA9';
          i.dispatchEvent(new Event('input', {bubbles:true}));
          i.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true,cancelable:true}));
        })()""")
        selected = await pg.get_attribute('.search-in', 'aria-activedescendant')
        await pg.wait_for_timeout(150)
        after = await pg.get_attribute('.search-in', 'aria-activedescendant')
        check(f'{w}：改词后立即方向键选中第二项，延迟查询不会把选择重置', selected == 'search-option-1' and after == selected, (selected, after))
        await pg.fill('.search-in', 'USART1'); await pg.wait_for_selector('.search-it')
        await pg.evaluate("""(() => {
          const i = document.querySelector('.search-in'); i.value = 'PA9';
          i.dispatchEvent(new Event('input', {bubbles:true}));
          i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}));
        })()""")
        st = await pg.evaluate("[STM.app.route().v, STM.app.route().pin === String(STM.model.pinByName.PA9.n), !document.querySelector('.search')]")
        check(f'{w}：搜索改词后立即回车，打开新词 PA9 对应引脚', st == ['home', True, True], st)
        await pg.evaluate('STM.app.openSearch()')
        await pg.fill('.search-in', 'USART1'); await pg.wait_for_selector('.search-it')
        await pg.evaluate("""(() => {
          const i = document.querySelector('.search-in'); i.value = '';
          i.dispatchEvent(new Event('input', {bubbles:true}));
          i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}));
        })()""")
        st = await pg.evaluate("[STM.app.route().v, !!document.querySelector('.search'), document.querySelectorAll('.search-it').length]")
        check(f'{w}：清空搜索后立即回车，不会打开旧结果', st == ['home', True, 0], st)
        await pg.fill('.search-in', 'GPIO')
        await pg.wait_for_selector('.search-it')
        st = await pg.evaluate("(() => { const i = document.querySelector('.search-in'); return [i.getAttribute('role'), !!document.getElementById(i.getAttribute('aria-activedescendant'))]; })()")
        await pg.keyboard.press('Tab')
        cancel = await pg.evaluate("document.activeElement.classList.contains('search-x')")
        await pg.keyboard.press('Escape')
        check(f'{w}：搜索能用 Tab 到取消并按 Esc 关闭，读屏能找到当前结果', st == ['combobox', True] and cancel and not await pg.locator('.search').count(), (st, cancel))

        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL&val=0x44444443'); await pg.wait_for_selector('.sheet.on')
        await pg.evaluate('STM.app.openSearch()')
        nested = await pg.evaluate("[document.getElementById('app').inert,document.querySelector('.sheet').inert,document.querySelector('.search').inert]")
        await pg.keyboard.press('Escape')
        after = await pg.evaluate("[document.documentElement.classList.contains('modal'),document.getElementById('app').inert,document.querySelector('.sheet').inert]")
        check(f'{w}：寄存器上打开搜索只允许操作搜索，关闭后寄存器仍锁住背景', nested == [True, True, False] and after == [True, True, False], (nested, after))

        await pg.evaluate("STM.app.navigate({sch:'board-08'})"); await wait_img(pg)
        await pg.evaluate('STM.app.openSearch()'); await pg.keyboard.press('Escape')
        st = await pg.evaluate("[document.documentElement.classList.contains('modal'),document.getElementById('app').inert,document.querySelector('.sheet').inert,document.querySelector('.viewer').inert]")
        check(f'{w}：寄存器、看图、搜索叠开，关搜索后只恢复看图', st == [True, True, True, False], st)
        # 一次导航退出两层，淡出中的 DOM 不应继续锁住页面。
        await pg.evaluate("STM.app.navigate({v:'topic',t:'usart'})")
        await pg.wait_for_function("!STM.app.route().reg && !STM.app.route().sch")
        st = await pg.evaluate("[document.documentElement.classList.contains('modal'),document.getElementById('app').inert]")
        check(f'{w}：同时关寄存器和看图后立即恢复页面操作', st == [False, False], st)

        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL&val=0x44444443'); await pg.wait_for_selector('.sheet.on')
        await pg.evaluate("window.__hexBefore = document.querySelector('.hexin input'); window.__hexValue = __hexBefore.value")
        colors = []
        for theme in ['dark', 'light']:
            await pg.evaluate("t => { localStorage.setItem('lm.theme',t); window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:window.parent,data:{type:'theme'}})); }", theme)
            colors.append(await pg.evaluate("""(() => {
              const wanted = STM.model.topicById.gpio.hue[document.documentElement.dataset.theme === 'dark' ? 1 : 0];
              return [getComputedStyle(document.querySelector('.sheet-p')).getPropertyValue('--h').trim() === wanted,
                getComputedStyle(document.querySelector('.nav-t[data-t=gpio]')).getPropertyValue('--h').trim() === wanted,
                document.querySelector('.hexin input') === __hexBefore && __hexBefore.value === __hexValue];
            })()"""))
        check(f'{w}：切换浅深色即时更新外设和寄存器配色，并保留正在算的值', colors == [[True]*3, [True]*3], colors)

        await pg.goto(TOOL + '?v=topic&t=i2c&reg=I2C_CCR'); await pg.wait_for_selector('.sheet.on')
        await pg.locator('.fxin input').nth(1).fill('350')
        initial = await pg.inner_text('.fxout')
        await pg.click('.sh-fx .pill.solid')
        val = int((await pg.input_value('.hexin input')).replace(' ', ''), 16)
        await pg.fill('.hexin input', '0xC023')
        duty = await pg.inner_text('.fxout')
        check(f'{w}：I2C 350 kHz 取 CCR=35 避免超速，改 DUTY 后同步重算', val == 0x8023 and '342.857' in initial and '288 kHz' in duty and 'CCR = 5' in duty, (initial, val, duty))
        await pg.locator('.fxin input').nth(1).fill('800')
        blocked = await pg.is_disabled('.sh-fx .pill.solid') and '400 kHz' in await pg.inner_text('.fxout')
        await pg.locator('.fxin input').nth(1).fill('100')
        await pg.locator('.fxin input').nth(0).fill('72')
        blocked_clock = await pg.is_disabled('.sh-fx .pill.solid') and '36 MHz' in await pg.inner_text('.fxout')
        check(f'{w}：I2C 超出总线或 PCLK1 上限时禁止写入并解释原因', blocked and blocked_clock, (blocked, blocked_clock))
        await pg.context.close()

    pg = await page(b)
    for query in ['reg=constructor', 'reg=toString', 'reg=hasOwnProperty', 'm=constructor', 'fig=constructor']:
        await pg.goto(TOOL + '?' + query); await pg.wait_for_selector('html.ready')
        check('异常地址仍能加载学习台：' + query, await pg.locator('#main').inner_text() != '')
    await pg.context.close()

async def main():
    async with async_playwright() as p:
        exe = os.environ.get('CHROMIUM_PATH')
        b = await p.chromium.launch(**({'executable_path': exe} if exe else {}))

        await stm32_operation_regressions(b)
        await stm32_audit_regressions(b)

        # ---------- 1. 独立打开：首页 → 主题 → 寄存器 → 返回 ----------
        pg = await page(b)
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        top = await pg.evaluate("[...document.querySelectorAll('.mtags:not(.msub) .mtag')].map(b => b.textContent)")
        check('首页：模块收成分组，首屏只有 STM32 + 5 组', top == ['STM32', '基础', '存储', '通信', '传感', '显示'] and not await pg.is_visible('.msub'), top)
        check('首页：没有引脚筛选框', await pg.evaluate("!document.querySelector('.boardh .filter') && !document.querySelector('.pd-quick')"))
        await pg.click('.mgrp:has-text("存储")')
        sub = await pg.evaluate("[...document.querySelectorAll('.msub .mtag')].map(b => b.textContent)")
        check('点「存储」展开这组的模块', sub == ['M24C02', 'W25Q32', 'SD 卡', 'SRAM', 'NAND'], sub)
        await pg.hover('.msub .mtag:has-text("M24C02")')
        lit = await pg.evaluate("[...document.querySelectorAll('.boardh .chip .pin.lit')].map(g => g.dataset.pin).sort()")
        check('首页：指到 M24C02 标签，芯片上点亮 PB10 / PB11', lit == ['69', '70'], lit)
        await pg.click('.mgrp:has-text("存储")')
        check('再点「存储」收起', not await pg.is_visible('.msub'))
        side = await pg.evaluate("[...document.querySelectorAll('.nav-t')].map(a => a.textContent)")
        check('侧栏外设只写缩写', side == ['RCC', 'GPIO', 'EXTI', 'USART', 'I2C', 'TIM', 'DMA', 'ADC', 'SPI', 'FSMC'], side)
        fs0 = await pg.evaluate("[parseFloat(getComputedStyle(document.querySelector('.side-tg')).fontSize), document.getElementById('side-topics').hidden]")
        await pg.click('.side-tg'); await pg.wait_for_timeout(150)
        fs1 = await pg.evaluate("[document.getElementById('side-topics').hidden, document.querySelector('.side-tg').getAttribute('aria-expanded')]")
        await pg.click('.side-tg'); await pg.wait_for_timeout(150)
        check('侧栏「外设」是大一点的标题，点一下收起 / 再点展开', fs0[0] >= 15 and fs0[1] is False and fs1 == [True, 'false'] and not await pg.evaluate("document.getElementById('side-topics').hidden"), (fs0, fs1))
        await pg.click('.nav-t[data-t="usart"]'); await pg.wait_for_selector('.topic')
        check('进入 USART 主题页', 'v=topic&t=usart' in pg.url and await pg.inner_text('.th-code') == 'USART', pg.url)
        secs = await pg.evaluate("[...document.querySelectorAll('.snav-i')].map(a => a.textContent)")
        check('主题页分节齐全（课件已去掉）', secs == ['要点', '引脚', '寄存器', '代码', '图'], secs)
        vis = await pg.evaluate("[...document.querySelectorAll('.topic > .sec')].filter(x => !x.hidden).map(x => x.id)")
        check('外设页分页：一次只显示一页（默认「要点」）', vis == ['s-points'], vis)
        await pg.click('.snav-i:has-text("寄存器")'); await pg.wait_for_timeout(600)
        vis = await pg.evaluate("[...document.querySelectorAll('.topic > .sec')].filter(x => !x.hidden).map(x => x.id)")
        check('点「寄存器」标签：只剩寄存器这一页，地址记下分页', vis == ['s-regs'] and 'sec=regs' in pg.url, (vis, pg.url))
        await pg.click('.rrow[data-reg="USART_BRR"]'); await pg.wait_for_selector('.sheet.on')
        await pg.click('.sh-fx .pill.solid'); await pg.wait_for_timeout(150)
        hexv = await pg.input_value('.hexin input')
        code = await pg.inner_text('.sh-code figure.code pre')
        check('波特率助手：72 MHz / 115200 → BRR = 0x271', hexv.replace(' ', '') == '0x00000271' and 'USART1->BRR' in code, hexv + ' | ' + code.splitlines()[0])
        await pg.wait_for_timeout(400)
        check('计算值写进地址（可分享）', 'val=0x00000271' in pg.url, pg.url)
        await pg.go_back(); await pg.wait_for_timeout(400)
        check('返回：关掉寄存器面板，留在主题页', not await pg.evaluate("!!document.querySelector('.sheet.on')") and 'reg=' not in pg.url)
        await pg.go_back(); await pg.wait_for_timeout(300)
        check('再返回：回到首页', await pg.evaluate("!!document.querySelector('.boardh')"))
        # 来回点几个外设再返回：按走过的路退回，不在同几页之间来回
        for t, code in [('gpio', 'GPIO'), ('usart', 'USART'), ('gpio', 'GPIO'), ('usart', 'USART'), ('i2c', 'I2C'), ('usart', 'USART')]:
            await pg.click('.nav-t[data-t="%s"]' % t)
            await pg.wait_for_function("(document.querySelector('.th-code') || {}).textContent === '%s' && location.search.includes('t=%s')" % (code, t)); await pg.wait_for_timeout(120)
        await pg.go_back(); await pg.wait_for_timeout(400)
        u1 = [pg.url, await pg.evaluate("(document.querySelector('.th-code') || {}).textContent")]
        await pg.go_back(); await pg.wait_for_timeout(400)
        check('独立打开：GPIO → USART → GPIO → USART → I2C → USART 再返回，先回 GPIO 再回首页，不在几页之间打转', 't=gpio' in u1[0] and u1[1] == 'GPIO' and await pg.evaluate("!!document.querySelector('.boardh')"), u1)
        check('独立打开：左上角「STM32F103 学习台」能点回工具箱首页', await pg.evaluate("(() => { const a = document.querySelector('#side a.brand'); return !!a && a.getAttribute('href') === '/'; })()"))

        # ---------- 2. 位段条与常用配置 ----------
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL&i=GPIOA'); await pg.wait_for_selector('.sheet.on')
        await pg.click('.bits-row:last-child .bits-cells button.bit:last-child')   # 位 0 → MODE0 = 01
        hexv = await pg.input_value('.hexin input')
        code = await pg.inner_text('.sh-code figure.code pre')
        check('点一下位 0：值和读-改-写代码同步', hexv.replace(' ', '') == '0x44444445' and 'GPIOA->CRL' in code and '&=' not in code.split('\n')[0] or '|' in code, hexv + ' | ' + code.splitlines()[0])
        await pg.click('.qchip >> nth=0'); await pg.wait_for_timeout(150)
        hexv = await pg.input_value('.hexin input')
        hal = await pg.evaluate("(() => { const f = [...document.querySelectorAll('.sh-code figure.code')][1]; return f && !f.hidden ? f.innerText : ''; })()")
        check('常用配置「LED1 推挽输出」→ 0x44444443，并给出 HAL 写法', hexv.replace(' ', '') == '0x44444443' and 'GPIO_InitStruct' in hal, hexv)
        grp = await pg.inner_text('.fgroup-h >> nth=0')
        order = await pg.evaluate("[...document.querySelectorAll('.fields .frow-h b')].slice(0, 4).map(b => b.textContent)")
        check('字段从低位到高位往下排', order == ['MODE0', 'CNF0', 'MODE1', 'CNF1'], order)
        check('GPIO 字段按引脚分组并标出板上用途', 'PA0' in grp and 'LED1' in grp, grp)

        # ---------- 3. 首页：芯片引脚 + 板载模块 ----------
        await pg.goto(TOOL + '?v=chip'); await pg.wait_for_selector('.boardh .chip')
        check('旧地址 v=chip 打开首页', 'v=' not in pg.url)
        await pg.goto(TOOL + '?q=USART1'); await pg.wait_for_selector('.boardh .chip'); await pg.wait_for_timeout(300)
        n = await pg.evaluate("document.querySelectorAll('.boardh .chip .pin.lit').length")
        check('旧链接 q=USART1 仍然点亮对应引脚', n >= 4, n)
        await pg.click('.boardh [data-pin="101"] .hit', force=True); await pg.wait_for_timeout(500)
        det = await pg.inner_text('.pdetail')
        check('点 101 脚：详情列出 USART1_TX，并指出接到 ST-Link 口的 TX', 'PA9' in det and 'USART1_TX' in det and 'ST-Link' in det, det[:80])
        await pg.click('.pdetail .mlink'); await pg.wait_for_selector('svg.mod')
        # 地址同步有节流，等它写进地址栏再判断
        try: await pg.wait_for_function("location.href.includes('m=stlink')", timeout=3000)
        except Exception: pass
        st = await pg.evaluate("[document.querySelector('.mod .mp.sel').dataset.mp, document.querySelector('.pdetail h2').textContent, document.querySelector('.msub .mtag.on').textContent, document.querySelector('.mgrp.on').textContent]")
        check('跳到 ST-Link 模块图，选中 TX 脚，「通信」组自动展开', st == ['p6', 'TX', 'ST-Link', '通信'] and 'm=stlink' in pg.url, st)
        await pg.click('.pdetail .mcubtn'); await pg.wait_for_selector('.boardh .chip .pin.sel')
        await pg.wait_for_timeout(500)
        sel = await pg.evaluate("document.querySelector('.boardh .chip .pin.sel').dataset.pin")
        check('点「PA9」回到芯片图并选中 101 脚', sel == '101' and 'pin=101' in pg.url, (sel, pg.url))
        await pg.click('.pdetail a.sig:has-text("USART1_TX")'); await pg.wait_for_selector('.topic')
        check('从信号跳到所属外设', 't=usart' in pg.url)
        await pg.goto(TOOL); await pg.wait_for_selector('.mtags')
        groups = await pg.evaluate("[...document.querySelectorAll('.mgrp')].map(b => b.textContent)")
        tags = ['STM32']; bad = []
        async def check_mod(tg):
            await pg.wait_for_selector('svg.mod')
            mp = await pg.evaluate("document.querySelectorAll('svg.mod .mp').length")
            cond = "(() => { const s = document.querySelector('svg.mod .mp.sel'); return !!s && !!document.querySelector('.pdetail .pd-mp.on') && !!document.querySelector('.pdetail .pd-doc p'); })()"
            # 模块图刚打开还在渲染时，CI 机器上按下到抬起可能被拖过 400 ms，缩放组件会当成长按不选中。
            # 先等两帧让渲染完；第一次没选中再点一次，两次都不行才算失败
            ok = False
            for _ in range(2):
                await pg.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                await pg.click('svg.mod .mp >> nth=0', force=True)
                try: await pg.wait_for_function(cond, timeout=2000); ok = True; break
                except Exception: pass
            if mp < 3 or not ok: bad.append((tg, mp, ok))
        for gname in groups:
            await pg.click('.mgrp:has-text("%s")' % gname); await pg.wait_for_timeout(150)
            if not await pg.is_visible('.msub'):      # 只有一个模块的组：直接打开
                tags.append(gname); await check_mod(gname); continue
            subs = await pg.evaluate("[...document.querySelectorAll('.msub .mtag')].map(b => b.textContent)")
            for tg in subs:
                tags.append(tg)
                await pg.click('.msub .mtag:has-text("%s")' % tg); await check_mod(tg)
        check('%d 个模块图都能打开、点脚选中、右边列出全部脚' % (len(tags) - 1), len(tags) >= 9 and not bad, bad or tags)
        await pg.goto(TOOL + '?m=eeprom&mp=p6'); await pg.wait_for_selector('.pd-conn')
        conn = await pg.inner_text('.pd-conn')
        docs = await pg.evaluate("[...document.querySelectorAll('.pdetail .pd-row h3')].map(h => h.textContent)")
        role = await pg.inner_text('.pdetail .pd-doc p')
        check('M24C02 第 6 脚 SCL 接 PB10（69 脚），下面只讲作用，不画主芯片小图', 'PB10' in conn and '69' in conn and docs == ['接到', '作用'] and '时钟' in role and not await pg.evaluate("!!document.querySelector('.pd-mini')"), [conn, docs, role[:30]])

        # ---------- 4. 原理图查看器；课件入口已去掉 ----------
        await pg.goto(TOOL + '?v=board'); await pg.wait_for_selector('.boardv')
        await pg.evaluate("STM.app.navigate({ sch: 'board-01' })"); await wait_img(pg)
        for _ in range(6):
            await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(60)
        await pg.wait_for_timeout(600)
        cnt = await pg.inner_text('.vw-n')
        check('原理图连续翻 6 页', cnt.startswith('7 /'), cnt)
        check('翻页地址跟上（只替换不新增记录）', 'sch=board-07' in pg.url, pg.url)
        await pg.go_back(); await pg.wait_for_timeout(400)
        check('返回关闭查看器，回到开发板页', not await pg.evaluate("!!document.querySelector('.viewer.on')") and await pg.evaluate("!!document.querySelector('.boardv')"))
        await pg.goto(TOOL + '?v=course&cw=v20-134'); await pg.wait_for_timeout(800)
        check('旧的课件地址打开首页', await pg.evaluate("!!document.querySelector('.boardh') && !document.querySelector('.viewer.on')") and not await pg.evaluate("[...document.querySelectorAll('.nav-i')].some(a => a.textContent.includes('课件'))"))

        # ---------- 5. 搜索 ----------
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        await pg.keyboard.press('/'); await pg.wait_for_selector('.search.on')
        for q, want in [('USART_BRR', 'USART_BRR'), ('UART1', 'USART'), ('GPIOA_CRL', 'GPIOx_CRL'), ('PA 9', 'PA9'), ('串口', 'USART')]:
            await pg.fill('.search-in', q); await pg.wait_for_timeout(200)
            first = await pg.evaluate("[...document.querySelectorAll('.search-it b')].slice(0,3).map(b => b.textContent)")
            check('搜索「%s」' % q, any(want in x for x in first), first)
        await pg.fill('.search-in', 'USART_BRR'); await pg.wait_for_timeout(200); await pg.keyboard.press('Enter')
        await pg.wait_for_selector('.sheet.on')
        check('搜索结果回车直接打开寄存器', 'reg=USART_BRR' in pg.url)
        await pg.keyboard.press('/'); await pg.wait_for_selector('.search.on')
        await pg.fill('.search-in', 'USART1_IRQHandler'); await pg.wait_for_timeout(250)
        first = await pg.evaluate("(document.querySelector('.search-it b') || {}).textContent")
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(600)
        check('搜索代码里的函数名：打开对应的寄存器文件', first == 'usart.c' and 'cf=usart.c' in pg.url and await pg.evaluate("document.querySelector('.ftab.on').textContent") == 'usart.c', [first, pg.url])
        await pg.goto(TOOL + '?m=eeprom'); await pg.wait_for_selector('.pd-links')
        await pg.click('.pd-links a.linkbtn:has-text("eeprom.c")'); await pg.wait_for_timeout(600)
        check('模块图：从 M24C02 直接打开 eeprom.c', 't=i2c' in pg.url and await pg.evaluate("[document.querySelector('.cseg-b.on').textContent, document.querySelector('.ftab.on').textContent].join()") == '寄存器,eeprom.c', pg.url)

        # ---------- 6. 深链 / 旧链接 ----------
        for qs, test, name in [
            ('?sch=board-05', "document.querySelector('.vw-n') && document.querySelector('.vw-n').textContent.startsWith('5 /')", '原理图第 5 页'),
            ('?tab=pins&q=PA9', "!location.search.includes('v=') && !!document.querySelector('.boardh .chip [data-pin=\"101\"].lit')", '旧链接 tab=pins'),
            ('?tab=regs&reg=GPIO_CRH&i=GPIOB', "!!document.querySelector('.sheet.on') && document.querySelector('.sh-expr').textContent === 'GPIOB->CRH'", '旧链接 tab=regs'),
            ('?tab=chip&page=board-05', "!!document.querySelector('.viewer.on') && location.search.includes('v=board')", '旧链接原理图'),
            ('?tab=code&snip=' + 'USART1 中断收发', "location.search.includes('t=usart')", '旧链接代码片段'),
        ]:
            await pg.goto(TOOL + qs); await pg.wait_for_timeout(1200)
            check('深链：' + name, await pg.evaluate(test), pg.url)

        # ---------- 7. 架构图缩略图都能加载 ----------
        await pg.goto(TOOL + '?v=topic&t=tim&sec=figs'); await pg.wait_for_selector('.fgrid')
        await pg.evaluate("document.querySelector('.fgrid').scrollIntoView()")
        await pg.wait_for_timeout(300)
        for i in range(8):
            await pg.mouse.wheel(0, 900); await pg.wait_for_timeout(150)
        await pg.wait_for_timeout(1500)
        bad = await pg.evaluate("[...document.querySelectorAll('.fgrid img')].filter(i => !(i.complete && i.naturalWidth > 0)).length + document.querySelectorAll('.fgrid .thumb.missing').length")
        check('TIM 主题 27 张图的缩略图全部加载', bad == 0, bad)
        await pg.context.close()

        # ---------- 8. 嵌在工具箱里：返回键逐层退回 ----------
        pg = await page(b)
        await pg.goto(BASE + '/stm32'); f = await tool_frame(pg)
        await f.click('.nav-t[data-t="i2c"]'); await f.wait_for_selector('.topic')
        await f.click('.snav-i:has-text("寄存器")'); await f.click('.rrow[data-reg="I2C_CCR"]'); await f.wait_for_selector('.sheet.on')
        await f.evaluate("STM.app.navigate({ sch: 'board-04' })"); await wait_img(f)
        depth = lambda: f.evaluate("({ v: !!document.querySelector('.viewer.on'), s: !!document.querySelector('.sheet.on'), t: !!document.querySelector('.topic') })")
        await pg.go_back(); await pg.wait_for_timeout(600); d1 = await depth()
        check('外壳返回 1：关查看器，寄存器还在', not d1['v'] and d1['s'], d1)
        await pg.go_back(); await pg.wait_for_timeout(600); d2 = await depth()
        check('外壳返回 2：关寄存器，回到 I2C 页', not d2['s'] and d2['t'], d2)
        await pg.go_back(); await pg.wait_for_timeout(600)
        check('外壳返回 3：回到首页', await f.evaluate("!!document.querySelector('.boardh')"))
        await pg.go_back(); await pg.wait_for_timeout(900)
        check('外壳返回 4：关闭工具', not await pg.evaluate("!!document.querySelector('#stage .panel.show')") and await pg.evaluate("location.pathname") == '/')
        check('嵌在工具箱里：左上角「学习台」标志不是链接（外面有返回键和回工具箱）', await f.evaluate("document.querySelector('#side .brand').tagName") == 'DIV')
        # 来回点几个外设：外壳的返回键、浏览器返回都按走过的路退回，不在同几页之间来回
        async def zigzag():
            await pg.goto(BASE + '/stm32'); fr = await tool_frame(pg)
            for t, code in [('gpio', 'GPIO'), ('usart', 'USART'), ('gpio', 'GPIO'), ('usart', 'USART'), ('i2c', 'I2C'), ('usart', 'USART')]:
                await fr.click('.nav-t[data-t="%s"]' % t)
                await fr.wait_for_function("(document.querySelector('.th-code') || {}).textContent === '%s'" % code); await pg.wait_for_timeout(120)
            return fr
        shown = lambda fr: fr.evaluate("document.querySelector('.boardh') ? 'home' : (document.querySelector('.th-code') || {}).textContent")
        f = await zigzag()
        steps = [await pg.evaluate("document.querySelector('#stage .panel.show')._depth")]
        for _ in range(2):
            await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(700); steps.append(await shown(f))
        await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(900)
        steps.append(await pg.evaluate("location.pathname"))
        check('嵌入：来回点 GPIO / USART / I2C 以后只叠了 2 层；返回键：GPIO → 学习台首页 → 关闭', steps == [2, 'GPIO', 'home', '/'], steps)
        f = await zigzag()
        steps = []
        for _ in range(2):
            await pg.go_back(); await pg.wait_for_timeout(700); steps.append(await shown(f))
        await pg.go_back(); await pg.wait_for_timeout(900)
        steps.append(await pg.evaluate("[location.pathname, !!document.querySelector('#stage .panel.show')]"))
        check('嵌入：浏览器 / 手机的返回也一样：GPIO → 学习台首页 → 关闭', steps == ['GPIO', 'home', ['/', False]], steps)
        # 外设页「引脚」里点一个引脚跳到芯片图：返回回到原来的外设页（还在「引脚」分页）；首页上点过引脚再点「首页」不叠层
        await pg.goto(BASE + '/stm32?v=topic&t=gpio&sec=pins'); f = await tool_frame(pg)
        await f.click('.ptile >> nth=0'); await f.wait_for_selector('.boardh'); await pg.wait_for_timeout(300)
        pin = await pg.evaluate("new URLSearchParams(location.search).get('pin')")
        await pg.go_back(); await pg.wait_for_timeout(700)
        st = [pin, await shown(f), await f.evaluate("[...document.querySelectorAll('.topic > .sec')].filter(x => !x.hidden).map(x => x.id)")]
        await pg.go_back(); await pg.wait_for_timeout(700); st.append(await shown(f))
        check('嵌入：外设页点引脚看芯片图，返回回到外设页的「引脚」，再返回到学习台首页', bool(pin) and st[1:] == ['GPIO', ['s-pins'], 'home'], st)
        await f.evaluate("STM.app.update({ pin: '68' })"); await f.click('.nav-t[data-t="usart"]'); await pg.wait_for_timeout(300)
        await f.evaluate("STM.app.navigate({ v: 'home' })"); await pg.wait_for_timeout(500)
        check('嵌入：回学习台首页总是清空返回栈（返回键一下关掉）', await pg.evaluate("document.querySelector('#stage .panel.show')._depth") == 0)
        # 连续翻页后返回
        await pg.goto(BASE + '/stm32?v=board&sch=board-01'); f = await tool_frame(pg); await wait_img(f)
        rs0 = (await pg.evaluate('__rs')) + (await f.evaluate('__rs'))
        await f.focus('.vw-x') if await f.evaluate("getComputedStyle(document.querySelector('.vw-x')).display !== 'none'") else await f.focus('.viewer .icon-btn[aria-label="下一页"]')
        for _ in range(14):
            await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(25)
        await pg.wait_for_timeout(900)
        rs = (await pg.evaluate('__rs')) + (await f.evaluate('__rs')) - rs0
        cnt = await f.inner_text('.vw-n')
        check('嵌入：按住方向键翻 14 页，页码正确', cnt.startswith('15 /'), cnt)
        check('嵌入：翻页期间地址写入被节流', rs <= 12, '%d 次' % rs)
        check('外壳地址跟到当前页', 'sch=board-15' in await pg.evaluate('location.search'), await pg.evaluate('location.search'))
        await pg.go_back(); await pg.wait_for_timeout(700)
        check('翻页后返回只关查看器', not await f.evaluate("!!document.querySelector('.viewer.on')") and await pg.evaluate("!!document.querySelector('#stage .panel.show')"))
        # 外壳切主题
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(300)
        await pg.click('#themeBtn'); await pg.wait_for_timeout(200)
        await pg.click('.card[data-id=stm32]'); f = await tool_frame(pg)
        check('工具箱切到深色后，学习台也是深色', await f.evaluate("document.documentElement.getAttribute('data-theme')") == 'dark')
        await pg.context.close()

        # ---------- 9. 手机 ----------
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        check('手机首页：没选引脚时不显示空的详情框', not await pg.is_visible('.pdetail'))
        await pg.goto(TOOL + '?pin=101'); await pg.wait_for_selector('.pd-h')
        order = await pg.evaluate("['.chipv-stage','.mtags','.pdetail'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().top))")
        check('手机首页：芯片图 → 模块标签 → 详情', order[0] < order[1] < order[2], order)
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        await pg.click('.bar-menu'); await pg.wait_for_timeout(350)
        dr = await pg.evaluate("(() => { const r = document.querySelector('#side').getBoundingClientRect(); return [document.documentElement.classList.contains('drawer'), Math.round(r.left), Math.round(r.width)]; })()")
        check('手机：点菜单从左边滑出侧栏', dr[0] and dr[1] == 0 and dr[2] > 200, dr)
        await pg.click('#side .nav-t[data-t="gpio"]'); await pg.wait_for_selector('.topic')
        check('手机：侧栏点 GPIO 进入外设页，侧栏收起', not await pg.evaluate("document.documentElement.classList.contains('drawer')") and 't=gpio' in pg.url)
        await pg.click('.bar-menu'); await pg.wait_for_timeout(300); await pg.click('.scrim', position={'x': 370, 'y': 400}); await pg.wait_for_timeout(300)
        check('手机：点遮罩收起侧栏', not await pg.evaluate("document.documentElement.classList.contains('drawer')"))
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL'); await pg.wait_for_selector('.sheet.on')
        box = await pg.evaluate("(() => { const r = document.querySelector('.sheet-p').getBoundingClientRect(); const v = document.querySelector('.sh-valrow .pill').getBoundingClientRect(); return [r.width, v.right]; })()")
        check('手机：寄存器面板全屏，复位按钮不被截断', box[0] >= 389 and box[1] <= 390, box)
        overflow = await pg.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
        check('手机：页面没有横向溢出', not overflow)
        await pg.goto(TOOL + '?v=board&sch=board-05'); await wait_img(pg)
        st = await pg.query_selector('.vw-stage'); bb = await st.bounding_box(); y = bb['y'] + bb['height'] / 2
        await pg.evaluate("""([x0, x1, y]) => {
          const s = document.querySelector('.vw-stage');
          const ev = (t, x) => s.dispatchEvent(new PointerEvent(t, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
          ev('pointerdown', x0); ev('pointermove', (x0 + x1) / 2); ev('pointermove', x1); ev('pointerup', x1);
        }""", [bb['x'] + 330, bb['x'] + 60, y])
        await pg.wait_for_timeout(600)
        check('手机：左滑翻到下一页', (await pg.inner_text('.vw-n')).startswith('6 /'))
        await pg.context.close()

        # ---------- 10. 编程思维总览、外设页入口、手机布局 ----------
        CHAPS = ['gpio', 'exti', 'usart', 'i2c', 'tim', 'dma', 'adc', 'spi']
        pg = await page(b)
        await pg.goto(TOOL + '?v=think'); await pg.wait_for_selector('.tk-ch')
        hrefs = await pg.evaluate("[...document.querySelectorAll('.tk-ch')].map(a => new URL(a.href).searchParams.get('t'))")
        check('硬件原理总览：八章', hrefs == CHAPS and await pg.evaluate("document.querySelectorAll('.tk-flow li').length") == 6 and await pg.evaluate("document.querySelector('h1').textContent") == '硬件原理', hrefs)
        for chap in ['gpio', 'usart', 'tim', 'adc', 'spi']:
            await pg.goto(TOOL + '?v=topic&t=' + chap); await pg.wait_for_selector('.topic')
            ok = await pg.evaluate("(document.querySelector('.thinkin b') || {}).textContent === '硬件原理'")
            if not ok: break
        check('五个外设页都有「硬件原理」入口', ok)
        bad = []
        for tid in ['sys', 'fsmc']:
            await pg.goto(TOOL + '?v=topic&t=' + tid); await pg.wait_for_selector('.topic')
            if await pg.evaluate("!!document.querySelector('.thinkin')"): bad.append(tid)
        check('没有推导链的外设不显示「硬件原理」入口', not bad, bad)
        await pg.context.close()
        # 外设页代码：寄存器（完整文件）/ HAL 库 / 代码推导
        pg = await page(b)
        await pg.goto(TOOL + '?v=topic&t=exti&sec=code'); await pg.wait_for_selector('.cd-files')
        st = await pg.evaluate("[[...document.querySelectorAll('.cseg-b')].map(b => b.textContent), document.querySelector('.cseg-b.on').textContent, !document.querySelector('.code-reg').hidden, document.querySelector('.code-hal').hidden, document.querySelector('.code-cd').hidden]")
        check('外设页代码：寄存器 / HAL 库 / 代码推导三页，默认寄存器', st == [['寄存器', 'HAL 库', '代码推导'], '寄存器', True, True, True], st)
        st = await pg.evaluate("[[...document.querySelectorAll('.code-reg .ftab')].map(b => b.textContent), document.querySelectorAll('.code-reg .rc-plan, .code-reg .rc-l.has, .code-reg button.rc-lb').length, document.querySelectorAll('.code-reg .rc-cm').length]")
        check('寄存器页：只放完整的 .h / .c / main.c，带注释，不写思路', st[0] == ['key.h', 'key.c', 'main.c'] and st[1] == 0 and st[2] >= 8, st)
        await pg.click('.code-reg .ftab:has-text("key.c")'); await pg.wait_for_timeout(100)
        vis = await pg.evaluate("[...document.querySelectorAll('.code-reg .rc-fn')].map(x => !x.hidden)")
        check('点文件名切换文件', vis == [False, True, False], vis)
        await pg.click('.cseg-b:has-text("HAL")'); await pg.wait_for_timeout(600)
        check('切到 HAL 库写法', await pg.evaluate("document.querySelector('.code-reg').hidden && !document.querySelector('.code-hal').hidden && document.querySelectorAll('.code-hal .snip').length > 0") and 'cv=hal' in pg.url, pg.url)
        await pg.click('.cseg-b:has-text("代码推导")'); await pg.wait_for_timeout(600)
        n = await pg.evaluate("[document.querySelector('.code-cd').hidden, document.querySelectorAll('.code-cd .cd-step').length, document.querySelectorAll('.code-cd .rc-l.has').length]")
        check('切到代码推导：分步推出文件，能点开理由', not n[0] and n[1] >= 8 and n[2] >= 10 and 'cv=cd' in pg.url, [n, pg.url])
        await pg.click('.code-cd .rc-l.has .rc-lb >> nth=2'); await pg.wait_for_timeout(100)
        why = await pg.inner_text('.code-cd .rc-l.open .rc-why')
        check('代码推导里点一行展开原因', '原因' in why, why[:60])
        # 自己写：挡住代码行，写对了才露出来，进度记在本机
        await pg.goto(TOOL + '?v=topic&t=exti&sec=code&cv=cd'); await pg.wait_for_selector('.cd-modes')
        await pg.click('.cd-mb:has-text("自己写")'); await pg.wait_for_timeout(200)
        n0 = await pg.evaluate("[document.querySelectorAll('.cd-inp').length, document.querySelector('.cd-prog').textContent]")
        inp = pg.locator('.cd-inp').first
        first = await pg.evaluate("document.querySelector('.cd-inp').getAttribute('aria-label')")
        await inp.fill('void KEY_Init(int);'); await inp.press('Enter'); await pg.wait_for_timeout(150)
        wrong = await pg.evaluate("document.querySelectorAll('.cd-bad').length == 1 && document.querySelector('.cd-bad .cd-msg').textContent.length > 0")
        await inp.fill(await pg.evaluate("(() => { const L = STM.codederive.data.CD.exti; for (const st of L.steps) for (const f of L.files) for (const l of f.lines) if (l[3] === st.id && STM.codederive.data.blankable(l[0])) return l[0].trim(); })()")); await inp.press('Enter'); await pg.wait_for_timeout(150)
        n1 = await pg.evaluate("[document.querySelectorAll('.cd-inp').length, document.querySelectorAll('.cd-ok').length, document.querySelector('.cd-prog').textContent, document.activeElement.classList.contains('cd-inp')]")
        await pg.click('.cd-blank.act button:has-text("答案")'); await pg.wait_for_timeout(100)
        await pg.reload(); await pg.wait_for_selector('.cd-modes'); await pg.wait_for_timeout(300)
        n2 = await pg.evaluate("[document.querySelector('.cd-mb.on').textContent, document.querySelectorAll('.cd-ok').length, document.querySelectorAll('.cd-shown').length, document.querySelector('.cd-prog').textContent]")
        check('自己写（EXTI）：写错提示、写对露出代码并跳到下一行、刷新后进度还在', n0[0] >= 20 and n0[1] == '0 / %d' % n0[0] and wrong and n1[:3] == [n0[0] - 1, 1, '1 / %d' % n0[0]] and n1[3] and n2 == ['自己写', 1, 1, '2 / %d' % n0[0]], [n0, wrong, n1, n2])
        await pg.click('.cd-reset'); await pg.wait_for_timeout(100)
        await pg.click('.cd-mb:has-text("看推导")'); await pg.wait_for_timeout(100)
        check('重来清空进度；切回看推导没有输入框', await pg.evaluate("document.querySelectorAll('.cd-inp').length == 0 && !(JSON.parse(localStorage.getItem('lm.stm32.cdself') || '{}').exti)"))
        await pg.evaluate("localStorage.removeItem('lm.stm32.codestyle')")
        bad = []
        for chap in [c for c in CHAPS if c not in ('gpio', 'tim')] + ['sys', 'fsmc']:
            await pg.goto(TOOL + '?v=topic&t=' + chap + '&sec=code&cv=cd'); await pg.wait_for_selector('.code-cd .cd-step')
            n = await pg.evaluate("[document.querySelectorAll('.code-cd .cd-step').length, document.querySelectorAll('.code-reg .ftab').length, document.querySelectorAll('.code-cd .rc-l.has').length, document.querySelector('.code-cd').hidden]")
            if n[0] < 7 or n[1] < 3 or n[2] < 6 or n[3]: bad.append((chap, n))
        await pg.goto(TOOL + '?v=topic&t=gpio&sec=code&cv=cd'); await pg.wait_for_timeout(500)
        gp = await pg.evaluate("[document.querySelectorAll('.code-reg .ftab').length, (document.querySelector('.code-cd .thinkin b') || {}).textContent, (document.querySelector('.code-cd .thinkin') || {}).getAttribute && document.querySelector('.code-cd .thinkin').getAttribute('href')]")
        check('八个外设的代码页有完整文件和代码推导；GPIO、定时器的代码推导并进了编程思维，这里只留入口', not bad and gp[0] == 3 and gp[1] == '编程思维' and 'v=lab' in (gp[2] or ''), [bad, gp])
        bad = []
        for t, want, cx, files in [('i2c', ['软件 I2C', '硬件 I2C'], 'i2chw', 'i2c2.c'), ('tim', ['节拍 + PWM', '输入捕获', 'N 个脉冲'], 'timpulse', 'pulse.c'), ('adc', ['单通道', '多通道 + DMA'], 'adcdma', 'adc_dma.c')]:
            await pg.goto(TOOL + '?v=topic&t=' + t + '&sec=code&cv=reg'); await pg.wait_for_selector('.cd-vars')
            got = await pg.evaluate("[...document.querySelectorAll('.cd-var')].map(b => b.textContent)")
            await pg.click('.cd-var:has-text("%s")' % want[-1]); await pg.wait_for_timeout(500)
            ft = await pg.evaluate("[...document.querySelectorAll('.ftab')].map(b => b.textContent)")
            if got != want or ('cx=' + (cx if t != 'tim' else 'timpulse')) not in pg.url or files not in ft: bad.append((t, got, pg.url, ft))
        check('I2C / TIM / ADC：课件的另外几个案例可以切换（硬件 I2C、输入捕获、N 个脉冲、多通道 + DMA）', not bad, bad)
        cd = await pg.evaluate("STM.codederive.data.CD.gpio.files.map(f => f.name)")
        check('GPIO：led.h / led.c / main.c', cd == ['led.h', 'led.c', 'main.c'], cd)
        bad = []
        for old, want in [('?v=think&t=gpio&s=code', 'v=topic&t=gpio&sec=code&cv=cd'), ('?v=think&t=fsmc', 'v=topic&t=fsmc&sec=code&cv=cd'), ('?v=think&t=sys', 'v=topic&t=sys&sec=code&cv=cd')]:
            await pg.goto(TOOL + old); await pg.wait_for_selector('.topic'); await pg.wait_for_timeout(300)
            if not pg.url.endswith(want): bad.append((old, pg.url))
        check('旧的代码推导链接转到外设页的代码推导', not bad, bad)
        txt = await pg.evaluate("STM.codederive.fileText(STM.codederive.data.CD.gpio.files[0])")
        check('led.h 带头文件保护和函数声明', '#ifndef __LED_H' in txt and 'void LED_On(uint8_t n);' in txt and '#endif' in txt, txt[:60])
        await pg.goto(TOOL + '?v=think&t=gpio&hv=why'); await pg.wait_for_selector('.dv-mode.enter')
        check('章节首页没有代码推导入口', not await pg.evaluate("!!document.querySelector('.dv-codein')"))
        await pg.click('.dv-modeb >> nth=1'); await pg.wait_for_selector('.dv-step')
        check('章节首页：点「自主推导」直接进推导', 's=s' in pg.url and await pg.evaluate("JSON.parse(localStorage.getItem('lm.stm32.derive')).mode") == 'self', pg.url)
        await pg.evaluate("(() => { const o = JSON.parse(localStorage.getItem('lm.stm32.derive')); o.mode = 'full'; localStorage.setItem('lm.stm32.derive', JSON.stringify(o)); })()")
        side = await pg.evaluate("[...document.querySelectorAll('.nav-i')].map(a => a.textContent)")
        check('侧栏：首页、开发板、编程思维、硬件原理', side == ['首页', '开发板', '编程思维', '硬件原理'], side)
        txt = await pg.evaluate("STM.codederive.fileText(STM.codederive.data.CD.gpio.files[1])")
        check('复制出来的代码带注释', '// ' in txt and 'GPIO' in txt, txt[:80])
        await pg.context.close()
        pg = await page(b, 390, 844, mobile=True)
        overflow = []
        pages = ['?v=topic&t=' + c + '&sec=code&cv=' + k for c in CHAPS + ['sys', 'fsmc'] for k in ['reg', 'cd']] + ['?v=topic&t=fsmc', '', '?m=lcd', '?m=beep&mp=g', '?m=led', '?m=eeprom&mp=p6', '?v=think'] + ['?v=think&t=' + c for c in CHAPS] + ['?v=think&t=i2c&s=s3', '?v=think&t=i2c&s=s6', '?v=think&t=i2c&s=s12', '?v=think&t=i2c&s=s14', '?v=think&t=i2c&s=s19', '?v=think&t=i2c&s=s21',
                 '?v=think&t=gpio&s=s13', '?v=think&t=usart&s=s11', '?v=think&t=tim&s=s11', '?v=think&t=adc&s=s11', '?v=think&t=spi&s=s11', '?v=think&t=i2c&s=review']
        for qs in pages:
            await pg.goto(TOOL + qs); await pg.wait_for_timeout(600)
            if await pg.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"): overflow.append(qs)
        check('手机：%d 个页面没有横向溢出' % len(pages), not overflow, overflow)
        clipped = []
        for qs in ['?v=topic&t=' + c + '&sec=code&cv=' + k for c in CHAPS + ['sys', 'fsmc'] for k in ['reg', 'hal', 'cd']]:
            await pg.goto(TOOL + qs); await pg.wait_for_timeout(600)
            n = await pg.evaluate("Array.from(document.querySelectorAll('.rc-c, .rc-cm, .rc-sig')).filter(c => c.getClientRects().length && (c.scrollWidth > c.clientWidth + 1 || c.closest('.rc-code').scrollWidth > c.closest('.rc-code').clientWidth + 1)).length")
            if n: clipped.append((qs, n))
        check('手机：代码长行折行，没有被截掉的行', not clipped, clipped)
        await pg.context.close()

        # ---------- 11. 编程思维 · I2C 推导链：自主推导模式把 22 环的每一道题都答一遍 ----------
        pg = await page(b)
        await pg.goto(TOOL + '?v=think&t=i2c'); await pg.wait_for_selector('.dv-map')
        check('I2C 推导章首页：推导链 22 环、7 条主干结论、两种学法', await pg.evaluate("document.querySelectorAll('.dv-node').length") == 22 and await pg.evaluate("document.querySelectorAll('.dv-factl li').length") == 7 and await pg.evaluate("document.querySelectorAll('.dv-modeb').length") == 2)
        await pg.click('.dv-modeb >> nth=1'); await pg.wait_for_selector('.dv-step')
        await pg.goto(TOOL + '?v=think&t=i2c'); await pg.wait_for_selector('.dv-map')
        check('切到自主推导：结论在推出来之前隐藏', await pg.evaluate("document.querySelectorAll('.dv-node-g').length") == 0 and await pg.evaluate("document.querySelectorAll('.dv-factl li.locked').length") == 7)
        ANSWER = """async ([chid, id]) => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const ch = STM32_DERIVE[chid], C = STM32DeriveCore, a = C.allAsks(ch)[id];
          const box = document.querySelector('.dv-ask[data-ask="' + id + '"]');
          const fbText = () => (box.querySelector('.dv-fb') || {}).textContent || '';
          const r = { id, type: a.type, wrongOk: true, solved: false };
          if (a.type === 'choice') {
            const btns = [...box.querySelectorAll('.dv-opt')];
            const find = (t) => btns.find(b => b.textContent.replace(/\\s/g, '') === t.replace(/\\*\\*|`|\\[\\[s\\d+\\]\\]|\\{F\\d\\}/g, (m) => m.startsWith('[[') ? '问题' + (C.stepById(ch)[m.slice(2, -2)]._i + 1) : m.startsWith('{') ? m.slice(1, -1) : '').replace(/\\s/g, ''));
            const wrong = a.opts.find(o => !o.ok), right = a.opts.find(o => o.ok);
            if (wrong) { const wb = find(wrong.t); wb.click(); await sleep(30); const t = fbText(); r.wrongOk = t.includes('你默认了') && t.includes(wrong.assume) && t.includes('反例') && !!box.querySelector('.fb-back'); }
            find(right.t).click();
          } else if (a.type === 'fill') {
            const inp = box.querySelector('.dv-fill input'), go = box.querySelector('.dv-fill .pill');
            inp.value = 'zzz'; go.click(); await sleep(30); r.wrongOk = fbText().includes('提示');
            inp.value = a.answers[0]; go.click();
          } else if (a.type === 'explain') {
            const ta = box.querySelector('textarea'); ta.value = '因为大家都松手了，上拉电阻把线拉到 VCC'; box.querySelector('.dv-row .pill').click(); await sleep(30);
            r.wrongOk = box.querySelectorAll('.dv-pt input:checked').length >= 1 && !!box.querySelector('.dv-model');
            [...box.querySelectorAll('.dv-explain .pill')].pop().click();
          } else if (a.type === 'order') {
            const it = C.orderItems(ch, a), want = it.texts;
            const norm = (s) => s.replace(/\\s+/g, '');
            const pick = (t) => { const c = [...box.querySelectorAll('.dv-opool .dv-chip')].find(b => norm(b.textContent) === norm(t)); c.click(); };
            [...want].reverse().forEach(pick); box.querySelector('.dv-row .pill').click(); await sleep(30);
            r.wrongOk = fbText().includes('先后不对') && box.querySelectorAll('.dv-chip.bad').length === 2;
            if (a.fn) r.wrongOk = r.wrongOk && !!box.querySelector('.dv-osim .dv-simres');
            [...box.querySelectorAll('.dv-oans .dv-chip')].reverse().forEach(b => b.click());
            want.forEach(pick); box.querySelector('.dv-row .pill').click();
          }
          await sleep(40);
          r.solved = box.classList.contains('solved');
          return r;
        }"""
        async def walk(chid, n):
            total = {'asks': 0, 'wrongOk': 0, 'solved': 0, 'gated': 0}
            bad = []
            for k in range(1, n + 1):
                await pg.goto(TOOL + '?v=think&t=%s&s=s%d' % (chid, k)); await pg.wait_for_selector('.dv-step')
                for _ in range(10):
                    cur = await pg.evaluate("(() => { const b = [...document.querySelectorAll('.dv-ask:not(.soft):not(.solved)')]; return b.length ? b[0].dataset.ask : null; })()")
                    if not cur: break
                    gated = await pg.evaluate("!document.querySelector('.dv-gist')")
                    r = await pg.evaluate(ANSWER, [chid, cur])
                    total['asks'] += 1; total['wrongOk'] += r['wrongOk']; total['solved'] += r['solved']; total['gated'] += gated
                    if not (r['wrongOk'] and r['solved']): bad.append(r)
                    cont = await pg.query_selector('.dv-cont')
                    if cont: await cont.click(); await pg.wait_for_timeout(60)
                if not await pg.evaluate("!!document.querySelector('.dv-gist')"): bad.append('s%d 没走到结论' % k)
            return total, bad
        total, bad = await walk('i2c', 22)
        check('I2C 自主推导：%d 道题逐一停下（答完才继续），错答都指出「默认了什么 + 反例 + 回看哪一环」，最后都答对' % total['asks'], total['asks'] >= 30 and not bad and total['gated'] == total['asks'], bad[:3] or total)
        for chid in ['gpio', 'usart', 'tim', 'adc', 'spi']:
            n = await pg.evaluate("(id) => STM32_DERIVE[id].steps.length", chid)
            total, bad = await walk(chid, n)
            check('%s 自主推导：%d 环 %d 道题逐一停下、错答有针对的反馈、全部答对' % (chid.upper(), n, total['asks']), total['asks'] >= 12 and not bad and total['gated'] == total['asks'], bad[:3] or total)
        await pg.goto(TOOL + '?v=think&t=i2c'); await pg.wait_for_selector('.dv-map')
        check('22 环都标记为推完，主干结论全部解锁', await pg.evaluate("document.querySelectorAll('.dv-node.done').length") == 22 and await pg.evaluate("document.querySelectorAll('.dv-factl li.locked').length") == 0)
        check('首页出现「常卡的地方」入口', await pg.evaluate("!!document.querySelector('.dv-revin')"))
        await pg.click('.dv-revin'); await pg.wait_for_selector('.dv-rv')
        nrv = await pg.evaluate("document.querySelectorAll('.dv-rv').length"); roots = await pg.evaluate("document.querySelectorAll('.dv-roots li').length")
        check('常卡的地方：按推理环节归类，列出最常出岔子的环节和上次的错误想法', nrv >= 10 and roots >= 1 and await pg.evaluate("!!document.querySelector('.dv-rv-w li')"), (nrv, roots))
        rid = await pg.evaluate("document.querySelector('.dv-rv .dv-ask-choice').dataset.ask")
        right = await pg.evaluate("(id) => { const a = STM32DeriveCore.allAsks(STM32_DERIVE.i2c)[id.split('~')[0]]; return a.opts.findIndex(o => o.ok); }", rid)
        await pg.evaluate("""([id, k]) => { const box = document.querySelector('.dv-ask[data-ask="' + id + '"]'); const a = STM32DeriveCore.allAsks(STM32_DERIVE.i2c)[id.split('~')[0]];
          const norm = s => s.replace(/\\*\\*|`/g, '').replace(/\\s/g, ''); [...box.querySelectorAll('.dv-opt')].find(b => norm(b.textContent) === norm(a.opts[k].t)).click(); }""", [rid, right])
        await pg.wait_for_timeout(100)
        st = await pg.evaluate("(id) => { const s = JSON.parse(localStorage.getItem('lm.stm32.derive')).ch.i2c.stuck; return [s.streak[id], s.due[id] > Date.now()]; }", rid.split('~')[0])
        check('复习答对一次：间隔拉长到明天', st[0] == 1 and st[1], st)

        # 完整推导模式：交换代码行、模拟器、小部件
        await pg.goto(TOOL + '?v=think&t=i2c'); await pg.click('.dv-modeb >> nth=0')
        await pg.goto(TOOL + '?v=think&t=i2c&s=s19'); await pg.wait_for_selector('.dv-fn')
        check('完整推导：整段推理一次展开，题目可选（虚线框）', await pg.evaluate("document.querySelectorAll('.dv-ask.soft').length >= 2 && !!document.querySelector('.dv-gist')"))
        fn = '.dv-fn >> nth=1'   # i2c_stop
        await pg.click('.dv-fn >> nth=1 >> .dv-line.has .dv-lb >> nth=0')
        check('点一行看理由和出处', await pg.evaluate("(() => { const l = document.querySelectorAll('.dv-fn')[1].querySelector('.dv-line.open .dv-lwhy'); return !!l && !l.hidden && !!l.querySelector('.dv-fc, .dv-sl'); })()"))
        await pg.click(fn + ' >> .dv-fn-tools .pill')
        await pg.evaluate("""(() => { const f = document.querySelectorAll('.dv-fn')[1]; const ls = [...f.querySelectorAll('.dv-line.has .dv-lb')].filter(b => !b.closest('.pre'));
          const t = (s) => ls.find(b => b.textContent.replace(/\\s|ⓘ/g, '') === s); t('SDA_L();').click(); t('SCL_H();').click(); })()""")
        await pg.wait_for_selector('.dv-swap .dv-wave')
        sw = await pg.inner_text('.dv-fn >> nth=1 >> .dv-swap')
        check('交换停止函数前两步（课件写法）：说出原因并在模拟里看到「重复起始 + 空报文」', '不能换' in sw and '空报文' in sw, sw[:120])
        await pg.goto(TOOL + '?v=think&t=i2c&s=s21'); await pg.wait_for_selector('.dv-simctl')
        p0 = await pg.inner_text('.dv-simctl ~ div .dv-simfacts')
        await pg.click('.dv-simctl .dv-sw input'); await pg.wait_for_timeout(100)
        p1 = await pg.inner_text('.dv-simctl ~ div .dv-simfacts')
        check('写一个字节的模拟：拔掉 EEPROM 后返回 1', '返回 0' in p0 and '0x5A' in p0 and '返回 1' in p1, (p0, p1))
        await pg.goto(TOOL + '?v=think&t=i2c&s=s3'); await pg.wait_for_selector('.dv-bus')
        v0 = await pg.inner_text('.dv-busv-t'); await pg.click('.dv-dev >> nth=0'); v1 = await pg.inner_text('.dv-busv-t')
        check('共线实验：推挽一高一低报短路，改成同电平就没有冲突', '短路' in v0 and '没有冲突' in v1, (v0[:30], v1[:30]))
        await pg.goto(TOOL + '?v=think&t=i2c&s=s6'); await pg.wait_for_selector('.dv-rc')
        await pg.evaluate("(() => { const r = document.querySelector('.dv-rcc input'); r.value = 13; r.dispatchEvent(new Event('input')); })()")
        rc = await pg.inner_text('.dv-rcr')
        check('上拉实验：100 kΩ 时上升时间超标', '超过标准模式' in rc, rc[:80])
        await pg.goto(TOOL + '?v=think&t=i2c&s=s12'); await pg.wait_for_selector('.dv-addr')
        await pg.click('.dv-bit.epin >> nth=2'); ad = await pg.inner_text('.dv-addro')
        check('地址字节：E0 接 VCC 变成 0xA2，板上 EEPROM 不应答', '0xA2' in ad and '对不上' in ad, ad[:60])
        await pg.goto(TOOL + '?v=think&t=i2c&s=s14'); await pg.wait_for_selector('.dv-page')
        check('页回卷：从 0x0E 写 4 个，后两个落回 0x00、0x01', await pg.evaluate("[...document.querySelectorAll('.dv-gc.wrap')].length") == 2)
        # 通用单片机模拟器的小部件
        await pg.goto(TOOL + '?v=think&t=usart&s=s11'); await pg.wait_for_selector('.dv-term')
        check('USART：模拟器里电脑收到 hello', await pg.evaluate("[...document.querySelectorAll('.dv-term')].some(t => t.textContent.includes('hello'))"))
        await pg.goto(TOOL + '?v=think&t=gpio&s=s12'); await pg.wait_for_selector('.dv-fn')
        await pg.click('.dv-fn >> nth=0 >> .dv-fn-tools .pill')
        await pg.evaluate("""(() => { const f = document.querySelectorAll('.dv-fn')[0]; const ls = [...f.querySelectorAll('.dv-line.has .dv-lb')].filter(b => !b.closest('.pre'));
          ls[0].click(); ls[2].click(); })()""")
        await pg.wait_for_selector('.dv-swap .dv-simres')
        sw = await pg.inner_text('.dv-fn >> nth=0 >> .dv-swap')
        check('GPIO：交换「开时钟」和「清 CRL」→ 说出原因，模拟里 LED1 不再亮', '不能换' in sw and '时钟' in sw, sw[:160])
        await pg.goto(TOOL + '?v=think&t=tim&s=s10'); await pg.wait_for_selector('.dv-lamp')
        check('定时器：模拟结果里有 LED 灯和波形', await pg.evaluate("!!document.querySelector('.dv-sim .dv-lamp') && !!document.querySelector('.dv-sim .dv-wave, .dv-sim svg')"))
        await pg.goto(TOOL + '?v=think&t=adc&s=s11'); await pg.wait_for_selector('.dv-simctl input[type=range]')
        await pg.evaluate("(() => { const r = document.querySelector('.dv-simctl input[type=range]'); r.value = 100; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()")
        await pg.wait_for_timeout(200)
        adc = await pg.evaluate("document.querySelector('.dv-simctl').closest('.dv-sim').querySelector('.dv-term').textContent")
        import re as _re
        m = _re.search(r'ADC =\s*(\d+)', adc)
        check('ADC：电位器拧到 1.00 V，读数约 1241', bool(m) and abs(int(m.group(1)) - 1241) <= 12, adc[:80])
        await pg.goto(TOOL + '?v=think&t=spi&s=s11'); await pg.wait_for_selector('.dv-term')
        check('SPI：模拟器读出 W25Q32 的 ID EF4016', await pg.evaluate("[...document.querySelectorAll('.dv-term')].some(t => t.textContent.includes('EF4016'))"))
        await pg.goto(TOOL + '?v=topic&t=i2c'); await pg.wait_for_selector('.thinkin')
        th = await pg.inner_text('.thinkin')
        check('I2C 资料页的入口显示推导进度', '22 / 22' in th or '复习' in th, th)
        await pg.goto(TOOL + '?v=think&t=i2c&s=s99'); await pg.wait_for_selector('.dv-map')
        check('不存在的环节回到章节首页', 's=' not in pg.url.split('?')[-1] or 's=s99' not in pg.url)
        await pg.context.close()
        for theme in ['dark']:
            pg = await page(b, theme=theme)
            await pg.goto(TOOL + '?v=think&t=i2c&s=s10'); await pg.wait_for_selector('.dv-wave')
            await pg.screenshot(path='/tmp/stm32-derive-%s.png' % theme)
            await pg.context.close()

        # ---------- 12. 工具箱首页：分类、继续上次、小芯 ----------
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(BASE + '/')
        await pg.evaluate("localStorage.setItem('lm.shell.recent', JSON.stringify(['stm32'])); localStorage.setItem('lm.shell.stm32', 'v=topic&t=i2c&sec=code&cv=cd')")
        await pg.reload(); await pg.wait_for_timeout(1500)
        cats = await pg.evaluate("[...document.querySelectorAll('.cat-h')].map(h => h.textContent)")
        check('首页按分类排：学习 / 工具', cats == ['学习', '工具'], cats)
        hero = await pg.evaluate("(() => { const c = document.querySelector('.card.hero'); return c && [c.dataset.id, c.querySelector('.go').textContent]; })()")
        check('最近用过的 STM32 放大，写着上次看到哪', hero == ['stm32', 'I2C 代码推导'], hero)
        ids = await pg.evaluate("[...document.querySelectorAll('.card[data-id]')].map(c => c.dataset.id)")
        check('首页没有互传和协作中心', 'transfer' not in ids and 'hub' not in ids, ids)
        check('小芯落在标题栏里', await pg.evaluate("LimingXin.mode") == 'idle')
        await pg.evaluate("LimingXin.cmd('normal')")
        await pg.wait_for_function("document.querySelector('.xin svg').dataset.face === 'eyes'")
        normal = await pg.evaluate("[...document.querySelectorAll('.xin .c-ew')].map(e => [+e.getAttribute('width'), +e.getAttribute('height')])")
        check('小芯常态使用图中的专注竖矩形眼，不是微笑', len(normal) == 2 and normal == [[1.5, 2.65], [1.5, 2.65]], normal)
        hands = await pg.evaluate("""(() => {
          const arms = svg => [...svg.querySelectorAll('rect')].filter(e => (e.getAttribute('fill') || '').includes('-pin)') && (+e.getAttribute('x') < 4 || +e.getAttribute('x') >= 16))
            .map(e => ['x', 'y', 'width', 'height'].map(a => +e.getAttribute(a)));
          const avatar = document.createElement('div'); avatar.innerHTML = LimingXin.portrait();
          return [arms(LimingXin.el.querySelector('svg')), arms(avatar.querySelector('svg'))];
        })()""")
        check('常态和聊天头像的双手对称平伸，没有固定举手', all(len(a) == 2 and a[0][1:] == a[1][1:] and a[0][2] > a[0][3] and a[0][0] + a[0][2] + a[1][0] == 20 for a in hands), hands)
        expressions, cheeks = [], []
        for cmd, face in [('smile', 'smile'), ('focus', 'focus'), ('happy', 'hap'), ('calm', 'calm'), ('wow', 'wow'), ('love', 'love')]:
            await pg.evaluate('cmd => LimingXin.cmd(cmd)', cmd)
            await pg.wait_for_function('face => document.querySelector(".xin svg").dataset.face === face', arg=face)
            pixels = await pg.evaluate("[...document.querySelectorAll('.xin .c-ew')].map(e => ['x','y','width','height'].map(a => e.getAttribute(a)))")
            expressions.append(json.dumps(pixels))
            cheeks.append(await pg.locator('.xin .c-rose').count())
        check('六种参考表情都能实际触发，而且图案各不相同', len(set(expressions)) == 6)
        check('腮红只在微笑、开心和喜欢时出现', cheeks == [4, 0, 4, 0, 0, 4], cheeks)
        await pg.evaluate("LimingXin.cmd('normal'); LimingXin.feel('smile', 200)")
        await pg.wait_for_function("document.querySelector('.xin svg').dataset.face === 'smile'")
        await pg.wait_for_function("document.querySelector('.xin svg').dataset.face === 'eyes'")
        check('微笑结束后自动恢复睁眼常态', await pg.evaluate('LimingXin.mood') == '')
        check('恢复常态时同时收起腮红', await pg.locator('.xin .c-rose').count() == 0)
        await pg.evaluate("LimingXin.cmd('angry')")
        await pg.wait_for_function("document.querySelector('.xin svg').dataset.face === 'angry'")
        check('生气能实际触发新眉眼，面板没有腮红', await pg.locator('.xin .c-rose').count() == 0)
        await pg.evaluate("LimingXin.cmd('normal')")
        await pg.click('#searchBtn'); await pg.fill('#q', 'zzzz'); await pg.wait_for_timeout(100)
        check('搜不到时小芯难过', await pg.evaluate("LimingXin.mood") == 'sad' and await pg.is_visible('#empty'))
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        check('关掉搜索，小芯恢复', await pg.evaluate("LimingXin.mood") != 'sad')
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        c = await pg.evaluate("(() => { const r = document.querySelector('.card[data-id=map]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        cdp = await pg.context.new_cdp_session(pg)
        async def touch(kind, x=0, y=0):
            await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y}]})
        await touch('touchStart', *r)
        for i in range(1, 13):
            await touch('touchMove', r[0] + (c[0] - r[0]) * i / 12, r[1] + (c[1] - r[1]) * i / 12); await pg.wait_for_timeout(30)
        over = await pg.evaluate("[LimingXin.mode, (document.querySelector('.card.xin-over') || {dataset: {}}).dataset.id, scrollY]")
        check('手机：按住小芯拖到世界地图卡上，卡片亮起、页面不滚动', over == ['drag', 'map', 0], over)
        await touch('touchEnd'); await pg.wait_for_timeout(1200)
        check('松手打开世界地图', await pg.evaluate("location.pathname") == '/map' and await pg.evaluate("!!document.querySelector('#stage .panel.show')"))
        await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1400)
        check('回到首页，小芯掉回标题栏', await pg.evaluate("[location.pathname, LimingXin.mode]") == ['/', 'idle'])
        kinds = await pg.evaluate("LimingXin.plats().map(p => p.kind)")
        check('首页能站的地方：标题栏 + 每张卡片的上沿和里面', kinds.count('ground') == 1 and kinds.count('top') == 2 and kinds.count('in') == 2, kinds)
        i_in = kinds.index('in')
        await pg.evaluate("LimingXin.hop(%d)" % i_in); await pg.wait_for_timeout(1500)
        check('小芯能跳进卡片里，落地后站在里面', await pg.evaluate("[LimingXin.mode, LimingXin.plat && LimingXin.plat.kind]") == ['idle', 'in'])
        await pg.evaluate("LimingXin.hop(0)"); await pg.wait_for_timeout(1500)
        check('再跳回标题栏', await pg.evaluate("[LimingXin.mode, LimingXin.plat && LimingXin.plat.kind]") == ['idle', 'ground'])

        # 正常点开 STM32：学习台里没有小芯；关掉以后首页的小芯还在原地
        before = await pg.evaluate("LimingXin.el.style.transform")
        await pg.click('.card[data-id=stm32]', position={'x': 20, 'y': 20}); f = await tool_frame(pg); await pg.wait_for_timeout(1200)
        check('正常打开学习台：里面没有小芯', await f.evaluate("LimingXin.mode") == 'away')
        await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1500)
        while await pg.evaluate("!!document.querySelector('.panel.show .back')"):
            await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1500)
        check('关掉学习台：首页小芯还在原来的地方', await pg.evaluate("[LimingXin.mode, LimingXin.el.style.transform]") == ['idle', before], before)

        # 把小芯拖到 STM32 卡片上扔进去：学习台里出现小芯；关掉以后它跳回首页
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        c = await pg.evaluate("(() => { const r = document.querySelector('.card[data-id=stm32]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        await touch('touchStart', *r)
        for i in range(1, 13):
            await touch('touchMove', r[0] + (c[0] - r[0]) * i / 12, r[1] + (c[1] - r[1]) * i / 12); await pg.wait_for_timeout(30)
        await touch('touchEnd'); f = await tool_frame(pg); await pg.wait_for_timeout(1200)
        for _ in range(40):
            if await f.evaluate("LimingXin.mode") not in ('away', 'rope', 'fly'): break
            await pg.wait_for_timeout(100)
        inside = await f.evaluate("[LimingXin.mode, !!LimingXin.plat]")
        check('扔进 STM32 卡片：小芯出现在学习台里', inside[1] and inside[0] in ('idle', 'walk', 'play'), inside)
        # 学习台里从背包「收起来」：小芯回去歇着，右边探出小脑袋；刷新学习台也还收着；点小脑袋它跳回来
        peek_st = "[LimingXin.mode, LimingXin.hidden, !!document.querySelector('.xin-peek') && !document.querySelector('.xin-peek').hidden, document.documentElement.scrollWidth <= innerWidth]"
        items = await f.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent))")
        await f.click('.xin-bag .xin-it:has-text("收起来")'); await pg.wait_for_timeout(500)
        st = await f.evaluate(peek_st)
        check('学习台里背包有「收起来」：点了小芯不见了，右边探出小脑袋，页面不横向滚动', '收起来' in items and st == ['away', True, True, True], (items, st))
        await f.evaluate("location.reload()"); await pg.wait_for_timeout(600); f = await tool_frame(pg); await pg.wait_for_timeout(800)
        st = await f.evaluate(peek_st)
        check('刷新学习台：小芯还收着，小脑袋还在', st == ['away', True, True, True], st)
        await f.click('.xin-peek')
        for _ in range(40):
            if await f.evaluate("LimingXin.mode") in ('idle', 'walk', 'play'): break
            await pg.wait_for_timeout(100)
        st = await f.evaluate(peek_st)
        check('点小脑袋：小芯跳回学习台，小脑袋收起', st[0] in ('idle', 'walk', 'play') and st[1:3] == [False, False], st)
        await f.evaluate("LimingXin.hide()"); await pg.wait_for_timeout(300)
        await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1500)
        while await pg.evaluate("!!document.querySelector('.panel.show .back')"):
            await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1500)
        out = await pg.evaluate("[LimingXin.mode, LimingXin.plat && LimingXin.plat.kind, sessionStorage.getItem('lm.xin.in')]")
        check('关掉学习台：小芯跳回首页标题栏，学习台里的歇着', out == ['idle', 'ground', None] and await f.evaluate("LimingXin.mode") == 'away', out)
        check('小芯脚下没有影子横线', await pg.evaluate("!document.querySelector('.xin-sh')"))
        # 背包：长按打开，喂饼干、戴耳机、收起来再用 ✻ 叫回来
        await pg.wait_for_timeout(1500)
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        await touch('touchStart', *r); await pg.wait_for_timeout(700); await touch('touchEnd'); await pg.wait_for_timeout(200)
        items = await pg.evaluate("[...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent)")
        check('长按小芯打开小背包', items[:5] == ['饼干', '电池', '小球', 'LED', '耳机'] and '收起来' in items, items)
        await pg.click('.xin-bag .xin-it:has-text("饼干")'); await pg.wait_for_timeout(400)
        for _ in range(20):   # 正在半空时会等落地再吃
            if await pg.evaluate("LimingXin.mode") == 'play': break
            await pg.wait_for_timeout(100)
        check('从背包喂饼干：小芯抱着饼干吃', await pg.evaluate("LimingXin.mode") == 'play' and not await pg.evaluate("!!document.querySelector('.xin-bag')"))
        await pg.wait_for_timeout(4500)
        await pg.evaluate("LimingXin.bag()"); await pg.click('.xin-bag .xin-it:has-text("耳机")'); await pg.wait_for_timeout(300)
        check('戴上耳机：头上有耳机', await pg.evaluate("!!LimingXin.el.querySelector('rect.c-hp')"))
        await pg.evaluate("LimingXin.bag()")
        check('戴着耳机时背包里是「摘耳机」', await pg.evaluate("[...document.querySelectorAll('.xin-bag .xin-it span')].some(s => s.textContent === '摘耳机')"))
        await pg.click('.xin-bag .xin-it:has-text("收起来")'); await pg.wait_for_timeout(300)
        check('收起来：小芯不见了，✻ 可以点', await pg.evaluate("[LimingXin.mode, document.querySelector('.hd .spark').classList.contains('xin-call')]") == ['away', True])
        await pg.click('.hd .spark'); await pg.wait_for_timeout(2200)
        check('点 ✻：小芯顺着线降下来', await pg.evaluate("[LimingXin.mode, document.querySelector('.hd .spark').classList.contains('xin-call')]") == ['idle', False])
        # 扔到最下面空白处：下面没有落脚点，射线吊住，再爬上去
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        await touch('touchStart', *r)
        for i in range(1, 13):
            await touch('touchMove', r[0], r[1] + (760 - r[1]) * i / 12); await pg.wait_for_timeout(30)
        await touch('touchEnd'); await pg.wait_for_timeout(500)
        hang = await pg.evaluate("[LimingXin.mode, LimingXin.mood, getComputedStyle(document.querySelector('.xin-thread')).display]")
        check('扔到下面没有落脚点：射一根线吊住，吓得发抖', hang == ['hang', 'scared', 'block'], hang)
        await pg.wait_for_timeout(5000)
        check('顺着线爬上去，再跳回能站的地方', await pg.evaluate("[LimingXin.mode, !!LimingXin.plat]") == ['idle', True])
        await pg.context.close()

        # 电脑：右键打开背包；让它睡以后鼠标在旁边晃、点别处都不吵醒它，点它才醒；玩灯时表情不跟着灯来回变
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(2500)
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        await pg.mouse.click(r[0], r[1], button='right'); await pg.wait_for_timeout(200)
        check('电脑：右键小芯打开小背包', await pg.evaluate("!!document.querySelector('.xin-bag')"))
        await pg.click('.xin-bag .xin-it:has-text("睡觉")'); await pg.wait_for_timeout(200)
        for i in range(15):
            await pg.mouse.move(r[0] + 120 * ((i % 5) - 2), r[1] + 50 * ((i % 3) - 1)); await pg.wait_for_timeout(50)
        await pg.mouse.click(1100, 700); await pg.wait_for_timeout(300)
        check('电脑：睡着以后鼠标在旁边晃、点别处都不会吵醒它', await pg.evaluate("LimingXin.mode") == 'sleep')
        await pg.mouse.click(r[0], r[1]); await pg.wait_for_timeout(200)
        check('电脑：点它才醒', await pg.evaluate("LimingXin.mode") != 'sleep')
        faces = await pg.evaluate("LimingXin.frames('led').map(f => f.face || '')")
        hap = [i for i, f in enumerate(faces) if f == 'hap']
        check('玩灯：一直盯着灯看，最后才笑一下（表情不来回切）', len(hap) == 1 and all(f in ('', 'eyes') for f in faces[:hap[0]]), faces)
        await pg.context.close()

        # 电脑：抓着头拖，鼠标停在卡片上沿外面、身子挂在卡片里，也能扔进去
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.evaluate("sessionStorage.clear()"); await pg.wait_for_timeout(2500)
        r = await pg.evaluate("""(() => { const r = LimingXin.el.getBoundingClientRect(), cx = r.x + r.width / 2;
          for (let yy = r.y; yy < r.bottom; yy++) { const e = document.elementFromPoint(cx, yy); if (e && LimingXin.el.contains(e)) return [cx, yy + 2]; }
          return [cx, r.y + r.height / 2]; })()""")
        c = await pg.evaluate("(() => { const r = document.querySelector('.card[data-id=stm32]').getBoundingClientRect(); return [r.x + r.width / 2, r.y]; })()")
        await pg.mouse.move(r[0], r[1]); await pg.mouse.down(); await pg.mouse.move(c[0], c[1] - 6, steps=6); await pg.mouse.up()
        await pg.wait_for_timeout(1200)
        check('电脑：抓着头拖、身子在学习台卡片上，松手就进去', await pg.evaluate("document.body.classList.contains('tool-open')"))
        await pg.context.close()

        # 新动作：听烦了砸耳机、敲代码砸电脑、荡秋千、跳舞、不听话
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(2600)
        await pg.evaluate("LimingXin.music(true)"); await pg.wait_for_timeout(300)
        await pg.evaluate("LimingXin.bore(); LimingXin.rage('phones')"); await pg.wait_for_timeout(3800)
        st = await pg.evaluate("[!!document.querySelector('.xin-k') || true, LimingXin.el.querySelector('rect.c-hp') === null]")
        check('听歌听烦了：把耳机扯下来砸了（耳机没了）', st[1], st)
        await pg.wait_for_timeout(5000)
        await pg.evaluate("LimingXin.bag()"); await pg.click('.xin-bag .xin-it:has-text("耳机")'); await pg.wait_for_timeout(300)
        check('刚砸完耳机再给它戴：不戴（摇头、吐舌头）', await pg.evaluate("LimingXin.el.querySelector('rect.c-hp') === null"))
        await pg.wait_for_timeout(3000)
        items = await pg.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it')].map(b => b.textContent))")
        check('背包里有敲代码、跳舞、秋千', all(k in items for k in ('敲代码', '跳舞', '秋千')), items)
        await pg.click('.xin-bag .xin-it:has-text("敲代码")'); await pg.wait_for_timeout(1500)
        check('敲代码：掏出笔记本', await pg.evaluate("!!LimingXin.el.querySelector('rect.c-lt')"))
        await pg.wait_for_timeout(16000)
        # 碎片可能只存在一瞬间，每 200 ms 看一次会漏：在页面里挂监听，记下出现过的最多碎片数
        await pg.evaluate("""window.__xinK = 0; new MutationObserver(() => { window.__xinK = Math.max(window.__xinK, document.querySelectorAll('.xin-k').length); })
          .observe(document.body, { childList: true, subtree: true })""")
        # 正在半空（刚起跳）时叫它敲代码：要等落地再敲，不能一落地就被掐掉（以前偶尔这样：笔记本没了也没砸）
        await pg.evaluate("(() => { const ps = LimingXin.plats(); LimingXin.hop(ps.findIndex(p => p.kind === 'top' && p.el.dataset.id === 'map')); })()"); await pg.wait_for_timeout(260)
        air = await pg.evaluate("LimingXin.mode")
        await pg.evaluate("LimingXin.code(true, 'smash')")
        pcs = []
        for i in range(90):
            await pg.wait_for_timeout(200)
            pcs.append(await pg.evaluate("[!!LimingXin.el.querySelector('rect.c-lt'), window.__xinK]"))
        check('写不出来气炸了：把电脑砸了（电脑碎成碎片）；半空中叫它也等落地再做', air == 'fly' and pcs[-1][1] > 0 and not pcs[-1][0], (air, pcs[-1]))
        await pg.wait_for_timeout(4000)
        await pg.evaluate("(() => { const ps = LimingXin.plats(); LimingXin.hop(ps.findIndex(p => p.kind === 'top' && p.el.dataset.id === 'map')); })()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("LimingXin.swing()")
        modes = []
        for i in range(40):
            await pg.wait_for_timeout(300); modes.append(await pg.evaluate("LimingXin.mode"))
        thr = await pg.evaluate("getComputedStyle(document.querySelector('.xin-thread')).display")
        check('荡秋千：吊着线来回荡，最后松手落到平台上', 'swing' in modes and modes[-1] in ('idle', 'walk', 'play', 'sleep') and thr == 'none', modes[::4])
        faces = await pg.evaluate("LimingXin.frames('dance').map(f => f.face)")
        check('跳舞：有转身（背过去）和笑', 'back' in faces and faces.count('hap') > 10)
        await pg.context.close()

        # 电脑：返回键旁边一直有「回工具箱」（学习台首页也有）；点了好几层，点它一下回到首页
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(1200)
        await pg.click('.card[data-id=stm32]'); f = await tool_frame(pg); await pg.wait_for_timeout(600)
        hb = "getComputedStyle(document.querySelector('.panel[data-id=stm32] .home-b')).display"
        h0 = await pg.evaluate(hb)
        await f.click('.nav-t[data-t="usart"]'); await pg.wait_for_timeout(400)
        await f.click('.nav-t[data-t="gpio"]'); await pg.wait_for_timeout(400)
        await f.click('.snav-i:has-text("寄存器")'); await pg.wait_for_timeout(400)
        h1 = await pg.evaluate(hb)
        await pg.click('.panel[data-id=stm32] .home-b'); await pg.wait_for_timeout(1200)
        st = await pg.evaluate("[document.body.classList.contains('tool-open'), location.pathname]")
        check('电脑：学习台首页就有「回工具箱」，点进几层后还在，点一下回到工具箱首页', h0 == 'grid' and h1 == 'grid' and st == [False, '/'], (h0, h1, st))
        await pg.click('.card[data-id=stm32]'); await pg.wait_for_timeout(1500)
        await pg.click('.panel[data-id=stm32] .back'); await pg.wait_for_timeout(1200)
        check('回工具箱以后再打开学习台：返回键一下关掉', await pg.evaluate("[document.body.classList.contains('tool-open'), location.pathname]") == [False, '/'])
        await pg.context.close()

        # 寄存器面板：左右联动、取值列表代替下拉框、没有「已改」字样、代码下面讲寄存器是干啥的；手机上位格子下面直接显示选中字段，底部露着代码
        pg = await page(b)
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_BSRR&i=GPIOA'); await pg.wait_for_selector('.sheet.on'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[document.querySelectorAll('.sheet .selctl, .sheet .switch').length, document.querySelectorAll('.fields .fvals').length > 10, !!document.querySelector('.sh-about p') && document.querySelector('.sh-about p').textContent.includes('BS')]")
        check('寄存器面板：字段下面没有下拉框 / 开关，改成取值列表；代码下面有「作用」', st[0] == 0 and st[1] and st[2], st)
        await pg.click('.fields .frow-h:has(b:text-is("BS1"))'); await pg.wait_for_timeout(200)
        check('点左边的字段：右边位格子里对应的位高亮', await pg.evaluate("[...document.querySelectorAll('.bit.pick')].map(n => n.dataset.f)") == ['BS1'])
        await pg.click('.bit[data-f="BS11"]'); await pg.wait_for_timeout(800)
        st = await pg.evaluate("""(() => { const row = document.querySelector('.fields .frow.pick'), r = row.getBoundingClientRect(), b = document.querySelector('.sh-body').getBoundingClientRect();
          return [row.querySelector('.frow-h b').textContent, r.top >= b.top && r.bottom <= b.bottom, getComputedStyle(row.querySelector('.frow-h b'), '::after').content, row.querySelector('.fv.on b').textContent]; })()""")
        check('点右边的位：左边滚到那个字段并选中，名字变色、不写「已改」，当前值标在列表里', st[0] == 'BS11' and st[1] and st[2] in ('none', 'normal', '') and st[3] == '1', st)
        # 宽屏：右边一栏自己能往下滑（代码、作用看得全），左边不跟着动
        rs = await pg.evaluate("""(() => { const R = document.querySelector('.sh-r'), L = document.querySelector('.sh-l'); const l0 = L.scrollTop;
          R.scrollTop = 9999; return [R.scrollHeight > R.clientHeight, R.scrollTop > 0, L.scrollTop === l0, getComputedStyle(R).overflowY]; })()""")
        check('电脑 / 平板：寄存器面板右边一栏能单独往下滑', rs[1] and rs[2] and rs[3] == 'auto', rs)
        await pg.context.close()
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL&i=GPIOA'); await pg.wait_for_selector('.sheet.on'); await pg.wait_for_timeout(400)
        dock0 = await pg.evaluate("document.querySelector('.sh-dock').hidden")
        await pg.tap('.bit[data-f="MODE0"] >> nth=0'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("""(() => { const cb = document.querySelector('.sh-code figure.code').getBoundingClientRect();
          return [!document.querySelector('.sh-pick').hidden && document.querySelector('.sh-pick .frow-h b').textContent, cb.top < innerHeight - 60, document.querySelector('.sh-code pre').textContent]; })()""")
        await pg.tap('.sh-pick .fv >> nth=3'); await pg.wait_for_timeout(300)
        st2 = await pg.evaluate("[document.querySelector('.sh-pick .fv.on b').textContent, document.querySelector('.sh-code pre').textContent]")
        check('手机：点位格子，代码就在格子下面（不用翻到底），下面跟着这个字段的说明', st[0] == 'MODE0' and st[1] and 'MODE0' in st[2] and st2[0] == '11' and 'MODE0' in st2[1], (st, st2))
        await pg.evaluate("document.querySelector('.fields').scrollIntoView()"); await pg.wait_for_timeout(500)
        st3 = await pg.evaluate("[document.querySelector('.sh-dock').hidden, document.querySelector('.sh-dock').textContent]")
        check('手机：往下翻到字段列表看不到代码时，底部露出代码条', dock0 and not st3[0] and 'MODE0' in st3[1], (dock0, st3))
        await pg.context.close()

        # ---------- 编程思维：明确任务 → 查资料 → 规划 → 编写 → 验证（右边一份资料）；硬件原理：自绘结构图，按块讲 ----------
        pg = await page(b, 1440, 900)
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        await pg.click('.nav-i[data-v=lab]'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[location.search, [...document.querySelectorAll('.lab-ch h2')].map(n => n.textContent)]")
        check('侧栏「编程思维」：打开模块首页，列出 GPIO、定时器两章', 'v=lab' in st[0] and st[1] == ['GPIO：点亮 LED', '定时器：呼吸灯与毫秒节拍'], st)
        await pg.click('.lab-ch'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[[...document.querySelectorAll('.lab-tab')].map(n => n.textContent), document.querySelector('.lp-doc .lp-kind').textContent, document.querySelector('.lp-src').textContent]")
        check('五步框架；明确任务这一步右边是开发板原理图（注明第几页）', st[0] == ['1明确任务', '2查资料', '3规划', '4编写', '5验证'] and st[1] == '开发板原理图' and '第 8 页' in st[2], st)
        await pg.click('.lab-tab[data-st=look]'); await pg.wait_for_timeout(300)
        await pg.click('.lp-look-q >> nth=4'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-doc .lp-doc-h b').textContent, [...document.querySelectorAll('.lp-fn.on')].map(n => n.textContent), document.querySelector('.lp-src').textContent, document.querySelectorAll('.lp-doc-b > *').length]")
        check('查资料：点第 5 问，右边换成 CRL 位图，高亮 PA0/PA1 的字段，注明手册页码（不标章节号），一次只有一份', st[0] == 'GPIOx_CRL' and 'MODE0' in st[1] and 'CNF1' in st[1] and '9.2.1' not in st[2] and '171' in st[2] and st[3] == 1, st)
        await pg.click('.lp-look-q >> nth=1'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-doc .lp-kind').textContent, document.querySelector('.lp-doc .lp-doc-h b').textContent, document.querySelectorAll('.lp-hl').length, document.querySelector('.lp-src').textContent]")
        check('查资料：系统结构图标出 RCC 和 APB2，写明是英文版矢量图转译', st[0] == '参考手册' and '系统结构' in st[1] and st[2] == 2 and '转译' in st[3], st)
        await pg.click('.lab-tab[data-st=plan]'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[[...document.querySelectorAll('.lp-fr-k')].map(n => n.textContent), !!document.querySelector('.lp-main .lm-fig'), getComputedStyle(document.querySelector('.lp-side')).display, document.querySelector('.lm-src').textContent]")
        check('规划：同一套框架（① 开时钟 ② 配引脚 ③ 配外设 ④ 使能 用），上面是自绘结构图（注明不是手册原图）', st[0] == ['① 开时钟', '② 配引脚', '③ 配外设', '④ 使能', '用'] and st[1] and st[2] == 'none' and '自绘' in st[3], st)
        await pg.click('.lm-step[data-s="2"]'); await pg.wait_for_timeout(200)
        st = await pg.evaluate("[...document.querySelectorAll('.lm-fig .hot')].map(n => n.textContent).join(' ')")
        check('规划：点「② 配引脚」，图上这一步要写的寄存器亮起来（CNF0 / MODE0、BS0）', 'CNF0' in st and 'MODE0' in st and 'BS0' in st and 'IOPAEN' not in st, st)
        await pg.click('.lm-fig .mz[data-z=cfg]'); await pg.wait_for_timeout(500)
        check('规划：点图上的一块，跳到硬件原理的这一块', 'v=think' in pg.url and 'z=cfg' in pg.url and await pg.evaluate("document.querySelector('.lm-ch').textContent") == '端口配置', pg.url)
        await pg.go_back(); await pg.wait_for_timeout(400)
        await pg.click('.lab-tab[data-st=code]'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[[...document.querySelectorAll('.lb-chip')].map(n => n.textContent), [...document.querySelectorAll('.lp-goal')].map(n => n.textContent), document.querySelectorAll('.lp-file').length]")
        check('编写：第一版只写 main.c，代码按子目标分组', st[0] == ['第一版 单文件', '第二版 led 模块'] and st[1][:2] == ['① 开时钟', '② 配引脚'] and st[2] == 1, st)
        await pg.click('.lp-file .rc-l:has-text("GPIOA->CRL |=") .rc-lb'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-doc-h b').textContent, document.querySelector('.lp-reg-v').textContent, [...document.querySelectorAll('.lp-fl li')].map(n => n.textContent)]")
        check('点一行寄存器代码：右边换成 CRL，值是这一行执行完的值，写出 MODE0 = 11 的含义', st[0] == 'GPIOx_CRL' and '4443' in st[1] and any('MODE0' in x and '= 11' in x and '50' in x for x in st[2]), st)
        check('编写：代码后面没有「动画」链接', await pg.evaluate("document.querySelectorAll('.lp-hwl, .lp-hw').length") == 0)
        await pg.click('.lp-acts .lab-b:has-text("在结构图里看")'); await pg.wait_for_timeout(500)
        st = await pg.evaluate("[location.search, document.querySelector('.lm-ch').textContent, [...document.querySelectorAll('.lm-regs .lm-rn')].map(n => n.textContent)]")
        check('寄存器资料下「在结构图里看」：跳到硬件原理里 CRL 所在的「端口配置」，列出要写的位', 'hv=map' in st[0] and 'z=cfg' in st[0] and st[1] == '端口配置' and 'CRL.MODE0' in st[2], st)
        await pg.go_back(); await pg.wait_for_timeout(400)
        await pg.click('.lb-chip >> nth=1'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[document.querySelectorAll('.lp-file').length, [...document.querySelectorAll('.lp-file .code-t')].map(n => n.textContent)]")
        check('第二版：led.h / led.c / main.c', st[1] == ['led.h', 'led.c', 'main.c'] and 'fn=v2' in pg.url, st)
        # 硬件原理：全图 + 图例 + 初始化顺序；按块讲（图放大到这一块，右边讲解卡片），没有逐行动画
        await pg.goto(TOOL + '?v=think&t=gpio'); await pg.wait_for_timeout(600)
        st = await pg.evaluate("[[...document.querySelectorAll('.lm-tab')].map(n => n.textContent), document.querySelectorAll('.lm-legend li').length, [...document.querySelectorAll('.lm-init li .lm-in')].map(n => n.textContent), document.querySelectorAll('.lb-ctl, .lb-p, .lb-code').length, document.querySelector('.lm-src').textContent]")
        check('硬件原理 GPIO：结构图分 5 块，全图下面是图例和初始化顺序；没有播放按钮和逐行代码；注明自绘', st[0] == ['全图', '时钟', '端口配置', '输出驱动', '输入', '引脚与外部电路'] and st[1] == 5 and st[2] == ['开时钟', '配引脚', '配外设', '使能', '用'] and st[3] == 0 and '自绘' in st[4], st)
        await pg.click('.lm-tab[data-z=out]'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[location.search, document.querySelector('.lm-ch').textContent, [...document.querySelectorAll('.lm-regs .lm-rn')].map(n => n.textContent), document.querySelector('.lm-fig').getAttribute('viewBox').split(' ').map(Number)[2] < 1000, !!document.querySelector('.lm-minibox table')]")
        check('点「输出驱动」：图放大到这一块，讲解卡片列出 BSRR 的写法，附推挽 / 开漏对照表', 'z=out' in st[0] and st[1] == '输出驱动' and 'BSRR.BS0' in st[2] and 'BSRR.BR0' in st[2] and st[3] and st[4], st)
        await pg.click('.lm-nav .lab-next'); await pg.wait_for_timeout(300)
        check('卡片底部「下一块」：到「输入」，LED 任务里这一块标「这个任务不用」', await pg.evaluate("[document.querySelector('.lm-ch').textContent, document.querySelector('.mz[data-z=in] .mzn').textContent]") == ['输入', '这个任务不用'])
        await pg.click('.lm-vr button[data-k=key]'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[location.search, [...document.querySelectorAll('.lm-regs .lm-rn')].map(n => n.textContent), document.querySelector('.lm-fig').textContent.includes('PF8')]")
        check('切到「PF8 · KEY1 输入」：输入这一块列出选上拉（BS8）和读 IDR8，图上换成 PF8 和按键', 'fn=key' in st[0] and 'BSRR.BS8' in st[1] and 'IDR.IDR8' in st[1] and st[2], st)
        await pg.click('.lab-tab[data-hv=why]'); await pg.wait_for_timeout(500)
        check('硬件原理：「为什么这样设计」是原来的推导链', await pg.evaluate("!!document.querySelector('.dv-map, .dv-mode')") and 'hv=why' in pg.url)
        # 验证：代码在 VS Code 里写，这里粘贴进来检查；没有挖空
        await pg.goto(TOOL + '?v=lab&t=gpio&st=check'); await pg.wait_for_timeout(500)
        st = await pg.evaluate("[[...document.querySelectorAll('.lb-chip')].map(n => n.textContent), document.querySelectorAll('.cd-inp, .lab-tokens').length, document.querySelectorAll('.lp-recall-f li').length, document.querySelectorAll('.lp-card').length]")
        check('验证：三道题（编写 LED_Init / LED_On、LED_Off / 迁移），没有挖空和插词按钮；右边先只给框架，资料卡收着', st[0] == ['编写 LED_Init', '编写 LED_On / LED_Off', '迁移：按键控制 LED'] and st[1] == 0 and st[2] == 5 and st[3] == 0, st)
        wrong = "    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;\n    LED_PORT->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0 | GPIO_CRL_CNF1 | GPIO_CRL_MODE1);\n    LED_PORT->CRL |= (GPIO_CRL_MODE0 | GPIO_CRL_MODE1);\n    LED_PORT->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\n    LED_PORT->CRH |= (GPIO_CRH_MODE8);\n    LED_PORT->BSRR = GPIO_BSRR_BS0 | GPIO_BSRR_BS1 | GPIO_BSRR_BS8;"
        await pg.fill('.lab-ta', wrong)
        await pg.click('.lab-acts .lab-p'); await pg.wait_for_timeout(600)
        st = await pg.evaluate("[[...document.querySelectorAll('.lab-r')].map(n => n.className), document.querySelector('.lab-r-m').textContent]")
        await pg.click('.lab-r .lab-b'); await pg.click('.lab-r .lab-b'); await pg.wait_for_timeout(200)
        d1 = await pg.evaluate("document.querySelector('.lp-doc-h b') && document.querySelector('.lp-doc-h b').textContent")
        await pg.click('.lab-r .lab-b'); await pg.wait_for_timeout(200)
        h = await pg.evaluate("[document.querySelectorAll('.lab-hints p').length, document.querySelector('.lab-hints figure.code pre').textContent]")
        check('验证：粘贴先配输出再写 1 的 LED_Init → 指出上电会闪，第二级提示右边换成输出配置图，最后给写法', st[0] == ['lab-r lab-r-warn'] and '闪' in st[1] and '输出配置' in (d1 or '') and h[0] == 2 and 'BSRR' in h[1], (st, d1, h))
        await pg.reload(); await pg.wait_for_timeout(500)
        check('粘贴的代码刷新后还在', 'BSRR = GPIO_BSRR_BS0' in await pg.evaluate("document.querySelector('.lab-ta').value"))
        await pg.goto(TOOL + '?v=lab&t=gpio&st=check&fn=key'); await pg.wait_for_timeout(500)
        tas = pg.locator('.lab-ta')
        await tas.nth(0).fill("    RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;\n    GPIOF->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\n    GPIOF->CRH |= GPIO_CRH_CNF8_1;")
        await tas.nth(1).fill("        if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) LED_On(LED1);\n        else LED_Off(LED1);")
        await pg.click('.lab-acts .lab-p'); await pg.wait_for_timeout(800)
        m1 = await pg.evaluate("document.querySelector('.lab-r-m').textContent")
        await tas.nth(0).fill("    RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;\n    GPIOF->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\n    GPIOF->CRH |= GPIO_CRH_CNF8_1;\n    GPIOF->BSRR = GPIO_BSRR_BS8;")
        await pg.click('.lab-acts .lab-p'); await pg.wait_for_timeout(800)
        m2 = await pg.evaluate("document.querySelector('.lab-r').className")
        check('验证③换题（按键控制 LED）：忘了选上拉 → 指出下拉；改对 → 全对', '下拉' in m1 and m2 == 'lab-r lab-r-ok', (m1, m2))
        await pg.goto(TOOL + '?v=lab&t=gpio&st=c'); await pg.wait_for_timeout(400)
        check('旧地址 st=c 转到「编写」', 'st=code' in pg.url, pg.url)
        await pg.goto(TOOL + '?v=think&t=gpio&hv=run&fn=mine-init&ln=3'); await pg.wait_for_timeout(600)
        check('旧的动画地址（hv=run）打开结构图全图，不报错', 'hv=map' in pg.url and 'ln=' not in pg.url and await pg.evaluate("!!document.querySelector('.lm-fig') && document.querySelector('.lm-tab[aria-selected=true]').textContent") == '全图', pg.url)
        check('验证：没有「放进动画」按钮', True)
        # 定时器一章
        await pg.goto(TOOL + '?v=lab'); await pg.wait_for_timeout(300)
        check('编程思维首页：GPIO、定时器两章', await pg.evaluate("[...document.querySelectorAll('.lab-ch h2')].map(n => n.textContent)") == ['GPIO：点亮 LED', '定时器：呼吸灯与毫秒节拍'])
        await pg.goto(TOOL + '?v=lab&t=tim&st=look'); await pg.wait_for_timeout(400)
        await pg.click('.lp-look-q >> nth=1'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-kind').textContent, [...document.querySelectorAll('.lp-af.on')].map(n => n.textContent), document.querySelector('.lp-src').textContent]")
        check('定时器·查资料：PA1 的复用功能来自数据手册，TIM5_CH2 标出来', st[0] == '数据手册' and st[1] == ['TIM5_CH2'] and 'DS5792' in st[2], st)
        await pg.goto(TOOL + '?v=lab&t=tim&st=code&fn=v2'); await pg.wait_for_timeout(500)
        await pg.click('.lp-file .rc-l:has-text("TIM5->CCER") .rc-lb'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-doc-h b').textContent, [...document.querySelectorAll('.lp-fn.on')].map(n => n.textContent), document.querySelector('.lp-src').textContent]")
        check('定时器·编写：点 CCER 那一行，右边是 CCER 位图，CC2E / CC2P 标出来，不标章节号', st[0] == 'TIMx_CCER' and 'CC2E' in st[1] and 'CC2P' in st[1] and 'RM0008' in st[2] and '15.4.9' not in st[2], st)
        await pg.goto(TOOL + '?v=think&t=tim'); await pg.wait_for_timeout(600)
        st = await pg.evaluate("[[...document.querySelectorAll('.lm-tab')].map(n => n.textContent), document.querySelector('.mz[data-z=irq] .mzn').textContent, [...document.querySelectorAll('.lm-init li')].map(n => n.textContent)]")
        check('定时器·硬件原理：时钟 / 时基单元 / 输出比较 / 引脚 / 中断五块；PWM 任务里中断标「这个任务不用」；初始化顺序列出 PSC、ARR、CCR2…', st[0] == ['全图', '时钟', '时基单元', '输出比较', '引脚', '中断'] and st[1] == '这个任务不用' and 'PSC' in st[2][2] and 'CCMR1.OC2M' in st[2][2] and 'CR1.CEN' in st[2][3], st)
        await pg.click('.lm-tab[data-z=tb]'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[[...document.querySelectorAll('.lm-fx span')].map(n => n.textContent), [...document.querySelectorAll('.lm-regs li')].map(n => n.textContent), !!document.querySelector('.lm-minibox .lm-wave')]")
        check('时基单元：给出计数频率公式，PSC = 71、ARR = 999、EGR.UG、CR1.CEN，附 CNT 锯齿波', any('PSC + 1' in x for x in st[0]) and any('PSC' in x and '71' in x for x in st[1]) and any('UG' in x for x in st[1]) and st[2], st)
        await pg.click('.lm-regs .lm-reg >> nth=0'); await pg.wait_for_timeout(300)
        check('点卡片里的寄存器：就地展开它的位图', await pg.evaluate("document.querySelector('.lm-regs .lp-doc .lp-doc-h b').textContent") == 'TIMx_PSC')
        await pg.click('.lm-vr button[data-k=tick]'); await pg.wait_for_timeout(300); await pg.click('.lm-tab[data-z=oc]'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lm-lead').textContent, document.querySelector('.mz[data-z=oc] .mzn').textContent]")
        check('切到 TIM6：输出比较这一块标「基本定时器没有」', '基本定时器' in st[0] and st[1] == '基本定时器没有', st)
        await pg.click('.lm-tab[data-z=irq]'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[...document.querySelectorAll('.lm-regs .lm-rn')].map(n => n.textContent)")
        check('TIM6 的中断：清 UIF、开 UIE、NVIC_EnableIRQ，中断函数里清 UIF', st == ['SR.UIF', 'DIER.UIE', 'NVIC_EnableIRQ(TIM6_IRQn)', 'SR.UIF'], st)
        await pg.goto(TOOL + '?v=lab&t=tim&st=check'); await pg.wait_for_timeout(500)
        await pg.fill('.lab-ta', await pg.evaluate("STM32Lab.body(STM32Lab.chapter('tim'), 'PWM_Init').replace(' | TIM_CCER_CC2P', '')"))
        await pg.click('.lab-acts .lab-p'); await pg.wait_for_timeout(800)
        m = await pg.evaluate("document.querySelector('.lab-r-m').textContent")
        check('定时器·验证：粘贴忘了 CC2P 的 PWM_Init → 指出亮暗反了', '反了' in m, m)
        await pg.context.close()
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(TOOL + '?v=lab&t=gpio&st=code'); await pg.wait_for_timeout(600)
        await pg.tap('.lp-file .rc-l:has-text("GPIOA->CRL |=") .rc-lb'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[getComputedStyle(document.querySelector('.lp-side')).display, document.querySelector('.lp-mt button.new') !== null, document.documentElement.scrollWidth <= innerWidth]")
        await pg.tap('.lp-mt button >> nth=1'); await pg.wait_for_timeout(300)
        st2 = await pg.evaluate("[getComputedStyle(document.querySelector('.lp-side')).display, getComputedStyle(document.querySelector('.lp-main')).display, document.querySelector('.lp-doc-h b').textContent]")
        check('手机：讲解 / 资料切换，点了寄存器行「资料」上亮个点，切过去就是那份资料', st == ['none', True, True] and st2 == ['block', 'none', 'GPIOx_CRL'], (st, st2))
        await pg.goto(TOOL + '?v=think&t=tim&z=oc'); await pg.wait_for_timeout(600)
        st = await pg.evaluate("""(() => { const f = document.querySelector('.lm-scroll').getBoundingClientRect(), c = document.querySelector('.lm-card').getBoundingClientRect();
          return [f.bottom <= c.top + 1, c.width > 300, document.querySelector('.lm-ch').textContent, document.documentElement.scrollWidth <= innerWidth]; })()""")
        check('手机·硬件原理：放大的一块在上、讲解卡片在下，页面没有横向滚动', st == [True, True, '输出比较', True], st)
        await pg.context.close()
        # ---------- 小芯聊天 ----------
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(1500)
        items = await pg.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent))")
        check('小芯聊天：网站没配密钥（本地预览）时背包里没有「聊天」', '聊天' not in items, items)
        await pg.keyboard.press('Escape')
        await pg.goto(BASE + '/#xin'); await pg.wait_for_selector('.xc.show')
        check('没配密钥时 #xin 打开面板，只说没开', '还没开' in await pg.text_content('.xc') and not await pg.is_visible('.xc-login') and not await pg.is_visible('.xc-ft'))
        await pg.context.close()

        pg = await page(b)
        xs = await xin_mock(pg)
        await pg.goto(BASE + '/#xin'); await pg.wait_for_selector('.xc.show .xc-login')
        check('没登录：#xin 先要密码', await pg.is_visible('.xc-login input[type=password]') and not await pg.is_visible('.xc-ft'))
        await pg.click('.xc-x'); await pg.wait_for_timeout(400)
        items = await pg.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent))")
        await pg.click('.xin-bag .xin-it:has-text("聊天")'); await pg.wait_for_selector('.xc.show .xc-login')
        check('功能开着、没登录：背包里也有「聊天」，点了先要密码', '聊天' in items and await pg.is_visible('.xc-login input[type=password]'), items)
        ops_before = list(xs['ops'])
        await pg.fill('.xc-login input', 'pw-ok-123456'); await pg.click('.xc-login .xc-btn')
        await pg.wait_for_selector('.xc-hello'); await pg.wait_for_timeout(200)
        check('没登录不叫醒云电脑，登录以后马上叫醒', 'wake' not in ops_before and 'wake' in xs['ops'], (ops_before, xs['ops']))
        st = await pg.evaluate("[!!document.querySelector('.xc-hello .xc-av'), [...document.querySelectorAll('.xc-hello .xc-chip')].map(b => b.textContent), document.querySelector('.xc-row .xc-mdl').textContent, document.querySelector('.xc-sub').textContent]")
        check('登录以后：欢迎页（小芯头像和一句话，没有建议按钮），输入框底下的按钮写着默认模式「自动 · 最高」（小芯自己挑模型），标题下面写着在线',
              await pg.is_visible('.xc-row textarea') and st == [True, [], '自动最高', '在线'] and not await pg.evaluate("!!document.querySelector('.xc-hello button')"), st)
        PK = """(() => { const p = document.querySelector('.xc-pick'), t = p.querySelector('.xc-pk-t'), m = p.querySelector('.xc-pk-g[data-g=model]'), on = b => b.getAttribute('aria-checked') === 'true' ? '*' : '';
          return [document.querySelector('.xc-mdl span').firstChild.textContent, t ? t.querySelector('i').textContent : null, !!m,
            [...p.querySelectorAll('.xc-eff-d')].map(b => b.getAttribute('aria-label') + on(b)), document.querySelector('.xc-mdl span').firstChild.textContent,
            (document.querySelector('.xc-mdl span i') || {}).textContent || '', m ? [...m.querySelectorAll('.xc-pk-o')].map(b => b.textContent + on(b)) : null, p.hidden] })()"""
        AUTO = """(() => { const p = document.querySelector('.xc-pick'); return [p.querySelector('.xc-pk-agent').textContent, [...p.querySelectorAll('.xc-pk-ml li')].map(l => l.textContent),
          p.querySelectorAll('.xc-pk-o, .xc-eff-d').length, p.textContent.includes('用 Kimi'), p.textContent.includes('天启模式'), document.activeElement === p.querySelector('.xc-pk-close')] })()"""
        async def open_set():
            await pg.click('.xc-list-b'); await pg.wait_for_selector('.xc-set-b')
            if await pg.evaluate("document.querySelector('.xc-set').hidden"): await pg.click('.xc-set-b')
            await pg.wait_for_selector('.xc-set')
        async def close_dr():
            await pg.click('.xc-dr-x'); await pg.wait_for_function("!document.querySelector('.xc').classList.contains('dr-open')")
        async def set_tianqi(on):
            await open_set()
            if await pg.evaluate("document.querySelector('.xc-tianqi .xc-sw').getAttribute('aria-checked') === 'true'") != on: await pg.click('.xc-tianqi .xc-sw')
            await close_dr()
        await pg.click('.xc-mdl'); await pg.wait_for_selector('.xc-pick:not([hidden])')
        try: await pg.wait_for_function("document.activeElement === document.querySelector('.xc-pick .xc-pk-close')", timeout=2000)
        except Exception: pass
        au = await pg.evaluate(AUTO)
        check('默认模式的模型按钮点开：只说明小芯自己挑（列出 Codex 的四个模型），没有模型和档位可选；教怎么点名、怎么打开天启模式；焦点在关闭按钮上',
              au == ['Codex', ['GLM-5.3 Flash', 'GLM-5.3', 'Kimi K3.1 Pro', 'DeepSeek V4.1 Flash'], 0, True, True, True], au)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        await set_tianqi(True)
        await pg.click('.xc-mdl'); await pg.wait_for_selector('.xc-pick:not([hidden])')
        st = await pg.evaluate(PK)
        check('打开天启模式：Harness 模型面板直接显示三个模型，当前 DeepSeek V4.1 Flash；分段按钮写出四档名称，默认高',
              st == ['DeepSeek V4.1 Flash', '高', True, ['关', '低', '高*', '最高'], 'DeepSeek V4.1 Flash', '高', ['DeepSeek V4.1 Flash*', 'GLM-5.3', 'GLM-5.3 Flash'], False], st)
        await pg.click('.xc-eff-d[data-v=off]'); await pg.wait_for_timeout(100)
        st = await pg.evaluate(PK)
        bo = await pg.locator('.xc-eff-d[data-v=off]').bounding_box(); bm = await pg.locator('.xc-eff-d[data-v=max]').bounding_box()
        await pg.mouse.move(bo['x'] + bo['width'] / 2, bo['y'] + bo['height'] / 2); await pg.mouse.down()
        await pg.mouse.move(bm['x'] + bm['width'] / 2, bm['y'] + bm['height'] / 2, steps=6); await pg.mouse.up(); await pg.wait_for_timeout(100)
        st2 = await pg.evaluate(PK)
        await pg.focus('.xc-eff-d[data-v=max]'); await pg.keyboard.press('ArrowLeft'); await pg.wait_for_timeout(100)
        st3 = await pg.evaluate(PK) + [await pg.evaluate("localStorage.getItem('lm.xin.effort')")]
        check('点一个点就选那一档（面板不关，标题和按钮跟着变）；按住拖到最右是最高；键盘左键往回一档；记在这个浏览器里',
              st[1:4] == ['关', True, ['关*', '低', '高', '最高']] and st[5] == '关' and not st[7] and st2[3] == ['关', '低', '高', '最高*'] and st2[5] == '最高'
              and st3[3] == ['关', '低', '高*', '最高'] and st3[-1] == 'high', (st, st2, st3))
        await pg.click('.xc-pk-o[data-v="glm-5.3"]'); await pg.wait_for_timeout(100)
        hg = await pg.evaluate(PK)
        await pg.keyboard.press('ArrowDown'); await pg.wait_for_timeout(100)
        hf = await pg.evaluate(PK)
        await pg.keyboard.press('Home'); await pg.wait_for_timeout(100)
        check('Harness 可直接换 GLM；不支持关闭思考时只显示三档；模型列表支持方向键和 Home，选择写入浏览器',
              hg[0] == 'GLM-5.3' and hg[3] == ['低', '高*', '最高'] and hf[0] == 'GLM-5.3 Flash'
              and await pg.evaluate("localStorage.getItem('lm.xin.hmodel')") == 'deepseek-v4.1-flash', (hg, hf))
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        st0 = [await pg.evaluate("document.querySelector('.xc-pick').hidden"), await pg.is_visible('.xc-row textarea')]
        check('Esc 关闭模型设置后焦点回到模型按钮，聊天仍然打开', await pg.evaluate("document.activeElement === document.querySelector('.xc-mdl')") and await pg.is_visible('.xc.show'))
        await pg.click('.xc-plus'); await pg.click('.xc-mi-plug'); await pg.wait_for_selector('.xc-sheet [data-name=purge] .xc-sw')
        hp = await pg.evaluate("[...document.querySelectorAll('.xc-sheet [data-name]')].map(e => e.dataset.name)")
        await pg.click('.xc-sheet [data-name=purge] .xc-sw'); await pg.wait_for_function("document.querySelector('.xc-sheet [data-name=purge] .xc-sw').getAttribute('aria-checked') === 'false'")
        check('Harness 插件页只列 Purge，开关请求明确带 Harness，不会开关 Codex 的 MCP', hp == ['purge'] and xs.get('plugins_agent') == 'harness' and xs.get('plugin_set') == [{'agent': 'harness', 'name': 'purge', 'on': False}], (hp, xs.get('plugin_set')))
        await pg.click('.xc-sh-x')
        await open_set()
        st = await pg.evaluate("""[document.querySelector('.xc-tianqi .xc-sw').getAttribute('aria-checked'), document.querySelector('.xc-tianqi .xc-tg-t b').textContent, document.querySelector('.xc-tianqi .xc-tg-t span').textContent,
          !!document.querySelector('.xc-set [data-agent]'), document.querySelector('.xc-set').textContent.includes('Claude'), !!document.querySelector('.xc-set .xc-effort, .xc-set .xc-cxmodel'), localStorage.getItem('lm.xin.agent')]""")
        check('设置里是「天启模式」开关（开着 = Harness，带一句说明），没有三选一、没有 Claude；思考强度、模型不在设置里；面板按 Esc 关、聊天不关',
              st == ['true', '天启模式', '打开后新对话用 Harness，自己选模型和思考强度', False, False, False, 'harness'] and st0 == [True, True], (st, st0))
        await pg.click('.xc-tianqi .xc-sw'); await pg.wait_for_timeout(100)
        await close_dr()
        st = await pg.evaluate("[document.querySelector('.xc-mdl').textContent, localStorage.getItem('lm.xin.agent'), localStorage.getItem('lm.xin.agent.v')]")
        check('关掉天启模式：回到默认模式，按钮写「自动最高」，记在这个浏览器里', st == ['自动最高', 'codex', '3'], st)
        # 以前的 Claude 对话照样能打开：按钮写 Claude 和它的档位（五档），能改；回到新对话又是默认模式
        await pg.click('.xc-list-b'); await pg.wait_for_selector('.xc-si')
        await pg.click('.xc-si:has-text("旧对话")'); await pg.wait_for_selector('.xc-code')
        await pg.click('.xc-mdl'); await pg.wait_for_selector('.xc-pick:not([hidden])')
        st = await pg.evaluate(PK)
        await pg.click('.xc-eff-d[data-v=xhigh]'); await pg.wait_for_timeout(100)
        await pg.click('.xc-msgs', position={'x': 10, 'y': 10}); await pg.wait_for_timeout(100)
        hid = await pg.evaluate("document.querySelector('.xc-pick').hidden")
        st2 = await pg.evaluate("document.querySelector('.xc-mdl').textContent")
        await pg.click('.xc-new-b'); await pg.wait_for_selector('.xc-hello')
        st3 = await pg.evaluate("[localStorage.getItem('lm.xin.agent'), localStorage.getItem('lm.xin.effort'), document.querySelector('.xc-mdl').textContent]")
        check('以前的 Claude 对话：打开还是 Claude，五档 低 / 中 / 高 / 超高 / 最高，能选超高；点外面面板就关；新对话回到默认模式（自动最高），Claude 的档位记着',
              st[:4] == ['Claude', '高', False, ['低', '中', '高*', '超高', '最高']] and hid and st2 == 'Claude超高' and st3 == ['codex', 'xhigh', '自动最高'], (st, hid, st2, st3))
        check('新对话还没有用量：输入框底下那一行不显示', not await pg.is_visible('.xc-use'))
        await pg.fill('.xc-row textarea', '看看工作目录'); await pg.keyboard.press('Enter')
        await pg.wait_for_function("document.querySelector('.xc-typing-l') && document.querySelector('.xc-typing-l').textContent.startsWith('在电脑上忙')", timeout=5000)
        st = await pg.evaluate("""[LimingXin.aiState, document.querySelector('.xc').classList.contains('running'), document.querySelectorAll('.xc-me').length, (document.querySelector('.xin-say') || {}).textContent,
          document.querySelector('.xc-sub').textContent, document.querySelector('.xc-msgs').textContent.includes('Model metadata'), document.querySelector('.xc-msgs').textContent.includes('ls /data/workspace'),
          !!document.querySelector('.xc-tool'), document.querySelector('.xc-msgs').lastElementChild.classList.contains('xc-typing')]""")
        check('发出去：默认模式传 Codex、思考强度最高、不带模型（小芯电脑上挑）；只有自己的一句和小芯的第一句，它执行的命令、无关警告都不显示，最后冒「正在输入」写着在电脑上忙；小芯坐到电脑前敲代码',
              xs['sent'] == {'agent': 'codex', 'text': '看看工作目录', 'effort': 'max'} and st[:4] == ['work', True, 1, '收到，我看看。'] and st[4] == '正在电脑上忙…' and st[5:] == [False, False, False, True], (xs['sent'], st))
        await pg.wait_for_function(CHAT_DONE, timeout=8000)
        # 荡秋千 / 跳跃时 xin dance 会先排队，落地后才开始；不要在空中动作尚未结束时读取最终姿态。
        await pg.wait_for_function("LimingXin.mode === 'play'", timeout=20000)
        await pg.wait_for_timeout(200)
        st = await pg.evaluate("""[LimingXin.aiState, LimingXin.mode, document.querySelector('.xc').classList.contains('running'), localStorage.getItem('lm.xin.sid'),
          [...document.querySelectorAll('.xc-ai .xc-bub')].map(b => b.textContent), [...document.querySelectorAll('.xc-sys')].map(e => e.textContent),
          document.querySelector('.xc-msgs').textContent.includes('跳舞'), document.querySelector('.xc-st').hidden, !!document.querySelector('.xc-done')]""")
        check('做完：「正在输入」收起、停止键变回发送、记住对话；小芯的两句话在白底气泡里；xin dance 让小芯跳舞但聊天里不写；没有状态栏和「完成 · xx 秒」那条线',
              st[0] == '' and st[1] == 'play' and not st[2] and st[3] == 'snew000001' and st[4] == ['收到，我看看。', '里面有一个 blink 目录。'] and st[6:] == [False, True, False], st)
        by = await pg.evaluate("[[...document.querySelectorAll('.xc-by')].map(e => e.textContent), document.querySelector('.xc-msgs .xc-by') === document.querySelector('.xc-msgs').lastElementChild]")
        await pg.click('.xc-mdl'); await pg.wait_for_selector('.xc-pick:not([hidden])')
        au = await pg.evaluate(AUTO)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        check('回答下面一行小字写这一轮实际用的模型（先试的没接上就说换了它）；模型按钮点开标出「上一句」用的是谁',
              by == [['GLM-5.3 · DeepSeek V4.1 Flash 没接上，换了它'], True] and au[1] == ['GLM-5.3 Flash', 'GLM-5.3上一句', 'Kimi K3.1 Pro', 'DeepSeek V4.1 Flash'], (by, au))
        use = await pg.evaluate("[document.querySelector('.xc-use').hidden, [...document.querySelectorAll('.xc-use-i')].map(e => e.textContent), document.querySelector('.xc-use-bar > i').style.width]")
        check('做完一轮：输入框底下显示这个对话的用量（上下文 12%、消耗 6.2万 token、缓存命中 80%）', use == [False, ['上下文 12%', '消耗 6.2万 token', '缓存命中 80%'], '12%'], use)
        items = await pg.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent))")
        check('登录以后背包里有「聊天」', '聊天' in items, items)
        check('记事本：小芯记了一笔，聊天里一个小提示「记住了：…」', st[5] == ['记住了：用户在做 blink 点灯'], st[5])
        await pg.keyboard.press('Escape')
        await pg.click('.xc-list-b'); await pg.wait_for_selector('.xc-si')
        await pg.click('.xc-memb'); await pg.wait_for_selector('.xc-memt')
        memv = await pg.input_value('.xc-memt')
        await pg.fill('.xc-memt', memv + '- 2026-11-04：喜欢先看代码\n'); await pg.click('.xc-memrow .xc-btn'); await pg.wait_for_timeout(300)
        check('记事本：对话列表里能打开，看到内容，改了能保存', '用户在学定时器' in memv and xs['mem'].endswith('喜欢先看代码\n') and '存好了' in await pg.text_content('.xc-memrow'), (memv, xs['mem']))
        await pg.click('.xc-back'); await pg.wait_for_selector('.xc-si')
        await pg.click('.xc-si'); await pg.wait_for_selector('.xc-code')
        st = await pg.evaluate("""[document.querySelector('.xc-code code').textContent, document.querySelector('.xc-code .xc-lang').textContent, !!document.querySelector('.xc-tool'),
          [...document.querySelectorAll('.xc-ai')].map(e => ['wide', 'cont', 'bad'].filter(c => e.classList.contains(c)).join(' ')),
          (document.querySelector('.xc-ai.bad .xc-bub') || {}).textContent, !!document.querySelector('.xc-time'), document.querySelector('.xc-msgs').textContent.includes('arm-none-eabi-gcc')]""")
        check('打开旧对话：代码块（带语言、复制），执行的命令不显示；小芯接着说的不再画头像；没做成的那一轮有一句提示；最前面有时间',
              st[:3] == ['int main(void) { return 0; }', 'c', False] and st[3] == ['wide', 'cont', 'cont bad'] and st[4] == '这次没做成' and st[5] and not st[6], st)
        hl = await pg.evaluate("""(() => { const by = c => [...document.querySelectorAll('.xc-code .hl-' + c)].map(e => e.textContent);
          const kw = document.querySelector('.xc-code .hl-kw'); return [by('kw'), by('fn'), by('num'), kw && getComputedStyle(kw).color !== getComputedStyle(document.querySelector('.xc-code code')).color]; })()""")
        check('代码上色：关键字、函数名、数字各有颜色（复制出来还是原文）', hl == [['int', 'void', 'return'], ['main'], ['0'], True], hl)
        use = await pg.evaluate("[[...document.querySelectorAll('.xc-use-i')].map(e => e.textContent), !!document.querySelector('.xc-use-more')]")
        await pg.click('.xc-use-b'); await pg.wait_for_selector('.xc-use-more')
        more = await pg.text_content('.xc-use-more')
        await pg.click('.xc-use-b'); await pg.wait_for_timeout(100)
        check('打开旧对话：用量换成这个对话的（上下文 47%、消耗 373万、缓存命中 96%）；点一下展开明细（上下文 12万 / 25.8万、输入、缓存、输出），再点收起',
              use == [['上下文 47%', '消耗 373万 token', '缓存命中 96%'], False] and more == '上下文 12万 / 25.8万 · 输入 370万（缓存命中 357万） · 输出 2.9万' and not await pg.is_visible('.xc-use-more'), (use, more))
        await pg.click('.xc-new-b'); await pg.wait_for_selector('.xc-hello')
        check('点新对话：用量那一行收起来', not await pg.is_visible('.xc-use'))
        await pg.click('.xc-x'); await pg.wait_for_timeout(400)
        check('关掉面板', not await pg.is_visible('.xc'))
        # 发出去、还没送到小芯的电脑：「正在输入」旁边写「接收中」、标题栏「接收中…」，自己那句下面不加小字；
        # 送到了变成「思考中」，从送到那一刻算秒数，每秒走；电脑在睡时写「唤醒中」（不写「唤醒云电脑」，也不另外冒状态栏）
        pt = await page(b)
        xt = await xin_mock(pt, authed=True, live=[[{'t': 'user', 'text': '想一想'}], [], [], [{'t': 'text', 'text': '想好了。'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 5000}]])
        xt['send_delay'] = 1.5
        await pt.goto(BASE + '/#xin'); await pt.wait_for_selector('.xc.show .xc-row textarea'); await pt.wait_for_timeout(300)
        await pt.fill('.xc-row textarea', '想一想'); await pt.keyboard.press('Enter'); await pt.wait_for_timeout(400)
        s1 = await pt.evaluate("[(document.querySelector('.xc-typing-l') || {}).textContent, document.querySelector('.xc-sub').textContent, document.querySelector('.xc-me').textContent, !!document.querySelector('.xc-me.pending')]")
        await pt.wait_for_function("!document.querySelector('.xc-me.pending')", timeout=5000)
        s2 = await pt.evaluate("[document.querySelector('.xc-typing-l').textContent, document.querySelector('.xc-sub').textContent]")
        await pt.wait_for_timeout(1150); l1 = await pt.text_content('.xc-typing-l')
        await pt.wait_for_timeout(1000); l2 = await pt.text_content('.xc-typing-l')
        sec = lambda t: int(t.split(' · ')[1].split(' ')[0]) if ' · ' in t else -1
        check('发出去还没送到：「正在输入」旁边写「接收中」、标题栏「接收中…」，自己那句下面没有小字', s1 == ['接收中', '接收中…', '想一想', True], s1)
        check('送到了：变成「思考中」、标题栏「思考中…」；秒数从送到那一刻算、每秒走一下',
              s2[0].startswith('思考中') and s2[1] == '思考中…' and l1.startswith('思考中 · ') and 1 <= sec(l1) <= 2 and sec(l2) == sec(l1) + 1, (s2, l1, l2))
        await pt.wait_for_function(CHAT_DONE, timeout=8000)
        xt['send_waking'] = 1; xt['send_delay'] = 1.5; xt['polls'] = 0   # 第二句从头再放一遍进度（不然第一次取进度就是做完了）
        await pt.fill('.xc-row textarea', '再想一想'); await pt.keyboard.press('Enter')
        await pt.wait_for_function("(document.querySelector('.xc-typing-l') || {}).textContent === '唤醒中'", timeout=3000)
        s3 = await pt.evaluate("[document.querySelector('.xc-sub').textContent, document.querySelector('.xc-st').hidden, document.querySelector('.xc').innerText.includes('云电脑'), [...document.querySelectorAll('.xc-me')].pop().textContent]")
        await pt.wait_for_function("((document.querySelector('.xc-typing-l') || {}).textContent || '').startsWith('思考中')", timeout=6000)
        check('电脑在睡：「正在输入」旁边和标题栏写「唤醒中」，不写「唤醒云电脑」、不冒状态栏；叫醒发出去以后变成「思考中」',
              s3 == ['唤醒中…', True, False, '再想一想'] and xt['sent'].get('text') == '再想一想', (s3, xt['sent']))
        await pt.context.close()
        # 上一句还在跑（多标签）：send 回 soft busy → 输入还原、提示请稍后再试、打开同一对话，不把发送状态弄脏
        pb = await page(b)
        xb = await xin_mock(pb, authed=True)
        await pb.goto(BASE + '/#xin'); await pb.wait_for_selector('.xc.show .xc-row textarea'); await pb.wait_for_timeout(300)
        await pb.fill('.xc-row textarea', '先发一句'); await pb.keyboard.press('Enter')
        await pb.wait_for_function(CHAT_DONE, timeout=8000)
        xb['send_busy'] = 1; xb['sent'] = None; xb['history_sid'] = None
        await pb.fill('.xc-row textarea', '忙的时候再发')
        assert await pb.input_value('.xc-row textarea') == '忙的时候再发'
        await pb.click('.xc-send')   # 点发送，避免 Enter 和 submit 抢两次
        # 软错误：pending 消失、busy_args 记下、重新拉 history；输入应还原
        await pb.wait_for_function("!document.querySelector('.xc-me.pending') && !LimingXinChat.state.sending", timeout=8000)
        for _ in range(20):
            if xb.get('busy_args') and xb.get('history_sid'): break
            await pb.wait_for_timeout(100)
        st = await pb.evaluate("""({
          text: document.querySelector('.xc-row textarea').value,
          pending: !!document.querySelector('.xc-me.pending'),
          run: LimingXinChat.state.run || '',
          sending: !!LimingXinChat.state.sending,
          sid: LimingXinChat.state.sid || '',
          err: [...document.querySelectorAll('.xc-err,.xc-sys')].map(e => e.textContent)
        })""")
        check('上一句还在跑：输入还在、没有 pending、没在发送；软错误不会当成发送成功，并重新打开同一对话',
              st['text'] == '忙的时候再发' and not st['pending'] and not st['sending'] and not st['run']
              and xb.get('sent') is None and (xb.get('busy_args') or {}).get('text') == '忙的时候再发'
              and xb.get('history_sid') == 'snew000001' and st['sid'] == 'snew000001', (st, xb.get('busy_args'), xb.get('history_sid'), xb.get('sent')))
        await pb.context.close()
        # 不开面板：背包「聊天」→ 小芯旁边的输入框 → 回复在小芯头上的气泡里，点气泡才打开面板
        pq = await page(b)
        xq = await xin_mock(pq, authed=True)
        await pq.goto(BASE + '/'); await pq.wait_for_timeout(1800)
        await pq.evaluate("LimingXin.bag()"); await pq.click('.xin-bag .xin-it:has-text("聊天")')
        await pq.wait_for_selector('.xin-ask')
        st = await pq.evaluate("[!!document.querySelector('.xc.show'), document.activeElement === document.querySelector('.xin-ask textarea'), (() => { const r = document.querySelector('.xin-ask').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; })()]")
        check('背包「聊天」：小芯旁边冒输入框（不弹面板），光标在框里，框在屏幕内', st == [False, True, True], st)
        check('登录了：一打开网页就叫醒云电脑（wake）', 'wake' in xq['ops'], xq['ops'])
        await pq.fill('.xin-ask textarea', '看看工作目录'); await pq.keyboard.press('Enter')
        await pq.wait_for_timeout(400)
        st = await pq.evaluate("[!!document.querySelector('.xin-ask'), !!document.querySelector('.xc.show'), LimingXin.aiState]")
        check('输入框里回车：框收起，面板不弹，小芯开始干活', st == [False, False, 'work'] and xq['sent'] and xq['sent'].get('text') == '看看工作目录', (st, xq['sent']))
        await pq.wait_for_function("(() => { const b = document.querySelector('.xin-say[data-tap]'); return b && b.textContent.includes('blink'); })()", timeout=10000)
        await pq.click('.xin-say[data-tap]'); await pq.wait_for_selector('.xc.show .xc-code')
        check('回复出现在小芯的气泡里，点气泡打开面板看全文', await pq.is_visible('.xc.show'))
        await pq.context.close()
        # 回归：输入框发出去、还在跑的时候打开面板（重读历史时那一轮已做完）→ 不能卡在「还在忙」，第二句要发得出去
        ps = await page(b)
        xs2 = await xin_mock(ps, authed=True)
        await ps.goto(BASE + '/'); await ps.wait_for_timeout(1500)
        await ps.evaluate("LimingXin.bag()"); await ps.click('.xin-bag .xin-it:has-text("聊天")')
        await ps.fill('.xin-ask textarea', '第一句'); await ps.keyboard.press('Enter'); await ps.wait_for_timeout(500)
        await ps.evaluate("LimingXinChat.open()"); await ps.wait_for_selector('.xc.show .xc-code'); await ps.wait_for_timeout(600)
        st = await ps.evaluate("[LimingXinChat.state.run, document.querySelector('.xc').classList.contains('running')]")
        await ps.fill('.xc-row textarea', '第二句'); await ps.keyboard.press('Enter'); await ps.wait_for_timeout(600)
        check('还在跑时打开面板：以历史为准，不卡在「还在忙」，第二句发得出去', st == ['', False] and (xs2['sent'] or {}).get('text') == '第二句', (st, xs2['sent']))
        await ps.context.close()
        # 见面打招呼：小芯留的那句话在打开网页时冒出来；同一句只说一次
        pgr = await page(b)
        xg = await xin_mock(pgr, authed=True)
        xg['greet'] = {'id': 'g0000001', 'text': '今天签到好啦，连签 10 天', 'at': 0}
        await pgr.goto(BASE + '/')
        await pgr.wait_for_function("(() => { const b = document.querySelector('.xin-say'); return b && b.textContent.includes('签到好啦'); })()", timeout=10000)
        st = await pgr.evaluate("[localStorage.getItem('lm.xin.greeted'), document.querySelector('.xin-say').hasAttribute('data-tap')]")
        check('见面打招呼：打开网页时小芯说出它留的话（能点），记下说过了', st[0] == 'g0000001' and st[1] and 'greet' in xg['ops'], (st, xg['ops']))
        await pgr.click('.xin-say[data-tap]'); await pgr.wait_for_selector('.xin-ask')
        check('点打招呼的气泡：冒输入框回它一句', await pgr.is_visible('.xin-ask textarea'))
        await pgr.reload(); await pgr.wait_for_timeout(2500)
        again = await pgr.evaluate("(() => { const b = document.querySelector('.xin-say'); return !!b && b.textContent.includes('签到好啦'); })()")
        check('见面打招呼：同一句刷新以后不再说', not again)
        # 每日任务页：看清单、改了保存、现在就做一遍（打开那段对话）
        await pgr.evaluate("LimingXinChat.open()"); await pgr.wait_for_selector('.xc.show')
        await pgr.click('.xc-list-b'); await pgr.wait_for_selector('.xc-dailyb')
        await pgr.click('.xc-dailyb'); await pgr.wait_for_selector('.xc-memt')
        v = await pgr.input_value('.xc-memt')
        stt = await pgr.text_content('.xc-dailyst')
        await pgr.fill('.xc-memt', v + '- 提醒我复习定时器\n'); await pgr.click('.xc-memrow .xc-btn:not(.xc-btn2)'); await pgr.wait_for_timeout(300)
        check('每日任务页：看到清单和最近一次结果，改了能保存', '签到' in v and '做完了' in stt and xg['daily'].endswith('提醒我复习定时器\n'), (v, stt, xg['daily']))
        await pgr.click('.xc-btn2'); await pgr.wait_for_selector('.xc.show .xc-body:not([hidden]) .xc-code')
        check('每日任务页：「现在就做一遍」强制开一轮，并打开那段对话', xg['daily_args'] == {'force': True} and await pgr.evaluate("LimingXinChat.state.view") == 'chat', xg['daily_args'])
        await pgr.context.close()
        # 对话改名 / 删除、小芯的文件（预览、下载）、回答里的路径点了打开
        pf = await page(b)
        xf = await xin_mock(pf, authed=True)
        await pf.goto(BASE + '/'); await pf.wait_for_timeout(1200)
        await pf.evaluate("LimingXinChat.open()"); await pf.wait_for_selector('.xc.show .xc-hello')
        await pf.fill('.xc-row textarea', '写个点灯程序'); await pf.keyboard.press('Enter'); await pf.wait_for_function(CHAT_DONE, timeout=8000)
        await pf.click('.xc-list-b'); await pf.wait_for_selector('.xc-sli'); await pf.wait_for_timeout(350)   # 等侧边栏滑完
        tiles = await pf.evaluate("[...document.querySelectorAll('.xc-nav .xc-memb')].map(b => b.textContent)")
        dr = await pf.evaluate("""(() => { const d = document.querySelector('.xc-drawer').getBoundingClientRect(), p = document.querySelector('.xc').getBoundingClientRect();
          return [document.querySelector('.xc').classList.contains('dr-open'), Math.round(d.left - p.left), d.width < p.width, !!document.querySelector('.xc-dr .xc-dr-new'), document.querySelector('.xc-set').hidden,
            getComputedStyle(document.querySelector('.xc-scrim')).opacity, document.querySelector('.xc-list-b').getAttribute('aria-expanded'), !document.querySelector('.xc-body').hidden]; })()""")
        check('☰ 拉开侧边栏：从面板左边滑出来、比面板窄，后面一层遮罩，聊天还在下面；上面「新对话」，四个入口：记事本、每日任务、后台任务、小芯的文件；设置收着', tiles == ['小芯的记事本', '每日任务', '后台任务', '小芯的文件'] and 0 <= dr[1] <= 2 and dr[:1] + dr[2:] == [True, True, True, True, '1', 'true', True], (tiles, dr))   # 宽屏面板左边有 2px 边框，侧边栏贴着它
        await pf.click('.xc-sli:nth-child(1) .xc-si-more'); await pf.wait_for_selector('.xc-sa input')
        await pf.fill('.xc-sa input', '点灯程序'); await pf.click('.xc-sa-b:has-text("改名")'); await pf.wait_for_timeout(300)
        t = await pf.text_content('.xc-sli:nth-child(1) .xc-si-t')
        check('对话 ⋯ 改名：传给后台，列表里马上变', xf['renamed'] == {'sid': 'shist00001', 'title': '点灯程序'} and t == '点灯程序' and not await pf.is_visible('.xc-sa'), (xf['renamed'], t))
        await pf.click('.xc-sli:nth-child(2) .xc-si-more'); await pf.wait_for_selector('.xc-sa-del')
        await pf.click('.xc-sa-del'); await pf.wait_for_timeout(200)
        armed = await pf.text_content('.xc-sa-del'); n1 = await pf.evaluate("document.querySelectorAll('.xc-sli').length")
        await pf.click('.xc-sa-del'); await pf.wait_for_timeout(300)
        n2 = await pf.evaluate("document.querySelectorAll('.xc-sli').length")
        check('对话 ⋯ 删除：第一下变「确定删除？」，第二下才删', armed == '确定删除？' and n1 == 2 and n2 == 1 and xf['forgot'] == {'sid': 'sold000001'}, (armed, n1, n2, xf['forgot']))
        await pf.click('.xc-filesb'); await pf.wait_for_selector('.xc-fi')
        names = await pf.evaluate("[...document.querySelectorAll('.xc-fi-n')].map(e => e.textContent)")
        await pf.click('.xc-fi:has-text("blink")'); await pf.wait_for_selector('.xc-crumb')
        await pf.click('.xc-fi:has-text("build")'); await pf.wait_for_selector('.xc-fi:has-text("app.hex")')
        crumbs = await pf.text_content('.xc-crumbs')
        await pf.click('.xc-fi:has-text("app.hex")'); await pf.wait_for_selector('.xc-pre')
        pre = await pf.text_content('.xc-pre')
        check('小芯的文件：一层层点进文件夹，面包屑写着在哪，点 .hex 能预览', names == ['blink', 'notes.md'] and crumbs.replace(' ', '') == '工作目录›blink›build' and pre.startswith(':02000004'), (names, crumbs, pre[:30]))
        async with pf.expect_download() as dl:
            await pf.click('.xc-memrow .xc-btn:has-text("下载")')
        d = await dl.value
        await pf.wait_for_timeout(200)
        check('小芯的文件：点「下载」存成 app.hex', d.suggested_filename == 'app.hex' and xf['download'] == W + '/blink/build/app.hex' and '下载好了' in await pf.text_content('.xc-memrow'), (d.suggested_filename, xf['download']))
        await pf.click('.xc-crumb:has-text("build")'); await pf.wait_for_selector('.xc-fi:has-text("app.bin")')
        await pf.click('.xc-fi:has-text("app.bin")'); await pf.wait_for_selector('.xc-fmeta')
        check('二进制文件不预览，只给下载', '不是文字文件' in await pf.text_content('.xc-sess') and not await pf.is_visible('.xc-pre'))
        await pf.click('.xc-crumb:has-text("blink")'); await pf.wait_for_selector('.xc-fi:has-text("main.c")')
        await pf.click('.xc-fi:has-text("main.c")'); await pf.wait_for_selector('.xc-pre')
        st = await pf.evaluate("[document.querySelector('.xc-pre').textContent, [...document.querySelectorAll('.xc-pre .hl-pre, .xc-pre .hl-kw, .xc-pre .hl-mc')].map(e => e.textContent)]")
        check('小芯的文件：.c 文件的预览也上色（预处理、关键字、寄存器宏）', st[0].startswith('#include') and '#include' in st[1] and 'int' in st[1] and 'GPIOA' in st[1], st)
        await pf.click('.xc-back'); await pf.wait_for_selector('.xc-sli')
        await pf.click('.xc-si'); await pf.wait_for_selector('.xc-path')
        await pf.click('.xc-path'); await pf.wait_for_selector('.xc-pre')
        back = await pf.text_content('.xc-back')
        check('回答里的 /data/workspace/… 路径点一下打开那个文件', '回到对话' in back and 'app.hex' in await pf.text_content('.xc-crumbs'), back)
        await pf.click('.xc-back'); await pf.wait_for_timeout(200)
        check('「← 回到对话」回到刚才的对话', await pf.evaluate("LimingXinChat.state.view") == 'chat' and await pf.is_visible('.xc-path'))
        await pf.click('.xc-list-b'); await pf.wait_for_selector('.xc-sli'); await pf.wait_for_timeout(300)
        await pf.mouse.click(5 + (await pf.evaluate("document.querySelector('.xc').getBoundingClientRect().right")) - 30, 300); await pf.wait_for_timeout(350)
        s1 = await pf.evaluate("[document.querySelector('.xc').classList.contains('dr-open'), getComputedStyle(document.querySelector('.xc-drawer')).visibility, !!document.querySelector('.xc.show')]")
        await pf.click('.xc-list-b'); await pf.wait_for_selector('.xc-sli'); await pf.keyboard.press('Escape'); await pf.wait_for_timeout(350)
        s2 = await pf.evaluate("[document.querySelector('.xc').classList.contains('dr-open'), !!document.querySelector('.xc.show')]")
        check('侧边栏：点旁边的遮罩收起、按 Esc 只收侧边栏不关面板', s1 == [False, 'hidden', True] and s2 == [False, True], (s1, s2))
        # 对话多了：只露最近 5 个和正在看的那个，其余收在「更多对话」里；展开、收起；删掉一个以后后面的补上来
        xf['many'] = 9
        await pf.evaluate("LimingXinChat.state.sid = 'shist00001'")
        await pf.click('.xc-list-b'); await pf.wait_for_selector('.xc-sli'); await pf.wait_for_timeout(350)
        vis = "[...document.querySelectorAll('.xc-sli')].filter(e => !e.hidden).map(e => e.querySelector('.xc-si-t').textContent)"
        f1 = await pf.evaluate("[" + vis + ", document.querySelector('.xc-more-b').textContent, document.querySelector('.xc-dr-h').textContent, document.querySelectorAll('.xc-sli').length]")
        await pf.click('.xc-more-b'); await pf.wait_for_timeout(100)
        f2 = await pf.evaluate("[" + vis + ".length, document.querySelector('.xc-more-b').textContent, document.querySelector('.xc-more-b').getAttribute('aria-expanded')]")
        await pf.click('.xc-more-b'); await pf.wait_for_timeout(100)
        f3 = await pf.evaluate(vis + ".length")
        await pf.click('.xc-sli:nth-child(1) .xc-si-more'); await pf.wait_for_selector('.xc-sa-del')
        await pf.click('.xc-sa-del'); await pf.click('.xc-sa-del'); await pf.wait_for_timeout(300)
        f4 = await pf.evaluate("[" + vis + ", document.querySelector('.xc-more-b').textContent]")
        check('对话多了侧边栏不拉长：只露最近 5 个和正在看的那个（排第 7），「更多对话（3）」展开全部、「收起」收回；删掉一个后面的补上来',
              f1 == [['对话 1', '对话 2', '对话 3', '对话 4', '对话 5', '对话 7'], '更多对话（3）', '最近的对话 · 9', 9] and f2 == [9, '收起', 'true'] and f3 == 6
              and f4 == [['对话 2', '对话 3', '对话 4', '对话 5', '对话 6', '对话 7'], '更多对话（2）'], (f1, f2, f3, f4))
        await pf.click('.xc-dr-x'); await pf.wait_for_timeout(300)
        xf['many'] = 0
        # 归档：⋯ 里「归档」→ 收进「已归档（1）」（默认收着），点开能看到；在那里「取消归档」→ 放回最近的对话
        await pf.click('.xc-list-b'); await pf.wait_for_selector('.xc-sli'); await pf.wait_for_timeout(350)
        main = "[...document.querySelectorAll('.xc-sl-main .xc-sli')].map(e => e.querySelector('.xc-si-t').textContent)"
        a0 = await pf.evaluate("[" + main + ", !document.querySelector('.xc-arch-b').hidden]")
        await pf.click('.xc-sl-main .xc-sli:nth-child(2) .xc-si-more'); await pf.wait_for_selector('.xc-sa-arc')
        btns = await pf.evaluate("[...document.querySelectorAll('.xc-sa .xc-sa-b')].map(b => b.textContent)")
        await pf.click('.xc-sa-arc'); await pf.wait_for_timeout(200)
        a1 = await pf.evaluate("[" + main + ", document.querySelector('.xc-arch-b').textContent, document.querySelector('.xc-sl-arch').hidden]")
        await pf.click('.xc-arch-b'); await pf.wait_for_timeout(150)
        a2 = await pf.evaluate("[[...document.querySelectorAll('.xc-sl-arch .xc-si-t')].map(e => e.textContent), document.querySelector('.xc-sl-arch').hidden]")
        await pf.click('.xc-sl-arch .xc-si-more'); await pf.wait_for_selector('.xc-sa-arc')
        unarc = await pf.text_content('.xc-sa-arc')
        await pf.click('.xc-sa-arc'); await pf.wait_for_timeout(200)
        a3 = await pf.evaluate("[" + main + ", document.querySelector('.xc-arch-b').hidden]")
        check('归档：⋯ 里有改名、归档、删除；归档后收进「已归档（1）」（默认收着），点开看得到；在那里取消归档放回最近的对话',
              a0 == [['编译 main.c', '旧对话'], False] and btns == ['改名', '归档', '删除'] and a1 == [['编译 main.c'], '已归档（1）', True]
              and a2 == [['旧对话'], False] and unarc == '取消归档' and a3 == [['编译 main.c', '旧对话'], True]
              and xf.get('archived') == [{'sid': 'sold000001', 'on': True}, {'sid': 'sold000001', 'on': False}], (a0, btns, a1, a2, unarc, a3, xf.get('archived')))
        await pf.click('.xc-dr-x'); await pf.wait_for_timeout(300)
        await pf.click('.xc-x'); await pf.wait_for_timeout(400)
        await pf.evaluate("LimingXin.bag()"); await pf.click('.xin-bag .xin-it:has-text("聊天")'); await pf.wait_for_selector('.xin-ask')
        btns = await pf.evaluate("[...document.querySelectorAll('.xin-ask button')].map(b => b.getAttribute('aria-label') || b.textContent.trim())")
        check('小芯旁边的输入框：只有说话、发送、展开（没有「考考我」「朗读」）', '考考我' not in btns and '朗读' not in btns and '发送' in btns and '展开' in btns, btns)
        await pf.context.close()
        # 学会的新动作、好感度
        pm = await page(b)
        xm = await xin_mock(pm, authed=True, live=XIN_LIVE_BOND)
        xm['greet'] = {'warming': False, 'bond': XIN_BOND, 'moves': [XIN_MOVE]}
        xm['bond'] = XIN_BOND
        await pm.goto(BASE + '/'); await pm.wait_for_function("LimingXin.learned.length === 1", timeout=10000)
        await pm.wait_for_function("LimingXin.mode === 'idle'", timeout=8000)
        items = await pm.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent))")
        await pm.click('.xin-bag .xin-it:has-text("新动作")'); await pm.wait_for_timeout(150)
        st = await pm.evaluate("[LimingXin.mode, (document.querySelector('.xin-say') || {}).textContent]")
        check('新动作：打开网页时学会小芯编的动作，背包里「新动作」点了就做，头上说名字', '新动作' in items and st == ['play', '打招呼'], (items, st))
        rb = await pm.evaluate("(() => { const r = [LimingXin.rebel]; LimingXin.obedient = false; r.push(LimingXin.rebel); LimingXin.bond(0); r.push(LimingXin.rebel); LimingXin.bond(3); r.push(LimingXin.rebel); LimingXin.obedient = true; r.push(LimingXin.rebel); return r; })()")
        check('好感度：越熟越听话（叛逆概率 刚认识 0.3 → 好朋友 0.14 → 最好的朋友 0.08），测试里一直不叛逆', rb == [0, 0.14, 0.3, 0.08, 0], rb)
        await pm.wait_for_function("LimingXin.mode === 'idle'", timeout=8000)
        await pm.evaluate("LimingXin.bag()"); await pm.click('.xin-bag .xin-it:has-text("饼干")'); await pm.wait_for_timeout(400)
        check('好感度：在网页上喂小芯吃饼干，告诉它的电脑（加好感）', xm.get('played') == {'kind': 'cookie'}, xm.get('played'))
        await pm.evaluate("LimingXinChat.open()"); await pm.wait_for_selector('.xc.show')
        await pm.click('.xc-list-b'); await pm.wait_for_selector('.xc-bond-b')
        bt = await pm.text_content('.xc-bond-b')
        await pm.click('.xc-bond-b'); await pm.wait_for_timeout(150)
        logs = await pm.evaluate("[...document.querySelectorAll('.xc-bond-log li')].map(l => l.textContent)")
        check('对话列表上面显示关系和好感度，点开看最近的变化', bt.startswith('♥♥♥♡ 好朋友 · 好感度 5') and '升一级' in bt and len(logs) == 2 and '+1陪我聊天' in logs[0] and '-1你凶我' in logs[1], (bt, logs))
        await pm.click('.xc-dr-new'); await pm.wait_for_selector('.xc-hello')   # 侧边栏里的「新对话」：开新对话并收起侧边栏
        check('侧边栏里点「新对话」：开新对话、侧边栏收起', not await pm.evaluate("document.querySelector('.xc').classList.contains('dr-open')"))
        await pm.fill('.xc-row textarea', '学个转圈'); await pm.keyboard.press('Enter')
        await pm.wait_for_function(CHAT_DONE, timeout=8000); await pm.wait_for_timeout(200)
        notes = await pm.evaluate("[...document.querySelectorAll('.xc-sys')].map(n => n.textContent)")
        st = await pm.evaluate("[LimingXin.learned, LimingXinChat.state.bond.score]")
        check('聊天里小芯学会新动作（马上教给页面上的小芯）、好感度 +2，各一个小提示', '学会了新动作：转圈' in notes and '好感度 +2 · 你教我新动作' in notes and st == [['打招呼', '转圈'], 54], (notes, st))
        await pm.context.close()
        # 小芯的屏幕：观看 → 接管 → 关掉（接管过就作废链接）
        pw = await page(b)
        xw = await xin_mock(pw, authed=True)
        await pw.goto(BASE + '/'); await pw.wait_for_timeout(1000)
        await pw.evaluate("LimingXinChat.open()"); await pw.wait_for_selector('.xc.show .xc-scr-b')
        await pw.click('.xc-scr-b'); await pw.wait_for_function("(() => { const f = document.querySelector('.xs .xs-fr'); return f && !f.hidden && f.src.includes('/icons/icon-192.png'); })()", timeout=8000)
        st = await pw.evaluate("""[!document.querySelector('.xs').hidden, document.querySelector('.xs-mode [aria-checked=true]').dataset.mode, document.querySelector('.xs-tip').textContent,
          (() => { const r = document.querySelector('.xs-fr').getBoundingClientRect(); return r.width >= innerWidth - 1 && r.height > innerHeight * 0.6; })(), document.body.classList.contains('xs-open')]""")
        check('小芯的屏幕：标题栏点「屏幕」全屏打开它的桌面，默认只看（提示说怎么接管），画面占满', xw['screen'] == [{'control': False}] and st[:2] == [True, 'view'] and '接管' in st[2] and st[3] and st[4], (xw['screen'], st))
        await pw.click('.xs-mode [data-mode=ctl]'); await pw.wait_for_function("document.querySelector('.xs .xs-fr').src.includes('ctl=1')", timeout=8000)
        st = await pw.evaluate("[document.querySelector('.xs-mode [aria-checked=true]').dataset.mode, document.querySelector('.xs').classList.contains('ctl'), document.querySelector('.xs-tip').textContent]")
        check('小芯的屏幕：点「接管」换成能操作的链接，提示变成接管中', xw['screen'][-1] == {'control': True} and st[:2] == ['ctl', True] and '接管中' in st[2], (xw['screen'], st))
        await pw.click('.xs-x'); await pw.wait_for_timeout(300)
        st = await pw.evaluate("[document.querySelector('.xs').hidden, document.querySelector('.xs-fr').src, document.body.classList.contains('xs-open')]")
        check('小芯的屏幕：关掉，接管过就让后台把链接全部作废', st == [True, 'about:blank', False] and 'screen_off' in xw['ops'], (st, xw['ops'][-3:]))
        await pw.context.close()
        # 做完提醒、通知点进来的 #xin=<对话>
        pv = await page(b)
        await pv.context.grant_permissions(['notifications'], origin=BASE)
        await pv.add_init_script(FAKE_PUSH)
        xv = await xin_mock(pv, authed=True)
        await pv.goto(BASE + '/'); await pv.wait_for_timeout(1200)
        await pv.evaluate("LimingXinChat.open()"); await pv.wait_for_selector('.xc.show .xc-hello')
        await pv.click('.xc-list-b'); await pv.wait_for_selector('.xc-set-b')
        await pv.click('.xc-set-b'); await pv.wait_for_selector('.xc-set')
        rows = await pv.evaluate("[...document.querySelectorAll('.xc-tg-t b')].map(b => b.textContent)")
        await pv.wait_for_function("document.querySelector('.xc-push .xc-sw').getAttribute('aria-checked') === 'false' && !document.querySelector('.xc-push .xc-sw').disabled")
        check('设置：天启模式、附带正在看的页面、做完提醒（模型、思考强度在输入框底下；没有「朗读回答」了），做完提醒默认关着', rows == ['天启模式', '附带正在看的页面', '做完提醒'], rows)
        c0 = await pv.evaluate("document.querySelector('.xc-ctxauto .xc-sw').getAttribute('aria-checked')")
        await pv.click('.xc-ctxauto .xc-sw')
        c1 = await pv.evaluate("[document.querySelector('.xc-ctxauto .xc-sw').getAttribute('aria-checked'), localStorage.getItem('lm.xin.ctx')]")
        await pv.click('.xc-ctxauto .xc-sw')
        c2 = await pv.evaluate("[document.querySelector('.xc-ctxauto .xc-sw').getAttribute('aria-checked'), localStorage.getItem('lm.xin.ctx')]")
        check('设置：「附带正在看的页面」默认开着，关掉记在浏览器里，再点打开', c0 == 'true' and c1 == ['false', '0'] and c2 == ['true', None], (c0, c1, c2))
        await pv.click('.xc-push .xc-sw'); await pv.wait_for_function("document.querySelector('.xc-push .xc-sw').getAttribute('aria-checked') === 'true'")
        await pv.wait_for_timeout(300)
        note = await pv.text_content('.xc-push .xc-tg-n')
        opts = await pv.evaluate("(() => { const o = window.__subOpts; return [o.userVisibleOnly, o.applicationServerKey.length, o.applicationServerKey[0], o.applicationServerKey[64]]; })()")
        check('做完提醒：打开时用小芯电脑的公钥订阅，订阅交给它保存，再发一条试试', xv['push_sub'] and xv['push_sub']['sub']['endpoint'] == 'https://push.example.com/send/abc' and xv['push_test'] == 1 and opts == [True, 65, 4, 63] and '开好了' in note, (xv['push_sub'], xv['push_test'], opts, note))
        sw = await pv.evaluate("navigator.serviceWorker.getRegistration().then(r => r && r.active && r.active.scriptURL)")
        check('做完提醒：注册了 /sw.js', (sw or '').endswith('/sw.js'), sw)
        await pv.click('.xc-push .xc-sw'); await pv.wait_for_function("document.querySelector('.xc-push .xc-sw').getAttribute('aria-checked') === 'false'")
        check('做完提醒：再点关掉，退订并告诉小芯那边删掉', xv['push_unsub'] == {'endpoint': 'https://push.example.com/send/abc'} and await pv.evaluate("window.__sub === null"), xv['push_unsub'])
        await pv.context.close()
        ph = await page(b)
        xh = await xin_mock(ph, authed=True)
        await ph.goto(BASE + '/#xin=shist00001'); await ph.wait_for_selector('.xc.show .xc-code')
        check('点「做完提醒」的通知进来（#xin=对话）：直接打开那段对话', xh['history_sid'] == 'shist00001' and await ph.evaluate("localStorage.getItem('lm.xin.sid')") == 'shist00001', xh['history_sid'])
        await ph.click('.xc-x'); await ph.wait_for_timeout(300)
        check('关上面板时把 #xin=… 从地址里去掉', not ph.url.endswith('#xin=shist00001'), ph.url)
        await ph.context.close()
        # 附带页面信息：学习台「验证」页、粘贴的代码、选中的文字，一起发给小芯；✕ 这次不带
        pc = await page(b)
        xc = await xin_mock(pc, authed=True)
        await pc.goto(BASE + '/'); await pc.wait_for_timeout(1200)
        await pc.click('.card[data-id=stm32]', position={'x': 20, 'y': 20}); f = await tool_frame(pc)
        await f.goto(BASE + '/tools/stm32/?embed=1&v=lab&t=tim&st=check'); await pc.wait_for_timeout(300)
        f = await tool_frame(pc)
        await f.fill('.lab-ta', 'TIM5->PSC = 71;')
        await f.evaluate("(() => { const h = document.querySelector('#main h1, #main h2, #main h3'); const r = document.createRange(); r.selectNodeContents(h); const s = getSelection(); s.removeAllRanges(); s.addRange(r); window.__selTxt = String(s).trim(); })()")
        sel = await f.evaluate("window.__selTxt")
        await pc.evaluate("LimingXinChat.open()"); await pc.wait_for_selector('.xc.show .xc-ctx:not([hidden])')
        chip = await pc.text_content('.xc-ctx span')
        check('附带：学习台里打开聊天，输入框上面写着在哪一页、选中了什么、你写的代码', '验证' in chip and '选中' in chip and '你写的代码' in chip, chip)
        await pc.fill('.xc-row textarea', '我这样写对吗'); await pc.keyboard.press('Enter')
        await pc.wait_for_selector('.xc-me .xc-ctxm')
        ctx = (xc['sent'] or {}).get('context') or ''
        check('附带：页面、选中的文字、验证里的代码都传给后台，自己的话下面显示附带了什么',
              '【用户正在看】STM32 学习台' in ctx and '验证' in ctx and sel and sel in ctx and 'TIM5->PSC = 71;' in ctx and xc['sent'].get('text') == '我这样写对吗' and xc['sent'].get('ctxLabel'),
              (sel, ctx[:200], xc['sent'].get('ctxLabel')))
        await pc.wait_for_function(CHAT_DONE, timeout=8000)
        await pc.click('.xc-ctx button')
        h1 = await pc.evaluate("document.querySelector('.xc-ctx').hidden")
        # 点了 ✕：接着发也不带，发完也不再冒出来；关了面板再打开还是不带（以前发完一句就又出来了）
        await pc.fill('.xc-row textarea', '再问一句'); await pc.click('.xc-send')
        await pc.wait_for_function("LimingXinChat.state.sending === false && document.querySelectorAll('.xc-me').length >= 2", timeout=8000)
        await pc.wait_for_function(CHAT_DONE, timeout=8000)
        sent2 = dict(xc['sent'] or {})
        h2 = await pc.evaluate("document.querySelector('.xc-ctx').hidden")
        await pc.click('.xc-x'); await pc.wait_for_timeout(300)
        await pc.evaluate("LimingXinChat.open()"); await pc.wait_for_timeout(400)
        h3 = await pc.evaluate("document.querySelector('.xc-ctx').hidden")
        check('附带：点 ✕ 以后在这一页一直不带：接着发不带、发完不再冒出来、重新打开面板也不带',
              h1 and sent2.get('text') == '再问一句' and 'context' not in sent2 and h2 and h3, (h1, sent2, h2, h3))
        # 自己取消选中（点了页面别处）→ 不再带上次选的
        await pc.click('.xc-x'); await pc.wait_for_timeout(300)
        await f.evaluate("(() => { const h = document.querySelector('#main h1, #main h2, #main h3'); const r = document.createRange(); r.selectNodeContents(h); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()")
        await pc.wait_for_timeout(100)
        await pc.evaluate("LimingXinChat.open()"); await pc.wait_for_selector('.xc.show .xc-ctx:not([hidden])')
        had = await pc.text_content('.xc-ctx span')
        await pc.click('.xc-x'); await pc.wait_for_timeout(300)
        await f.click('#main h1, #main h2, #main h3', position={'x': 2, 'y': 2}); await pc.wait_for_timeout(200)
        await pc.evaluate("LimingXinChat.open()"); await pc.wait_for_selector('.xc.show .xc-ctx:not([hidden])')
        now = await pc.text_content('.xc-ctx span')
        check('附带：选中后带上；点页面别处取消选中以后不再带', '选中' in had and '选中' not in now, (had, now))
        # 关掉学习台以后，学习台里选过的也不带
        await pc.click('.xc-x'); await pc.wait_for_timeout(300)
        await f.evaluate("(() => { const h = document.querySelector('#main h1, #main h2, #main h3'); const r = document.createRange(); r.selectNodeContents(h); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()")
        while await pc.evaluate("!!document.querySelector('.panel.show .back')"):
            await pc.evaluate("document.querySelector('.panel.show .back').click()"); await pc.wait_for_timeout(1500)
        await pc.evaluate("LimingXinChat.open()"); await pc.wait_for_timeout(500)
        st = await pc.evaluate("[document.body.classList.contains('tool-open'), document.querySelector('.xc-ctx').hidden, document.querySelector('.xc-ctx span').textContent]")
        check('附带：关掉学习台以后不带学习台里选的', st[:2] == [False, True], st)
        await pc.context.close()
        # 后台任务（分身）：前台派出去的卡片跟着轮询更新；做完了聊天最后小芯说结果；看过程、补充要求；有任务在做时输入框上面一条
        pt = await page(b)
        xt = await xin_mock(pt, authed=True, live=XIN_LIVE_TASK)
        now = int(time.time() * 1000)
        T1 = {'sid': 'stask00001', 'no': 1, 'parent': 'snew000001', 'title': '编译 LED', 'kind': 'code', 'model': 'glm-5.3', 'why': 'code', 'status': 'running', 'created': now - 130000,
              'startedAt': now - 130000, 'endedAt': 0, 'dir': '/data/workspace/blink', 'after': [], 'turns': 1, 'question': '', 'activity': '在执行：make'}
        xt['tasks'] = [T1]
        await pt.add_init_script("localStorage.setItem('lm.xin.agent.v','3');localStorage.setItem('lm.xin.agent','codex')")
        await pt.goto(BASE + '/#xin'); await pt.wait_for_selector('.xc.show .xc-row textarea'); await pt.wait_for_timeout(300)
        await pt.fill('.xc-row textarea', '编译一下 blink，后台做'); await pt.keyboard.press('Enter')
        await pt.wait_for_function(CHAT_DONE, timeout=8000)
        await pt.wait_for_function("document.querySelector('.xc-task-a') && document.querySelector('.xc-task-a').textContent === '在执行：make'", timeout=8000)
        cd = await pt.evaluate(TASK_CARD_JS)
        check('后台任务：派出去的地方一张卡片（任务 1 · 编译 LED、进行中 · 2 分钟、写代码 · GLM-5.3、在干什么、看过程 / 停止）；输入框上面一条「后台 1 个任务在做」',
              cd == ['任务 1 · 编译 LED', '进行中 · 2 分钟', '写代码 · GLM-5.3', '在执行：make', ['看过程', '停止'], True, True, '后台 1 个任务在做'], cd)
        T1.update({'status': 'done', 'endedAt': now, 'activity': '', 'result': {'ok': True, 'text': '我编好了：`/data/workspace/blink/build/app.hex`，直接烧录就行。', 'err': '', 'at': now}})
        await pt.evaluate("LimingXinChat.tasks()")
        await pt.wait_for_selector('.xc-tres')
        rs = await pt.evaluate(TASK_RES_JS)
        check('任务做完：卡片变「做完了」（停止按钮没了）；聊天最后小芯说结果（任务几、做完了、正文里的路径能点、模型和用时、看过程），任务条收起',
              rs == ['任务 1「编译 LED」做完了', '我编好了：/data/workspace/blink/build/app.hex，直接烧录就行。', 'GLM-5.3 · 用时 2 分钟', True, True, '做完了', ['看过程'], True], rs)
        await pt.evaluate("LimingXinChat.tasks()"); await pt.wait_for_timeout(400)
        check('同一次结果只说一次（再轮询不重复）', await pt.evaluate("document.querySelectorAll('.xc-tres').length") == 1)
        await pt.click('.xc-tres .xc-task-btn'); await pt.wait_for_selector('.xc-sheet .xc-tk-log')
        tk = await pt.evaluate(TASK_SHEET_JS)
        check('看过程：一页里写着状态、模型、工作目录（能点开）、要求、每一步说的话和执行的命令（去掉 bash 外壳，点开看输出）；做完的能补充要求让它接着做',
              tk[:3] == ['任务 1 · 编译 LED', '做完了写代码 · GLM-5.3', '/data/workspace/blink'] and tk[3] == '要求编译 blink 工程' and tk[4] == ['make'] and tk[5]
              and tk[6] == ['我先看看工程。', '编好了：/data/workspace/blink/build/app.hex'] and tk[7].startswith('补充要求') and tk[8] == '接着做', tk)
        await pt.fill('.xc-tk-in', '再加个呼吸灯'); await pt.click('.xc-tk-act .xc-btn')
        await pt.wait_for_function("document.querySelector('.xc-tk-note') && document.querySelector('.xc-tk-note').textContent === '任务 1 接着做了'")
        check('补充要求直接交给那个任务（不经过前台）', xt.get('task_tell') == {'sid': 'stask00001', 'text': '再加个呼吸灯'}, xt.get('task_tell'))
        await pt.click('.xc-sh-x'); await pt.wait_for_timeout(300)
        # 小芯在回上一句时发的话：先排着（灰色气泡「排队中」），回完一起发
        xt['polls'] = 0
        await pt.fill('.xc-row textarea', '先看看这个'); await pt.keyboard.press('Enter')
        await pt.wait_for_function("LimingXinChat.state.run")
        await pt.fill('.xc-row textarea', '再顺便看看那个')
        q0 = await pt.evaluate("document.querySelector('.xc-send').getAttribute('aria-label')")
        await pt.keyboard.press('Enter')
        q1 = await pt.evaluate("[document.querySelectorAll('.xc-me.queued').length, document.querySelector('.xc-me.queued .xc-qtag').textContent, document.querySelector('.xc-send').getAttribute('aria-label'), document.querySelector('.xc-row textarea').value]")
        await pt.wait_for_function("!document.querySelector('.xc-me.queued')", timeout=10000)
        await pt.wait_for_function(CHAT_DONE, timeout=10000)
        q2 = await pt.evaluate("[...document.querySelectorAll('.xc-me .xc-bub')].map(b => b.textContent).slice(-2)")
        check('小芯在回上一句：输入框有话按钮是「排队发送」，发了先排着（灰色气泡写「排队中」，能 ✕），这一句回完自动发出去',
              q0 == '排队发送' and q1[:3] == [1, '排队中 · 小芯说完这句就发✕', '停止'] and q1[3] == '' and xt['sent'].get('text') == '再顺便看看那个' and q2 == ['先看看这个', '再顺便看看那个'], (q0, q1, xt['sent'], q2))
        # 任务中心（侧边栏「后台任务」）：所有对话的任务（还没做完的 / 最近的，写着哪个对话派的）、每日任务、各模型最近 14 天
        T1.update({'status': 'done'})
        xt['tasks'].append({'sid': 'stask00002', 'no': 2, 'parent': 'snew000001', 'title': '检查：编译 LED', 'kind': 'review', 'model': 'kimi-k3.1-pro', 'why': 'review', 'status': 'queued',
                            'created': now, 'startedAt': 0, 'endedAt': 0, 'dir': '/data/workspace/blink', 'after': [1], 'turns': 0, 'question': ''})
        await pt.click('.xc-list-b'); await pt.wait_for_selector('.xc-tasksb')
        await pt.click('.xc-tasksb'); await pt.wait_for_selector('.xc-sess .xc-tl-i')
        tc = await pt.evaluate(TASK_CENTER_JS)
        check('任务中心：侧边栏「后台任务」打开，还没做完的在上（等任务 1 做完 · 检查 · Kimi）、最近的在下，写着在哪个对话派的；每日任务做得怎么样；各模型最近 14 天（用了几次、成了几次、平均多久、换过几次模型）',
              tc[0] == ['还没做完的', '最近的', '每日任务', '各模型最近 14 天'] and tc[1] == ['任务 2 · 检查：编译 LED', '任务 1 · 编译 LED'] and tc[2][0] == '等任务 1 做完检查 · Kimi K3.1 Pro'
              and tc[3] == ['在「编译一下 blink」里派的', '在「编译一下 blink」里派的'] and tc[4].startswith('最近一次：11-06 做完了') and tc[5] == ['GLM-5.3用了 4 次，成了 3 次，平均 3 分钟，换过 1 次模型', 'DeepSeek V4.1 Flash（天启）用了 2 次，成了 2 次，平均 20 秒'], tc)
        await pt.click('.xc-sess .xc-tl-i[data-tsid=stask00001]'); await pt.wait_for_selector('.xc-sheet .xc-tk-log')
        check('任务中心里点一个任务：打开它的过程', await pt.evaluate("document.querySelector('.xc-sheet .xc-sh-hd b').textContent") == '任务 1 · 编译 LED')
        await pt.click('.xc-sh-x'); await pt.wait_for_timeout(200)
        await pt.context.close()
        # 「＋」：发图片和文件（选了马上传，传完才能发，发出去的消息里显示缩略图和文件卡片）；开关插件
        pa = await page(b, 390, 844, mobile=True)
        xa = await xin_mock(pa, authed=True)
        await pa.add_init_script("localStorage.setItem('lm.xin.agent.v','3');localStorage.setItem('lm.xin.agent','codex')")
        await pa.goto(BASE + '/#xin'); await pa.wait_for_selector('.xc.show .xc-row textarea'); await pa.wait_for_timeout(300)
        await pa.click('.xc-plus'); await pa.wait_for_selector('.xc-menu:not([hidden])')
        menu = await pa.evaluate("[...document.querySelectorAll('.xc-mi')].map(b => b.textContent)")
        PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
        xa['upload_delay'] = 0.8
        await pa.set_input_files('.xc-file', files=[{'name': '板子.png', 'mimeType': 'image/png', 'buffer': PNG}, {'name': '说明书.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 test'}])
        await pa.wait_for_selector('.xc-att.up')
        busy = await pa.evaluate("[document.querySelectorAll('.xc-att').length, document.querySelector('.xc-send').disabled, !!document.querySelector('.xc-att.img .xc-att-p'), document.querySelector('.xc-menu').hidden]")
        await pa.wait_for_function("document.querySelectorAll('.xc-att.ok').length === 2", timeout=8000)
        done = await pa.evaluate("[[...document.querySelectorAll('.xc-att b')].map(b => b.textContent), document.querySelector('.xc-send').disabled]")
        await pa.fill('.xc-row textarea', '帮我看看这块板子'); await pa.click('.xc-send')
        await pa.wait_for_function("document.querySelector('.xc-me .xc-mfiles')", timeout=5000)
        await pa.wait_for_function(CHAT_DONE, timeout=8000)
        sent = xa['sent'] or {}
        shown = await pa.evaluate("[!!document.querySelector('.xc-me .xc-mimg img'), document.querySelector('.xc-me .xc-mfile span').textContent, document.querySelector('.xc-me .xc-bub').textContent, document.querySelector('.xc-atts').hidden]")
        check('「＋」菜单只有两项、不带小字：图片或文件、插件；选了文件马上传（传的时候发送键不能点、图片有缩略图），传完能发；消息里带图片缩略图和文件卡片，附件条清空',
              menu == ['图片或文件', '插件'] and busy == [2, True, True, True] and done == [['板子.png', '说明书.pdf'], False]
              and sorted(u['name'] for u in xa['uploads']) == ['板子.png', '说明书.pdf'] and all(u['xin'] == '1' for u in xa['uploads'])
              and sent.get('files') == [{'path': '/data/workspace/uploads/20261106/003005-ab12-板子.png', 'name': '板子.png'}, {'path': '/data/workspace/uploads/20261106/003005-ab12-说明书.pdf', 'name': '说明书.pdf'}]
              and sent.get('text') == '帮我看看这块板子' and shown == [True, '说明书.pdf', '帮我看看这块板子', True], (menu, busy, done, xa.get('uploads'), sent, shown))
        # 只发文件不说话也行；附件能去掉
        xa['upload_delay'] = 0
        await pa.set_input_files('.xc-file', files=[{'name': 'a.txt', 'mimeType': 'text/plain', 'buffer': b'a'}, {'name': 'b.txt', 'mimeType': 'text/plain', 'buffer': b'b'}])
        await pa.wait_for_function("document.querySelectorAll('.xc-att.ok').length === 2", timeout=5000)
        await pa.click('.xc-att:nth-child(1) .xc-att-x'); await pa.wait_for_timeout(100)
        left = await pa.evaluate("[...document.querySelectorAll('.xc-att b')].map(b => b.textContent)")
        await pa.click('.xc-send'); await pa.wait_for_timeout(600)
        sent2 = xa['sent'] or {}
        check('只发文件不说话也能发；附件条上的 ✕ 去掉一个', left == ['b.txt'] and sent2.get('text') == '' and [f['name'] for f in sent2.get('files') or []] == ['b.txt'], (left, sent2))
        await pa.wait_for_function(CHAT_DONE, timeout=8000)
        # 插件：「＋ → 插件」升起一页，列出插件和开没开；点开关告诉小芯的电脑，提示下一句生效；点遮罩收起
        await pa.click('.xc-plus'); await pa.click('.xc-mi-plug'); await pa.wait_for_selector('.xc-sheet [data-name=rea] .xc-sw')
        rows = await pa.evaluate("[...document.querySelectorAll('.xc-sheet .xc-tg')].map(r => [r.dataset.name, r.querySelector('.xc-tg-t b').textContent, r.querySelector('.xc-sw').getAttribute('aria-checked')])")
        await pa.click('.xc-sheet [data-name=rea] .xc-sw'); await pa.wait_for_function("document.querySelector('.xc-sheet [data-name=rea] .xc-sw').getAttribute('aria-checked') === 'true'")
        note = await pa.text_content('.xc-sheet [data-name=rea] .xc-tg-n')
        small = await pa.evaluate("document.querySelectorAll('.xc-sheet .xc-tg-t span, .xc-sheet p:not(.xc-tg-n)').length")
        await pa.mouse.click(195, 300); await pa.wait_for_timeout(300)
        closed = await pa.evaluate("[document.querySelector('.xc-sheet').hidden, !!document.querySelector('.xc.show')]")
        check('插件：「＋ → 插件」列出自己装的插件和开没开（不带说明小字）；点开关告诉小芯的电脑；点遮罩收起不关面板',
              rows == [['rea', 'REA 逆向', 'false'], ['playwright', 'playwright', 'true']] and xa.get('plugin_set') == [{'agent': 'codex', 'name': 'rea', 'on': True}]
              and note == '' and small == 0 and closed == [True, True], (rows, xa.get('plugin_set'), note, small, closed))
        await pa.context.close()
        # 电脑：学习台首页的方块都顶在最上面，小芯站进芯片图框里沿着底边走；它的背包里也有「聊天」
        # （之前在学习台里收起来过：再把它扔进去，照样出来）
        await pg.evaluate("sessionStorage.setItem('lm.xin.stmoff', '1')")
        await drag_xin_into(pg, 'stm32'); f = await tool_frame(pg)
        for _ in range(80):
            if await f.evaluate("LimingXin.mode") in ('idle', 'walk', 'play'): break
            await pg.wait_for_timeout(100)
        st = await f.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [LimingXin.mode, LimingXin.plat && LimingXin.plat.kind, r.top >= 0 && r.bottom <= innerHeight]; })()")
        items = await f.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent))")
        check('电脑：小芯能被扔进学习台（站在芯片图框里，整个在屏幕内），背包里有「聊天」', st[0] in ('idle', 'walk', 'play') and st[1] == 'in' and st[2] and '聊天' in items, (st, items))
        check('之前在学习台里收起来过，再把小芯扔进去：照样出来，没有小脑袋', await f.evaluate("[LimingXin.hidden, !!document.querySelector('.xin-peek:not([hidden])')]") == [False, False])
        await pg.context.close()

        pg = await page(b, 390, 844, mobile=True)
        await xin_mock(pg, authed=True)
        await pg.add_init_script("localStorage.setItem('lm.xin.sid', 'shist00001')")
        await pg.goto(BASE + '/#xin'); await pg.wait_for_selector('.xc.show .xc-code'); await pg.wait_for_timeout(1500)
        st = await pg.evaluate("""(() => { const p = document.querySelector('.xc').getBoundingClientRect(), x = LimingXin.el.getBoundingClientRect();
          return [Math.round(p.top) > 150, Math.round(p.bottom) == innerHeight, x.bottom <= p.top + 1, document.documentElement.scrollWidth <= innerWidth]; })()""")
        check('手机：面板从底下升起来，小芯在标题栏上露着，页面不横向滚动', st == [True, True, True, True], st)
        await pg.evaluate("LimingXin.say('你好呀，这是一句比较长的话')"); await pg.wait_for_timeout(100)
        st = await pg.evaluate("(() => { const r = document.querySelector('.xin-say').getBoundingClientRect(); return [r.left >= 0, r.right <= innerWidth, r.top >= 0, r.width > 80]; })()")
        check('手机：小芯的气泡完整显示在屏幕里', st == [True, True, True, True], st)
        # 小芯被扔进 STM32 学习台：学习台里那个小芯的背包也有「聊天」，打开的是外面工具箱页面上的面板
        await pg.click('.xc-x'); await pg.wait_for_timeout(1500)
        cdp = await pg.context.new_cdp_session(pg)
        async def touch2(kind, x=0, y=0):
            await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y}]})
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        c = await pg.evaluate("(() => { const r = document.querySelector('.card[data-id=stm32]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        await touch2('touchStart', *r)
        for i in range(1, 13):
            await touch2('touchMove', r[0] + (c[0] - r[0]) * i / 12, r[1] + (c[1] - r[1]) * i / 12); await pg.wait_for_timeout(30)
        await touch2('touchEnd'); f = await tool_frame(pg)
        for _ in range(60):
            if await f.evaluate("LimingXin.mode") in ('idle', 'walk', 'play'): break
            await pg.wait_for_timeout(100)
        items = await f.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent))")
        await f.click('.xin-bag .xin-it:has-text("聊天")'); await f.wait_for_selector('.xin-ask')
        await f.click('.xin-ask-more'); await pg.wait_for_selector('.xc.show .xc-code')
        check('学习台里的小芯：背包有「聊天」，点了在它旁边冒输入框，「展开」打开工具箱页面上的面板', '聊天' in items and await pg.is_visible('.xc.show') and not await f.evaluate("!!document.querySelector('.xin-ask')"), items)
        await pg.context.close()
        # 直接打开学习台（不经过工具箱首页）：没有小芯
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(TOOL + '?v=topic&t=i2c&sec=code&cv=cd'); await pg.wait_for_timeout(2000)
        check('直接打开学习台：没有小芯', await pg.evaluate("LimingXin.mode") == 'away')
        await pg.context.close()
        await b.close()

    print('\n==== %d/%d 通过 ====' % (sum(1 for r in results if r[1]), len(results)))
    real = [e for e in errors if 'Failed to load resource' not in e]
    print('JS 报错：%d' % len(real)); [print('  ' + e[:300]) for e in real[:20]]
    print('外部资源加载失败（不计）：%d' % (len(errors) - len(real)))
    print('本站资源失败：%d' % len(local_fail)); [print('  ' + e[:300]) for e in local_fail[:20]]
    return all(r[1] for r in results) and not real and not local_fail

sys.exit(0 if asyncio.run(main()) else 1)
