#!/usr/bin/env python3
"""「天启」独立入口（/tianqi 和 /tools/tianqi/）：
- 没配好：显示「天启还没配好」，只发一次 GET /api/tq/me，不碰 /api/xin/
- 已配好已登录（1280）：照 Harness 桌面端三栏——左边对话记录常驻、中间对话、右边文件终端预览，无小芯入口；发话带 agent='harness'、model、effort，
  不带 context/ctxLabel/main；只调 TQ_OPS（docs/superpowers/specs/2026-11-19-tianqi-harness-workbench-design.md）
- Ctrl+B 收窄条、Ctrl+J 开关右栏；文件在右栏打开，markdown 能预览；设置里换外观（夜空 / 星图）
- 天启插件面板（左栏底部「插件」），Purge / REA 开关走 li2 的接口
- 没登录：登录框是天启的星，登录走 POST /api/tq/login
- 网关没配好：ping 回 ready=false，显示「天启的网关还没配好」，输入框和发送键禁用
- 唤醒中：send 回 accepted/waking，状态行显示「已收到 · 唤醒中」，随后送达并回话
- 首页：「工具」分类有「天启」卡片，点开地址变 /tianqi，iframe 地址为 /tools/tianqi/?embed=1，返回键不挡菜单键

运行：先 npm run dev，再 python3 test/e2e/xin_tianqi_e2e.py
"""
import asyncio
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402


def load_tq_ops():
    src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'xin.js')
    with open(src_path, 'r', encoding='utf-8') as f:
        text = f.read()
    m = re.search(r"export const TQ_OPS = new Set\(\[([^\]]+)\]\)", text)
    if not m:
        raise RuntimeError('TQ_OPS not found in src/xin.js')
    return set(re.findall(r"'([^']+)'", m.group(1)))


TQ_OPS = load_tq_ops()


