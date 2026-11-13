#!/usr/bin/env python3
"""小芯内核第 1 步的网页部分（docs/xin-kernel-design.md §14）：

- 发消息时云电脑在睡：Cloudflare 已经存好这句，网页显示「已收到 · 唤醒中」，送到后照常出答案，从不报「没发出去」。
- 云电脑在冷却（很久）：一直显示「已收到 · 冷却中，约 HH:MM 送到」，过了以前 90 秒的上限也不报错。
- 刷新页面时这句还在待送达里：重新画出这句话和等待状态。
- 服务器说能用流：回复从 /api/xin/stream 来，不再轮询；整段答案原样画出来，不拆开。
- 流不可用（503）：退回轮询，答案照样出来。
- 手机和电脑宽度下，冷却那行字都完整可见。

运行：先起本地预览（5173），再 python3 test/e2e/xin_kernel_e2e.py
"""
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

LABEL = "((document.querySelector('.xc-typing-l') || {}).textContent || '')"
BUBBLES = "[...document.querySelectorAll('.xc-m:not(.xc-typing) .xc-bub')].map(b => b.textContent)"
RESULT = {'sid': 'snew000001', 'run': 'rlive00001', 'agent': 'codex'}


def view(args, state='pending', wait=None, result=None, vid=None):
    return {'id': vid or args.get('clientId'), 'state': state, 'attempts': 1, 'createdAt': 0, 'deliveredAt': 0, 'wait': wait,
            'result': result, 'error': None, 'sid': args.get('sid'), 'main': bool(args.get('main')), 'text': args.get('text', ''), 'files': []}


async def backend(pg, **cfg):
    """在通用的假接口前面加一层：/me 的 stream、/stream、send 的「已收到」、delivery、deliveries。"""
    st = await ui.xin_mock(pg, authed=True)
    st.update({'sends': [], 'deliveries': 0, 'k_polls': 0, 'streams': 0, 'last_send': None})

    async def handle(route):
        req = route.request
        path = req.url.split('/api/xin/')[1].split('?')[0]
        if path == 'me':
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'enabled': True, 'authed': True, **({'stream': True} if cfg.get('stream') else {})}))
        if path == 'stream':
            st['streams'] += 1
            if cfg.get('stream_status', 200) != 200:
                return await route.fulfill(status=cfg['stream_status'], content_type='application/json', body=json.dumps({'ok': False, 'state': 'unavailable'}))
            return await route.fulfill(status=200, content_type='text/event-stream; charset=utf-8', body=cfg['stream_body'])
        if path != 'call':
            return await route.fallback()
        body = json.loads(req.post_data or '{}')
        op, args = body.get('op'), body.get('args') or {}

        def ok(data):
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        if op == 'send' and cfg.get('accept'):
            st['sends'].append(args)
            st['last_send'] = args
            wait = cfg['accept']
            return await ok({'ok': False, 'state': 'cooldown' if wait['state'] == 'cooldown' else 'waking', 'accepted': True, 'delivery': view(args, wait=wait),
                             'retryAfter': 2, 'msg': '已收到'})
        if op == 'delivery':
            st['deliveries'] += 1
            args0 = st['last_send'] or cfg.get('pending_row') or {}
            if st['deliveries'] > cfg.get('deliver_after', 10 ** 9):
                return await ok({'ok': True, 'data': view(args0, state='delivered', result=RESULT, vid=args.get('id'))})
            return await ok({'ok': True, 'data': view(args0, wait=cfg.get('accept') or cfg.get('pending_wait'), vid=args.get('id'))})
        if op == 'deliveries':
            rows = [view(cfg['pending_row'], wait=cfg.get('pending_wait'), vid='cid-reload-0001')] if cfg.get('pending_row') else []
            return await ok({'ok': True, 'data': {'rows': rows, 'wakes': {'count': 0, 'p50': 0, 'max': 0, 'over45': 0}}})
        if op == 'poll':
            st['k_polls'] += 1
        return await route.fallback()
    await pg.route('**/api/xin/**', handle)
    return st


