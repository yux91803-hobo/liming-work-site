#!/usr/bin/env python3
"""「小芯的电脑」终端窗口（docs/superpowers/plans/2026-11-16-xin-workbench-round2-b.md；站长 2026-11-16：点聊天里小芯的头像弹出来，
像素风、像 Claude Code，代码一个字一个字敲出来）。

1. 窗口本身（site/xin/term.js）：欢迎框里小芯的像素小人、模型、工作目录；「> 要求」；「运行(…)」这样一步一行；输出最多 8 行；
   内部命令不画；网页的地址栏和标题；改动一行一行敲；做完一行和光标；一个字一个字敲（积压多了加速）；减少动态时直接画；
   Esc 关、焦点回到头像；分页用方向键换；手机上从底下升起、不横向滚动。
2. 聊天里：回答的头像点开看那一轮（只说了话的点不开）；正在回话时「正在输入」的头像点开看正在做的；后台的活最下面一行，
   点开看它（只在开着时才取，关了就停），做完写结果；任务结果的头像点开，没取过才去取完整记录；换对话窗口关上。

运行：先起本地预览（5173），再 python3 test/e2e/xin_term_e2e.py
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402


def now():
    return int(time.time() * 1000)


B = lambda c: "/bin/bash -lc '%s'" % c  # noqa: E731
OUT20 = '\n'.join('arm-none-eabi-gcc -c src/f%02d.c -o build/f%02d.o' % (i, i) for i in range(20))
DIFF = '--- update /data/workspace/blink/src/tim.c\n@@ -9,3 +9,6 @@\n-  TIM2->CCR2 = 500;\n+  static uint16_t d = 0;\n+  TIM2->CCR2 = d < 1000 ? d : 2000 - d;\n+  if (++d >= 2000) d = 0;\n   TIM2->CR1 |= TIM_CR1_CEN;'
WEB_OUT = '网址：https://example.com/a\n标题：示例页面\n正文……'
EVENTS = [{'t': 'text', 'text': '我先看看工程。'},
          {'t': 'tool', 'id': 'a', 'name': 'Bash', 'detail': B('cd /data/workspace/blink && make -j4')},
          {'t': 'tool_end', 'id': 'a', 'name': 'Bash', 'detail': B('cd /data/workspace/blink && make -j4'), 'ok': True, 'out': OUT20},
          {'t': 'tool', 'id': 'x', 'name': 'Bash', 'detail': B('xin task new --kind code 帮我写点灯程序')},
          {'t': 'tool_end', 'id': 'x', 'name': 'Bash', 'detail': B('xin task new --kind code 帮我写点灯程序'), 'ok': True, 'out': '任务 2 已派出'},
          {'t': 'tool', 'id': 'w', 'name': 'Bash', 'detail': 'xin browser open https://example.com/a'},
          {'t': 'tool_end', 'id': 'w', 'name': 'Bash', 'detail': 'xin browser open https://example.com/a', 'ok': True, 'out': WEB_OUT},
          {'t': 'tool_end', 'id': 'e', 'name': 'Edit', 'detail': 'update /data/workspace/blink/src/tim.c', 'ok': True, 'out': DIFF}]
WIN = """() => { const w = document.querySelector('.tm-win'); if (!w || w.hidden) return null; const s = w.querySelector('.tm-scr');
  return { ban: [!!w.querySelector('.tm-mk svg'), (w.querySelector('.tm-bn') || {}).textContent, [...w.querySelectorAll('.tm-bt span')].map(e => e.textContent)],
    title: w.querySelector('.tm-name').textContent, prompt: (w.querySelector('.tm-pr') || {}).textContent || null,
    rows: [...w.querySelectorAll('.tm-l')].map(r => r.querySelector('.tm-m').textContent), text: s.textContent,
    sum: (w.querySelector('.tm-sum') || {}).textContent || null, cur: !!w.querySelector('.tm-cur .tm-caret'), st: w.querySelector('.tm-st').hidden ? null : w.querySelector('.tm-st').textContent,
    tabs: [...w.querySelectorAll('.tm-tab')].map(t => t.textContent + (t.getAttribute('aria-selected') === 'true' ? '*' : '')), typing: !!w.querySelector('.tm-tp') }; }"""


async def open_work(pg):
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    await pg.wait_for_function('!!window.LimingXinTerm')


async def part1(browser):
    pg = await ui.page(browser, 1280, 860)
    await ui.xin_mock(pg, authed=True)
    await open_work(pg)
    await pg.evaluate("""(evs) => { const a = document.createElement('button'); a.className = 'xc-av'; a.id = 'anc'; a.textContent = 'x'; a.dataset.term = 'x'; document.querySelector('.xc-msgs').appendChild(a);
      window.__w = LimingXinTerm.win(document.querySelector('.xc'));
      __w.open({ anchor: a, tabs: [{ key: 'run:r1', label: '这一轮', prompt: '编一下 blink', model: 'GLM-5.3', cwd: '/data/workspace/blink', live: false, endMs: 48000, events: evs }] }); }""", EVENTS)
    await pg.wait_for_timeout(560)
    early = await pg.evaluate(WIN)
    await pg.wait_for_function("!document.querySelector('.tm-win .tm-tp') && !!document.querySelector('.tm-win .tm-cur')", timeout=8000)
    r = await pg.evaluate(WIN)
    ui.check('欢迎框：小芯的像素小人、「小芯」、模型、工作目录（~/workspace/blink）；标题栏写「小芯的电脑」；下面「> 要求」',
             r['ban'] == [True, '小芯', ['GLM-5.3', '~/workspace/blink']] and r['title'] == '小芯的电脑' and r['prompt'] == '>编一下 blink', (r['ban'], r['title'], r['prompt']))
    ui.check('一个字一个字敲：打开半秒时只敲出了一部分，敲完才有结尾的光标', early and len(early['text']) < len(r['text']) * 0.8 and not early['cur'] and r['cur'], (len(early['text']) if early else None, len(r['text'])))
    ui.check('一步一行：说的话、运行(make -j4)、打开网页(…)、修改(src/tim.c)；内部命令（派活）不画',
             r['rows'][0] == '我先看看工程。' and r['rows'][1] == '运行(make -j4)' and r['rows'][2] == '打开网页(example.com/a)' and r['rows'][3] == '修改(src/tim.c)' and len(r['rows']) == 4 and 'xin task' not in r['text'], r['rows'])
    det = await pg.evaluate("""() => { const w = document.querySelector('.tm-win'), c = w.querySelector('.tm-k-cmd'), web = w.querySelector('.tm-k-web'), ed = w.querySelector('.tm-k-edit');
      return [c.querySelector('.tm-pre').textContent.split('\\n').length, (c.querySelector('.tm-more') || {}).textContent, c.classList.contains('tm-ok'),
        web.querySelector('.tm-host').textContent, web.querySelector('.tm-pg').textContent,
        ed.querySelector('.tm-df').textContent, ed.querySelectorAll('.tm-dl.tm-add').length, ed.querySelectorAll('.tm-dl.tm-del').length, [...ed.querySelectorAll('.tm-dl .tm-c')].map(e => e.textContent)[1]]; }""")
    ui.check('输出最多 8 行，多的写「… 还有 12 行」；网页卡片有地址和标题；改动先写「文件 +3 −1」，再一行一行（红一行、绿三行）',
             det[:3] == [8, '… 还有 12 行', True] and det[3:5] == ['example.com/a', '示例页面'] and det[5] == 'src/tim.c  +3  −1' and det[6:8] == [3, 1] and det[8] == '  TIM2->CCR2 = 500;', det)
    ui.check('结尾：「在电脑上做了 48 秒 · 1 条命令 · 改了 1 个文件 · 看了 1 个网页」，再一个闪着的光标；没在做就没有转圈那一行',
             r['sum'] == '在电脑上做了 48 秒 · 1 条命令 · 改了 1 个文件 · 看了 1 个网页' and r['cur'] and r['st'] is None, (r['sum'], r['st']))
    # 积压很多也不会落后太久：一下来了 25 条命令（一万多个字），还是一个字一个字敲，但 3 秒内敲完
    big = '\n'.join('line %03d ' % i + 'x' * 40 for i in range(12))
    await pg.evaluate("""(big) => { __w.open({ anchor: document.getElementById('anc'), tabs: [{ key: 'run:r2', label: '这一轮', prompt: '跑一下', live: true, events: [], status: () => ({ verb: '编译中', sec: 12 }) }] });
      for (let i = 0; i < 25; i++) { __w.push('run:r2', { t: 'tool', id: 'q' + i, name: 'Bash', detail: 'make target' + i }); __w.push('run:r2', { t: 'tool_end', id: 'q' + i, name: 'Bash', detail: 'make target' + i, ok: true, out: big }); } }""", big)
    await pg.wait_for_timeout(250)
    mid = await pg.evaluate("[document.querySelectorAll('.tm-win .tm-l').length, !!document.querySelector('.tm-win .tm-tp')]")
    t0 = time.time()
    await pg.wait_for_function("document.querySelectorAll('.tm-win .tm-l').length === 25 && !document.querySelector('.tm-win .tm-tp') && document.querySelectorAll('.tm-win .tm-more').length === 25", timeout=8000)
    took = time.time() - t0 + 0.25
    st = await pg.evaluate(WIN)
    ui.check('积压多了就加速：一下来 25 条命令，0.25 秒时还在一个字一个字敲（不是一下冒出来），3 秒内敲完', mid[0] < 25 and mid[1] and took < 3, (mid, round(took, 2)))
    ui.check('还在做时最底下一行：在干什么、多久、Esc 关闭', st['st'] and '编译中' in st['st'] and '12 秒' in st['st'] and 'Esc 关闭' in st['st'], st['st'])
    await pg.keyboard.press('Escape')
    esc = await pg.evaluate("[document.querySelector('.tm-win').hidden, document.activeElement && document.activeElement.id, document.querySelector('.xc').classList.contains('show')]")
    ui.check('Esc 只关终端：焦点回到头像，工作台还开着', esc == [True, 'anc', True], esc)
    # 分页：方向键换
    await pg.evaluate("""() => { __w.open({ anchor: document.getElementById('anc'), tabs: [{ key: 'run:a', label: '这一轮', live: false, events: [{ t: 'text', text: '一' }] }, { key: 'task:b', label: '编译 blink', live: true, events: [], status: () => ({ verb: '准备中' }) }] }); }""")
    await pg.wait_for_timeout(300)
    await pg.focus('.tm-tab[aria-selected=true]')
    await pg.keyboard.press('ArrowRight')
    await pg.wait_for_timeout(200)
    tb = await pg.evaluate(WIN)
    ui.check('几件活就几页：方向键换到下一页，读屏是 tab', tb['tabs'] == ['这一轮', '编译 blink*'] and await pg.evaluate("document.querySelector('.tm-tabs').getAttribute('role') === 'tablist'"), tb['tabs'])
    await pg.context.close()
    # 减少动态：直接画完
    pg = await ui.page(browser, 1280, 860)
    await pg.emulate_media(reduced_motion='reduce')
    await ui.xin_mock(pg, authed=True)
    await open_work(pg)
    rm = await pg.evaluate("""(evs) => { const w = LimingXinTerm.win(document.querySelector('.xc')); w.open({ tabs: [{ key: 'run:r1', prompt: '编一下', live: false, events: evs }] });
      const x = document.querySelector('.tm-win'); return [!!x.querySelector('.tm-tp'), x.querySelectorAll('.tm-l').length, !!x.querySelector('.tm-cur')]; }""", EVENTS)
    ui.check('系统设了减少动态：不打字，打开就全画好', rm == [False, 4, True], rm)
    await pg.context.close()
    # 手机：从底下升起来，不横向滚动
    pg = await ui.page(browser, 390, 844, mobile=True, theme='dark')
    await ui.xin_mock(pg, authed=True)
    await open_work(pg)
    await pg.evaluate("""(evs) => { const w = LimingXinTerm.win(document.querySelector('.xc')); w.open({ tabs: [{ key: 'run:r1', prompt: '很长的命令', live: false,
      events: evs.concat([{ t: 'tool_end', id: 'z', name: 'Bash', detail: 'arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb -Wall -O2 -ffunction-sections -fdata-sections -Iinc -Idrivers/CMSIS/Device/ST/STM32F1xx/Include -c src/main.c', ok: false, out: 'error: ' + 'x'.repeat(300) }]) }] }); }""", EVENTS)
    await pg.wait_for_function("!!document.querySelector('.tm-win .tm-cur')", timeout=8000)
    m = await pg.evaluate("""() => { const w = document.querySelector('.tm-win'), r = w.getBoundingClientRect(); return [w.classList.contains('tm-sheet'), Math.round(r.bottom) === innerHeight, r.left === 0 && Math.round(r.right) === innerWidth,
      document.documentElement.scrollWidth <= innerWidth, w.querySelector('.tm-scr').scrollWidth <= w.querySelector('.tm-scr').clientWidth + 1, !document.querySelector('.tm-scrim').hidden]; }""")
    ui.check('390 宽深色：从底下升起来占满宽、有遮罩，很长的命令和报错不横向滚动', m == [True, True, True, True, True, True], m)
    await pg.context.close()


TASK, CONV = 'stask00blk', 'snew000001'


def task(**kw):
    t = {'sid': TASK, 'no': 1, 'parent': CONV, 'title': '编译 blink', 'kind': 'code', 'model': 'glm-5.3', 'dir': '/data/workspace/blink', 'status': 'queued', 'created': now(), 'after': [], 'turns': 1}
    t.update(kw)
    return t


RUN1 = [[{'t': 'user', 'text': '内部要求原文：编译 blink 工程'}, {'t': 'tool', 'id': 'a', 'name': 'Bash', 'detail': B('cd /data/workspace/blink && ls')},
         {'t': 'tool_end', 'id': 'a', 'name': 'Bash', 'detail': B('cd /data/workspace/blink && ls'), 'ok': True, 'out': 'Makefile\nsrc'}],
        [{'t': 'tool', 'id': 'b', 'name': 'Bash', 'detail': B('xin remember 站长在学 TIM')}, {'t': 'text', 'text': '我先编一遍看看。'},
         {'t': 'tool', 'id': 'c', 'name': 'Bash', 'detail': B('cd /data/workspace/blink && make -j4')}],
        [{'t': 'tool_end', 'id': 'c', 'name': 'Bash', 'detail': B('cd /data/workspace/blink && make -j4'), 'ok': True, 'out': 'arm-none-eabi-gcc -c src/main.c\nok'}]]


async def part2(browser):
    pg = await ui.page(browser, 1280, 860)
    front = [[{'t': 'text', 'text': '好，我去编一下。'}, {'t': 'tool', 'id': 'f1', 'name': 'Bash', 'detail': B('xin task new --kind code 帮我编译 blink 工程')},
              {'t': 'tool_end', 'id': 'f1', 'name': 'Bash', 'detail': B('xin task new --kind code 帮我编译 blink 工程'), 'ok': True, 'out': '任务 1 已派出'},
              {'t': 'task', 'sid': TASK, 'no': 1, 'title': '编译 blink', 'kind': 'code', 'model': 'glm-5.3', 'status': 'queued', 'after': [], 'at': now()}],
             [{'t': 'done', 'ok': True, 'code': 0, 'ms': 2000}]]
    st = await ui.xin_mock(pg, authed=True, live=front)
    st.update({'tasks': [], 'tp': {'rtask00b01': RUN1}, 'tp_rel': {}, 'tp_done': {}, 'tpolls': [], 'task_hist_calls': 0})

    async def overlay(route):
        body = json.loads(route.request.post_data or '{}')
        op, args = body.get('op'), body.get('args') or {}
        if op == 'poll' and str(args.get('run', '')).startswith('rtask'):
            run = args['run']
            st['tpolls'].append((run, args.get('off'), 'deviceId' in args or 'watching' in args))
            pub = [e for blk in st['tp'].get(run, [])[:st['tp_rel'].get(run, 0)] for e in blk]
            off = int(args.get('off', 0))
            evs = pub[off:off + 400]
            data = {'events': evs, 'off': off + len(evs), 'done': bool(st['tp_done'].get(run)) and off + len(evs) >= len(pub)}
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': data}))
        if op == 'history' and args.get('sid') == TASK and st.get('task_hist'):
            st['task_hist_calls'] += 1
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': {'session': {'sid': TASK, 'agent': 'codex'}, 'task': st['tasks'][0], 'runs': st['task_hist'], 'active': None}}))
        if op == 'history' and args.get('sid') == CONV and st.get('conv_hist'):
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': {'session': {'sid': CONV, 'agent': 'codex', 'title': '编译 blink'}, 'runs': st['conv_hist'], 'tasks': st['tasks'], 'active': None}}))
        await route.fallback()
    await pg.route('**/api/xin/call', overlay)

    # 历史：回答的头像点开看那一轮（xin_mock 的 shist00001 里有一条编译失败的命令）；只说了话的点不开
    await pg.add_init_script("if (!sessionStorage.getItem('__t')) { sessionStorage.setItem('__t', '1'); localStorage.setItem('lm.xin.sid','shist00001'); }")
    await open_work(pg)
    await pg.wait_for_function("LimingXinChat.state.sid === 'shist00001' && !!document.querySelector('.xc-ai')", timeout=10000)
    av = await pg.evaluate("[...document.querySelectorAll('.xc-msgs .xc-ai > .xc-av')].map(a => a.dataset.term || '')")
    ui.check('回答的头像：那一轮在电脑上执行过命令才点得开（带小终端标记），读屏念「看小芯在电脑上做了什么」',
             av[:1] == ['run:rhist00001'] and await pg.evaluate("document.querySelector('.xc-av-t').getAttribute('role') === 'button' && document.querySelector('.xc-av-t').getAttribute('aria-label') === '看小芯在电脑上做了什么'"), av)
    await pg.click('.xc-av-t[data-term="run:rhist00001"]')
    await pg.wait_for_function("!!document.querySelector('.tm-win:not([hidden]) .tm-cur')", timeout=8000)
    h = await pg.evaluate(WIN)
    ui.check('点开：「> 编译 main.c」，运行(arm-none-eabi-gcc -c main.c) 失败标红、报错在下面，结尾写做了多久',
             h['prompt'] == '>编译 main.c' and h['rows'][-1] == '运行(arm-none-eabi-gcc -c main.c)' and 'error: boom' in h['text'] and h['sum'] and h['sum'].startswith('在电脑上做了 3 秒') and h['tabs'] == [], h)
    await pg.keyboard.press('Escape')

    # 新对话里让它做事：前台派活（内部命令不画），回完以后最下面一行，点头像看那件活
    await pg.click('.xc-new-b')
    await pg.fill('.xc-row textarea', '帮我编一下 blink')
    await pg.keyboard.press('Enter')
    await pg.wait_for_function("!!document.querySelector('.xc-bgrow')", timeout=10000)
    row = await pg.evaluate("(() => { const r = document.querySelector('.xc-bgrow'), l = document.querySelector('.xc-msgs'); return [r.querySelector('.xc-typing-l').textContent, l.lastElementChild === r, r.querySelector('.xc-av').dataset.term]; })()")
    chat = await pg.evaluate("document.querySelector('.xc-msgs').textContent")
    ui.check('派出去的活：回完以后最下面一行「编译 blink · 准备中」（和正在输入一个样），头像点开看它', row == ['编译 blink · 准备中', True, 'live'], row)
    ui.check('前台派活的内部命令不出现在聊天里', 'xin task' not in chat and '帮我编译 blink 工程' not in chat, chat[-160:])
    reply = await pg.evaluate("document.querySelector('.xc-ai[data-run=\"rlive00001\"] > .xc-av').dataset.term || ''")
    ui.check('派了活的那条回答，头像也点得开（看那件活）', reply == 'run:rlive00001', reply)

    st['tasks'] = [task(status='running', run='rtask00b01', startedAt=now() - 3000)]
    st['tp_rel']['rtask00b01'] = 1
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_timeout(1500)
    polls0 = len(st['tpolls'])
    ui.check('终端没开时不去取那件活的过程（只看任务摘要）', polls0 == 0, polls0)
    await pg.click('.xc-bgrow .xc-av')
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win:not([hidden]) .tm-l')].some(r => r.textContent.includes('ls'))", timeout=10000)
    st['tp_rel']['rtask00b01'] = 2
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win .tm-l')].some(r => r.textContent.includes('make -j4'))", timeout=10000)
    await pg.wait_for_timeout(2500)
    t1 = await pg.evaluate(WIN)
    offs = [o for r, o, _ in st['tpolls'] if r == 'rtask00b01']
    ui.check('点开：这件活一页，欢迎框写它的模型和目录，「> 编译 blink」；画出 ls、说的话、make，内部命令和要求原文不画',
             t1['prompt'] == '>编译 blink' and t1['ban'][2] == ['GLM-5.3', '~/workspace/blink'] and [x.split('(')[0] for x in t1['rows']] == ['运行', '我先编一遍看看。', '运行']
             and 'xin remember' not in t1['text'] and '内部要求原文' not in t1['text'], (t1['rows'], t1['ban']))
    ui.check('开着时才轮询：按 off 往前走，不带设备和标签页（不算在看这个对话）', offs[:1] == [0] and max(offs) >= 3 and not any(w for _, _, w in st['tpolls']), offs[:6])
    ui.check('最底下一行写它在干什么（make → 编译中）', t1['st'] and t1['st'].startswith('编译中'), t1['st'])
    await pg.keyboard.press('Escape')
    n1 = len(st['tpolls'])
    await pg.wait_for_timeout(2500)
    ui.check('关上终端：不再去取', len(st['tpolls']) == n1, len(st['tpolls']) - n1)

    # 再打开：接着上次取到的地方；做完了，那一页写「干完了 · 用时 2 分钟」
    st['tp_rel']['rtask00b01'] = 3
    await pg.click('.xc-bgrow .xc-av')
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win .tm-l')].some(r => r.textContent.includes('make -j4') && r.textContent.includes('ok'))", timeout=10000)
    again = [o for r, o, _ in st['tpolls'][n1:] if r == 'rtask00b01']
    ui.check('再打开：从上次取到的地方接着取，不重取', again and min(again) >= 3, again[:4])
    st['tp_done']['rtask00b01'] = True
    st['tasks'] = [task(status='done', run='rtask00b01', startedAt=now() - 125000, endedAt=now(), result={'ok': True, 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'at': now()}, delivery={'state': 'delivered'})]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("!!document.querySelector('.tm-win .tm-sum')", timeout=10000)
    await pg.wait_for_function("[...document.querySelectorAll('.xc-tres')].some(e => e.textContent.includes('编好了'))", timeout=10000)
    d = await pg.evaluate(WIN)
    res = await pg.evaluate("(() => { const r = [...document.querySelectorAll('.xc-tres')].pop(); return [r.querySelector(':scope > .xc-av').dataset.term, !document.querySelector('.xc-bgrow')]; })()")
    ui.check('做完：终端那一页写「干完了 · 用时 2 分钟 · 2 条命令」、不再转圈；聊天里是小芯转达的答案，它的头像点开看这件活，最下面那一行没了',
             d['sum'] == '干完了 · 用时 2 分钟 · 2 条命令' and d['st'] is None and res == ['task:' + TASK, True], (d['sum'], d['st'], res))
    await pg.keyboard.press('Escape')

    # 换对话：终端关上，不再取
    st['tasks'] = [task(status='running', run='rtask00b01', startedAt=now())]
    st['tp_done']['rtask00b01'] = False
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_selector('.xc-bgrow')
    await pg.click('.xc-bgrow .xc-av')
    await pg.wait_for_selector('.tm-win:not([hidden])')
    await pg.click('.xc-si:has-text("编译 main.c")')
    await pg.wait_for_function("LimingXinChat.state.sid === 'shist00001' && !document.querySelector('.xc-loading')", timeout=10000)
    n2 = len(st['tpolls'])
    await pg.wait_for_timeout(2500)
    sw = await pg.evaluate("[document.querySelector('.tm-win').hidden, !document.querySelector('.xc-bgrow')]")
    ui.check('换到别的对话：终端关上、那件活不再取，最下面那一行也不跟过来', sw == [True, True] and len(st['tpolls']) == n2, (sw, len(st['tpolls']) - n2))

    # 刷新以后：任务结果的头像点开，没取过才去取这件活的完整记录
    st['tasks'] = [task(status='done', run='rtask00b01', startedAt=now() - 125000, endedAt=now() - 1000, result={'ok': True, 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'at': now() - 1000}, delivery={'state': 'delivered'})]
    st['conv_hist'] = [{'run': 'rlive00001', 'started': now() - 200000, 'done': True, 'events': [{'t': 'user', 'text': '帮我编一下 blink'}, {'t': 'text', 'text': '好，我去编一下。'},
                                                                                                    {'t': 'task', 'sid': TASK, 'no': 1, 'title': '编译 blink', 'kind': 'code', 'status': 'queued'}, {'t': 'done', 'ok': True}]},
                       {'run': 'rhand00001', 'started': now() - 900, 'done': True, 'events': [{'t': 'text', 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'taskResult': {'sid': TASK, 'status': 'done', 'at': now() - 1000, 'endedAt': st['tasks'][0]['endedAt']}}, {'t': 'done', 'ok': True}]}]
    st['task_hist'] = [{'run': 'rtask00b01', 'events': [e for blk in RUN1 for e in blk] + [{'t': 'done', 'ok': True}]}]
    await pg.evaluate("localStorage.setItem('lm.xin.sid', '%s')" % CONV)
    await pg.reload()
    await pg.wait_for_function("LimingXinChat.state.sid === '%s' && !!document.querySelector('.xc-tres .xc-av-t')" % CONV, timeout=15000)
    c0 = st['task_hist_calls']
    await pg.click('.xc-tres .xc-av-t')
    await pg.wait_for_function("!!document.querySelector('.tm-win:not([hidden]) .tm-cur')", timeout=10000)
    r2 = await pg.evaluate(WIN)
    ui.check('刷新以后：点任务结果的头像才去取（一次），画出 ls、说的话、make，结尾「干完了 · 用时 2 分钟 · 2 条命令」',
             c0 == 0 and st['task_hist_calls'] == 1 and len(r2['rows']) == 3 and r2['sum'] == '干完了 · 用时 2 分钟 · 2 条命令', (c0, st['task_hist_calls'], r2['rows'], r2['sum']))
    await pg.context.close()


async def part3(browser):
    """正在回话：「正在输入」的头像点开看这一轮正在做的；新的命令接着敲；回完写结尾。"""
    pg = await ui.page(browser, 1280, 860)
    live = [[{'t': 'text', 'text': '我先看看。'}, {'t': 'tool', 'id': 'l1', 'name': 'Bash', 'detail': B('cd /data/workspace/blink && ls')}],
            [{'t': 'tool_end', 'id': 'l1', 'name': 'Bash', 'detail': B('cd /data/workspace/blink && ls'), 'ok': True, 'out': 'Makefile\nsrc'}, {'t': 'tool', 'id': 'l2', 'name': 'Bash', 'detail': B('make -j4')}]] + [[]] * 6 + \
           [[{'t': 'tool_end', 'id': 'l2', 'name': 'Bash', 'detail': B('make -j4'), 'ok': True, 'out': 'ok'}, {'t': 'text', 'text': '编好了。'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 9000, 'model': 'deepseek-v4.1-flash'}]]
    await ui.xin_mock(pg, authed=True, live=live)
    await open_work(pg)
    await pg.fill('.xc-row textarea', '编一下')
    await pg.keyboard.press('Enter')
    await pg.wait_for_function("(document.querySelector('.xc-typing-l') || {}).textContent && document.querySelector('.xc-typing-l').textContent.startsWith('找文件')", timeout=10000)
    face = await pg.evaluate("(() => { const f = document.querySelector('.xc-typing > .xc-av'); return [f.dataset.term, f.classList.contains('live'), f.getAttribute('aria-label')]; })()")
    ui.check('正在回话：「正在输入」的头像点得开（标记在闪），读屏念「看小芯正在电脑上做什么」', face == ['live', True, '看小芯正在电脑上做什么'], face)
    await pg.click('.xc-typing > .xc-av')
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win:not([hidden]) .tm-l')].some(r => r.textContent.includes('make -j4'))", timeout=10000)
    await pg.wait_for_function("document.querySelector('.tm-win .tm-st').textContent.includes('秒')", timeout=5000)
    a = await pg.evaluate(WIN)
    ui.check('点开：这一轮「> 编一下」、ls 和正在跑的 make；最底下一行写在干什么和秒数', a['prompt'] == '>编一下' and a['rows'][1].startswith('运行(ls)') and a['st'] and ('编译中' in a['st'] or '找文件' in a['st']) and '秒' in a['st'], (a['rows'], a['st']))
    await pg.wait_for_function("!!document.querySelector('.tm-win .tm-sum')", timeout=15000)
    b = await pg.evaluate(WIN)
    ui.check('回完：make 标绿，「编好了。」接在后面，结尾「在电脑上做了 9 秒 · 2 条命令」，不再转圈', b['sum'] == '在电脑上做了 9 秒 · 2 条命令' and b['st'] is None and b['rows'][-1] == '编好了。', (b['sum'], b['rows']))
    await pg.context.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        await part1(browser)
        await part2(browser)
        await part3(browser)
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
