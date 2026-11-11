#!/usr/bin/env python3
"""工具箱首页的「小芯」和全屏工作台。

- 网站没开小芯聊天时首页没有这一块；开了没登录：有，点了先登录。
- 首页卡片：最近在做的、等你的、做好的最多三行；点任务打开工作台并打开那个任务；最后一行打字回车，发到主对话。
- 工作台：≥1180 左边对话、中间聊天、右边进行中和成果；900–1179 没有左栏；更窄只有聊天，方格按钮把右栏滑进来。
- 右栏：在做的能「改一下」（直接打字，送进那个任务）和停止；网页成品显示截图，点「打开」是预览。
- 关掉回到首页；#xin-work 直接打开工作台；面板里的展开按钮也能进工作台。

运行：先起本地预览（5173），再 python3 test/e2e/xin_work_e2e.py
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

NOW = int(time.time() * 1000)
PID = 'b' * 32
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                    '1f15c4890000000d49444154789c63f8cf50f01f0005fe02fea7d6a4bf0000000049454e44ae426082')


def tasks():
    return [
        {'sid': 'stasklive01', 'no': 1, 'parent': 'shist00001', 'title': 'PA0 点灯工程', 'kind': 'code', 'status': 'running', 'created': NOW - 200000, 'startedAt': NOW - 180000,
         'activity': '正在编译 main.c', 'dir': '/data/workspace/blink', 'turns': 1, 'after': []},
        {'sid': 'staskwait01', 'no': 2, 'parent': 'shist00001', 'title': '删掉旧工程', 'kind': 'quick', 'status': 'waiting', 'created': NOW - 900000, 'endedAt': NOW - 800000,
         'question': '要删掉 /data/workspace/old 吗？', 'turns': 1, 'after': []},
        {'sid': 'staskweb001', 'no': 3, 'parent': 'shist00001', 'title': '奶龙互动网页', 'kind': 'code', 'status': 'done', 'created': NOW - 7200000, 'startedAt': NOW - 7100000, 'endedAt': NOW - 6800000,
         'turns': 1, 'web': True, 'result': {'ok': True, 'text': '我画好了，点下面的预览就能看。', 'at': NOW - 6800000}, 'preview': {'ready': True, 'url': '/xin/preview.html?id=' + PID}, 'delivery': {'state': 'delivered'}},
        {'sid': 'staskdone01', 'no': 4, 'parent': 'sother00001', 'title': '查 ADC 采样时间', 'kind': 'research', 'status': 'done', 'created': NOW - 90000000, 'endedAt': NOW - 89000000,
         'turns': 1, 'result': {'ok': True, 'text': '采样时间 = (SMP + 12.5) 个 ADC 周期。', 'at': NOW - 89000000}, 'delivery': {'state': 'delivered'}},
    ]


async def backend(pg, authed=True, main=None):
    st = await ui.xin_mock(pg, authed=authed)
    st['tasks'] = tasks()
    st.update({'sends': [], 'main': main, 'previews': 0})

    async def handle(route):
        body = json.loads(route.request.post_data or '{}')
        op, args = body.get('op'), body.get('args') or {}
        if op == 'greet':
            return await route.fulfill(json={'ok': True, 'data': {'warming': False, 'main': st['main'], 'bg': 1}})
        if op == 'send' and args.get('main'):
            st['sends'].append(args)
            st['main'] = 'smain000001'
            st['polls'] = 0
            return await route.fulfill(json={'ok': True, 'data': {'sid': 'smain000001', 'run': 'rlive00001', 'agent': 'codex', 'main': True, 'turns': 1}})
        if op == 'send':
            st['sends'].append(args)
        if op == 'history' and args.get('sid') == 'shist00001':
            return await route.fulfill(json={'ok': True, 'data': {'session': {'sid': 'shist00001', 'agent': 'codex', 'title': '编译 main.c'}, 'runs': [{'run': 'rhist00001', 'events': ui.XIN_HIST, 'done': True}],
                                                                  'active': st.get('active'), 'tasks': [t for t in st['tasks'] if t['parent'] == 'shist00001']}})
        await route.fallback()
    await pg.route('**/api/xin/call', handle)

    async def png(route):
        st['previews'] += 1
        await route.fulfill(status=200, content_type='image/png', body=PNG)
    await pg.route('**/api/xin/preview/*/preview.png', png)
    return st


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))

        # 0. 网站没开小芯聊天（本地预览没有密钥）：首页没有这一块
        pg = await ui.page(browser)
        await pg.goto(ui.BASE + '/')
        await pg.wait_for_timeout(1200)
        ui.check('没开小芯聊天时首页没有工作台卡片', await pg.locator('#xinWork').is_hidden())
        await pg.context.close()

        # 1. 没登录：卡片在，点了进工作台先登录；登录后首页卡片有任务
        pg = await ui.page(browser, 390, 844, mobile=True)
        st = await backend(pg, authed=False)
        await pg.goto(ui.BASE + '/')
        await pg.wait_for_selector('#xinWork:not([hidden]) .xw-card')
        head = await pg.evaluate("[document.querySelector('.xw-st').textContent, document.querySelector('.xw-ask input').placeholder, document.querySelector('.xw-list').hidden]")
        ui.check('没登录：首页有「小芯」卡片，写着未登录，没有任务行', head == ['未登录', '登录后就能聊', True], head)
        await pg.click('.xw-head')
        await pg.wait_for_selector('.xc.wb.show .xc-login input')
        locked = await pg.evaluate("[document.querySelector('.xc').classList.contains('locked'), getComputedStyle(document.querySelector('.xc-work')).display, location.hash]")
        ui.check('点卡片：全屏工作台，先要密码，右栏不出来', locked == [True, 'none', '#xin-work'], locked)
        await pg.fill('.xc-login input', 'pw-ok-123456')
        await pg.click('.xc-login .xc-btn')
        await pg.wait_for_selector('.xc-hello')
        await pg.click('.xc-x')
        await pg.wait_for_function("!document.querySelector('.xc').classList.contains('show') && !location.hash")
        await pg.wait_for_function("document.querySelectorAll('.xw-t').length === 3", timeout=10000)
        rows = await pg.evaluate("[...document.querySelectorAll('.xw-t')].map(b => [b.classList[1], b.querySelector('.xw-tt').textContent, b.querySelector('.xw-tm').textContent])")
        ui.check('登录后首页：在做的、等你的、做好的三行，在做的写用了多久', [r[:2] for r in rows] == [['run', 'PA0 点灯工程'], ['wait', '删掉旧工程'], ['ok', '奶龙互动网页']]
                 and rows[0][2] == '3 分钟' and rows[1][2] == '等你' and rows[2][2] == '1 小时前' and await pg.text_content('.xw-st') == '在忙', rows)
        fit = await pg.evaluate("document.documentElement.scrollWidth <= innerWidth")
        ui.check('手机首页不横向滚动', fit)

        # 2. 首页打字回车：进工作台，发到主对话
        await pg.fill('.xw-ask input', '帮我看看定时器')
        has = await pg.evaluate("document.querySelector('.xw-ask').classList.contains('has')")
        await pg.press('.xw-ask input', 'Enter')
        await pg.wait_for_function(ui.CHAT_DONE + " && LimingXinChat.state.sid === 'smain000001'", timeout=10000)
        sent = st['sends'][-1]
        view = await pg.evaluate("[document.querySelector('.xc').classList.contains('wb'), [...document.querySelectorAll('.xc-me .xc-bub')].map(e => e.textContent), document.querySelector('.xw-ask input').value]")
        ui.check('首页最后一行打字回车：进工作台，这句发到主对话（带 main），首页输入框清空', has and sent.get('main') is True and sent.get('text') == '帮我看看定时器' and view == [True, ['帮我看看定时器'], ''], (sent, view))

        # 3. 窄屏工作台：方格按钮滑出进行中和成果
        btn = await pg.evaluate("[getComputedStyle(document.querySelector('.xc-work-b')).display, document.querySelector('.xc-work-b').classList.contains('live'), getComputedStyle(document.querySelector('.xc-wb-b')).display, getComputedStyle(document.querySelector('.xc-list-b')).display]")
        ui.check('手机工作台：标题栏有方格按钮（有在做的亮个点），没有「收起工作台」，对话列表还是 ☰', btn == ['grid', True, 'none', 'grid'], btn)
        await pg.click('.xc-work-b')
        await pg.wait_for_function("document.querySelector('.xc').classList.contains('work-open')")
        await pg.wait_for_timeout(350)
        col = await pg.evaluate("""[[...document.querySelectorAll('.wk-h')].map(e => e.firstChild.textContent + e.lastChild.textContent), [...document.querySelectorAll('.wk-c')].map(c => c.dataset.tsid),
          (() => { const r = document.querySelector('.xc-work').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right) === innerWidth]; })(), document.documentElement.scrollWidth <= innerWidth]""")
        ui.check('右栏滑进来盖满聊天：在做 1、等你 1、成果 2，顺序对，不横向滚动',
                 col == [['在做1', '等你1', '成果2'], ['stasklive01', 'staskwait01', 'staskweb001', 'staskdone01'], [0, True], True], col)
        await pg.keyboard.press('Escape')
        await pg.wait_for_function("!document.querySelector('.xc').classList.contains('work-open') && document.querySelector('.xc').classList.contains('show')")
        ui.check('Esc 先收起右栏，工作台还开着', True)
        await pg.click('.xc-x')
        await pg.wait_for_function("!document.querySelector('.xc').classList.contains('show')")
        await pg.wait_for_timeout(300)
        ui.check('关掉工作台：回到首页，退出全屏状态', await pg.evaluate("!document.querySelector('.xc').classList.contains('wb') && !document.body.classList.contains('xc-wb') && !location.hash"))

        # 4. 首页点任务行：进工作台、打开那个任务
        await pg.click('.xw-t.wait')
        await pg.wait_for_selector('.xc-sheet:not([hidden]) .xc-tk-log')
        sh = await pg.evaluate("[document.querySelector('.xc').classList.contains('wb'), document.querySelector('.xc-sh-hd b').textContent]")
        ui.check('首页点任务：进工作台，直接打开那个任务', sh == [True, '我在做：删掉旧工程'], sh)
        await pg.context.close()

        # 5. 宽屏三栏；右栏卡片的动作；看过程盖在右栏上
        for width, height, side, workcol in ((1280, 860, True, True), (1024, 768, False, True)):
            pg = await ui.page(browser, width, height)
            st = await backend(pg, main='smain000001')
            await pg.add_init_script("localStorage.setItem('lm.xin.sid','shist00001')")
            await pg.goto(ui.BASE + '/#xin-work')
            await pg.wait_for_selector('.xc.wb.show .wk-c')
            await pg.wait_for_function(ui.CHAT_DONE + " && LimingXinChat.state.histFor === 'shist00001'")
            await pg.wait_for_timeout(300)
            lay = await pg.evaluate("""(() => { const r = s => { const e = document.querySelector(s); if (!e || getComputedStyle(e).display === 'none') return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; };
              return [r('.xc-drawer'), r('.xc-body'), r('.xc-work'), getComputedStyle(document.querySelector('.xc-list-b')).display, document.querySelector('.xc-ttl b').textContent,
                getComputedStyle(document.querySelector('.xc-work-b')).display, document.documentElement.scrollWidth <= innerWidth, !!document.querySelector('.xc-mainb')]; })()""")
            if side:
                ok = lay[0] == [0, 280] and lay[1][0] == 280 and lay[2] == [width - 340, 340] and lay[3] == 'none' and lay[4] == '编译 main.c' and lay[5] == 'none' and lay[6] and lay[7]
                ui.check('%d 宽：左边对话（主对话、列表常驻）、中间聊天（标题写对话名）、右边进行中和成果，没有 ☰ 和方格按钮' % width, ok, lay)
            else:
                ok = lay[0][0] + lay[0][1] <= 0 and lay[1][0] == 0 and lay[2] == [width - 340, 340] and lay[3] == 'grid' and lay[4] == '小芯' and lay[5] == 'none' and lay[6]
                ui.check('%d 宽：聊天加右栏，对话列表用 ☰ 拉出' % width, ok, lay)
            await pg.wait_for_function("document.querySelector('.wk-img') && document.querySelector('.wk-img').complete && document.querySelector('.wk-img').naturalWidth > 0", timeout=10000)
            web = await pg.evaluate("[document.querySelector('.wk-c[data-tsid=staskweb001] .wk-img').getAttribute('src'), document.querySelector('.wk-c[data-tsid=staskweb001] a.wk-b').getAttribute('href'), document.querySelector('.wk-c[data-tsid=staskweb001] a.wk-b').target]")
            n0 = st['previews']
            await pg.evaluate("LimingXinChat.work()")
            await pg.wait_for_timeout(200)
            ui.check('%d 宽：网页成品显示截图，「打开」是新标签的预览；重画不重新下载截图' % width,
                     web == ['/api/xin/preview/' + PID + '/preview.png', '/xin/preview.html?id=' + PID, '_blank'] and st['previews'] == n0 == 1, (web, n0, st['previews']))
            await pg.click('.wk-c[data-tsid=stasklive01] .wk-b:has-text("改一下")')
            await pg.wait_for_selector('.xc-sheet:not([hidden]) .xc-tk-in')
            await pg.wait_for_function("document.activeElement === document.querySelector('.xc-sheet .xc-tk-in')", timeout=3000)
            await pg.wait_for_timeout(350)   # 等滑进来的动画走完再量位置
            sheet = await pg.evaluate("(() => { const b = document.querySelector('.xc-sheet').getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width), getComputedStyle(document.querySelector('.xc-scrim')).display]; })()")
            await pg.keyboard.type('改成 PA1')
            await pg.keyboard.press('Enter')
            await pg.wait_for_function("document.querySelector('.xc-tk-note') && document.querySelector('.xc-tk-note').textContent")
            tell = st.get('task_tell') or {}
            ui.check('%d 宽：右栏「改一下」：看过程盖在右栏上（不挡聊天、没有遮罩），输入框拿到焦点，回车送进那个任务' % width,
                     sheet == [width - 340, 340, 'none'] and tell.get('sid') == 'stasklive01' and tell.get('text') == '改成 PA1', (sheet, tell))
            # 看过程开着也能接着聊：聊天没被挡
            await pg.fill('.xc-row textarea', '顺便问一句')
            await pg.keyboard.press('Enter')
            await pg.wait_for_function(ui.CHAT_DONE, timeout=10000)
            ui.check('%d 宽：看过程开着时照样能在中间聊天' % width, (st['sends'][-1] or {}).get('text') == '顺便问一句' and await pg.is_visible('.xc-sheet'), st['sends'][-1])
            await pg.click('.xc-sh-x')
            stop = pg.locator('.wk-c[data-tsid=stasklive01] .wk-b:has-text("停止")')
            await stop.click()
            await pg.wait_for_function("!document.querySelector('.wk-c[data-tsid=stasklive01].live')", timeout=10000)
            ui.check('%d 宽：右栏「停止」：任务停下，从「在做」挪到成果里' % width, (st.get('task_stop') or {}).get('sid') == 'stasklive01' and await pg.evaluate("!!document.querySelector('.wk-list.done .wk-c[data-tsid=stasklive01]')"))
            # 收起工作台：变回普通面板
            await pg.click('.xc-wb-b')
            await pg.wait_for_function("!document.querySelector('.xc').classList.contains('wb')")
            await pg.wait_for_timeout(300)
            back = await pg.evaluate("[Math.round(document.querySelector('.xc').getBoundingClientRect().width), getComputedStyle(document.querySelector('.xc-work')).display, location.hash]")
            ui.check('%d 宽：标题栏「收起工作台」：变回右侧面板，右栏不见' % width, back[0] <= 420 and back[1] == 'none' and back[2] == '', back)
            await pg.click('.xc-wb-b')
            await pg.wait_for_function("document.querySelector('.xc').classList.contains('wb') && location.hash === '#xin-work'")
            ui.check('%d 宽：面板里的展开按钮再进工作台' % width, True)
            await pg.context.close()

        # 7. 已有主对话、正看着别的对话（上一句还在跑）时在首页打字：切到主对话，这句发进去，轮询接上新的一轮
        pg = await ui.page(browser, 390, 844, mobile=True)
        st = await backend(pg, main='smain000001')
        st['active'] = {'run': 'rbusy00001', 'off': 0, 'started': NOW}
        st['hold'] = True
        await pg.add_init_script("localStorage.setItem('lm.xin.sid','shist00001')")
        await pg.goto(ui.BASE + '/#xin')
        await pg.wait_for_function("LimingXinChat.state.run === 'rbusy00001' && LimingXinChat.state.polling", timeout=10000)
        await pg.click('.xc-x')
        await pg.wait_for_function("!document.querySelector('.xc').classList.contains('show')")
        st['active'] = None
        st['hold'] = False
        await pg.fill('.xw-ask input', '主对话里说一句')
        await pg.press('.xw-ask input', 'Enter')
        await pg.wait_for_function(ui.CHAT_DONE + " && LimingXinChat.state.histFor === 'smain000001' && !!document.querySelector('.xc-me')", timeout=15000)
        sent = st['sends'][-1]
        bubbles = await pg.evaluate("[...document.querySelectorAll('.xc-ai:not(.xc-typing) .xc-bub')].map(b => b.textContent).slice(-1)")
        ui.check('别的对话还在回话时从首页打字：切到主对话发出去，新一轮的回复照样收到', sent.get('sid') == 'smain000001' and sent.get('text') == '主对话里说一句' and bubbles == ['里面有一个 blink 目录。'], (sent, bubbles))
        await pg.context.close()

        # 6. 平板竖屏、深色：看一眼不横向滚动
        for width, height, theme in ((768, 1024, 'dark'), (390, 844, 'dark')):
            pg = await ui.page(browser, width, height, mobile=True, theme=theme)
            await backend(pg)
            await pg.goto(ui.BASE + '/#xin-work')
            await pg.wait_for_selector('.xc.wb.show')
            await pg.wait_for_timeout(400)
            await pg.click('.xc-work-b')
            await pg.wait_for_selector('.wk-c')
            await pg.wait_for_timeout(350)
            ok = await pg.evaluate("document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.wk-c')].every(c => c.getBoundingClientRect().right <= innerWidth + 1)")
            ui.check('%d 宽深色：右栏卡片都在屏幕里' % width, ok)
            await pg.context.close()
        await browser.close()

    bad = [name for name, ok in ui.results if not ok]
    real = [e for e in ui.errors if 'Failed to load resource' not in e]
    print('\n==== %d/%d 通过 ====' % (len(ui.results) - len(bad), len(ui.results)))
    if real:
        print('JS 报错：', real[:5])
    if ui.local_fail:
        print('本站资源失败：', ui.local_fail[:5])
    return not bad and not real and not ui.local_fail


if __name__ == '__main__':
    sys.exit(0 if asyncio.run(main()) else 1)
