#!/usr/bin/env python3
"""小芯内核第 1 步的网页部分（docs/xin-kernel-design.md §14）：

- 发消息时云电脑在睡：Cloudflare 已经存好这句，网页显示「已收到 · 唤醒中」，送到后照常出答案，从不报「没发出去」。
- 云电脑在冷却（很久）：一直显示「已收到 · 冷却中，约 HH:MM 送到」，过了以前 90 秒的上限也不报错。
- 刷新页面时这句还在待送达里：重新画出这句话和等待状态。
- 服务器说能用流：回复从 /api/xin/stream 来，不再轮询；整段答案原样画出来，不拆开。
- 流不可用（503）：退回轮询，答案照样出来。
- 手机和电脑宽度下，冷却那行字都完整可见。
- 「消息没存上」后再点发送：沿用同一个 clientId（万一其实存上了，不会变成两轮）。
- 刷新后待送达里有「没送到」的：把那句话和原因画出来，读过就确认，不悄悄丢。
- 流连上以后卡住（不来数据也不断开）：超过期限自己断开，退回轮询，答案照样出来，不重复。
- 已经退回轮询时窗口失去焦点：不多发一次轮询，同一段答案只画一次。

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
    st.update({'sends': [], 'deliveries': 0, 'k_polls': 0, 'streams': 0, 'last_send': None, 'send_ids': [], 'acks': [], 'poll_offs': []})

    async def handle(route):
        req = route.request
        path = req.url.split('/api/xin/')[1].split('?')[0]
        if path == 'me':
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'enabled': True, 'authed': True, **({'stream': True} if cfg.get('stream') else {})}))
        if path == 'stream':
            st['streams'] += 1
            if cfg.get('stream_url'):   # 交给本机一个真的流（能连上以后卡住）
                return await route.continue_(url=cfg['stream_url'] + '?' + req.url.split('?', 1)[1])
            if cfg.get('stream_status', 200) != 200:
                return await route.fulfill(status=cfg['stream_status'], content_type='application/json', body=json.dumps({'ok': False, 'state': 'unavailable'}))
            return await route.fulfill(status=200, content_type='text/event-stream; charset=utf-8', body=cfg['stream_body'])
        if path != 'call':
            return await route.fallback()
        body = json.loads(req.post_data or '{}')
        op, args = body.get('op'), body.get('args') or {}

        def ok(data):
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        if op == 'send':
            st['send_ids'].append(args.get('clientId'))
            if cfg.get('store_fail') and len(st['send_ids']) == 1:
                return await ok({'ok': False, 'state': 'error', 'resend': True, 'msg': '消息没存上，请再发一次'})
        if op == 'send' and cfg.get('accept'):
            st['sends'].append(args)
            st['last_send'] = args
            wait = cfg['accept']
            return await ok({'ok': False, 'state': 'cooldown' if wait['state'] == 'cooldown' else 'waking', 'accepted': True, 'delivery': view(args, wait=wait),
                             'retryAfter': 2, 'msg': '已收到'})
        if op == 'delivery' and cfg.get('failed_row'):
            st['acks'].append(args.get('id'))
            return await ok({'ok': True, 'data': cfg['failed_row']})
        if op == 'delivery':
            st['deliveries'] += 1
            args0 = st['last_send'] or cfg.get('pending_row') or {}
            if st['deliveries'] > cfg.get('deliver_after', 10 ** 9):
                return await ok({'ok': True, 'data': view(args0, state='delivered', result=RESULT, vid=args.get('id'))})
            return await ok({'ok': True, 'data': view(args0, wait=cfg.get('accept') or cfg.get('pending_wait'), vid=args.get('id'))})
        if op == 'deliveries':
            rows = [view(cfg['pending_row'], wait=cfg.get('pending_wait'), vid='cid-reload-0001')] if cfg.get('pending_row') else []
            if cfg.get('failed_row'): rows.append(cfg['failed_row'])
            return await ok({'ok': True, 'data': {'rows': rows, 'wakes': {'count': 0, 'p50': 0, 'max': 0, 'over45': 0}}})
        if op == 'poll':
            st['k_polls'] += 1
            st['poll_offs'].append(args.get('off', 0))
            if cfg.get('poll'):
                return await ok({'ok': True, 'data': await cfg['poll'](args)})
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

        # 6. 「消息没存上」后再点发送：沿用同一个 clientId
        pg = await ui.page(browser, 1280, 860)
        st = await backend(pg, store_fail=True)
        await pg.goto(ui.BASE + '/#xin')
        await send(pg, '这句第一次没存上')
        await pg.wait_for_function("document.querySelector('.xc').textContent.includes('消息没存上，请再发一次')", timeout=10000)
        back = await pg.evaluate("document.querySelector('.xc-row textarea').value")
        await pg.click('.xc-send')
        await pg.wait_for_function(ui.CHAT_DONE + ' && LimingXinChat.state.sid === "snew000001"', timeout=20000)
        ui.check('没存上：那句话放回输入框；再点发送用的是同一个 clientId', back == '这句第一次没存上' and len(st['send_ids']) == 2 and st['send_ids'][0] and st['send_ids'][0] == st['send_ids'][1], (back, st['send_ids']))
        await pg.context.close()

        # 7. 刷新后：待送达里有一条「没送到」（24 小时放弃），把那句话和原因画出来，并向服务器确认读过了
        failed = {'id': 'cid-failed-0001', 'state': 'failed', 'attempts': 150, 'createdAt': 0, 'deliveredAt': 0, 'wait': None, 'result': None,
                  'error': {'code': 'gave_up', 'msg': '24 小时都没送到'}, 'sid': None, 'main': True, 'text': '昨天发的那句', 'files': []}
        for width, height, mobile in ((390, 844, True), (1280, 860, False)):
            pg = await ui.page(browser, width, height, mobile=mobile)
            st = await backend(pg, failed_row=failed)
            await pg.goto(ui.BASE + '/#xin')
            await pg.wait_for_selector('.xc.show .xc-row textarea')
            try:
                await pg.wait_for_function("document.querySelector('.xc').textContent.includes('没送到：24 小时都没送到')", timeout=8000)
            except Exception:
                pass
            bubbles = await pg.evaluate(BUBBLES)
            text = await pg.evaluate("document.querySelector('.xc').textContent")
            idle = await pg.evaluate(ui.CHAT_DONE)
            wide = await pg.evaluate("document.documentElement.scrollWidth <= innerWidth")
            ui.check('没送到 %d 宽：刷新后画出那句话和原因，只画一次，页面不在等待状态、不横向滚动' % width,
                     bubbles.count('昨天发的那句') == 1 and text.count('没送到：24 小时都没送到') == 1 and idle and wide, (bubbles[-2:], text.count('没送到'), idle, wide))
            ui.check('没送到 %d 宽：读过就向服务器确认（下次不再报）' % width, st['acks'] == ['cid-failed-0001'], st['acks'])
            await pg.context.close()

        # 8. 流连上以后卡住：先到一段，然后既不来数据也不断开。页面超过期限自己断开，两次以后退回轮询，答案照样完整、不重复
        async def stalled(reader, writer):
            head = (await reader.readuntil(b'\r\n\r\n')).decode('latin-1')
            off = int((head.split('off=')[1].split('&')[0].split(' ')[0]) or 0) if 'off=' in head else 0
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n')
            if off == 0:
                writer.write(('id: 10\ndata: ' + json.dumps({'events': [{'t': 'text', 'text': '流里先到的一段'}], 'off': 1, 'pos': 10, 'done': False}, ensure_ascii=False) + '\n\n').encode())
            else:
                writer.write(b': hb\n\n')
            await writer.drain()
            try:
                await reader.read()   # 一直挂着，直到页面自己断开
            finally:
                writer.close()
        server = await asyncio.start_server(stalled, '127.0.0.1', 0)
        port = server.sockets[0].getsockname()[1]

        async def rest(args):
            if args.get('off', 0) >= 1:
                return {'events': [{'t': 'text', 'text': '轮询接着到的一段'}, {'t': 'done', 'ok': True, 'ms': 1000}], 'off': 3, 'done': True}
            return {'events': [], 'off': 0, 'done': False}
        pg = await ui.page(browser, 390, 844, mobile=True)
        await pg.add_init_script('window.LimingXinChatTimeoutMs = 1200')   # 期限调短，测试不用真等 45 秒
        st = await backend(pg, stream=True, stream_url='http://127.0.0.1:%d/stall' % port, poll=rest)
        await pg.goto(ui.BASE + '/#xin')
        await send(pg, '流会卡住')
        try:
            await pg.wait_for_function(ui.CHAT_DONE + ' && LimingXinChat.state.sid === "snew000001"', timeout=15000)
        except Exception:
            pass
        bubbles = await pg.evaluate(BUBBLES)
        ui.check('流卡住：先到的那段画出来了；页面自己发现流断了，退回轮询拿到剩下的，每段只画一次',
                 bubbles.count('流里先到的一段') == 1 and bubbles.count('轮询接着到的一段') == 1 and st['streams'] == 2 and st['poll_offs'] == [1] and await pg.evaluate(ui.CHAT_DONE),
                 (bubbles[-3:], st['streams'], st['poll_offs']))
        await pg.context.close()
        server.close()

        # 9. 已经退回轮询时窗口失去焦点：不多发一次轮询，同一段答案只画一次
        async def slow(args):
            if args.get('off', 0) == 0:
                await asyncio.sleep(1.2)   # 这次轮询还在路上，窗口失去焦点
                return {'events': [{'t': 'text', 'text': '这段答案只该出现一次'}], 'off': 1, 'done': False}
            return {'events': [{'t': 'done', 'ok': True, 'ms': 1000}], 'off': 2, 'done': True}
        pg = await ui.page(browser, 1280, 860)
        st = await backend(pg, stream=True, stream_status=503, poll=slow)
        await pg.goto(ui.BASE + '/#xin')
        await send(pg, '问一句')
        for _ in range(100):
            if st['k_polls']: break
            await asyncio.sleep(0.1)
        await asyncio.sleep(0.3)
        await pg.evaluate("window.dispatchEvent(new Event('blur'))")
        await pg.wait_for_function(ui.CHAT_DONE, timeout=20000)
        await asyncio.sleep(0.4)
        bubbles = await pg.evaluate(BUBBLES)
        ui.check('退回轮询后失去焦点：轮询没有从同一个位置多取一遍，答案只画一次', bubbles.count('这段答案只该出现一次') == 1 and st['poll_offs'] == [0, 1], (bubbles.count('这段答案只该出现一次'), st['poll_offs']))
        ui.local_fail[:] = [f for f in ui.local_fail if '/api/xin/stream?' not in f]
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
