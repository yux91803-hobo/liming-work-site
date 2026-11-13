"""Production smoke: real dispatch/chat, durable completion, conversation isolation and named Gemini 4 Hydrogen (Antigravity) web delivery.
Credentials come only from Actions Secrets. Never emit response bodies, cookies, screenshots or model traces.
"""
import asyncio
import base64
import hashlib
import json
import os
import time
import uuid
from xin_live_policy import validate_front_model, front_reply_limit, is_leftover_smoke, reply_shape, spoken_marker, says, first_person_receipt, explain_background_fallback
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'https://liming-work.com').rstrip('/')
PASSWORD = os.environ.get('XIN_OWNER_PASSWORD', '')
AGY_MODEL = 'gemini-4-hydrogen'
# 后台按类别定思考强度（vm-runtime.mjs 的 AGY_KIND_EFFORT）：默认文件任务是查资料（research），点名做网页是写代码（code）
AGY_EFFORT = {'research': 'medium', 'code': 'high'}
# Public replies must not mention model, runner or task internals.
LEAKS = ('kimi','deepseek','gemini','antigravity','分身','任务编号')

async def main():
    if len(PASSWORD) < 12:
        raise RuntimeError('Production smoke requires the configured owner credential')
    # Task titles are limited to 40 characters; keep the exact-match fixture inside that contract.
    marker = 'xin-smoke-' + uuid.uuid4().hex[:24]
    directory = '/data/workspace/.xin-live-smoke/' + marker
    sid = None
    alternate_sid = None
    web_sid = None
    image_sid = None
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        context = await browser.new_context(viewport={'width': 1280, 'height': 860})
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(type(e).__name__))
        # The CI runner VM can be paused by its host; the TCP shim then turns the dead connection into ETIMEDOUT.
        # Both #106 and #107 release runs were rolled back by exactly that, mid-way through the long wait for the web task.
        # Read-only ops are safe to resend, so they are retried; ops with side effects are never resent here.
        READ_ONLY = {'history', 'tasks', 'poll', 'sessions', 'status', 'delivery'}
        TRANSPORT = ('ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN', 'socket hang up', 'Timeout')
        async def raw(what, send, retry):
            # Every direct request goes through here so a failure never prints Playwright's call log (it carries the cookie).
            limit = time.monotonic() + 180
            while True:
                try:
                    return await send()
                except Exception as error:
                    kind = next((k for k in TRANSPORT if k in str(error)), type(error).__name__)
                    if retry and kind in TRANSPORT and time.monotonic() < limit:
                        print('Retrying ' + what + ' after a dropped connection (' + kind + ')', flush=True)
                        await asyncio.sleep(3)
                        continue
                    raise RuntimeError('Production request transport failed: ' + what + ' ' + kind) from None
        async def call(op, args):
            limit = time.monotonic() + 180
            while True:
                response = await raw(op, lambda: context.request.post(BASE + '/api/xin/call', headers={'X-Xin': '1'}, data={'op': op, 'args': args}, timeout=80000), op in READ_ONLY)
                try:
                    d = await response.json()
                except Exception:
                    d = {}
                if response.status == 200 and d.get('ok') and not d.get('data', {}).get('error'):
                    return d['data']
                if d.get('state') in ('waking', 'busy') and time.monotonic() < limit:
                    await asyncio.sleep(min(15, max(2, d.get('retryAfter', 3))))
                    continue
                raise RuntimeError('Production call failed: ' + op + ' HTTP ' + str(response.status) + ' state=' + str(d.get('state', d.get('data', {}).get('error', 'unknown'))))
        async def backup_check():
            # Off-machine backup, end to end on production: make today's backup now (an existing one is kept), find it in
            # the list, download it decrypted with the current owner credential and compare size, sha256 and the gzip magic.
            # Only error codes are reported; the archive is never written or printed.
            limit = time.monotonic() + 240
            while True:
                response = await raw('backup', lambda: context.request.post(BASE + '/api/xin/backup', headers={'X-Xin': '1', 'Content-Type': 'application/json'}, data='{}', timeout=150000), True)
                try:
                    d = await response.json()
                except Exception:
                    d = {}
                if response.status == 200 and (d.get('ok') or d.get('skipped') == 'exists'):
                    break
                if d.get('state') in ('waking', 'busy') and time.monotonic() < limit:
                    await asyncio.sleep(10)
                    continue
                raise RuntimeError('Production backup failed: HTTP ' + str(response.status) + ' error=' + str(d.get('error', 'unknown')) + ' state=' + str(d.get('state', '')))
            listed = await raw('backups', lambda: context.request.get(BASE + '/api/xin/backups', timeout=60000), True)
            meta = next((b for b in ((await listed.json()).get('backups') or []) if b.get('date') == d.get('date')), None) if listed.status == 200 else None
            if not meta:
                raise RuntimeError('Production backup missing from the list: HTTP ' + str(listed.status))
            got = await raw('backup download', lambda: context.request.get(BASE + '/api/xin/backup?date=' + meta['date'], timeout=120000), True)
            body = await got.body() if got.status == 200 else b''
            if len(body) != meta.get('size') or hashlib.sha256(body).hexdigest() != meta.get('sha256') or body[:2] != b'\x1f\x8b':
                raise RuntimeError('Production backup did not decrypt to the recorded archive: HTTP ' + str(got.status) + ' bytes=' + str(len(body)))
            return 'new' if d.get('ok') else 'existing'
        async def forget_owned(owned_sid, own_task):
            h = await call('history', {'sid': owned_sid})
            if h.get('active'):
                await call('stop', {'run': h['active']['run']})
            ts = (await call('tasks', {'sid': owned_sid})).get('tasks', [])
            for t in ts:
                if own_task(t) and t['status'] in ('running','queued','waiting','stopping'):
                    await call('task_stop', {'sid': t['sid']})
            # Stopping takes a moment and forget refuses while a turn or task is still winding down: wait for it (at most ~90 s).
            for _ in range(30):
                h = await call('history', {'sid': owned_sid})
                ts = (await call('tasks', {'sid': owned_sid})).get('tasks', [])
                if not h.get('active') and not any(t['status'] in ('running', 'queued', 'stopping') for t in ts):
                    break
                await asyncio.sleep(3)
            await call('forget', {'sid': owned_sid})
        async def front_diagnosis(sid):
            # Cleanup deletes the conversation and its front log entries, so read the last turn's diagnosis first.
            # The controller's diagnosis has only event kinds, byte counts and error categories: no text, no markers.
            try:
                d = ((await call('history', {'sid': sid, 'diagnose': True})).get('runs') or [{}])[-1].get('diagnostics') or {}
                return json.dumps({'events': [e.get('t', '?') + (':' + e['errorType'] if e.get('errorType') else '') for e in d.get('events', [])],
                                   'traces': [str(t.get('outcome')) + ':' + str(t.get('errorType')) for t in d.get('traces', [])]})
            except Exception:
                return 'diagnosis unavailable'
        async def check_front(done):
            quota = (await call('tasks', {'all': True})).get('frontAntigravity') if done.get('model') == 'deepseek-v4.1-flash' else None
            return validate_front_model(done, quota, time.time() * 1000)
        try:
            await page.goto(BASE + '/#xin', wait_until='domcontentloaded')
            await page.locator('.xc-login input[name=pw]').fill(PASSWORD, timeout=30000)
            await page.locator('.xc-login button').click()
            await page.wait_for_function('LimingXinChat.state.authed', timeout=30000)
            # Smoke conversations left by an earlier run whose cleanup failed: recall would quote their old instructions
            # into this run's turns. Remove them first (only this script's own opening lines, never the main conversation).
            for leftover in [s for s in (await call('sessions', {})).get('sessions', []) if is_leftover_smoke(s)]:
                try:
                    await forget_owned(leftover['sid'], lambda t: True)
                    print('Removed a smoke conversation left by an earlier run', flush=True)
                except Exception as error:
                    print('Could not remove an earlier smoke conversation: ' + (str(error)[:160] if isinstance(error, RuntimeError) else type(error).__name__), flush=True)
            print('PASS off-machine encrypted backup (' + await backup_check() + ') listed and restorable with the owner credential', flush=True)
            # A fresh browser lands on the owner's always-on main conversation. That is the owner's, not a fixture:
            # every turn of this run goes to conversations it creates itself (and deletes at the end).
            await page.locator('.xc-new-b').click()
            await page.wait_for_function('!LimingXinChat.state.sid && !LimingXinChat.state.toMain && !LimingXinChat.state.loadingConversation && !LimingXinChat.state.run', timeout=30000)
            # The test namespace and result are unique to this run. No user project is touched.
            request = ('这是发布后的真实联调，使用默认后台安排，只派一个后台任务并立即回复，不要等待它完成。使用 xin task new --kind research '
                       '--title ' + marker + ' --dir ' + directory + ' -- 后台测试：先执行 sleep 45，再用 printf 把精确文本 ' + marker +
                       ' 写入当前任务副本的 result.txt，结束。不要访问其它项目、记事本、设备或用户服务。请只派这个任务，不要派审查。')
            async def settle(predicate, timeout):
                # On timeout report booleans only (page state + whether the server already finished the run). Never print text or markers.
                try:
                    await page.wait_for_function(predicate, timeout=timeout)
                    return
                except Exception as error:
                    failure = error
                state = {}
                try:
                    state = await page.evaluate('(() => { const s = LimingXinChat.state; return {sid: s.sid || "", run: s.run || "", sending: !!s.sending, polling: !!s.polling}; })()')
                except Exception:
                    pass
                server_done = None
                if state.get('run'):
                    try:
                        server_done = bool((await call('poll', {'run': state['run'], 'off': 0})).get('done'))
                    except Exception:
                        server_done = None
                raise RuntimeError('Chat state did not settle: sid=%s run=%s sending=%s polling=%s server_run_done=%s' % (
                    bool(state.get('sid')), bool(state.get('run')), state.get('sending'), state.get('polling'), server_done)) from failure
            dispatched_ms = time.time() * 1000
            await page.locator('.xc-row textarea').fill(request)
            await page.locator('.xc-send').click()
            await settle('LimingXinChat.state.sid && !LimingXinChat.state.run && !LimingXinChat.state.sending', 240000)
            sid = await page.evaluate('LimingXinChat.state.sid')
            if any(s.get('main') and s.get('sid') == sid for s in (await call('sessions', {})).get('sessions', [])):
                sid = None
                raise RuntimeError('Smoke turn landed in the main conversation')
            tasks = (await call('tasks', {'sid': sid}))['tasks']
            owned = [t for t in tasks if t['parent'] == sid and t['title'] == marker and t['dir'] == directory]
            if len(owned) != 1 or owned[0]['status'] not in ('running', 'queued'):
                raise RuntimeError('Expected one active isolated smoke task')
            task = owned[0]
            print('PASS real browser login and real background dispatch', flush=True)
            # Foreground stays usable while the task is executing.
            reply_marker = spoken_marker()
            await page.locator('.xc-row textarea').fill('只回复 ' + reply_marker + '，不要执行命令，也不要等待后台。')
            await page.locator('.xc-send').click()
            await settle('!LimingXinChat.state.run && !LimingXinChat.state.sending', 180000)
            shown = await page.locator('.xc-ai:not(.xc-typing) .xc-bub').all_text_contents()
            if not any(says(text, reply_marker) for text in shown):
                raise RuntimeError('Foreground reply missing: ' + await front_diagnosis(sid) + ' shape=' + json.dumps(reply_shape(shown, reply_marker)))
            print('PASS foreground real-model reply during background work', flush=True)
            # Only pixels contain the random answer; neither the prompt nor the filename reveals it.
            visual_token = 'READ-' + uuid.uuid4().hex[:10].upper()
            png = await page.evaluate("""text => {
                const c=document.createElement('canvas');c.width=1100;c.height=200;
                const g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,c.width,c.height);
                g.fillStyle='black';g.font='bold 90px monospace';g.fillText(text,30,130);
                return c.toDataURL('image/png').split(',')[1];
            }""", visual_token)
            uploaded = await raw('upload', lambda: context.request.post(BASE + '/api/xin/upload?name=visual-check.png',
                headers={'X-Xin':'1','Content-Type':'application/octet-stream'},data=base64.b64decode(png),timeout=80000), False)
            upload_data = await uploaded.json()
            if uploaded.status != 200 or not upload_data.get('ok'):
                raise RuntimeError('Synthetic image upload failed')
            image_client = 'visual-' + uuid.uuid4().hex
            image = await call('send', {'agent':'codex','clientId':image_client,
                'text':'只读取这张图片中唯一一行字符并照写出来。不要派任务、执行命令或记忆。',
                'files':[{'path':upload_data['data']['path'],'name':'visual-check.png'}]})
            image_sid = image['sid']
            limit = time.monotonic() + 90
            while True:
                result = await call('poll', {'run':image['run'],'off':0})
                if result.get('done'): break
                if time.monotonic() > limit: raise RuntimeError('Foreground image reply timed out')
                await asyncio.sleep(2)
            image_events = result.get('events', [])
            image_text = '\n'.join(e.get('text','') for e in image_events if e.get('t') == 'text')
            image_done = next((e for e in image_events if e.get('t') == 'done'), {})
            if visual_token not in image_text or not image_done.get('ok'):
                raise RuntimeError('Foreground real-model image reading mismatch')
            await check_front(image_done)
            if (await call('tasks', {'sid':image_sid})).get('tasks'):
                raise RuntimeError('Foreground image chat unexpectedly delegated work')
            print('PASS real foreground reads random image text directly without delegating', flush=True)
            # Kernel stage 1 (docs/xin-kernel-design.md §14): the message was stored before acknowledgement and maps to its turn,
            # and the turn's events stream from the kernel through Cloudflare. Only status codes and counts are printed.
            me = await (await raw('me', lambda: context.request.get(BASE + '/api/xin/me', timeout=30000), True)).json()
            if me.get('inbox'):
                delivered = await call('delivery', {'id': image_client})
                if delivered.get('state') != 'delivered' or (delivered.get('result') or {}).get('run') != image['run']:
                    raise RuntimeError('Pending delivery did not map to its turn: state=' + str(delivered.get('state')))
                print('PASS message stored before acknowledgement maps to its conversation turn', flush=True)
            if me.get('stream'):
                streamed = await raw('stream', lambda: context.request.get(BASE + '/api/xin/stream?off=0&run=' + image['run'], headers={'X-Xin': '1'}, timeout=120000), True)
                body = (await streamed.body()).decode('utf-8', 'replace') if streamed.status == 200 else ''
                messages = [json.loads(line[6:]) for line in body.split('\n') if line.startswith('data: ')]
                if not str(streamed.headers.get('content-type', '')).startswith('text/event-stream') or not messages or not messages[-1].get('done'):
                    raise RuntimeError('Kernel stream through Cloudflare failed: HTTP ' + str(streamed.status) + ' messages=' + str(len(messages)))
                print('PASS reply events stream from the kernel through Cloudflare (' + str(len(messages)) + ' messages)', flush=True)
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
            response = await raw('file download', lambda: context.request.get(BASE + '/api/xin/file', params={'path': directory + '/result.txt'}, timeout=80000), True)
            if response.status != 200 or (await response.text()).strip() != marker:
                raise RuntimeError('Published result file does not match')
            again = await call('history', {'sid': task['sid']})
            if again['task']['result']['at'] != h['task']['result']['at'] or len(again['runs']) != 1:
                raise RuntimeError('Task completion was duplicated')
            actual = again['task'].get('actualModel')
            if actual == AGY_MODEL:
                finished = [e for r in again['runs'] for e in r['events'] if e.get('t') == 'done']
                if not finished or finished[-1].get('effort') != AGY_EFFORT['research']:
                    raise RuntimeError('Research work on Hydrogen did not use medium thinking')
                print('PASS real default Antigravity Gemini 4 Hydrogen (medium for research) and confined file output', flush=True)
            else:
                # Only a cause the controller itself recorded explains a fallback: a real quota cooldown, or Gemini being
                # unavailable (no output at all = stall, or it answered with a non-SUCCESS status) during this run or in the
                # 15 minutes before it (new tasks skip Gemini then). A local agy failure (no result, non-zero exit) is never
                # recorded, so a broken integration on our side still fails here.
                center = await call('tasks', {'all': True})
                why = explain_background_fallback(center.get('antigravity'), center.get('antigravityIssue'), dispatched_ms, time.time() * 1000)
                print('PASS ' + ('real quota cooldown retained' if why == 'quota' else why + ' recorded by the controller') +
                      ' and fallback produced the verified file', flush=True)
            if errors:
                raise RuntimeError('Browser JavaScript errors')
            print('PASS closed-page completion, published file download and stable single-turn result', flush=True)
            # Hold an actual server response while switching to a new conversation.
            # The API call and both model turns are real; only network delivery to the page is delayed.
            page = await context.new_page()
            page.on('pageerror', lambda e: errors.append(type(e).__name__))
            await page.goto(BASE + '/#xin', wait_until='domcontentloaded')
            await page.wait_for_function('(sid) => LimingXinChat.state.authed && LimingXinChat.state.sid===sid && LimingXinChat.state.histFor===sid && !LimingXinChat.state.loadingConversation', arg=sid, timeout=60000)
            first_marker=spoken_marker(reply_marker)
            second_marker=spoken_marker(first_marker+' '+reply_marker)
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
                bubbles = await page.locator('.xc-ai:not(.xc-typing) .xc-bub').all_text_contents()
                if not any(says(text, second_marker) for text in bubbles):
                    kinds = {}
                    saved = None
                    try:
                        saved = await call('history', {'sid': alternate_sid})
                        for event in [e for r in saved.get('runs', []) for e in r.get('events', [])]:
                            kinds[event.get('t') or '?'] = kinds.get(event.get('t') or '?', 0) + 1
                    except Exception:
                        kinds = {'history': 0}
                    done = [e for r in (saved or {}).get('runs', []) for e in r.get('events', []) if e.get('t') == 'done']
                    assistant_has_marker = any(says(e.get('text'), second_marker) for r in (saved or {}).get('runs', []) for e in r.get('events', []) if e.get('t') == 'text')
                    # Counts and booleans only: never print the reply, the marker or the prompt.
                    raise RuntimeError('New conversation real-model reply missing'
                        + ' bubbles=' + str(len(bubbles))
                        + ' bad=' + str(await page.locator('.xc-ai.bad').count())
                        + ' typing=' + str(await page.locator('.xc-ai.xc-typing').count())
                        + ' events=' + ','.join(k + ':' + str(kinds[k]) for k in sorted(kinds))
                        + ' doneOk=' + str(bool(done and done[-1].get('ok')))
                        + ' savedAssistantHasMarker=' + str(bool(assistant_has_marker))
                        + ' shape=' + json.dumps(reply_shape(bubbles, second_marker, first_marker)))
                limit=time.monotonic()+120
                while True:
                    old=await call('history',{'sid':sid})
                    original=next((r for r in old.get('runs',[]) if r['run']==held['run']),None)
                    # Another completion/handoff can be the last run. Wait for the exact accepted input.
                    if original and original.get('done'):break
                    if time.monotonic()>limit:raise RuntimeError('Original real turn did not finish')
                    await asyncio.sleep(2)
                events=[e for run in old['runs'] if run['run']==held['run'] for e in run['events'] if e.get('t')=='text']
                if not any(says(e.get('text',''), first_marker) for e in events):
                    target_events=original.get('events',[]) if original else []
                    kinds={k:sum(e.get('t')==k for e in target_events) for k in sorted({e.get('t') or '?' for e in target_events})}
                    ended=[e for e in target_events if e.get('t')=='done']
                    raise RuntimeError('Original conversation reply was lost'
                        +' events='+','.join(k+':'+str(kinds[k]) for k in kinds)
                        +' doneOk='+str(bool(ended and ended[-1].get('ok')))
                        +' stopped='+str(bool(ended and ended[-1].get('stopped')))
                        +' userHasMarker='+str(any(first_marker in e.get('text','') for e in target_events if e.get('t')=='user'))
                        +' assistantBytes='+str(sum(len(e.get('text','').encode()) for e in events))
                        +' assistantHasPriorMarker='+str(any(says(e.get('text',''), reply_marker) for e in events)))
                if errors:raise RuntimeError('Browser JavaScript errors')
                print('PASS real delayed response stays in its original conversation while the new conversation completes',flush=True)
            finally:
                release.set()
            # Canonical user scenario. Use the current isolated conversation, with no existing work.
            started = time.monotonic()
            named_request = '你让 Gemini 4 Hydrogen 去画个奶龙。做成可爱的动画互动网页：黄色圆滚滚的小恐龙、大眼睛，可以点按钮跳舞和挥手，适合手机。不使用任何外部资源。请直接制作，不要先讨论。'
            named_dispatched_ms = time.time() * 1000
            await page.locator('.xc-row textarea').fill(named_request)
            await page.locator('.xc-send').click()
            await page.wait_for_function('!LimingXinChat.state.run && !LimingXinChat.state.sending', timeout=90000)
            ack_seconds = time.monotonic() - started
            reply = await page.locator('.xc-ai:not(.xc-typing) .xc-bub').last.inner_text()
            receipt_history = await call('history', {'sid': alternate_sid})
            receipt_runs = [r for r in receipt_history['runs'] if any(e.get('t') == 'user' and e.get('text') == named_request for e in r['events'])]
            if len(receipt_runs) != 1:
                raise RuntimeError('Named web receipt did not retain exactly one original request')
            receipt_done = next((e for e in reversed(receipt_runs[0]['events']) if e.get('t') == 'done'), {})
            receipt_model = await check_front(receipt_done)
            if ack_seconds > front_reply_limit(receipt_model) or not first_person_receipt(reply) or any(x in reply.lower() for x in LEAKS):
                raise RuntimeError('Named web work did not receive a bounded first-person receipt'
                    + ' seconds=' + str(round(ack_seconds, 2)) + ' model=' + receipt_model
                    + ' firstPerson=' + str(first_person_receipt(reply))
                    + ' leaks=' + str(any(x in reply.lower() for x in LEAKS)))
            ts = (await call('tasks', {'sid': alternate_sid}))['tasks']
            web = [t for t in ts if t.get('parent') == alternate_sid and t.get('web')]
            # Antigravity work is never strict-pinned (controller keeps a real-quota fallback), so check the named request instead.
            # The task summary exposes the routing reason as `why`; it does not carry the internal requestedNamed flag.
            if len(web) != 1 or web[0].get('requestedModel') != AGY_MODEL or web[0].get('why') != 'named':
                raise RuntimeError('Named Gemini web dispatch was missing, duplicated or not recorded as named')
            web_sid = web[0]['sid']
            if web[0]['status'] not in ('queued','running'):
                raise RuntimeError('Expected active Gemini web work during concurrent foreground test')
            front_marker = spoken_marker(first_marker + ' ' + second_marker)
            await page.locator('.xc-row textarea').fill('只回复 ' + front_marker + '，不要执行命令、派任务，也不用管正在做的事。')
            await page.locator('.xc-send').click()
            await page.wait_for_function('!LimingXinChat.state.run && !LimingXinChat.state.sending', timeout=90000)
            if not says(await page.locator('.xc-ai:not(.xc-typing) .xc-bub').last.inner_text(), front_marker):
                shown = await page.locator('.xc-ai:not(.xc-typing) .xc-bub').all_text_contents()
                # Counts and booleans only: never print the reply, the marker or the prompt.
                raise RuntimeError('Concurrent real foreground reply missing during Gemini web work: '
                    + await front_diagnosis(alternate_sid)
                    + ' shape=' + json.dumps(reply_shape(shown[-1:], front_marker))
                    + ' lastMentionsWeb=' + str(any(w in (shown[-1] if shown else '') for w in ('奶龙', '网页', '页面', '在做'))))
            front = await call('history', {'sid': alternate_sid})
            done = [e for r in front['runs'] for e in r['events'] if e.get('t') == 'done']
            await check_front(done[-1] if done else {})
            await page.locator('.xc-row textarea').fill('现在进度怎么样')
            await page.locator('.xc-send').click()
            await page.wait_for_function('!LimingXinChat.state.run && !LimingXinChat.state.sending', timeout=90000)
            progress = await page.locator('.xc-ai:not(.xc-typing) .xc-bub').last.inner_text()
            state = (await call('history', {'sid': web_sid}))['task']['status']
            if state in ('queued','running') and ('画好了' in progress or '%' in progress):
                raise RuntimeError('Progress claimed completion or an invented percentage')
            print('PASS named Gemini web receipt, configured foreground with real quota evidence and truthful progress', flush=True)
            limit = time.monotonic() + 1500
            while True:
                web = (await call('history', {'sid': web_sid}))['task']
                if web['status'] == 'done' and web.get('delivery', {}).get('state') == 'delivered': break
                if web['status'] in ('failed','stopped','waiting') or time.monotonic() > limit:
                    raise RuntimeError('Real Gemini web work did not complete: ' + web['status'])
                await asyncio.sleep(5)
            preview = web.get('preview') or {}
            saved_front = await call('history', {'sid': alternate_sid})
            deliveries = [e for r in saved_front['runs'] for e in r['events'] if e.get('taskResult', {}).get('sid') == web_sid]
            if len(deliveries) != 1 or '我画好了' not in deliveries[0].get('text', ''):
                raise RuntimeError('Completion was not delivered exactly once without another user prompt')
            if web.get('actualModel') != AGY_MODEL:
                # Same rule as the background file task: only a cause the controller recorded explains a fallback
                # (a real quota cooldown, or a Gemini outage: stall / non-SUCCESS answer). #132 正式站：named Gemini 120 秒不出声，换 GLM 做完。
                center = await call('tasks', {'all': True})
                why = explain_background_fallback(center.get('antigravity'), center.get('antigravityIssue'), named_dispatched_ms, time.time() * 1000)
                print('PASS named Gemini web fell back only because ' + ('of a real quota cooldown' if why == 'quota' else why + ' was recorded by the controller'), flush=True)
            if not preview.get('ready') or not preview.get('checks'):
                raise RuntimeError('Real Gemini web artifact or browser evidence missing')
            if not all((web.get('cleanup') or {}).get(k) for k in ('processesGone','tmpCleaned')):
                raise RuntimeError('Temporary processes/files were not cleaned before delivery')
            result = web['result']['text']
            if '我画好了' not in result or any(x in result.lower() for x in LEAKS):
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
                # Model-made artwork often animates forever; Playwright's "stable" wait would never end.
                # Click like a person (and like the controller's own CDP check): visible, then click its centre.
                control = frame.locator(check['selector'])
                await control.wait_for(state='visible', timeout=15000)
                await control.click(force=True)
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
            print('PASS real Gemini animated web preview, actual clicks and complete temporary cleanup', flush=True)
            print('PREVIEW_URL ' + BASE + preview['url'], flush=True)
            await art.close()
        finally:
            # Forget only this run's own conversation. Leave its small result artifact for diagnosis.
            for owned_sid in [s for s in (sid,alternate_sid,image_sid) if s]:
                try:
                    await forget_owned(owned_sid, lambda t: owned_sid == image_sid or (t.get('title') == marker and t.get('dir') == directory) or t['sid'] == web_sid)
                except Exception as error:
                    print('Smoke records retained for diagnosis: ' + (str(error)[:160] if isinstance(error, RuntimeError) else type(error).__name__), flush=True)
            await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
