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
    pop = await pg.evaluate("(() => { const s = getComputedStyle(document.querySelector('.tm-win')); return [s.animationName, s.animationTimingFunction]; })()")
    # 站长 2026-11-16「终端弹出来会有卡顿，不够丝滑」：原来是 steps(5) 一格一格跳；改成连续缓动，从点的地方放大出来
    ui.check('电脑上终端弹出来是连续缓动（不是 steps 一格一格跳）', pop[0] == 'tmpop' and pop[1].startswith('cubic-bezier') and 'steps' not in pop[1], pop)
    await pg.wait_for_timeout(560)
    early = await pg.evaluate(WIN)
    await pg.wait_for_function("!document.querySelector('.tm-win .tm-tp') && !!document.querySelector('.tm-win .tm-cur')", timeout=8000)
    r = await pg.evaluate(WIN)
    ui.check('开头：「小芯」、模型、工作目录（~/workspace/blink）；标题栏写「小芯的电脑」；下面「> 要求」',
             r['ban'] == [True, '小芯', ['GLM-5.3', '~/workspace/blink']] and r['title'] == '小芯的电脑' and r['prompt'] == '>编一下 blink', (r['ban'], r['title'], r['prompt']))
    sky = await pg.evaluate("""() => { const b = document.querySelector('.tm-win .tm-ban'), sc = b.querySelector('.tm-scene'), m = sc.querySelector('.tm-mk'), r = m.getBoundingClientRect(), g = b.querySelectorAll('.tm-rule')[1].getBoundingClientRect();
      return [b.querySelectorAll('.tm-rule').length, !!sc.querySelector('.tm-sky .tm-moon'), !!sc.querySelector('.tm-sky .tm-cl1'), sc.querySelectorAll('.tm-sky .tm-star').length >= 6,
        getComputedStyle(sc.querySelector('.tm-sky .tm-cl1')).stroke === 'none', !!m.querySelector('svg'), Math.abs(r.bottom - g.top) <= 3]; }""")
    ui.check('照 Claude Code 的欢迎页：两条点线中间一幅像素夜景（点画的云、月牙、* 星星，不描粗边），小芯站在下面那条点线（地平线）上', sky == [2, True, True, True, True, True, True], sky)
    ui.check('一个字一个字敲：打开半秒时只敲出了一部分，敲完才有结尾的光标', early and len(early['text']) < len(r['text']) * 0.8 and not early['cur'] and r['cur'], (len(early['text']) if early else None, len(r['text'])))
    ui.check('一步一行：说的话、运行(make -j4)、打开网页(…)、修改(src/tim.c)；内部命令（派活）不画',
             r['rows'][0] == '我先看看工程。' and r['rows'][1] == '运行(make -j4)' and r['rows'][2] == '打开网页(example.com/a)' and r['rows'][3] == '修改(src/tim.c)' and len(r['rows']) == 4 and 'xin task' not in r['text'], r['rows'])
    det = await pg.evaluate("""() => { const w = document.querySelector('.tm-win'), c = w.querySelector('.tm-k-cmd'), web = w.querySelector('.tm-k-web'), ed = w.querySelector('.tm-k-edit');
      return [c.querySelector('.tm-pre').textContent.split('\\n').length, (c.querySelector('.tm-more') || {}).textContent, c.classList.contains('tm-ok'),
        web.querySelector('.tm-a').textContent, (web.querySelector('.tm-pre') || {}).textContent, !web.querySelector('.tm-web'),
        ed.querySelector('.tm-df').textContent, ed.querySelectorAll('.tm-dl.tm-add').length, ed.querySelectorAll('.tm-dl.tm-del').length, [...ed.querySelectorAll('.tm-dl .tm-c')].map(e => e.textContent)[0],
        [...ed.querySelectorAll('.tm-dl .tm-n')].map(e => e.textContent), (ed.querySelector('.tm-dl.tm-add .tm-hkw') || {}).textContent, (ed.querySelector('.tm-dl.tm-add .tm-hty') || {}).textContent, (ed.querySelector('.tm-dl.tm-add .tm-hnu') || {}).textContent]; }""")
    ui.check('输出最多 8 行，多的写「… 还有 12 行」；打开网页照终端写法（地址、折角线下「标题：…」，不画小浏览器）；改动先写「文件 +3 −1」，再一行一行（红一行、绿三行）',
             det[:3] == [8, '… 还有 12 行', True] and det[3:6] == ['example.com/a', '标题：示例页面', True] and det[6] == 'src/tim.c  +3  −1' and det[7:9] == [3, 1] and det[9] == '  TIM2->CCR2 = 500;', det)
    ui.check('改动照 Claude Code：左边一列行号（删的写旧行号、加的写新行号），代码按 Monokai 上色（static 关键字、uint16_t 类型、数字）',
             det[10] == ['9', '9', '10', '11', '12'] and det[11:] == ['static', 'uint16_t', '0'], det[10:])
    ui.check('结尾：「用时 48 秒 · 运行 1 条命令 · 修改 1 个文件 · 打开 1 个网页」（和每一步的动词一致），再一个闪着的光标；没在做就没有转圈那一行',
             r['sum'] == '用时 48 秒 · 运行 1 条命令 · 修改 1 个文件 · 打开 1 个网页' and r['cur'] and r['st'] is None, (r['sum'], r['st']))
    # 模型的思考：暗色斜体一行，圆点是星；前台概括的那一句（status）不画（终端里已经有「> 要求」）
    await pg.evaluate("""() => { __w.open({ anchor: document.getElementById('anc'), tabs: [{ key: 'run:th', label: '本轮', prompt: '看看', live: false, endMs: 3000,
      events: [{ t: 'think', src: 'status', text: '查看工作目录' }, { t: 'think', src: 'model', text: 'Checking what is in the build folder first.' }, { t: 'text', text: '好了。' }] }] }); }""")
    await pg.wait_for_function("!!document.querySelector('.tm-win .tm-cur')", timeout=8000)
    th = await pg.evaluate("""() => { const r = document.querySelector('.tm-win .tm-k-think'), s = r && r.querySelector('.tm-say'); return [document.querySelectorAll('.tm-win .tm-k-think').length, s && s.textContent, s && getComputedStyle(s).fontStyle, !!(r && r.querySelector('.tm-b svg')), document.querySelector('.tm-win .tm-scr').textContent.includes('查看工作目录')]; }""")
    ui.check('模型的思考画成暗色斜体的一行、圆点是一颗星；前台概括那一句不画', th == [1, 'Checking what is in the build folder first.', 'italic', True, False], th)
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
    out = await pg.evaluate("(() => { const w = document.querySelector('.tm-win'); return [w.hidden, w.classList.contains('tm-out'), getComputedStyle(w).animationName, document.activeElement && document.activeElement.id]; })()")
    ui.check('Esc：终端缩小淡出（关的时候也有动画，不是一下没了），焦点马上回到原来的位置', out == [False, True, 'tmpopx', 'anc'], out)
    await pg.wait_for_function("document.querySelector('.tm-win').hidden", timeout=2000)
    esc = await pg.evaluate("[document.querySelector('.tm-win').hidden, document.activeElement && document.activeElement.id, document.querySelector('.xc').classList.contains('show'), document.querySelector('.tm-win').classList.contains('tm-out')]")
    ui.check('Esc 只关终端：焦点回到头像，工作台还开着', esc == [True, 'anc', True, False], esc)
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
    up = await pg.evaluate("(() => { const w = getComputedStyle(document.querySelector('.tm-win')), s = getComputedStyle(document.querySelector('.tm-scrim')); return [w.animationName, w.animationTimingFunction, w.animationDuration, s.animationName]; })()")
    # 照 Vaul（emilkowalski/vaul）的底部面板：translate3d(0,100%,0) 滑上来，cubic-bezier(0.32, 0.72, 0, 1)；遮罩同一条曲线淡入
    ui.check('手机：终端从底下滑上来是连续的（Vaul 那条曲线，不是 steps(4) 一格一格跳），遮罩一起淡入',
             up == ['tmup', 'cubic-bezier(0.32, 0.72, 0, 1)', '0.42s', 'tmfadein'], up)
    await pg.wait_for_function("!!document.querySelector('.tm-win .tm-cur')", timeout=8000)
    m = await pg.evaluate("""() => { const w = document.querySelector('.tm-win'), r = w.getBoundingClientRect(); return [w.classList.contains('tm-sheet'), Math.round(r.bottom) === innerHeight, r.left === 0 && Math.round(r.right) === innerWidth,
      document.documentElement.scrollWidth <= innerWidth, w.querySelector('.tm-scr').scrollWidth <= w.querySelector('.tm-scr').clientWidth + 1, !document.querySelector('.tm-scrim').hidden]; }""")
    ui.check('390 宽深色：从底下升起来占满宽、有遮罩，很长的命令和报错不横向滚动', m == [True, True, True, True, True, True], m)
    await pg.click('.tm-scrim', position={'x': 20, 'y': 20})
    down = await pg.evaluate("(() => { const w = document.querySelector('.tm-win'), s = document.querySelector('.tm-scrim'); return [w.hidden, getComputedStyle(w).animationName, s.hidden, getComputedStyle(s).animationName]; })()")
    ui.check('手机：点遮罩关掉，面板滑下去、遮罩淡出（不是一下没了）', down == [False, 'tmdown', False, 'tmfadeout'], down)
    await pg.wait_for_function("document.querySelector('.tm-win').hidden && document.querySelector('.tm-scrim').hidden", timeout=2000)
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

    # 历史：那一轮在电脑上执行过命令，回答下面留一行过程框，点开看那一轮（xin_mock 的 shist00001 里有一条编译失败的命令）。
    # 站长 2026-11-16：「终端小标没去掉……不需要这个小标」——头像不再是按钮、没有小终端标记
    await pg.add_init_script("if (!sessionStorage.getItem('__t')) { sessionStorage.setItem('__t', '1'); localStorage.setItem('lm.xin.sid','shist00001'); }")
    await open_work(pg)
    await pg.wait_for_function("LimingXinChat.state.sid === 'shist00001' && !!document.querySelector('.xc-ai')", timeout=10000)
    pr = await pg.evaluate("""(() => { const p = [...document.querySelectorAll('.xc-msgs .xc-proc')], a = document.querySelector('.xc-msgs .xc-ai > .xc-av');
      return [p.map(x => x.dataset.term), p.map(x => x.closest('.xc-ai').dataset.run), p[0] && p[0].getAttribute('role'), p[0] && p[0].getAttribute('aria-label'), p[0] && p[0].textContent,
        document.querySelectorAll('.xc-msgs .xc-av[data-term], .xc-msgs .xc-av-t').length, getComputedStyle(a, '::after').content]; })()""")
    ui.check('回答下面一行过程框（那一轮执行过命令才有）：写「用时 3 秒 · 运行 1 条命令」（和终端结尾同一句），是按钮、读屏念「…查看执行过程」；头像不再是按钮、没有小终端标记',
             pr[0] == ['run:rhist00001'] and pr[1] == ['rhist00001'] and pr[2] == 'button' and (pr[3] or '').endswith('查看执行过程') and pr[4] == '用时 3 秒 · 运行 1 条命令' and pr[5] == 0 and pr[6] in ('none', 'normal'), pr)
    await pg.click('.xc-proc[data-term="run:rhist00001"]')
    await pg.wait_for_function("!!document.querySelector('.tm-win:not([hidden]) .tm-cur')", timeout=8000)
    h = await pg.evaluate(WIN)
    ui.check('点开：「> 编译 main.c」，运行(arm-none-eabi-gcc -c main.c) 失败标红、报错在下面，结尾写做了多久',
             h['prompt'] == '>编译 main.c' and h['rows'][-1] == '运行(arm-none-eabi-gcc -c main.c)' and 'error: boom' in h['text'] and h['sum'] and h['sum'].startswith('用时 3 秒') and h['tabs'] == [], h)
    await pg.keyboard.press('Escape')

    # 新对话里让它做事：前台派活（内部命令不画）。站长 2026-11-16：「我让他干的这个活不要让他分成两个独立的话来答，可以弄成他要去画那段话下面
    # 搞一个框框加载，显示思考过程的话，左边不要显示头像，然后点开这个加载框可以看到终端」——那段话下面一个框，同一条回答，最下面不再单独一行
    await pg.click('.xc-new-b')
    await pg.fill('.xc-row textarea', '帮我编一下 blink')
    await pg.keyboard.press('Enter')
    BOX = '.xc-tb[data-tsid="%s"]' % TASK
    await pg.wait_for_function("!!document.querySelector('%s') && !document.querySelector('.xc-typing')" % BOX, timeout=10000)
    bx = await pg.evaluate("""(() => { const b = document.querySelector('%s'), host = b.closest('.xc-ai'), bub = host.querySelector(':scope > .xc-bub');
      return [b.querySelector('.xc-tb-t').textContent, b.querySelector('.xc-tb-s').textContent, host.dataset.run, bub.textContent, !!(bub.compareDocumentPosition(b) & 4),
        b.dataset.term, b.getAttribute('role'), !b.querySelector('.xc-av, .xc-face, svg.xin-portrait'), !document.querySelector('.xc-bgrow'), b.classList.contains('live'),
        document.querySelectorAll('.xc-msgs .xc-who').length]; })()""" % BOX)
    chat = await pg.evaluate("document.querySelector('.xc-msgs').textContent")
    ui.check('派出去的活：那段话「好，我去编一下。」下面一个框（同一条回答里，不画头像），上面任务名「编译 blink」、下面此刻那一步「准备中」，是按钮、点开看那件活；最下面不再单独一行',
             bx == ['编译 blink', '准备中', 'rlive00001', '好，我去编一下。', True, 'task:' + TASK, 'button', True, True, True, 1], bx)
    ui.check('前台派活的内部命令不出现在聊天里', 'xin task' not in chat and '帮我编译 blink 工程' not in chat, chat[-160:])
    # 正式站联调（scripts/test-xin-live.py）取小芯的回答用「最后一个 .xc-ai:not(.xc-typing) .xc-bub」：.xc-bub 只能是回答的正文。
    # #159 的框里三个点用了 .xc-bub，联调取到空字、判成「不是第一人称」，正式部署被回滚（北京 2026-11-17 00:37）
    lastbub = await pg.evaluate("[[...document.querySelectorAll('.xc-ai:not(.xc-typing) .xc-bub')].pop().innerText, document.querySelectorAll('.xc-tb .xc-bub').length]")
    ui.check('框里没有 .xc-bub（那是回答正文的类名）：照正式站联调的取法，最后一条回答的正文还是那段话', lastbub == ['好，我去编一下。', 0], lastbub)
    reply = await pg.evaluate("[document.querySelector('.xc-ai[data-run=\"rlive00001\"] > .xc-av').dataset.term || '', document.querySelectorAll('.xc-av-t').length]")
    ui.check('派了活的那条回答，头像不是按钮、没有小终端标记（看那件活点框）', reply == ['', 0], reply)

    # 站长：派了后台任务也要一直在动——框里那一步跟着任务摘要的 activity 换（2 秒取一次，不用点开终端）
    st['tasks'] = [task(status='running', run='rtask00b01', startedAt=now() - 3000, activity='在搜索：Gemini 4 Hydrogen review')]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("(document.querySelector('%s .xc-tb-s') || {}).textContent === '在搜索：Gemini 4 Hydrogen review'" % BOX, timeout=5000)
    st['tasks'] = [task(status='running', run='rtask00b01', startedAt=now() - 4000, activity='在读网页：deepmind.google/models')]
    await pg.wait_for_function("(document.querySelector('%s .xc-tb-s') || {}).textContent === '在读网页：deepmind.google/models'" % BOX, timeout=5000)
    live = await pg.evaluate("[document.querySelector('%s .xc-tb-sec').textContent, getComputedStyle(document.querySelector('%s .xc-tb-s')).animationName]" % (BOX, BOX))
    ui.check('后台在做时框自己在动：那一步跟着任务摘要换（2 秒一取，没点终端），秒数在走，那一步有一道光扫过去', live[0].endswith('秒') and live[1] == 'xcshim', live)
    st['tasks'] = [task(status='running', run='rtask00b01', startedAt=now() - 3000)]
    st['tp_rel']['rtask00b01'] = 1
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_timeout(1500)
    polls0 = len(st['tpolls'])
    ui.check('终端没开时不去取那件活的过程（只看任务摘要）', polls0 == 0, polls0)
    # 按下去和松开之间框里那一步正好换字（swapText 会换掉里面的元素）：这一下点击不能丢。
    # #156 的 CI 碰到过同类的：按下落在会被整块换掉的元素上、松开时它已不在，浏览器就不发 click。框里的字不接指针，点击落在框上（照 open-webui 的 StatusHistory）
    box = await pg.locator(BOX + ' .xc-tb-s').bounding_box()
    await pg.mouse.move(box['x'] + 6, box['y'] + box['height'] / 2)
    await pg.mouse.down()
    await pg.evaluate("(() => { const b = document.querySelector('%s'); b.innerHTML = b.innerHTML; })()" % BOX)
    await pg.mouse.up()
    opened = await pg.evaluate("!document.querySelector('.tm-win').hidden")
    ui.check('点框的那一下里框里的字整块换掉：点击照样打开终端', opened, opened)
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win:not([hidden]) .tm-l')].some(r => r.textContent.includes('ls'))", timeout=10000)
    st['tp_rel']['rtask00b01'] = 2
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win .tm-l')].some(r => r.textContent.includes('make -j4'))", timeout=10000)
    await pg.wait_for_timeout(2500)
    t1 = await pg.evaluate(WIN)
    offs = [o for r, o, _ in st['tpolls'] if r == 'rtask00b01']
    ui.check('点开：这件活一页，欢迎框写它的目录、不露模型（小芯的默认界面不露模型），「> 编译 blink」；画出 ls、说的话、make，内部命令和要求原文不画',
             t1['prompt'] == '>编译 blink' and t1['ban'][2] == ['~/workspace/blink'] and 'GLM' not in t1['text'] and [x.split('(')[0] for x in t1['rows']] == ['运行', '我先编一遍看看。', '运行']
             and 'xin remember' not in t1['text'] and '内部要求原文' not in t1['text'], (t1['rows'], t1['ban']))
    ui.check('开着时才轮询：按 off 往前走，不带设备和标签页（不算在看这个对话）', offs[:1] == [0] and max(offs) >= 3 and not any(w for _, _, w in st['tpolls']), offs[:6])
    ui.check('最底下一行写它此刻在做的那一步（在执行：make -j4）', t1['st'] and t1['st'].startswith('在执行：make -j4'), t1['st'])
    await pg.keyboard.press('Escape')
    n1 = len(st['tpolls'])
    await pg.wait_for_timeout(2500)
    ui.check('关上终端：不再去取', len(st['tpolls']) == n1, len(st['tpolls']) - n1)

    # 再打开：接着上次取到的地方；做完了，那一页写「已完成 · 用时 2 分钟」
    st['tp_rel']['rtask00b01'] = 3
    await pg.click(BOX)
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win .tm-l')].some(r => r.textContent.includes('make -j4') && r.textContent.includes('ok'))", timeout=10000)
    again = [o for r, o, _ in st['tpolls'][n1:] if r == 'rtask00b01']
    ui.check('再打开：从上次取到的地方接着取，不重取', again and min(again) >= 3, again[:4])
    # 这期间又聊了别的（下面垫一大段，滚到最下面）：结果照样接回上面那一轮，顶上冒一个小提示
    await pg.evaluate("(() => { const s = document.createElement('div'); s.className = 'xc-m xc-spacer'; s.style.height = '2400px'; document.querySelector('.xc-msgs').appendChild(s); const b = document.querySelector('.xc-body'); b.scrollTop = b.scrollHeight; })()")
    st['tp_done']['rtask00b01'] = True
    st['tasks'] = [task(status='done', run='rtask00b01', startedAt=now() - 125000, endedAt=now(), result={'ok': True, 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'at': now()}, delivery={'state': 'delivered'})]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("!!document.querySelector('.tm-win .tm-sum')", timeout=10000)
    await pg.wait_for_function("[...document.querySelectorAll('.xc-tres')].some(e => e.textContent.includes('编好了'))", timeout=10000)
    d = await pg.evaluate(WIN)
    res = await pg.evaluate("""(() => { const r = [...document.querySelectorAll('.xc-tres')].pop(), b = document.querySelector('%s'), host = b.closest('.xc-ai');
      return [r.classList.contains('cont'), r.dataset.run, host.nextElementSibling === r, !r.querySelector('.xc-who'), b.classList.contains('live'), b.querySelector('.xc-tb-t').textContent,
        (b.querySelector('.xc-tb-m') || {}).textContent, b.dataset.term, document.querySelectorAll('.xc-msgs .xc-who').length, !document.querySelector('.xc-bgrow'), !!r.querySelector(':scope > .xc-acts .xc-mcopy')]; })()""" % BOX)
    ui.check('做完：终端那一页写「已完成 · 用时 2 分钟 · 运行 2 条命令」、不再转圈；结果接在那段话和框下面（同一条回答，不画头像、不写「小芯」），框收成一行「编译 blink · 用时 2 分钟」，还能点开',
             d['sum'] == '已完成 · 用时 2 分钟 · 运行 2 条命令' and d['st'] is None and res == [True, 'rlive00001', True, True, False, '编译 blink', '用时 2 分钟', 'task:' + TASK, 1, True, True], (d['sum'], d['st'], res))
    await pg.keyboard.press('Escape')
    chip = await pg.evaluate("(() => { const c = document.querySelector('.xc-upchip'); return c && !c.hidden ? c.textContent : null; })()")
    ui.check('结果接回了上面那一轮、眼下看不到：顶上冒「编译 blink 做好了」', chip == '编译 blink 做好了', chip)
    await pg.click('.xc-upchip')
    await pg.wait_for_function("(() => { const r = [...document.querySelectorAll('.xc-tres')].pop().getBoundingClientRect(), b = document.querySelector('.xc-body').getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom; })()", timeout=3000)
    await pg.wait_for_timeout(200)
    hid = await pg.evaluate("document.querySelector('.xc-upchip').hidden")
    ui.check('点提示：平滑滚到结果，提示收起', hid, hid)
    await pg.evaluate("document.querySelector('.xc-spacer').remove()")

    # 换对话：终端关上，不再取
    st['tasks'] = [task(status='running', run='rtask00b01', startedAt=now())]
    st['tp_done']['rtask00b01'] = False
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("document.querySelector('%s').classList.contains('live')" % BOX, timeout=5000)
    await pg.click(BOX)
    await pg.wait_for_selector('.tm-win:not([hidden])')
    await pg.click('.xc-si:has-text("编译 main.c")')
    await pg.wait_for_function("LimingXinChat.state.sid === 'shist00001' && !document.querySelector('.xc-loading')", timeout=10000)
    n2 = len(st['tpolls'])
    await pg.wait_for_timeout(2500)
    sw = await pg.evaluate("[document.querySelector('.tm-win').hidden, !document.querySelector('.xc-tb[data-tsid]'), !document.querySelector('.xc-bgrow')]")
    ui.check('换到别的对话：终端关上、那件活不再取，框不跟过来', sw == [True, True, True] and len(st['tpolls']) == n2, (sw, len(st['tpolls']) - n2))

    # 刷新以后：任务结果的头像点开，没取过才去取这件活的完整记录
    st['tasks'] = [task(status='done', run='rtask00b01', startedAt=now() - 125000, endedAt=now() - 1000, result={'ok': True, 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'at': now() - 1000}, delivery={'state': 'delivered'})]
    st['conv_hist'] = [{'run': 'rlive00001', 'started': now() - 200000, 'done': True, 'events': [{'t': 'user', 'text': '帮我编一下 blink'}, {'t': 'text', 'text': '好，我去编一下。'},
                                                                                                    {'t': 'task', 'sid': TASK, 'no': 1, 'title': '编译 blink', 'kind': 'code', 'status': 'queued'}, {'t': 'done', 'ok': True}]},
                       {'run': 'rhand00001', 'started': now() - 900, 'done': True, 'events': [{'t': 'text', 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'taskResult': {'sid': TASK, 'status': 'done', 'at': now() - 1000, 'endedAt': st['tasks'][0]['endedAt']}}, {'t': 'done', 'ok': True}]}]
    st['task_hist'] = [{'run': 'rtask00b01', 'events': [e for blk in RUN1 for e in blk] + [{'t': 'done', 'ok': True}]}]
    await pg.evaluate("localStorage.setItem('lm.xin.sid', '%s')" % CONV)
    await pg.reload()
    await pg.wait_for_function("LimingXinChat.state.sid === '%s' && !!document.querySelector('.xc-tres') && !!document.querySelector('%s')" % (CONV, BOX), timeout=15000)
    hm = await pg.evaluate("""(() => { const r = document.querySelector('.xc-tres'), b = document.querySelector('%s'), host = b.closest('.xc-ai');
      return [host.nextElementSibling === r, r.classList.contains('cont'), r.dataset.run, document.querySelectorAll('.xc-msgs .xc-who').length, b.classList.contains('live'), (b.querySelector('.xc-tb-m') || {}).textContent]; })()""" % BOX)
    ui.check('刷新以后：还是一条回答——那段话、框（收成一行「用时 2 分钟」）、结果，只有一个「小芯」', hm == [True, True, 'rlive00001', 1, False, '用时 2 分钟'], hm)
    c0 = st['task_hist_calls']
    await pg.click(BOX)
    await pg.wait_for_function("!!document.querySelector('.tm-win:not([hidden]) .tm-cur')", timeout=10000)
    r2 = await pg.evaluate(WIN)
    ui.check('刷新以后：点框才去取（一次），画出 ls、说的话、make，结尾「已完成 · 用时 2 分钟 · 运行 2 条命令」',
             c0 == 0 and st['task_hist_calls'] == 1 and len(r2['rows']) == 3 and r2['sum'] == '已完成 · 用时 2 分钟 · 运行 2 条命令', (c0, st['task_hist_calls'], r2['rows'], r2['sum']))
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
    await pg.wait_for_function("(document.querySelector('.xc-typing-l') || {}).textContent && document.querySelector('.xc-typing-l').textContent.startsWith('在执行：ls')", timeout=10000)
    face = await pg.evaluate("""(() => { const t = document.querySelector('.xc-typing'), f = t.querySelector('.xc-av');
      return [t.dataset.term, t.getAttribute('role'), t.getAttribute('aria-label'), f.dataset.term || '', document.querySelectorAll('.xc-av-t').length, getComputedStyle(t.querySelector('.xc-typing-l')).pointerEvents]; })()""")
    ui.check('正在回话：「思考中」那一条整条是按钮（读屏念「查看正在执行的步骤」），头像不是按钮、没有小终端标记，里面的字不接指针', face == ['live', 'button', '查看正在执行的步骤', '', 0, 'none'], face)
    await pg.click('.xc-typing')
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win:not([hidden]) .tm-l')].some(r => r.textContent.includes('make -j4'))", timeout=10000)
    await pg.wait_for_function("document.querySelector('.tm-win .tm-st').textContent.includes('秒')", timeout=5000)
    a = await pg.evaluate(WIN)
    ui.check('点开：这一轮「> 编一下」、ls 和正在跑的 make；最底下一行写在干什么和秒数', a['prompt'] == '>编一下' and a['rows'][1].startswith('运行(ls)') and a['st'] and '在执行：' in a['st'] and '秒' in a['st'], (a['rows'], a['st']))
    await pg.wait_for_function("!!document.querySelector('.tm-win .tm-sum')", timeout=15000)
    b = await pg.evaluate(WIN)
    ui.check('回完：make 标绿，「编好了。」接在后面，结尾「用时 9 秒 · 运行 2 条命令」，不再转圈', b['sum'] == '用时 9 秒 · 运行 2 条命令' and b['st'] is None and b['rows'][-1] == '编好了。', (b['sum'], b['rows']))
    # 回完以后这一轮的记录里有模型（done 带的）：关上再点回答下面那一行过程框，欢迎框照样只写工作目录
    await pg.keyboard.press('Escape')
    proc = await pg.evaluate("[...document.querySelectorAll('.xc-msgs .xc-proc')].map(p => [p.textContent, p.dataset.term, p.closest('.xc-ai').querySelector(':scope > .xc-bub').textContent])")
    ui.check('回完：「思考中」那一条收成回答下面一行过程框「用时 9 秒 · 运行 2 条命令」（和终端结尾同一句），接在这一轮最后一句下面',
             proc == [['用时 9 秒 · 运行 2 条命令', 'run:rlive00001', '编好了。']], proc)
    await pg.click('.xc-msgs .xc-proc')
    await pg.wait_for_function("!!document.querySelector('.tm-win:not([hidden]) .tm-sum')", timeout=10000)
    c = await pg.evaluate(WIN)
    ui.check('小芯这一轮的欢迎框只写工作目录：回完再点回答的头像，带了模型也不露出来（天启才写模型）', c['ban'][1:] == ['小芯', ['~/workspace']] and 'DeepSeek' not in c['text'], c['ban'])
    await pg.context.close()
    # 站长：「希望像 grok bot 那样根据用户的输入问题显示相关的文字」——「正在输入」那一行先「思考中」，前台概括的那一句来了换成它；
    # 模型的英文思考不放进这一行（只在终端里画）
    pg = await ui.page(browser, 1280, 860)
    live = [[], [{'t': 'think', 'src': 'status', 'text': '查 Gemini 4 Hydrogen 的评测'}, {'t': 'think', 'src': 'model', 'text': 'Looking up public benchmark results first.'}]] + [[]] * 4 + \
           [[{'t': 'text', 'text': '查好了。'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 6000}]]
    await ui.xin_mock(pg, authed=True, live=live)
    await open_work(pg)
    await pg.fill('.xc-row textarea', '不要你感觉，要查一下')
    await pg.keyboard.press('Enter')
    await pg.wait_for_function("((document.querySelector('.xc-typing-l') || {}).textContent || '').startsWith('思考中')", timeout=10000)
    await pg.wait_for_function("((document.querySelector('.xc-typing-l') || {}).textContent || '').startsWith('查 Gemini 4 Hydrogen 的评测')", timeout=10000)
    await pg.wait_for_timeout(1300)
    lab = await pg.evaluate("[document.querySelector('.xc-typing-l').textContent, document.querySelector('.xc-msgs').textContent.includes('Looking up')]")
    ui.check('「正在输入」那一行：先「思考中」，前台概括的那一句来了换成它（秒数照走）；英文思考不放进聊天', lab[0].startswith('查 Gemini 4 Hydrogen 的评测 · ') and lab[0].endswith('秒') and not lab[1], lab)
    await pg.wait_for_function(ui.CHAT_DONE, timeout=15000)
    await pg.context.close()
    # 平板（触屏）上概括写全，不跟手机一样截短；手机上太长的按显示宽度截、加「…」，秒数还在，整行不出屏幕
    LONG = '查 Gemini 4 Hydrogen 在 SWE-bench 和 LiveCodeBench 上的评测'
    for w, h, phrase in ((768, 1024, '查 Gemini 4 Hydrogen 的评测'), (390, 844, LONG)):
        pg = await ui.page(browser, w, h, mobile=True)
        await ui.xin_mock(pg, authed=True, live=[[], [{'t': 'think', 'src': 'status', 'text': phrase}]] + [[]] * 4 + [[{'t': 'text', 'text': '查好了。'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 6000}]])
        await open_work(pg)
        await pg.fill('.xc-row textarea', '不要你感觉，要查一下')
        await pg.click('.xc-send')
        await pg.wait_for_function("((document.querySelector('.xc-typing-l') || {}).textContent || '').startsWith('查 Gemini')", timeout=10000)
        await pg.wait_for_timeout(1300)
        lab = await pg.evaluate("(() => { const l = document.querySelector('.xc-typing-l'), r = document.querySelector('.xc-typing').getBoundingClientRect(); return [l.textContent, r.right <= innerWidth, document.documentElement.scrollWidth <= innerWidth]; })()")
        if w == 768:
            ui.check('平板上「正在输入」写全概括（不按手机的长度截）', lab[0].startswith(phrase + ' · ') and lab[0].endswith('秒') and lab[1] and lab[2], lab)
        else:
            ui.check('手机上概括太长：按显示宽度截、加「…」，秒数还在，整行在屏幕里', lab[0].startswith('查 Gemini 4 Hydrogen') and '…' in lab[0] and not lab[0].startswith(LONG) and lab[0].endswith('秒') and lab[1] and lab[2], lab)
        await pg.wait_for_function(ui.CHAT_DONE, timeout=15000)
        await pg.context.close()


