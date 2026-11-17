"""正式站联调：后台干活时插话（docs/superpowers/specs/2026-11-17-xin-steer-design.md），真模型，在 scripts/test-xin-live.py 里调用。

A. Gemini：按顺序核对 4 个模型名（2 个启用、2 个备用），每一步先 sleep；第一步开始后在聊天里补「备用的别列，只列实际启用的」。
   前台回的是自己的话（不是控制器的固定句）；补充进了同一轮（过程里有兄弟的补充、没有为它另起一轮）；之后的命令不再处理备用的；
   最终名单只有启用的。同一编号的补充重送两次只算一次。
B. 停下再继续（中途断掉）：补充以后把任务停下；先说一句不带「继续」的补充，前台说状态、不开工；再明确说继续，接着做的那一轮
   仍按停下前的补充给名单（补的那句还在）。
C. Codex（点名 Kimi）：同样的补充经 turn/steer 进当前轮，最终名单对。

只打印布尔值和计数，不打印回话、标记和提示词（仓库公开）。
"""
import asyncio
import time
import uuid
from xin_live_policy import steer_request, list_verdict, after_steer, canned_reply

KEEP, DROP = ['alpha-main', 'gamma-main'], ['beta-backup', 'delta-backup']
ITEMS = [('alpha-main', True), ('beta-backup', False), ('gamma-main', True), ('delta-backup', False)]


def run_events(h):
    return [e for r in h.get('runs', []) for e in r.get('events', [])]


