"""Production smoke: real dispatch/chat, durable completion, conversation isolation and Kimi web delivery.
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
    # Task titles are limited to 40 characters; keep the exact-match fixture inside that contract.
    marker = 'xin-smoke-' + uuid.uuid4().hex[:24]
    directory = '/data/workspace/.xin-live-smoke/' + marker
    sid = None
    alternate_sid = None
    web_sid = None
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
            request = ('这是发布后的真实联调，使用默认后台安排，只派一个后台任务并立即回复，不要等待它完成。使用 xin task new --kind research '
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
            if not any(reply_marker in text for text in await page.locator('.xc-ai:not(.xc-typing) .xc-bub').all_text_contents()):
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
            actual = again['task'].get('actualModel')
            if actual == 'gemini-3.8-flash-high':
                finished = [e for r in again['runs'] for e in r['events'] if e.get('t') == 'done']
                if not finished or finished[-1].get('effort') != 'high':
                    raise RuntimeError('Antigravity was not fixed at High')
                print('PASS real default Antigravity Gemini 3.8 Flash High and confined file output', flush=True)
            else:
                quota = (await call('tasks', {'all': True})).get('antigravity') or {}
                if not quota.get('blocked') or quota.get('retryAt', 0) <= time.time() * 1000:
                    raise RuntimeError('Default Antigravity did not run and no real quota cooldown explains the fallback')
                print('PASS real quota cooldown retained and fallback produced the verified file', flush=True)
            if errors:
                raise RuntimeError('Browser JavaScript errors')
            print('PASS closed-page completion, published file download and stable single-turn result', flush=True)
            # Hold an actual server response while switching to a new conversation.
            # The API call and both model turns are real; only network delivery to the page is delayed.
            page = await context.new_page()
            page.on('pageerror', lambda e: errors.append(type(e).__name__))
            await page.goto(BASE + '/#xin', wait_until='domcontentloaded')
            await page.wait_for_function('(sid) => LimingXinChat.state.authed && LimingXinChat.state.sid===sid && LimingXinChat.state.histFor===sid && !LimingXinChat.state.loadingConversation', arg=sid, timeout=60000)
            first_marker='generation-original-'+uuid.uuid4().hex[:12]
            second_marker='generation-current-'+uuid.uuid4().hex[:12]
            entered=asyncio.Event();release=asyncio.Event();held={}
            async def hold_send(route):
                body=route.request.post_data_json or {}
                if body.get('op')=='send' and first_marker in body.get('args',{}).get('text',''):
                    response=await route.fetch(timeout=90000)
                    data=await response.json()
                    if not data.get('ok') or not data.get('data',{}).get('run'):
                        entered.set()
                        return await route.fulfill(response=response)
                    held['run']=data['data']['run'];entered.set()
                    await release.wait()
                    return await route.fulfill(response=response)
                await route.continue_()
            await page.route('**/api/xin/call',hold_send)
            try:
                await page.locator('.xc-row textarea').fill('只回复 '+first_marker+'，不要执行命令、派任务或记忆。')
                await page.locator('.xc-send').click()
                await asyncio.wait_for(entered.wait(),120)
                if not held.get('run'):raise RuntimeError('Real delayed-send fixture did not receive a run')
                await page.locator('.xc-new-b').click()
                release.set()
                await page.evaluate('() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                if await page.evaluate('Boolean(LimingXinChat.state.sid || LimingXinChat.state.run || LimingXinChat.state.sending)'):
                    raise RuntimeError('Late real response replaced the new conversation')
                await page.locator('.xc-row textarea').fill('只回复 '+second_marker+'，不要执行命令、派任务或记忆。')
                await page.locator('.xc-send').click()
                await page.wait_for_function('LimingXinChat.state.sid && !LimingXinChat.state.run && !LimingXinChat.state.sending',timeout=180000)
                alternate_sid=await page.evaluate('LimingXinChat.state.sid')
                text=await page.locator('.xc-msgs').inner_text()
                if alternate_sid==sid or second_marker not in text or first_marker in text:
                    raise RuntimeError('Conversation isolation failed after a real delayed send')
                if not any(second_marker in text for text in await page.locator('.xc-ai:not(.xc-typing) .xc-bub').all_text_contents()):
                    raise RuntimeError('New conversation real-model reply missing')
                limit=time.monotonic()+120
                while True:
                    old=await call('history',{'sid':sid})
                    if not old.get('active'):break
                    if time.monotonic()>limit:raise RuntimeError('Original real turn did not finish')
                    await asyncio.sleep(2)
                events=[e for run in old['runs'] if run['run']==held['run'] for e in run['events'] if e.get('t')=='text']
                if not any(first_marker in e.get('text','') for e in events):raise RuntimeError('Original conversation reply was lost')
                if errors:raise RuntimeError('Browser JavaScript errors')
                print('PASS real delayed response stays in its original conversation while the new conversation completes',flush=True)
            finally:
                release.set()
            # Canonical user scenario. Use the current isolated conversation, with no existing work.
            started = time.monotonic()
            await page.locator('.xc-row textarea').fill('你让 Kimi 去画个奶龙。做成可爱的动画互动网页：黄色圆滚滚的小恐龙、大眼睛，可以点按钮跳舞和挥手，适合手机。不使用任何外部资源。请直接制作，不要先讨论。')
            await page.locator('.xc-send').click()
            await page.wait_for_function('!LimingXinChat.state.run && !LimingXinChat.state.sending', timeout=30000)
            ack_seconds = time.monotonic() - started
            reply = await page.locator('.xc-ai:not(.xc-typing) .xc-bub').last.inner_text()
            if ack_seconds > 20 or '我' not in reply or any(x in reply.lower() for x in ('kimi','deepseek','分身','任务编号')):
                raise RuntimeError('Named web work did not receive a prompt first-person receipt')
            ts = (await call('tasks', {'sid': alternate_sid}))['tasks']
            web = [t for t in ts if t.get('parent') == alternate_sid and t.get('web')]
            if len(web) != 1 or web[0].get('requestedModel') != 'kimi-k3.1-pro' or not web[0].get('strictModel'):
                raise RuntimeError('Kimi web dispatch was missing, duplicated or not pinned')
            web_sid = web[0]['sid']
            if web[0]['status'] not in ('queued','running'):
                raise RuntimeError('Expected active Kimi work during concurrent foreground test')
            front_marker = 'web-front-' + uuid.uuid4().hex[:12]
            await page.locator('.xc-row textarea').fill('只回复 ' + front_marker + '，不要执行命令、派任务或等待正在做的事。')
            await page.locator('.xc-send').click()
            await page.wait_for_function('!LimingXinChat.state.run && !LimingXinChat.state.sending', timeout=90000)
            if front_marker not in await page.locator('.xc-ai:not(.xc-typing) .xc-bub').last.inner_text():
                raise RuntimeError('Concurrent real foreground reply missing during Kimi work')
            front = await call('history', {'sid': alternate_sid})
            done = [e for r in front['runs'] for e in r['events'] if e.get('t') == 'done']
            if not done or done[-1].get('model') != 'deepseek-v4.1-flash':
                raise RuntimeError('Foreground changed model during named background work')
            await page.locator('.xc-row textarea').fill('现在进度怎么样')
            await page.locator('.xc-send').click()
            await page.wait_for_function('!LimingXinChat.state.run && !LimingXinChat.state.sending', timeout=30000)
            progress = await page.locator('.xc-ai:not(.xc-typing) .xc-bub').last.inner_text()
            state = (await call('history', {'sid': web_sid}))['task']['status']
            if state in ('queued','running') and ('画好了' in progress or '%' in progress):
                raise RuntimeError('Progress claimed completion or an invented percentage')
            print('PASS named Kimi web receipt, unchanged DeepSeek chat and truthful progress', flush=True)
            limit = time.monotonic() + 1500
            while True:
                web = (await call('history', {'sid': web_sid}))['task']
                if web['status'] == 'done' and web.get('delivery', {}).get('state') == 'delivered': break
                if web['status'] in ('failed','stopped','waiting') or time.monotonic() > limit:
                    raise RuntimeError('Real Kimi web work did not complete: ' + web['status'])
                await asyncio.sleep(5)
            preview = web.get('preview') or {}
            saved_front = await call('history', {'sid': alternate_sid})
            deliveries = [e for r in saved_front['runs'] for e in r['events'] if e.get('taskResult', {}).get('sid') == web_sid]
            if len(deliveries) != 1 or '我画好了' not in deliveries[0].get('text', ''):
                raise RuntimeError('Completion was not delivered exactly once without another user prompt')
            if web.get('actualModel') != 'kimi-k3.1-pro' or not preview.get('ready') or not preview.get('checks'):
                raise RuntimeError('Real Kimi web artifact or browser evidence missing')
            if not all((web.get('cleanup') or {}).get(k) for k in ('processesGone','tmpCleaned')):
                raise RuntimeError('Temporary processes/files were not cleaned before delivery')
            result = web['result']['text']
            if '我画好了' not in result or any(x in result.lower() for x in ('kimi','deepseek','分身','任务编号')):
                raise RuntimeError('Web completion did not use the required public voice')
            await page.evaluate('LimingXinChat.tasks()')
            await page.wait_for_selector('.xc-preview', timeout=15000)
            async with page.expect_popup() as opened:
                await page.locator('.xc-preview').last.click()
            art = await opened.value
            art.on('pageerror', lambda e: errors.append(type(e).__name__))
            await art.wait_for_selector('#frame:not([hidden])', timeout=180000)
            frame = art.frame_locator('#frame')
            for check in preview['checks']:
                await frame.locator(check['selector']).click()
                target = frame.locator(check['expectSelector'])
                if 'expectText' in check and check['expectText'] not in await target.inner_text():
                    raise RuntimeError('Delivered artwork click text failed')
                if 'expectClass' in check and check['expectClass'] not in (await target.get_attribute('class') or '').split():
                    raise RuntimeError('Delivered artwork click state failed')
                if 'expectAttribute' in check:
                    expected = check['expectAttribute']
                    if await target.get_attribute(expected['name']) != expected['value']:
                        raise RuntimeError('Delivered artwork attribute failed')
            if await frame.locator('body').evaluate('() => self.origin') != 'null':
                raise RuntimeError('Delivered artwork escaped its opaque sandbox')
            if errors: raise RuntimeError('Browser JavaScript errors')
            print('PASS real Kimi animated web preview, actual clicks and complete temporary cleanup', flush=True)
            print('PREVIEW_URL ' + BASE + preview['url'], flush=True)
            await art.close()
        finally:
            # Forget only this run's own conversation. Leave its small result artifact for diagnosis.
            for owned_sid in [s for s in (sid,alternate_sid) if s]:
                try:
                    h = await call('history', {'sid': owned_sid})
                    if h.get('active'):
                        await call('stop', {'run': h['active']['run']})
                    ts = (await call('tasks', {'sid': owned_sid})).get('tasks', [])
                    for t in ts:
                        if ((t.get('title') == marker and t.get('dir') == directory) or t['sid'] == web_sid) and t['status'] in ('running','queued','waiting','stopping'):
                            await call('task_stop', {'sid': t['sid']})
                    await call('forget', {'sid': owned_sid})
                except Exception:
                    print('Smoke records retained for diagnosis', flush=True)
            await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