async def part4(browser):
    """天启：新对话空白页上「小芯 | 天启」；侧边栏、命令面板「新建天启对话」；天启对话里是星和「天启」。"""
    pg = await ui.page(browser, 1280, 860)
    st = await ui.xin_mock(pg, authed=True, live=[[{'t': 'text', 'text': '在呢。'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 2000, 'model': 'deepseek-v4.1-flash'}]])
    await open_work(pg)
    await pg.wait_for_selector('.xc-hello .xc-as')
    HELLO = """() => { const p = document.querySelector('.xc-hello'), mk = p.querySelector('.xc-hello-mk'); return [[...p.querySelectorAll('.xc-as-b')].map(b => b.textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : '')),
      p.querySelector('.xc-as').getAttribute('role'), p.classList.contains('tq'), p.querySelector('.xc-hello-t').textContent, getComputedStyle(mk.querySelector('.xc-tq')).opacity === '1',
      document.querySelector('.xc-mdl').hidden, document.querySelector('.xc-row textarea').placeholder]; }"""
    h0 = await pg.evaluate(HELLO)
    ui.check('新对话空白页上方「小芯 | 天启」（单选组，默认小芯），小芯的标志和大标题「小芯」，没有模型按钮，输入框写「给小芯发消息」', h0 == [['小芯*', '天启'], 'radiogroup', False, '小芯', False, True, '给小芯发消息'], h0)
    await pg.click('.xc-as-b[data-a=harness]')
    await pg.wait_for_timeout(700)
    h1 = await pg.evaluate(HELLO)
    ui.check('选天启：底滑过去，标志换成像素星、大标题「天启」，输入框底下出现模型按钮，写「给天启发消息」', h1 == [['小芯', '天启*'], 'radiogroup', True, '天启', True, False, '给天启发消息'], h1)
    # 站长：从天启切回小芯时大标题闪一下（第二轮被挤成两行、和淡出的「天启」叠在一起）。逐帧看：一直是一行、不比单行高
    await pg.evaluate("""() => { window.__hf = []; const w = document.querySelector('.xc-hello-tw'), t0 = performance.now();
      const tick = () => { window.__hf.push([...w.children].map(e => Math.round(e.getBoundingClientRect().height))); if (performance.now() - t0 < 500) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }""")
    await pg.click('.xc-as-b[data-a=codex]')
    await pg.wait_for_timeout(650)
    hf = await pg.evaluate("[window.__hf, Math.round(document.querySelector('.xc-hello-t').getBoundingClientRect().height), document.querySelector('.xc-hello-t').textContent]")
    ui.check('切回小芯：大标题换成「小芯」，换的过程中每一帧都是一行（不被挤成两行叠在一起）', hf[2] == '小芯' and all(h <= hf[1] + 2 for fr in hf[0] for h in fr), (hf[1], max((h for fr in hf[0] for h in fr), default=0), hf[2]))
    await pg.click('.xc-as-b[data-a=harness]')
    await pg.wait_for_timeout(500)
    await pg.focus('.xc-as-b[data-a=harness]')
    await pg.keyboard.press('ArrowLeft')
    await pg.wait_for_timeout(200)
    k = await pg.evaluate("[document.querySelector('.xc-as-b[aria-checked=true]').dataset.a, document.activeElement.dataset.a, localStorage.getItem('lm.xin.agent')]")
    ui.check('方向键也能换（焦点跟着），选了记在这个浏览器里', k == ['codex', 'codex', 'codex'], k)
    await pg.keyboard.press('ArrowRight')
    await pg.wait_for_timeout(200)
    await pg.fill('.xc-row textarea', '天启你好')
    await pg.keyboard.press('Enter')
    await pg.wait_for_function(ui.CHAT_DONE + " && !!document.querySelector('.xc-ai')", timeout=10000)
    sent = st['sent']
    conv = await pg.evaluate("(() => { const a = document.querySelector('.xc-ai'); return [a.querySelector(':scope > .xc-av').classList.contains('xc-tq'), a.querySelector('.xc-who').textContent, !document.querySelector('.xc-hello'), localStorage.getItem('lm.xin.agent')]; })()")
    ui.check('用天启发出去：是天启的新对话（agent harness、不带 main），回答的头像是星、名字写「天启」', sent.get('agent') == 'harness' and 'main' not in sent and conv == [True, '天启', True, 'harness'], (sent, conv))
    # 侧边栏「新建天启对话」、标题栏的「+」（新对话 = 小芯）
    await pg.click('.xc-tqb')
    await pg.wait_for_selector('.xc-hello')
    a1 = await pg.evaluate("[document.querySelector('.xc-hello').classList.contains('tq'), document.querySelector('.xc-tqb > span:last-child').textContent]")
    await pg.click('.xc-new-b')
    await pg.wait_for_timeout(300)
    a2 = await pg.evaluate("[document.querySelector('.xc-hello').classList.contains('tq'), localStorage.getItem('lm.xin.agent')]")
    ui.check('侧边栏键帽「新建天启对话」：空白页直接是天启；标题栏的「+」新对话还是小芯', a1 == [True, '新建天启对话'] and a2 == [False, 'codex'], (a1, a2))
    # 命令面板：搜「天启」
    await pg.keyboard.press('Control+k')
    await pg.wait_for_selector('.xc-pal:not([hidden]) input')
    await pg.keyboard.type('天启')
    await pg.wait_for_timeout(200)
    first = await pg.evaluate("(document.querySelector('.xc-pal [aria-selected=true]') || {}).textContent || ''")
    await pg.keyboard.press('Enter')
    await pg.wait_for_timeout(300)
    a3 = await pg.evaluate("document.querySelector('.xc-hello').classList.contains('tq')")
    ui.check('命令面板搜「天启」：第一个是「新建天启对话」，回车就是天启的空白页', '新建天启对话' in first and a3, (first, a3))
    await pg.context.close()