async def tianqi_mock(pg, enabled=True, authed=True, ready=True, waking_send=False, xin_enabled=False):
    st = {
        'enabled': enabled,
        'authed': authed,
        'ready': ready,
        'waking_send': waking_send,
        'delivery_checks': 0,
        'polls': 0,
        'last_text': '',
        'tq_calls': [],
        'tq_ops': [],
        'sends': [],
        'xin_reqs': [],
        'plugins': {'purge': True, 'rea': False},
        'plugin_updates': [],
        'files_reqs': [],
        'sessions': [
            {'sid': 'stq000001', 'agent': 'harness', 'title': '天启旧对话', 'turns': 1, 'updated': 1762214400000},
        ],
    }

    async def handle_xin(route):
        req = route.request
        st['xin_reqs'].append({'method': req.method, 'url': req.url, 'post': req.post_data})
        op = (req.post_data_json or {}).get('op') if req.method == 'POST' else None
        data = {'enabled': xin_enabled, 'authed': xin_enabled and st['authed']} if req.method == 'GET' else {
            'ok': True, 'data': {'name': 'li', 'state': 'running'} if op == 'status' else {}}
        await route.fulfill(status=200, content_type='application/json', json=data)

    async def handle_tq(route):
        req = route.request
        path = req.url.split('/api/tq/')[1].split('?')[0]
        st['tq_calls'].append('%s /api/tq/%s' % (req.method, path))

        def ok(body):
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(body))

        if path == 'me':
            return await ok({'enabled': st['enabled'], 'authed': st['authed'], 'stream': False})

        body = json.loads(req.post_data or '{}') if req.method == 'POST' else {}
        if path == 'login':
            ok_pw = body.get('password') == 'pw-ok-123456'
            if ok_pw:
                st['authed'] = True
            return await ok({'ok': True} if ok_pw else {'error': 'bad_pw', 'msg': '密码不对'}) if ok_pw else await route.fulfill(status=401, content_type='application/json', body=json.dumps({'msg': '密码不对'}))
        if path == 'logout':
            st['authed'] = False
            return await ok({'ok': True})

        if path != 'call':
            return await ok({'ok': False, 'state': 'error', 'msg': 'unsupported path: ' + path})

        op, args = body.get('op'), body.get('args') or {}
        st['tq_ops'].append(op)
        if op not in TQ_OPS:
            return await route.fulfill(status=400, content_type='application/json', body=json.dumps({'error': 'not_in_tianqi', 'msg': '天启没有这个功能'}))

        if op == 'status':
            return await ok({'ok': True, 'data': {'name': 'li2', 'state': 'running'}})
        if op == 'wake':
            return await ok({'ok': True, 'data': {'state': 'running', 'action': 'none'}})
        if op == 'ping':
            return await ok({'ok': True, 'data': {'ready': st['ready'], 'role': 'tianqi'}})
        if op == 'deliveries':
            return await ok({'ok': True, 'data': {'rows': []}})
        if op == 'sessions':
            return await ok({'ok': True, 'data': {'sessions': st['sessions']}})
        if op == 'plugins':
            return await ok({'ok': True, 'data': {'plugins': [
                {'name': name, 'on': on, 'agent': 'harness'} for name, on in st['plugins'].items()
            ]}})
        if op == 'plugin_set':
            st['plugin_updates'].append(args)
            st['plugins'][args['name']] = args['on']
            return await ok({'ok': True, 'data': {'on': args['on']}})
        if op == 'history':
            return await ok({'ok': True, 'data': {'session': {'sid': args.get('sid'), 'agent': 'harness', 'title': '天启旧对话', 'model': 'deepseek-v4.1-flash'}, 'runs': [{'run': 'rhist0001', 'events': [{'t': 'user', 'text': '老问题'}, {'t': 'text', 'text': '老回答'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 800, 'model': 'deepseek-v4.1-flash'}], 'done': True}], 'active': None}})
        if op == 'files':
            p = args.get('path') or '/data/workspace'
            st['files_reqs'].append(p)
            if p.endswith('.md'):
                return await ok({'ok': True, 'data': {'path': p, 'work': '/data/workspace', 'size': 64, 'mtime': 1763520000000, 'text': '# 天启的笔记\n\nPC13 接板上的 LED，低电平亮。'}})
            return await ok({'ok': True, 'data': {'dir': True, 'path': p, 'work': '/data/workspace', 'entries': [
                {'name': 'stm32-blink', 'dir': True, 'mtime': 1763520000000},
                {'name': 'notes.md', 'dir': False, 'size': 64, 'mtime': 1763520000000},
            ]}})
        if op == 'usage':
            return await ok({'ok': True, 'data': {'quotas': [], 'days': [], 'totals': {}, 'names': {}, 'sources': {}}})
        if op == 'send':
            st['sends'].append(args)
            st['last_text'] = args.get('text', '')
            st['polls'] = 0
            if st['waking_send']:
                st['waking_send'] = False
                return await ok({
                    'ok': False,
                    'accepted': True,
                    'state': 'waking',
                    'msg': '已收到 · 唤醒中',
                    'retryAfter': 1,
                    'delivery': {'id': 'dtq0001', 'state': 'pending', 'wait': {'state': 'waking'}},
                })
            return await ok({'ok': True, 'data': {'sid': args.get('sid') or 'stqnew0001', 'run': 'rtq0001', 'agent': 'harness'}})
        if op == 'delivery':
            st['delivery_checks'] += 1
            if st['delivery_checks'] == 1:
                return await ok({'ok': True, 'data': {'id': 'dtq0001', 'state': 'pending', 'wait': {'state': 'waking'}}})
            return await ok({'ok': True, 'data': {'id': 'dtq0001', 'state': 'delivered', 'result': {'sid': 'stqwake001', 'run': 'rtqwake01', 'agent': 'harness'}}})
        if op == 'poll':
            st['polls'] += 1
            reply = '唤醒后回复完成。' if args.get('run') == 'rtqwake01' else '你好，我是天启。'
            evs = [
                {'t': 'user', 'text': st['last_text']},
                {'t': 'text', 'text': reply},
                {'t': 'done', 'ok': True, 'code': 0, 'ms': 1200, 'model': 'deepseek-v4.1-flash'},
            ]
            return await ok({'ok': True, 'data': {'events': evs, 'off': len(evs), 'done': True}})
        return await ok({'ok': True, 'data': {}})

    await pg.route('**/api/xin/**', handle_xin)
    await pg.route('**/api/tq/**', handle_tq)
    return st


