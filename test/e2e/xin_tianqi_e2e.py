#!/usr/bin/env python3
"""「天启」独立入口（/tianqi 和 /tools/tianqi/）：
- 没配好：显示「天启还没配好」，只发一次 GET /api/tq/me，不碰 /api/xin/
- 已配好已登录（1280）：全屏工作台，星标志 +「天启」，无小芯元素/入口/文字；发话带 agent='harness'、model、effort，不带 context/ctxLabel/main；只调 TQ_OPS
- 没登录：登录框是天启的星，登录走 POST /api/tq/login
- 网关没配好：ping 回 ready=false，显示「天启的网关还没配好」，输入框和发送键禁用
- 唤醒中：send 回 accepted/waking，状态行显示「已收到 · 唤醒中」，随后送达并回话
- 首页：「工具」分类有「天启」卡片，点开地址变 /tianqi，iframe 地址为 /tools/tianqi/?embed=1，返回键不挡标题栏和侧边栏

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
        if op == 'history':
            return await ok({'ok': True, 'data': {'session': {'sid': args.get('sid'), 'agent': 'harness', 'title': '天启旧对话', 'model': 'deepseek-v4.1-flash'}, 'runs': [{'run': 'rhist0001', 'events': [{'t': 'user', 'text': '老问题'}, {'t': 'text', 'text': '老回答'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 800, 'model': 'deepseek-v4.1-flash'}], 'done': True}], 'active': None}})
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
        await pg.wait_for_function("document.querySelectorAll('.xc-si').length >= 1")
        info = await pg.evaluate("""(() => ({
          wb: document.querySelector('.xc').classList.contains('wb'),
          side: document.querySelector('.xc').classList.contains('wb-side'),
          hasWbBtn: !!document.querySelector('.xc-wb-b'),
          isleText: document.querySelector('.xc-isle .xc-ttl b')?.textContent,
          isleStar: !!document.querySelector('.xc-isle .xc-tq'),
          helloTitle: document.querySelector('.xc-hello-t')?.textContent,
          hasSwitcher: !!document.querySelector('.xc-as'),
          placeholder: document.querySelector('.xc-row textarea')?.placeholder,
          keys: [...document.querySelectorAll('.xc-dr-keys .xc-key')].map(e => e.textContent.trim()),
          hasMain: !!document.querySelector('.xc-mainb'),
          hasDaily: !!document.querySelector('.xc-dailyb'),
          hasSet: !!document.querySelector('.xc-set-b'),
          bodyText: document.body.innerText,
        }))()""")
        await pg.click('.xc-isle')
        await pg.wait_for_timeout(150)
        tray_open = await pg.evaluate("document.querySelector('.xc').classList.contains('tray-open') || document.querySelector('.xc-work').classList.contains('pop')")
        ui.check(
            '配好、登录了（1280）：全屏星标题栏/欢迎页、无工作台按钮/无切换/无主对话日常设置、侧边栏单键「新建对话」、点击天启岛不展开、页面零「小芯」',
            info['wb'] and info['side'] and not info['hasWbBtn'] and info['isleText'] == '天启' and info['isleStar']
            and info['helloTitle'] == '天启' and not info['hasSwitcher'] and info['placeholder'] == '给天启发消息'
            and info['keys'] == ['新建对话'] and not info['hasMain'] and not info['hasDaily'] and not info['hasSet']
            and not tray_open and '小芯' not in info['bodyText'],
            (info, tray_open),
        )
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
            '首页：「工具」分类有「天启」卡片，点击地址变 /tianqi，iframe 是 /tools/tianqi/?embed=1，嵌在首页时关闭键隐藏',
            cat_name == '工具' and pg.url.endswith('/tianqi') and iframe_src == '/tools/tianqi/?embed=1' and embed_ui['embed'] and embed_ui['xHidden'],
            (cat_name, pg.url, iframe_src, embed_ui),
        )
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