async def part5(browser):
    """模型和思考强度：按钮上的像素格、面板里滑过去的底、逐格亮、每档一句说明。"""
    pg = await ui.page(browser, 1280, 860)
    await ui.xin_mock(pg, authed=True)
    await open_work(pg)
    await pg.wait_for_selector('.xc-hello .xc-as')
    await pg.click('.xc-as-b[data-a=harness]')
    await pg.wait_for_timeout(300)
    CHIP = "(() => { const m = document.querySelector('.xc-mdl'), e = m.querySelector('.xc-em'); return [m.classList.contains('tq'), e.querySelectorAll('b').length, e.querySelectorAll('b.on').length, e.textContent]; })()"
    c0 = await pg.evaluate(CHIP)
    ui.check('输入框底下：模型名后面一组像素强度格（关以外三格），默认「高」亮两格；天启的冷色', c0 == [True, 3, 2, '高'], c0)
    await pg.click('.xc-mdl')
    await pg.wait_for_selector('.xc-pick:not([hidden])')
    await pg.wait_for_timeout(600)
    PICK = """() => { const p = document.querySelector('.xc-pick'), th = p.querySelector('.xc-eff-th').getBoundingClientRect(), on = p.querySelector('.xc-eff-d.on').getBoundingClientRect(), m = p.querySelector('.xc-pk-t .xc-em');
      return [p.classList.contains('tq'), p.querySelector('.xc-pk-agent').textContent, Math.abs((th.left + th.width / 2) - (on.left + on.width / 2)) < 2, m.querySelectorAll('b.on').length, p.querySelector('.xc-eff-help').textContent, p.querySelector('.xc-pk-tl').textContent]; }"""
    p0 = await pg.evaluate(PICK)
    ui.check('面板：写着「天启」；滑块停在「高」那一格正中，强度格亮两格，下面一句「思考更深，适合复杂问题」', p0 == [True, '天启', True, 2, '思考更深，适合复杂问题', '高'], p0)
    await pg.click('.xc-eff-d[data-v=max]')
    await pg.wait_for_timeout(80)
    mid = await pg.evaluate("(() => { const th = document.querySelector('.xc-eff-th').getBoundingClientRect(), on = document.querySelector('.xc-eff-d.on').getBoundingClientRect(); return Math.abs((th.left + th.width / 2) - (on.left + on.width / 2)) > 2; })()")
    await pg.wait_for_timeout(700)
    p1 = await pg.evaluate(PICK)
    c1 = await pg.evaluate(CHIP)
    ui.check('点「最高」：底滑过去（不是一下跳过去），三格都亮，说明换成「思考最深，适合最难的问题」，按钮上也三格', mid and p1[2:] == [True, 3, '思考最深，适合最难的问题', '最高'] and c1[2:] == [3, '最高'], (mid, p1, c1))
    await pg.click('.xc-eff-d[data-v=off]')
    await pg.wait_for_timeout(700)
    p2 = await pg.evaluate(PICK)
    ui.check('点「关」：一格都不亮，说明「不思考，直接回复」', p2[2:] == [True, 0, '不思考，直接回复', '关'], p2)
    await pg.click('.xc-pk-o[data-v="glm-5.3"]')
    await pg.wait_for_timeout(500)
    g = await pg.evaluate("[[...document.querySelectorAll('.xc-eff-d')].map(b => b.textContent), document.querySelectorAll('.xc-pk-t .xc-em b').length]")
    ui.check('换成 GLM：只有低 / 高 / 最高三档，强度格也是三格', g == [['低', '高', '最高'], 3], g)
    await pg.context.close()