def xin_operations(state):
    return [json.loads(req['post']).get('op') for req in state['xin_reqs'] if req['post']]

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))

        # 1. 没配好
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=False, authed=False)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc .xc-hint')
        await pg.wait_for_timeout(400)
        hint_text = await pg.text_content('.xc .xc-hint')
        body_text = await pg.evaluate('document.body.innerText')
        ui.check(
            '没配好：写「天启还没配好」，只发一次 GET /api/tq/me，/api/xin/ 零请求，界面没有「小芯」',
            '天启还没配好' in (hint_text or '') and st['tq_calls'] == ['GET /api/tq/me'] and st['xin_reqs'] == [] and '小芯' not in body_text,
            (hint_text, st['tq_calls'], st['xin_reqs']),
        )
        await pg.context.close()

        # 2. 配好、登录了（1280）
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        await pg.wait_for_selector('.tq-side .xc-si')
        await pg.wait_for_selector('.tq-pane .xc-fi')
        info = await pg.evaluate("""(() => {
          const r = s => document.querySelector(s).getBoundingClientRect();
          const side = r('.tq-side'), mid = r('.tq-mid'), right = r('.tq-right');
          return {
            fullScreen: document.querySelector('.xc.wb.tq-mode')?.clientWidth === innerWidth,
            columns: side.right <= mid.left && mid.right <= right.left && side.width > 200 && right.width > 300,
            brand: document.querySelector('.tq-brand h1')?.textContent,
            star: !!document.querySelector('.tq-brand .xc-tq'),
            sky: document.querySelectorAll('.xc.tq-mode canvas.tq-sky').length,
            tabs: [...document.querySelectorAll('.tq-tab')].map(e => e.textContent.trim()),
            foot: [...document.querySelectorAll('.tq-side-foot .tq-row')].filter(e => e.offsetParent).map(e => e.textContent.trim()),
            history: [...document.querySelectorAll('.tq-side .xc-si-t')].map(e => e.textContent),
            files: [...document.querySelectorAll('.tq-pane .xc-fi-n')].map(e => e.textContent),
            noXiaoxinControls: !document.querySelector('.xc-as,.xc-mainb,.xc-dailyb,.xc-set-b,.xc-wb-b'),
            placeholder: document.querySelector('.xc-row textarea')?.placeholder,
            bodyText: document.body.innerText,
          };
        })()""")
        ui.check('三栏：左边对话记录常驻、中间对话、右边文件终端预览，夜空三层画布，页面无小芯功能', info['fullScreen'] and info['columns']
                 and info['brand'] == '天启' and info['star'] and info['sky'] == 3 and info['noXiaoxinControls']
                 and info['tabs'] == ['文件', '终端', '预览'] and info['foot'] == ['设置', '插件']
                 and info['history'] == ['天启旧对话'] and 'stm32-blink' in info['files'] and st['files_reqs'][:1] == ['/data/workspace']
                 and info['placeholder'] == '给天启发消息' and '小芯' not in info['bodyText'], info)
        await pg.locator('.tq-side .xc-si', has_text='天启旧对话').click()
        await pg.get_by_text('老回答', exact=True).wait_for()
        ui.check('对话记录常驻左栏，点历史对话打开并更新标题，左栏不收起', await pg.locator('.tq-side .xc-drawer').is_visible()
                 and await pg.locator('.tq-mid-head h2').text_content() == '天启旧对话'
                 and st['tq_ops'].count('history') == 1, st['tq_ops'])
        await pg.locator('.tq-pane .xc-fi', has_text='notes.md').click()
        await pg.get_by_role('button', name='预览', exact=True).click()
        await pg.wait_for_selector('#tq-p-prev:not([hidden]) .tq-pv-fig pre')
        pv = await pg.text_content('#tq-p-prev .tq-pv-fig pre')
        ui.check('文件在右栏打开、聊天还在；markdown 点「预览」在「预览」标签里显示', '天启的笔记' in (pv or '')
                 and await pg.get_by_text('老回答', exact=True).is_visible() and st['files_reqs'][-1] == '/data/workspace/notes.md', (pv, st['files_reqs']))
        await pg.get_by_role('button', name='新建对话').click()
        await pg.get_by_text('从一个问题开始探索').wait_for()
        await pg.keyboard.press('Control+b')
        rail = await pg.evaluate("document.querySelector('.tq-frame').dataset.left")
        await pg.keyboard.press('Control+b')
        await pg.keyboard.press('Control+j')
        closed = await pg.evaluate("document.querySelector('.tq-frame').dataset.right")
        await pg.keyboard.press('Control+j')
        opened = await pg.evaluate("document.querySelector('.tq-frame').dataset.right")
        ui.check('Ctrl+B 把左栏收成窄条、Ctrl+J 收起和打开右栏', (rail, closed, opened) == ('rail', 'closed', 'open'), (rail, closed, opened))
        await pg.get_by_role('button', name='设置', exact=True).click()
        await pg.wait_for_selector('#tq-settings.on')
        await pg.get_by_role('radio', name='星图').click()
        await pg.wait_for_function("document.documentElement.dataset.theme === 'light'")
        saved = await pg.evaluate("localStorage.getItem('lm.tq.theme')")
        await pg.get_by_role('radio', name='夜空').click()
        await pg.wait_for_function("document.documentElement.dataset.theme === 'dark'")
        await pg.keyboard.press('Escape')
        await pg.wait_for_selector('#tq-settings', state='hidden')
        ui.check('设置里换外观：星图是浅色、夜空是深色，存在天启自己的 lm.tq.theme，Esc 关掉', saved == 'light', saved)
        trigger = pg.get_by_role('button', name='插件', exact=True)
        await trigger.click()
        panel = pg.get_by_role('region', name='天启插件')
        purge = panel.get_by_role('switch', name='Purge')
        rea = panel.get_by_role('switch', name='REA 逆向')
        await rea.wait_for()
        initial = (await purge.get_attribute('aria-checked'), await rea.get_attribute('aria-checked'))
        await rea.click()
        await pg.wait_for_function("document.querySelector('.xc-plug-rea [role=switch]').getAttribute('aria-checked') === 'true'")
        await pg.keyboard.press('Escape')
        focus_restored = await trigger.evaluate('e => document.activeElement === e')
        await trigger.click()
        await rea.wait_for()
        ui.check('天启插件面板向 li2 保存开关，关闭后恢复键盘焦点', initial == ('true', 'false') and focus_restored
                 and await rea.get_attribute('aria-checked') == 'true'
                 and st['plugin_updates'] == [{'agent': 'harness', 'name': 'rea', 'on': True}]
                 and not st['xin_reqs'], (initial, focus_restored, st['plugin_updates']))
        await panel.get_by_role('button', name='关掉').click()
        await pg.fill('.xc-row textarea', '帮我查个问题')
        await pg.press('.xc-row textarea', 'Enter')
        await pg.wait_for_function(ui.CHAT_DONE + " && [...document.querySelectorAll('.xc-ai .xc-bub')].some(e => e.textContent.includes('你好，我是天启'))", timeout=10000)
        sent = st['sends'][-1]
        after_text = await pg.evaluate("""(() => ({
          who: document.querySelector('.xc-ai .xc-who')?.textContent,
          star: !!document.querySelector('.xc-ai .xc-tq'),
          bodyText: document.body.innerText,
        }))()""")
        bad_ops = [op for op in st['tq_ops'] if op not in TQ_OPS]
        ui.check(
            '发消息：agent==harness、带 model/effort、不带 context/ctxLabel/main，回复写天启+星，只调用 TQ_OPS，/api/xin/ 零请求',
            sent.get('agent') == 'harness' and bool(sent.get('model')) and bool(sent.get('effort'))
            and 'context' not in sent and 'ctxLabel' not in sent and 'main' not in sent
            and after_text['who'] == '天启' and after_text['star'] and '小芯' not in after_text['bodyText']
            and not bad_ops and st['xin_reqs'] == [],
            (sent, after_text, bad_ops, st['xin_reqs']),
        )
        await pg.context.close()

        # 3. 没登录
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=False, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc-login:not([hidden]) .xc-login-av .xc-tq')
        login_txt = await pg.evaluate('document.body.innerText')
        await pg.fill('.xc-login input', 'pw-ok-123456')
        await pg.click('.xc-login .xc-btn')
        await pg.wait_for_selector('.xc-hello.tq')
        ui.check(
            '没登录：登录框是天启的星且零「小芯」，登录提交 POST /api/tq/login 并进入天启工作台',
            '小芯' not in login_txt and 'POST /api/tq/login' in st['tq_calls'] and st['xin_reqs'] == [],
            st['tq_calls'],
        )
        await pg.context.close()

        # 4. 网关没配好
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=False)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc-gw-warn:not([hidden])')
        gw = await pg.evaluate("""(() => ({
          warn: document.querySelector('.xc-gw-warn')?.textContent,
          taDisabled: document.querySelector('.xc-row textarea')?.disabled,
          sendDisabled: document.querySelector('.xc-send')?.disabled,
          bodyText: document.body.innerText,
        }))()""")
        ui.check(
            '网关没配好：显示「天启的网关还没配好」，输入框和发送键禁用',
            '天启的网关还没配好' in (gw['warn'] or '') and gw['taDisabled'] and gw['sendDisabled'] and '小芯' not in gw['bodyText'],
            gw,
        )
        await pg.context.close()

        # 5. 唤醒中
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True, waking_send=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc-hello.tq')
        await pg.fill('.xc-row textarea', '等它醒来回答')
        await pg.press('.xc-row textarea', 'Enter')
        await pg.wait_for_function("document.querySelector('.xc-typing-l')?.textContent.includes('已收到 · 唤醒中')", timeout=5000)
        saw_waking = await pg.text_content('.xc-typing-l')
        await pg.wait_for_function(ui.CHAT_DONE + " && [...document.querySelectorAll('.xc-ai .xc-bub')].some(e => e.textContent.includes('唤醒后回复完成'))", timeout=10000)
        ui.check(
            '唤醒中：状态行写「已收到 · 唤醒中」，待送达完成后回话显示',
            '已收到 · 唤醒中' in (saw_waking or '') and st['delivery_checks'] >= 2 and st['xin_reqs'] == [],
            (saw_waking, st['delivery_checks']),
        )
        await pg.context.close()

        # 6. 从首页正常打开时，小芯已经启动，天启使用自己的 iframe。
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, xin_enabled=True)
        await pg.goto(ui.BASE + '/')
        await pg.wait_for_selector('.card[data-id="tianqi"]')
        await pg.wait_for_function("window.LimingXinChat?.state.authed")
        for _ in range(60):
            if {'wake','greet'} <= set(xin_operations(st)): break
            await asyncio.sleep(.05)
        ui.check('普通首页照常唤醒小芯并打招呼', {'wake','greet'} <= set(xin_operations(st)), xin_operations(st))
        cat_name = await pg.evaluate("document.querySelector('.card[data-id=\"tianqi\"]')?.closest('.cat')?.querySelector('.cat-h')?.textContent")
        await pg.click('.card[data-id="tianqi"]')
        await pg.wait_for_selector('.panel[data-id="tianqi"].show iframe')
        iframe_src = await pg.get_attribute('.panel[data-id="tianqi"] iframe', 'src')
        fr = pg.frame(url=re.compile(r'/tools/tianqi/'))
        if not fr:
            for f in pg.frames:
                if '/tools/tianqi/' in f.url:
                    fr = f
                    break
        await fr.wait_for_selector('.xc.tq-mode.show .xc-hello.tq')
        embed_ui = await fr.evaluate("""(() => ({
          xHidden: getComputedStyle(document.querySelector('.xc-x')).display === 'none',
          embed: document.documentElement.classList.contains('embed'),
        }))()""")
        ui.check(
            '首页：「天启」分类有「天启」卡片，点击地址变 /tianqi，iframe 是 /tools/tianqi/?embed=1，嵌在首页时关闭键隐藏',
            cat_name == '天启' and pg.url.endswith('/tianqi') and iframe_src == '/tools/tianqi/?embed=1' and embed_ui['embed'] and embed_ui['xHidden'],
            (cat_name, pg.url, iframe_src, embed_ui),
        )
        await pg.context.close()

        # 手机双区上下排列，返回键与天启品牌、操作键分开。
        pg = await ui.page(browser, 390, 844, mobile=True)
        st = await tianqi_mock(pg)
        await pg.goto(ui.BASE + '/tianqi')
        frame = pg.frame_locator('.panel[data-id=tianqi] iframe')
        await frame.locator('.tq-empty').wait_for()
        back = await pg.locator('.panel[data-id=tianqi] .back').bounding_box()
        menu = await frame.locator('.tq-menu').bounding_box()
        box = await frame.locator('.tq-box').bounding_box()
        ui.check('手机天启工作台：左栏收进抽屉，返回键不挡菜单键，输入框在屏幕里，面板键能点', back['x'] + back['width'] <= menu['x']
                 and box['y'] + box['height'] <= 844 and await frame.locator('.tq-panel-b').is_visible(),
                 (back, menu, box))
        await pg.context.close()

        # 7. 深链：只启动天启；返回首页后再启动小芯。
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, xin_enabled=True)
        await pg.goto(ui.BASE + '/tianqi')
        await pg.wait_for_function("window.LimingXinChat?.state.authed && document.body.classList.contains('tool-open')")
        await pg.frame_locator('.panel[data-id="tianqi"] iframe').locator('.xc-hello.tq').wait_for()
        for _ in range(60):
            if 'wake' in st['tq_ops']: break
            await asyncio.sleep(.05)
        await pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        await pg.wait_for_timeout(250)
        during = xin_operations(st)
        ui.check('直接打开天启并切回可见时，只叫醒 li2', 'wake' in st['tq_ops'] and not during, (st['tq_ops'], during))
        await pg.locator('.panel[data-id="tianqi"] .back').click()
        await pg.wait_for_url(ui.BASE + '/')
        for _ in range(60):
            if {'wake','greet'} <= set(xin_operations(st)[len(during):]): break
            await asyncio.sleep(.05)
        after = xin_operations(st)[len(during):]
        ui.check('从天启返回首页后唤醒小芯并打招呼，各一次', after.count('wake') == 1 and after.count('greet') == 1, after)
        await pg.context.close()

        # 8. 在内嵌天启登录后，首页无需重新输一次密码。
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, xin_enabled=True, authed=False)
        await pg.goto(ui.BASE + '/tianqi')
        frame = pg.frame_locator('.panel[data-id=tianqi] iframe')
        await frame.locator('.xc-login input[name=pw]').fill('pw-ok-123456')
        await frame.locator('.xc-login button').click()
        await frame.locator('.xc-hello.tq').wait_for()
        await pg.locator('.panel[data-id=tianqi] .back').click()
        for _ in range(60):
            if 'greet' in xin_operations(st): break
            await asyncio.sleep(.05)
        ops = xin_operations(st)
        shared = await pg.evaluate('LimingXinChat.state.authed')
        ui.check('在天启登录一次，返回首页即可使用小芯', shared and ops.count('wake') == 1 and ops.count('greet') == 1, (shared, ops))
        await pg.context.close()

        await browser.close()

    if ui.errors or ui.local_fail:
        ui.check('运行过程中无脚本或本地请求报错', False, (ui.errors, ui.local_fail))
    else:
        ui.check('运行过程中无脚本或本地请求报错', True)
    bad = [r for r in ui.results if not r[1]]
    print('\n共 %d 项，失败 %d 项' % (len(ui.results), len(bad)))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    asyncio.run(main())