async def steer_live(page, call, settle, errors, leaks, owned, base_dir):
    async def new_conversation():
        await page.locator('.xc-new-b').click()
        await page.wait_for_function('!LimingXinChat.state.sid && !LimingXinChat.state.run && !LimingXinChat.state.loadingConversation', timeout=30000)

    # 发一句、等这一轮回完；回话从保存的记录里按原话找（主动说的那句可能同时画在最后，不拿页面上最后一条）
    async def say(text, timeout=180000):
        await page.locator('.xc-row textarea').fill(text)
        await page.locator('.xc-send').click()
        await settle('LimingXinChat.state.sid && !LimingXinChat.state.run && !LimingXinChat.state.sending', timeout)
        sid = await page.evaluate('LimingXinChat.state.sid')
        h = await call('history', {'sid': sid})
        run = next((r for r in reversed(h.get('runs', [])) if any(e.get('t') == 'user' and e.get('text') == text for e in r.get('events', []))), None)
        return sid, '\n'.join(e.get('text', '') for e in (run or {}).get('events', []) if e.get('t') == 'text')

    def check_reply(what, reply):
        bad = not reply.strip() or canned_reply(reply) or any(x in reply.lower() for x in leaks)
        if bad:
            raise RuntimeError(what + ' was not the assistant\'s own words: empty=' + str(not reply.strip()) + ' canned=' + str(canned_reply(reply))
                               + ' leaks=' + str(any(x in reply.lower() for x in leaks)))

    async def dispatch(tag, items, model=''):
        await new_conversation()
        title, directory = 'xin-steer-' + tag + '-' + uuid.uuid4().hex[:12], base_dir + '/steer-' + tag
        sid, _ = await say(steer_request(title, directory, items, model), 240000)
        owned.append(sid)
        ts = [t for t in (await call('tasks', {'sid': sid}))['tasks'] if t.get('title') == title]
        if len(ts) != 1:
            raise RuntimeError('Steer fixture ' + tag + ': expected one dispatched task, got ' + str(len(ts)))
        return sid, title, ts[0]

    async def wait_step(task_sid, name, what, limit=300):
        end = time.monotonic() + limit
        while True:
            h = await call('history', {'sid': task_sid})
            if any(e.get('t') in ('tool', 'tool_end') and name in str(e.get('detail', '')) for e in run_events(h)):
                return h
            if h['task']['status'] not in ('queued', 'running') or time.monotonic() > end:
                raise RuntimeError('Steer fixture: ' + what + ' did not start (status=' + h['task']['status'] + ')')
            await asyncio.sleep(2)

    async def wait_status(task_sid, want, limit=900):
        end = time.monotonic() + limit
        while True:
            h = await call('history', {'sid': task_sid})
            if h['task']['status'] in want:
                return h
            if time.monotonic() > end:
                raise RuntimeError('Steer fixture: task stayed ' + h['task']['status'] + ' instead of ' + '/'.join(want))
            await asyncio.sleep(4)

    def final_list(h, keep, drop, what):
        v = list_verdict((h['task'].get('result') or {}).get('text', ''), keep, drop)
        if h['task']['status'] != 'done' or not v['keeps'] or not v['drops']:
            raise RuntimeError(what + ' final list wrong: status=' + h['task']['status'] + ' keepsEnabled=' + str(v['keeps']) + ' dropsBackups=' + str(v['drops']))

    # ---------- A. Gemini：补一句，下一步跟着改，最后的名单只有启用的 ----------
    sid_a, title_a, task_a = await dispatch('a', ITEMS)
    await wait_step(task_a['sid'], 'alpha-main', 'Gemini first step')
    # 断线重送：同一编号两次只算一次。第一步刚开始、还在模型这一轮里，回执是「进了当前这一轮」
    client = 'steer-resend-' + uuid.uuid4().hex[:16]
    first = await call('task_tell', {'sid': task_a['sid'], 'text': '只列启用的（重送检查）', 'clientId': client})
    again = await call('task_tell', {'sid': task_a['sid'], 'text': '只列启用的（重送检查）', 'clientId': client})
    if first.get('delivery') != 'now' or again.get('delivery') != 'now':
        raise RuntimeError('Supplement to a running turn was not delivered into it once: first=' + str(first.get('delivery')) + ' resend=' + str(again.get('delivery')))
    _, reply = await say('刚才 ' + title_a + ' 那件事，备用的别列，只列实际启用的。')
    check_reply('Gemini supplement reply', reply)
    done_a = await wait_status(task_a['sid'], ('done', 'failed', 'stopped', 'waiting'))
    evs = run_events(done_a)
    steer = after_steer(evs, DROP)
    resent = sum(1 for e in evs if e.get('t') == 'user' and e.get('steer') and '重送检查' in str(e.get('text', '')))
    gemini = done_a['task'].get('actualModel') == 'gemini-4-hydrogen'
    if not steer['steered'] or steer['laterDrop'] or resent > 1 or len(done_a.get('runs', [])) != 1:
        raise RuntimeError('Gemini supplement did not steer the running turn: steered=' + str(steer['steered']) + ' laterBackupCommand=' + str(steer['laterDrop'])
                           + ' resentDelivered=' + str(resent) + ' runs=' + str(len(done_a.get('runs', []))) + ' gemini=' + str(gemini))
    final_list(done_a, KEEP, DROP, 'Gemini supplement')
    print('PASS supplement steered the running ' + ('Gemini' if gemini else 'fallback') + ' turn: own-words reply, next steps skipped backups, final list only enabled, resend counted once', flush=True)

    # ---------- B. 停下再继续：补的那句还在 ----------
    items_b = ITEMS[:3]
    sid_b, title_b, task_b = await dispatch('b', items_b)
    await wait_step(task_b['sid'], 'alpha-main', 'stop/continue first step')
    _, reply = await say('刚才 ' + title_b + ' 那件事，备用的别列，只列实际启用的。')
    check_reply('Supplement reply before stop', reply)
    await call('task_stop', {'sid': task_b['sid']})
    stopped = await wait_status(task_b['sid'], ('stopped',), 180)
    runs_before = len(stopped.get('runs', []))
    _, reply = await say(title_b + ' 那件事再加一条：名单按字母顺序排。')
    check_reply('Stopped-task status reply', reply)
    still = await call('history', {'sid': task_b['sid']})
    if still['task']['status'] != 'stopped' or len(still.get('runs', [])) != runs_before:
        raise RuntimeError('A supplement without "continue" restarted a stopped task: status=' + still['task']['status'])
    _, reply = await say('继续把 ' + title_b + ' 那件事做完。')
    check_reply('Continue reply', reply)
    done_b = await wait_status(task_b['sid'], ('done', 'failed', 'waiting'))
    if len(done_b.get('runs', [])) != runs_before + 1:
        raise RuntimeError('Explicit continue did not resume exactly once: runs=' + str(len(done_b.get('runs', []))))
    final_list(done_b, ['alpha-main', 'gamma-main'], ['beta-backup'], 'Stop/continue')
    print('PASS stopped mid-way: a plain supplement only reported the status, an explicit continue resumed and still applied the earlier supplement', flush=True)

    # ---------- C. Codex（点名 Kimi）：补充经 turn/steer 进当前轮 ----------
    sid_c, title_c, task_c = await dispatch('c', ITEMS[:3], '用 Kimi 做')
    if task_c.get('model') != 'kimi-k3.1-pro':
        raise RuntimeError('Codex fixture was not routed to the named Kimi model')
    await wait_step(task_c['sid'], 'alpha-main', 'Codex first step')
    _, reply = await say('刚才 ' + title_c + ' 那件事，备用的别列，只列实际启用的。')
    check_reply('Codex supplement reply', reply)
    done_c = await wait_status(task_c['sid'], ('done', 'failed', 'stopped', 'waiting'))
    steer = after_steer(run_events(done_c), ['beta-backup'])
    if not steer['steered'] or len(done_c.get('runs', [])) != 1:
        raise RuntimeError('Codex supplement did not enter the running turn: steered=' + str(steer['steered']) + ' runs=' + str(len(done_c.get('runs', []))))
    final_list(done_c, ['alpha-main', 'gamma-main'], ['beta-backup'], 'Codex supplement')
    if errors:
        raise RuntimeError('Browser JavaScript errors')
    print('PASS Codex (named Kimi) supplement entered the running turn via steer and the final list followed it', flush=True)
