#!/usr/bin/env python3
"""小芯：/api/xin/call 的请求被静默丢掉（fetch 永远不结束）时，页面要自己恢复。

场景 poll：这一轮的第一次 poll 永远不回 -> 期限到了 abort，3 秒后重新轮询，这一轮正常收尾。
场景 send：第一次 send 永远不回 -> 期限到了用同一个 clientId 原样重发，只有一句、只有一轮回复。
对照组不卡任何请求，用来得到正常情况下的回复气泡数。

运行：先起本地预览（5173），再 python3 test/e2e/xin_timeout_e2e.py
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

TIMEOUT_MS = 1500  # 测试里把请求期限调到 1.5 秒（window.LimingXinChatTimeoutMs）
REPLIES = '.xc-ai:not(.xc-typing) .xc-bub'
SETTLED = ui.CHAT_DONE + ' && !!LimingXinChat.state.sid'


async def scenario(browser, hang):
    tab = await ui.page(browser)
    await ui.xin_mock(tab, authed=True)
    await tab.add_init_script('window.LimingXinChatTimeoutMs=%d' % TIMEOUT_MS)
    never = asyncio.Event()  # 永远不 set（收尾时才放开），模拟被黑洞吃掉的连接
    seen = {'send': [], 'poll': 0, 'hung': 0}

    async def blackhole(route):
        body = json.loads(route.request.post_data or '{}')
        op = body.get('op')
        args = body.get('args') or {}
        if op == 'send':
            seen['send'].append(args.get('clientId'))
        if op == 'poll':
            seen['poll'] += 1
        first = op == hang and ((op == 'send' and len(seen['send']) == 1) or (op == 'poll' and seen['poll'] == 1))
        if not first:
            return await route.fallback()  # 交给 xin_mock
        seen['hung'] += 1
        await never.wait()
        try:
            await route.abort()
        except Exception:
            pass  # 页面早就 abort 了这个请求

    await tab.route('**/api/xin/call', blackhole)  # 必须注册在 xin_mock 之后，fallback 才会落到 mock
    try:
        await tab.goto(ui.BASE + '/#xin')
        await tab.wait_for_function('LimingXinChat.state.authed && !LimingXinChat.state.loadingConversation', timeout=8000)
        await tab.locator('.xc-row textarea').fill('连接卡住了也要能自己恢复')
        await tab.locator('.xc-send').click()
        await tab.wait_for_function(SETTLED, timeout=20000)
        await asyncio.sleep(0.5)  # 收尾后不应再冒出重复的气泡
        return {
            'hung': seen['hung'],
            'sends': list(seen['send']),
            'replies': await tab.locator(REPLIES).count(),
            'unsent': await tab.evaluate("document.body.innerText.includes('没发出去')"),
            'retry_send': await tab.evaluate('!!LimingXinChat.state.retrySend'),
        }
    finally:
        never.set()
        await asyncio.sleep(0)
        await tab.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        try:
            base = await scenario(browser, None)
            assert base['hung'] == 0 and len(base['sends']) == 1, 'control: unexpected request pattern'
            assert base['replies'] >= 1 and not base['unsent'], 'control: no reply'

            got = await scenario(browser, 'poll')
            assert got['hung'] == 1, 'poll: first poll was not held'
            assert len(got['sends']) == 1, 'poll: send went out more than once'
            assert got['replies'] == base['replies'], 'poll: reply bubbles differ from control (%d vs %d)' % (got['replies'], base['replies'])
            assert not got['unsent'], 'poll: page reported an unsent message'
            print('PASS stuck poll times out and the run still finishes', flush=True)

            got = await scenario(browser, 'send')
            assert got['hung'] == 1, 'send: first send was not held'
            assert len(got['sends']) == 2, 'send: expected exactly one retry, got %d sends' % len(got['sends'])
            assert len(set(got['sends'])) == 1 and got['sends'][0], 'send: retry used a different clientId'
            assert got['replies'] == base['replies'], 'send: reply bubbles differ from control (%d vs %d)' % (got['replies'], base['replies'])
            assert not got['unsent'] and not got['retry_send'], 'send: page reported an unsent message'
            print('PASS stuck send retries with the same clientId and gets one reply', flush=True)
        finally:
            await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
