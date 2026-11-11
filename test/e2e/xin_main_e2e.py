#!/usr/bin/env python3
"""小芯的主对话：一直聊下去的那一个，和别的对话并存。

- 新设备第一次打开：落在主对话的空白页，第一句带 main 发出去；之后刷新直接回到主对话。
- 云电脑上已经有主对话（别的设备开过）：打开网页就读出来，接着聊，不用带编号以外的东西。
- 「新对话」另开一个，不带 main；侧边栏第一行「主对话」随时回去。
- 主对话不在普通对话列表里，⋯ 只有「归档，重新开始」；归档后回到空白页，下一句又是 main。
- 天启模式开着时，空白页是天启的新对话，不会把天启的话发进主对话。
- 历史一页 30 轮：「更早的消息」往前翻，画在最前面，页面停在原来的位置。

运行：先起本地预览（5173），再 python3 test/e2e/xin_main_e2e.py
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

MAIN = 'smain000001'
BUBBLES = "[...document.querySelectorAll('.xc-m:not(.xc-typing) .xc-bub')].map(b => b.textContent)"


def turn(i):
    return {'run': 'rpage%05d' % i, 'started': 1000 + i, 'done': True,
            'events': [{'t': 'user', 'text': '问 %d' % i, 'at': 1762000000000 + i * 60000}, {'t': 'text', 'text': '答 %d' % i}, {'t': 'done', 'ok': True, 'ms': 1000}]}


async def backend(pg, main=None, turns=0):
    """在通用的假接口前面加一层：记着有没有主对话、主对话有几轮，按真的控制器那样回。"""
    st = await ui.xin_mock(pg, authed=True)
    st.update({'main': main, 'turns': turns, 'sends': [], 'history': [], 'archived_main': 0})

    async def handle(route):
        body = json.loads(route.request.post_data or '{}')
        op, args = body.get('op'), body.get('args') or {}

        def ok(data):
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': data}))
        if op == 'greet':
            return await ok({'warming': False, 'main': st['main']})
        if op == 'sessions':
            rows = [{'sid': 'shist00001', 'agent': 'codex', 'title': '编译 main.c', 'turns': 1, 'updated': 0}]
            if st['main']:
                rows.insert(0, {'sid': st['main'], 'agent': 'codex', 'title': '你好', 'turns': st['turns'], 'updated': 1762300000000, 'main': True})
            return await ok({'sessions': rows})
        if op == 'send':
            st['sends'].append(args)
            if args.get('main') or (st['main'] and args.get('sid') == st['main']):
                st['main'] = st['main'] or MAIN
                st['turns'] += 1
                st['polls'] = 0
                return await ok({'sid': st['main'], 'run': 'rlive00001', 'agent': 'codex', 'main': True, 'turns': st['turns']})
            return await route.fallback()
        if op == 'archive' and args.get('sid') == st['main']:
            st['archived_main'] += 1
            st['main'], st['turns'] = None, 0
            return await ok({'ok': True})
        if op == 'history' and args.get('sid') == MAIN:
            st['history'].append(args)
            n = st['turns']
            end = n if not args.get('before') else int(args['before'][5:])
            start = max(0, end - 30)
            return await ok({'session': {'sid': MAIN, 'agent': 'codex', 'main': True}, 'usage': None, 'runs': [turn(i) for i in range(start, end)], 'more': start > 0, 'active': None, 'tasks': []})
        await route.fallback()
    await pg.route('**/api/xin/call', handle)
    return st


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))

        # 1. 新设备、云电脑上还没有主对话
        pg = await ui.page(browser, 390, 844, mobile=True)
        st = await backend(pg)
        await pg.goto(ui.BASE + '/#xin')
        await pg.wait_for_selector('.xc.show .xc-hello')
        hello = await pg.evaluate("[document.querySelector('.xc-hello').textContent, !!document.querySelector('.xc-login:not([hidden])'), LimingXinChat.state.toMain]")
        ui.check('第一次打开：空白页只有小芯和一句招呼，没有说明小字；停在主对话上', hello == ['嗨，我是小芯', False, True], hello)
        await pg.fill('.xc-row textarea', '你好')
        await pg.click('.xc-send')
        await pg.wait_for_function(ui.CHAT_DONE + ' && !!LimingXinChat.state.sid', timeout=10000)
        first = st['sends'][-1]
        saved = await pg.evaluate("[LimingXinChat.state.sid, localStorage.getItem('lm.xin.main'), localStorage.getItem('lm.xin.sid')]")
        ui.check('第一句：不带对话编号、带 main、默认模式；回来的编号记成主对话', first.get('main') is True and 'sid' not in first and first.get('agent') == 'codex' and saved == [MAIN, MAIN, MAIN], (first, saved))
        await pg.fill('.xc-row textarea', '接着说')
        await pg.click('.xc-send')
        await pg.wait_for_function(ui.CHAT_DONE, timeout=10000)
        second = st['sends'][-1]
        ui.check('第二句：直接发到主对话的编号', second.get('sid') == MAIN and 'main' not in second, second)

        # 2. 侧边栏：主对话固定在最上面，不混在普通对话里；新对话另开一个
        await pg.click('.xc-list-b')
        await pg.wait_for_selector('.xc-si')
        dr = await pg.evaluate("""[document.querySelector('.xc-mainb span').textContent, document.querySelector('.xc-mainb').classList.contains('cur'),
          [...document.querySelectorAll('.xc-sl-main .xc-si-t')].map(e => e.textContent), document.querySelector('.xc-dr-h').textContent, !document.querySelector('.xc-main-more').hidden]""")
        ui.check('侧边栏：第一行「主对话」（正在看，标出来），普通对话列表里没有它', dr == ['主对话', True, ['编译 main.c'], '对话', True], dr)
        await pg.click('.xc-dr-new')
        await pg.wait_for_selector('.xc-hello')
        await pg.fill('.xc-row textarea', '另一个话题')
        await pg.click('.xc-send')
        await pg.wait_for_function(ui.CHAT_DONE + " && LimingXinChat.state.sid === 'snew000001'", timeout=10000)
        other = st['sends'][-1]
        ui.check('新对话：不带 main，是另一个对话；主对话的编号不变', 'main' not in other and 'sid' not in other and await pg.evaluate("localStorage.getItem('lm.xin.main')") == MAIN, other)
        await pg.click('.xc-list-b')
        await pg.wait_for_selector('.xc-mainb')
        await pg.click('.xc-mainb')
        await pg.wait_for_function("LimingXinChat.state.sid === '%s' && LimingXinChat.state.histFor === '%s' && !LimingXinChat.state.loadingConversation" % (MAIN, MAIN), timeout=10000)
        back = await pg.evaluate("[document.querySelector('.xc').classList.contains('dr-open'), %s.slice(-2)]" % BUBBLES)
        ui.check('点「主对话」：回到主对话，侧边栏收起，前面聊的都在', back == [False, ['问 1', '答 1']], back)

        # 3. 归档 = 重新开始
        await pg.click('.xc-list-b')
        await pg.wait_for_selector('.xc-main-more:not([hidden])')
        await pg.click('.xc-main-more')
        acts = await pg.evaluate("[...document.querySelectorAll('.xc-mainrow .xc-sa button')].map(b => b.textContent)")
        await pg.click('.xc-mainrow .xc-sa-b')
        await pg.wait_for_function("!localStorage.getItem('lm.xin.main') && !LimingXinChat.state.sid && !!document.querySelector('.xc-hello')", timeout=10000)
        await pg.wait_for_function("document.querySelector('.xc-main-more') && document.querySelector('.xc-main-more').hidden", timeout=10000)
        await pg.click('.xc-dr-x')
        await pg.wait_for_function("!document.querySelector('.xc').classList.contains('dr-open')")
        await pg.fill('.xc-row textarea', '重新开始')
        await pg.click('.xc-send')
        await pg.wait_for_function(ui.CHAT_DONE + ' && !!LimingXinChat.state.sid', timeout=10000)
        again = st['sends'][-1]
        ui.check('主对话的 ⋯ 只有「归档，重新开始」（没有删除）；归档后回到空白页，下一句又开出主对话',
                 acts == ['归档，重新开始'] and st['archived_main'] == 1 and again.get('main') is True and 'sid' not in again, (acts, st['archived_main'], again))
        await pg.context.close()

        # 4. 别的设备已经聊了 70 轮：新设备打开就读出来；往前翻页
        pg = await ui.page(browser)
        st = await backend(pg, main=MAIN, turns=70)
        await pg.goto(ui.BASE + '/#xin')
        await pg.wait_for_function("LimingXinChat.state.sid === '%s' && LimingXinChat.state.histFor === '%s' && !LimingXinChat.state.loadingConversation" % (MAIN, MAIN), timeout=10000)
        page1 = await pg.evaluate("[%s.length, %s[0], %s.slice(-1)[0], document.querySelector('.xc-msgs').firstElementChild.className, localStorage.getItem('lm.xin.main')]" % (BUBBLES, BUBBLES, BUBBLES))
        ui.check('已有主对话：打开网页自动读出最近 30 轮，最前面一颗「更早的消息」', page1 == [60, '问 40', '答 69', 'xc-earlier', MAIN], page1)
        await pg.evaluate("document.querySelector('.xc-body').scrollTop = 0")
        # 点按钮前浏览器可能先把它滚到合适的位置：位置在真正按下的那一刻记，和读完以后比
        await pg.evaluate("""document.querySelector('.xc-earlier').addEventListener('click', () => { const b = document.querySelector('.xc-body'), m = [...document.querySelectorAll('.xc-me .xc-bub')].find(e => e.textContent === '问 40');
          window.__seen = Math.round(m.getBoundingClientRect().top - b.getBoundingClientRect().top); }, true)""")
        await pg.click('.xc-earlier')
        seen = await pg.evaluate('window.__seen')
        await pg.wait_for_function("%s.length === 120" % BUBBLES, timeout=10000)
        page2 = await pg.evaluate("""(() => { const b = document.querySelector('.xc-body'), m = [...document.querySelectorAll('.xc-me .xc-bub')].find(e => e.textContent === '问 40');
          const all = %s; return [all[0], all.slice(-1)[0], document.querySelectorAll('.xc-earlier').length, document.querySelector('.xc-msgs').firstElementChild.className,
            Math.round(m.getBoundingClientRect().top - b.getBoundingClientRect().top)]; })()""" % BUBBLES)
        ui.check('更早的消息：再读 30 轮画在最前面，顺序对，按钮还在最上面；原来看的那句没有跳走',
                 page2[:4] == ['问 10', '答 69', 1, 'xc-earlier'] and abs(page2[4] - seen) <= 2 and st['history'][-1].get('before') == 'rpage00040', (page2, seen, st['history'][-1]))
        await pg.evaluate("document.querySelector('.xc-body').scrollTop = 0")
        await pg.click('.xc-earlier')
        await pg.wait_for_function("%s.length === 140" % BUBBLES, timeout=10000)
        page3 = await pg.evaluate("[%s[0], document.querySelectorAll('.xc-earlier').length]" % BUBBLES)
        ui.check('翻到头：最早的一句在最前，按钮消失', page3 == ['问 0', 0], page3)
        await pg.fill('.xc-row textarea', '第 71 句')
        await pg.keyboard.press('Enter')
        await pg.wait_for_function(ui.CHAT_DONE, timeout=10000)
        ui.check('在已有的主对话里接着说：发到它的编号', st['sends'][-1].get('sid') == MAIN and 'main' not in st['sends'][-1], st['sends'][-1])
        await pg.context.close()

        # 5. 这台设备不知道主对话已经有了（招呼还没回来就发了第一句）：这句照样进主对话，回完把前面的接上
        pg = await ui.page(browser)
        st = await backend(pg, main=MAIN, turns=3)
        gate = asyncio.Event()

        async def slow_greet(route):
            if (json.loads(route.request.post_data or '{}')).get('op') != 'greet':
                return await route.fallback()
            await gate.wait()
            await route.fallback()
        await pg.route('**/api/xin/call', slow_greet)
        await pg.goto(ui.BASE + '/#xin')
        await pg.wait_for_selector('.xc.show .xc-hello')
        await pg.fill('.xc-row textarea', '我来了')
        await pg.keyboard.press('Enter')
        await pg.wait_for_function("LimingXinChat.state.histFor === '%s' && !LimingXinChat.state.loadingConversation && !LimingXinChat.state.run" % MAIN, timeout=15000)
        late = await pg.evaluate("[%s.slice(0, 2), LimingXinChat.state.sid]" % BUBBLES)
        ui.check('不知道已有主对话就发了第一句：带 main 发出去，回完重读，前面的内容接上了',
                 st['sends'][-1].get('main') is True and late == [['问 0', '答 0'], MAIN], (st['sends'][-1], late))
        gate.set()
        await pg.context.close()

        # 6. 天启模式开着：空白页是天启的新对话，不发进主对话
        pg = await ui.page(browser)
        st = await backend(pg)
        await pg.add_init_script("localStorage.setItem('lm.xin.agent.v','3');localStorage.setItem('lm.xin.agent','harness')")
        await pg.goto(ui.BASE + '/#xin')
        await pg.wait_for_selector('.xc.show .xc-hello')
        await pg.fill('.xc-row textarea', '天启你好')
        await pg.keyboard.press('Enter')
        await pg.wait_for_function(ui.CHAT_DONE + ' && !!LimingXinChat.state.sid', timeout=10000)
        tq = st['sends'][-1]
        kept = await pg.evaluate("localStorage.getItem('lm.xin.main')")
        ui.check('天启模式开着时的空白页：发出去的是天启的新对话，不带 main', tq.get('agent') == 'harness' and 'main' not in tq and not kept, (tq, kept))
        await pg.context.close()

        # 7. 几种宽度下侧边栏不横向溢出
        for width, height, mobile in ((1280, 860, False), (1024, 768, True), (768, 1024, True), (390, 844, True)):
            pg = await ui.page(browser, width, height, mobile=mobile)
            await backend(pg, main=MAIN, turns=2)
            await pg.goto(ui.BASE + '/#xin')
            await pg.wait_for_function("LimingXinChat.state.histFor === '%s'" % MAIN, timeout=10000)
            await pg.click('.xc-list-b')
            await pg.wait_for_selector('.xc-si')
            await pg.wait_for_timeout(350)
            fit = await pg.evaluate("""(() => { const d = document.querySelector('.xc-drawer').getBoundingClientRect(), r = document.querySelector('.xc-mainrow').getBoundingClientRect();
              return [document.documentElement.scrollWidth <= innerWidth, r.left >= d.left && r.right <= d.right + 1, r.height >= 44]; })()""")
            ui.check('侧边栏 %d 宽：主对话一行放得下、够点，页面不横向滚动' % width, fit == [True, True, True], fit)
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
