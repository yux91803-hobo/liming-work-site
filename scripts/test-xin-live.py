"""Production smoke: browser login → real dispatch → concurrent chat → closed browser → durable task result.
Credentials come only from Actions Secrets. Never emit response bodies, cookies, screenshots or model traces.
"""
import asyncio
import json
import os
import time
import uuid
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'https://liming-work.com').rstrip('/')
PASSWORD = os.environ.get('XIN_OWNER_PASSWORD', '')

async def main():
    if len(PASSWORD) < 12:
        raise RuntimeError('Production smoke requires the configured owner credential')
    marker = 'xin-smoke-' + uuid.uuid4().hex
    directory = '/data/workspace/.xin-live-smoke/' + marker
    sid = None
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        context = await browser.new_context(viewport={'width': 1280, 'height': 860})
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(type(e).__name__))
        async def call(op, args):
            limit = time.monotonic() + 180
            while True:
                response = await context.request.post(BASE + '/api/xin/call', headers={'X-Xin': '1'}, data={'op': op, 'args': args}, timeout=80000)
                d = await response.json()
                if response.status == 200 and d.get('ok') and not d.get('data', {}).get('error'):
                    return d['data']
                if d.get('state') in ('waking', 'busy') and time.monotonic() < limit:
                    await asyncio.sleep(min(15, max(2, d.get('retryAfter', 3))))
                    continue
                raise RuntimeError('Production call failed: ' + op + ' HTTP ' + str(response.status) + ' state=' + str(d.get('state', d.get('data', {}).get('error', 'unknown'))))
        try:
            await page.goto(BASE + '/#xin', wait_until='domcontentloaded')
            await page.locator('.xc-login input[name=pw]').fill(PASSWORD, timeout=30000)
            await page.locator('.xc-login button').click()
            await page.wait_for_function('LimingXinChat.state.authed', timeout=30000)
            # The test namespace and result are unique to this run. No user project is touched.
            request = ('这是发布后的真实联调，只派一个后台任务并立即回复，不要等待它完成。使用 xin task new --kind research --model deepseek-v4.1-flash '
                       '--title ' + marker + ' --dir ' + directory + ' -- 后台测试：先执行 sleep 45，再用 printf 把精确文本 ' + marker +
                       ' 写入当前任务副本的 result.txt，结束。不要访问其它项目、记事本、设备或用户服务。请只派这个任务，不要派审查。')
            await page.locator('.xc-row textarea').fill(request)
            await page.locator('.xc-send').click()
            await page.wait_for_function('LimingXinChat.state.sid && !LimingXinChat.state.run && !LimingXinChat.state.sending', timeout=240000)
            sid = await page.evaluate('LimingXinChat.state.sid')
            tasks = (await call('tasks', {'sid': sid}))['tasks']
            owned = [t for t in tasks if t['parent'] == sid and t['title'] == marker and t['dir'] == directory]
            if len(owned) != 1 or owned[0]['status'] not in ('running', 'queued'):
                raise RuntimeError('Expected one active isolated smoke task')
            task = owned[0]
            print('PASS real browser login and real background dispatch', flush=True)
            # Foreground stays usable while the task is executing.
            reply_marker = 'front-' + uuid.uuid4().hex[:12]
            await page.locator('.xc-row textarea').fill('只回复 ' + reply_marker + '，不要执行命令，也不要等待后台。')
            await page.locator('.xc-send').click()
            await page.wait_for_function('!LimingXinChat.state.run && !LimingXinChat.state.sending', timeout=180000)
            if reply_marker not in await page.locator('.xc-msgs').inner_text():
                raise RuntimeError('Foreground reply missing')
            print('PASS foreground real-model reply during background work', flush=True)
            # Close the page: completion must be recovered through the API and supervisor, without a browser polling loop.
            await page.close()
            await asyncio.sleep(55)
            limit = time.monotonic() + 180
            while True:
                h = await call('history', {'sid': task['sid']})
                status = h['task']['status']
                if status == 'done':
                    break
                if status in ('failed', 'stopped', 'waiting') or time.monotonic() > limit:
                    raise RuntimeError('Background task did not complete: ' + status)
                await asyncio.sleep(4)
            response = await context.request.get(BASE + '/api/xin/file', params={'path': directory + '/result.txt'}, timeout=80000)
            if response.status != 200 or (await response.text()).strip() != marker:
                raise RuntimeError('Published result file does not match')
            again = await call('history', {'sid': task['sid']})
            if again['task']['result']['at'] != h['task']['result']['at'] or len(again['runs']) != 1:
                raise RuntimeError('Task completion was duplicated')
            if errors:
                raise RuntimeError('Browser JavaScript errors')
            print('PASS closed-page completion, published file download and stable single-turn result', flush=True)
        finally:
            # Forget only this run's own conversation. Leave its small result artifact for diagnosis.
            if sid:
                try:
                    h = await call('history', {'sid': sid})
                    if h.get('active'):
                        await call('stop', {'run': h['active']['run']})
                    ts = (await call('tasks', {'sid': sid})).get('tasks', [])
                    for t in ts:
                        if t.get('title') == marker and t.get('dir') == directory and t['status'] in ('running','queued','waiting','stopping'):
                            await call('task_stop', {'sid': t['sid']})
                    await call('forget', {'sid': sid})
                except Exception:
                    print('Smoke records retained for diagnosis', flush=True)
            await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