async def part6(browser):
    """先派活、后说话：话还是在框上面（填进框所在的那一条），不另起一条；手机上框占满正文那一栏。"""
    pg = await ui.page(browser, 390, 844, mobile=True)
    live = [[{'t': 'tool', 'id': 'f1', 'name': 'Bash', 'detail': B('xin task new --kind code 帮我编译 blink 工程')},
             {'t': 'task', 'sid': TASK, 'no': 1, 'title': '编译 blink', 'kind': 'code', 'status': 'queued', 'after': [], 'at': now()}],
            [{'t': 'tool_end', 'id': 'f1', 'name': 'Bash', 'detail': B('xin task new --kind code 帮我编译 blink 工程'), 'ok': True, 'out': '任务 1 已派出'}, {'t': 'text', 'text': '好，我去编一下，编好叫你。'}],
            [{'t': 'done', 'ok': True, 'code': 0, 'ms': 2000}]]
    st = await ui.xin_mock(pg, authed=True, live=live)
    st['tasks'] = []
    await open_work(pg)
    await pg.fill('.xc-row textarea', '帮我编一下 blink')
    await pg.click('.xc-send')
    BOX = '.xc-tb[data-tsid="%s"]' % TASK
    await pg.wait_for_function("!!document.querySelector('%s') && !document.querySelector('.xc-typing')" % BOX, timeout=10000)
    o = await pg.evaluate("""(() => { const b = document.querySelector('%s'), host = b.closest('.xc-ai'), bub = host.querySelector(':scope > .xc-bub'), r = b.getBoundingClientRect(), br = bub.getBoundingClientRect();
      return [document.querySelectorAll('.xc-ai[data-run="rlive00001"]').length, bub.textContent, !!(bub.compareDocumentPosition(b) & 4), !!host.querySelector(':scope > .xc-who'),
        Math.round(r.left) === Math.round(br.left), document.documentElement.scrollWidth <= innerWidth]; })()""" % BOX)
    ui.check('先派活、后说话：话填进框所在的那一条、在框上面（这一轮只有一条，带「小芯」）；手机上框和正文左边对齐、不横向滚动', o == [1, '好，我去编一下，编好叫你。', True, True, True, True], o)
    await pg.context.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        await part1(browser)
        await part2(browser)
        await part3(browser)
        await part4(browser)
        await part5(browser)
        await part6(browser)
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