async def send(pg, text):
    await pg.wait_for_selector('.xc.show .xc-row textarea')
    await pg.fill('.xc-row textarea', text)
    await pg.click('.xc-send')


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))

        # 1. 云电脑在睡：先「已收到 · 唤醒中」，送到后照常出答案
        pg = await ui.page(browser, 390, 844, mobile=True)
        st = await backend(pg, accept={'state': 'waking'}, deliver_after=2)
        await pg.goto(ui.BASE + '/#xin')
        await send(pg, '你好')
        await pg.wait_for_function(LABEL + ".includes('已收到 · 唤醒中')", timeout=10000)
        pend = await pg.evaluate("!!document.querySelector('.xc-m.pending, .pending .xc-bub, .xc-bub.pending') || !!document.querySelector('.pending')")
        await pg.wait_for_function(ui.CHAT_DONE + ' && LimingXinChat.state.sid === "snew000001"', timeout=20000)
        bubbles = await pg.evaluate(BUBBLES)
        text = await pg.evaluate("document.querySelector('.xc').textContent")
        ui.check('电脑在睡：先显示「已收到 · 唤醒中」，这句话标着还没送到', pend, pend)
        ui.check('送到后照常出答案，只发了一次 send，从没出现「没发出去」', len(st['sends']) == 1 and '里面有一个 blink 目录。' in bubbles and '没发出去' not in text, (len(st['sends']), bubbles[-2:]))
        await pg.context.close()

        # 2. 冷却很久：过了以前 90 秒的上限也不报错，一直显示「已收到 · 冷却中，约 HH:MM 送到」
        until = int(time.time() * 1000) + 2 * 3600 * 1000
        hhmm = datetime.fromtimestamp(until / 1000 + 8 * 3600, tz=timezone.utc).strftime('%H:%M')
        for width, height, mobile in ((390, 844, True), (1280, 860, False)):
            pg = await ui.page(browser, width, height, mobile=mobile)
            await pg.clock.install()
            st = await backend(pg, accept={'state': 'cooldown', 'until': until})
            await pg.goto(ui.BASE + '/#xin')
            await send(pg, '冷却时发的一句')
            await pg.wait_for_function(LABEL + ".includes('已收到 · 冷却中')", timeout=10000)
            await pg.clock.fast_forward(96000)
            await pg.wait_for_timeout(500)
            label = await pg.evaluate(LABEL)
            text = await pg.evaluate("document.querySelector('.xc').textContent")
            fit = await pg.evaluate("""(() => { const e = document.querySelector('.xc-typing-l'); if (!e) return null; const r = e.getBoundingClientRect();
              return [e.scrollWidth <= e.clientWidth + 1, r.left >= 0, r.right <= innerWidth, document.documentElement.scrollWidth <= innerWidth]; })()""")
            ui.check('冷却 %d 宽：过了 96 秒还在等，写明大约几点送到，没报「没发出去」，send 只发了一次' % width,
                     label == '已收到 · 冷却中，约 %s 送到' % hhmm and '没发出去' not in text and len(st['sends']) == 1, (label, len(st['sends'])))
            ui.check('冷却 %d 宽：那行字完整可见，页面不横向滚动' % width, fit == [True, True, True, True], fit)
            await pg.context.close()

        # 3. 刷新后：待送达里还有这句，画出来并接着等
        pg = await ui.page(browser, 1280, 860)
        st = await backend(pg, pending_row={'text': '刷新前那句', 'main': True, 'clientId': 'cid-reload-0001'}, pending_wait={'state': 'waking'})
        await pg.goto(ui.BASE + '/#xin')
        await pg.wait_for_function(LABEL + ".includes('已收到 · 唤醒中')", timeout=10000)
        shown = await pg.evaluate("[...document.querySelectorAll('.xc-m.pending .xc-bub, .pending .xc-bub')].map(b => b.textContent)")
        ui.check('刷新后：还没送到的那句画出来了，标着等待', '刷新前那句' in shown, shown)
        await pg.context.close()

        # 4. 能用流：回复从流里来，整段答案原样画出，不再轮询
        sse = ('id: 10\ndata: ' + json.dumps({'events': [{'t': 'text', 'text': '整段答案'}], 'off': 1, 'pos': 10, 'done': False}, ensure_ascii=False) + '\n\n'
               'id: 20\ndata: ' + json.dumps({'events': [{'t': 'done', 'ok': True, 'ms': 1000}], 'off': 2, 'pos': 20, 'done': True}) + '\n\n')
        pg = await ui.page(browser, 1280, 860)
        st = await backend(pg, stream=True, stream_body=sse)
        await pg.goto(ui.BASE + '/#xin')
        await send(pg, '用流回我')
        await pg.wait_for_function(ui.CHAT_DONE + ' && LimingXinChat.state.sid === "snew000001"', timeout=15000)
        bubbles = await pg.evaluate(BUBBLES)
        ui.check('流：答案原样一整段画出来，这一轮没有调 poll', bubbles[-1:] == ['整段答案'] and st['k_polls'] == 0 and st['streams'] >= 1, (bubbles[-2:], st['k_polls'], st['streams']))
        await pg.context.close()

        # 5. 流不可用（503）：退回轮询，答案照样出来
        pg = await ui.page(browser, 1280, 860)
        st = await backend(pg, stream=True, stream_status=503)
        await pg.goto(ui.BASE + '/#xin')
        await send(pg, '流坏了')
        await pg.wait_for_function(ui.CHAT_DONE + ' && LimingXinChat.state.sid === "snew000001"', timeout=20000)
        bubbles = await pg.evaluate(BUBBLES)
        ui.check('流 503：改用轮询，答案照样出来', '里面有一个 blink 目录。' in bubbles and st['k_polls'] > 0 and 1 <= st['streams'] <= 2, (bubbles[-1:], st['k_polls'], st['streams']))
        ui.local_fail[:] = [f for f in ui.local_fail if '/api/xin/stream?' not in f]   # 这一段故意让流回 503
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
