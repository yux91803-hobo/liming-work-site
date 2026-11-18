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
    ui.check('电脑上终端打开像老显示器开机（tmcrt：先亮一条横线再展开，站长 11-19），是连续缓动（不是 steps 一格一格跳）', pop[0] == 'tmcrt' and pop[1].startswith('cubic-bezier') and 'steps' not in pop[1], pop)
    # 站长 2026-11-17「我每次点开这个，都是从头在加载一遍，不符合逻辑」：打开就停在最新一步，已经做过的不再从头敲一遍
    early = await pg.evaluate(WIN)
    early_bottom = await pg.evaluate("(() => { const s = document.querySelector('.tm-win .tm-scr'); return s.scrollTop + s.clientHeight >= s.scrollHeight - 2; })()")
    await pg.wait_for_timeout(560)
    await pg.wait_for_function("!document.querySelector('.tm-win .tm-tp') && !!document.querySelector('.tm-win .tm-cur')", timeout=8000)
    r = await pg.evaluate(WIN)
    ui.check('开头：「小芯」、模型、工作目录（~/workspace/blink）；标题栏写「小芯的电脑」；下面「> 要求」',
             r['ban'] == [True, '小芯', ['GLM-5.3', '~/workspace/blink']] and r['title'] == '小芯的电脑' and r['prompt'] == '>编一下 blink', (r['ban'], r['title'], r['prompt']))
    sky = await pg.evaluate("""() => { const b = document.querySelector('.tm-win .tm-ban'), sc = b.querySelector('.tm-scene'), m = sc.querySelector('.tm-mk'), r = m.getBoundingClientRect(), g = b.querySelectorAll('.tm-rule')[1].getBoundingClientRect();
      return [b.querySelectorAll('.tm-rule').length, !!sc.querySelector('.tm-sky .tm-moon'), !!sc.querySelector('.tm-sky .tm-cl1'), sc.querySelectorAll('.tm-sky .tm-star').length >= 6,
        getComputedStyle(sc.querySelector('.tm-sky .tm-cl1')).stroke === 'none', !!m.querySelector('svg'), Math.abs(r.bottom - g.top) <= 3]; }""")
    ui.check('照 Claude Code 的欢迎页：两条点线中间一幅像素夜景（点画的云、月牙、* 星星，不描粗边），小芯站在下面那条点线（地平线）上', sky == [2, True, True, True, True, True, True], sky)
    ui.check('打开就停在最新一步：已经做过的一次画好（不从头重放、没有在敲的字），结尾的光标已经在，滚在最下面',
             early and early['text'] == r['text'] and early['cur'] and not early['typing'] and early_bottom, (len(early['text']) if early else None, len(r['text']), early and early['cur'], early and early['typing'], early_bottom))
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
    # 在做的那一页：打开时已经有的几步一次画好；打开以后新来的一步才一个字一个字敲
    await pg.evaluate("""() => { __w.open({ anchor: document.getElementById('anc'), tabs: [{ key: 'run:lv', label: '这一轮', prompt: '跑一下', live: true,
      events: [{ t: 'text', text: '我先看看。' }, { t: 'tool', id: 'k1', name: 'Bash', detail: "/bin/bash -lc 'ls'" }, { t: 'tool_end', id: 'k1', name: 'Bash', detail: "/bin/bash -lc 'ls'", ok: true, out: 'Makefile' }],
      status: () => ({ verb: '编译中', sec: 3 }) }] }); }""")
    lv0 = await pg.evaluate("[document.querySelectorAll('.tm-win .tm-l').length, !!document.querySelector('.tm-win .tm-tp'), document.querySelector('.tm-win .tm-scr').textContent.includes('Makefile')]")
    await pg.evaluate("""() => { __w.push('run:lv', { t: 'tool', id: 'k2', name: 'Bash', detail: "/bin/bash -lc 'make -j4 all'" }); }""")
    await pg.wait_for_timeout(60)
    lv1 = await pg.evaluate("[document.querySelectorAll('.tm-win .tm-l').length, !!document.querySelector('.tm-win .tm-tp')]")
    ui.check('在做的那一页：打开时已经有的两步一次画好（没有在敲的字）；打开以后新来的一步一个字一个字敲出来', lv0 == [2, False, True] and lv1 == [3, True], (lv0, lv1))
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
    ui.check('Esc：终端像老显示器关机（tmcrtoff：缩成一条线再缩成一个点，关的时候也有动画），焦点马上回到原来的位置', out == [False, True, 'tmcrtoff', 'anc'], out)
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
    # 内容一打开就画好（不再等打字），量位置要等滑上来的动画走完
    await pg.wait_for_function("document.querySelector('.tm-win').getAnimations().every(a => a.playState === 'finished')", timeout=3000)
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
             [], [], [{'t': 'done', 'ok': True, 'code': 0, 'ms': 2000}]]
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
        if op == 'send' and st.get('send2'):
            st['send2'] = False
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': {'sid': CONV, 'run': 'rlive00002', 'agent': 'codex'}}))
        if op == 'poll' and args.get('run') == 'rlive00002':
            evs = [{'t': 'text', 'text': '在的，你说。'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 800}][int(args.get('off', 0)):]
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': {'events': evs, 'off': 2, 'done': True}}))
        # 转达结果的那一轮：任务摘要还没轮询到「做完」时它的话已经到了
        if op == 'send' and st.get('send3'):
            st['send3'] = False
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': {'sid': CONV, 'run': 'rhand00002', 'agent': 'codex'}}))
        if op == 'poll' and args.get('run') == 'rhand00002':
            tr = {'sid': TASK, 'status': 'done', 'at': st['res_at'], 'endedAt': st['res_at']}
            evs = [{'t': 'text', 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'taskResult': tr}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 600}][int(args.get('off', 0)):]
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': {'events': evs, 'off': 2, 'done': True}}))
        if op == 'history' and args.get('sid') == TASK and st.get('task_hist'):
            st['task_hist_calls'] += 1
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': {'session': {'sid': TASK, 'agent': 'codex'}, 'task': st['tasks'][0], 'runs': st['task_hist'], 'active': None}}))
        if op == 'history' and args.get('sid') == CONV and st.get('conv_hist'):
            early = st.get('conv_early') or []   # 「更早的消息」那一页（带 before 来取）
            runs, more = (early, False) if args.get('before') else (st['conv_hist'], bool(early))
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': {'session': {'sid': CONV, 'agent': 'codex', 'title': '编译 blink'}, 'runs': runs, 'tasks': st['tasks'], 'more': more, 'active': None}}))
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
    # 站长 2026-11-17「图一的那个要跟着相应的最新对话下面，不然我还得翻上去找着看」：在做的框一直在最底下
    await pg.wait_for_function("!!document.querySelector('%s') && !!document.querySelector('.xc-typing')" % BOX, timeout=10000)
    mid = await pg.evaluate("""(() => { const w = document.querySelector('%s').closest('.xc-tbw'), t = document.querySelector('.xc-typing'), l = document.querySelector('.xc-msgs');
      return [!!w && w.classList.contains('dock'), l.lastElementChild === w, !!w && !!(t.compareDocumentPosition(w) & 4), !!(t.compareDocumentPosition(document.querySelector('.xc-ai[data-run="rlive00001"] > .xc-bub')) & 2)]; })()""" % BOX)
    ui.check('前台还在回话时派出了活：框在「思考中」那一行下面、在聊天最底下；回话的字在「思考中」上面', mid == [True, True, True, True], mid)
    await pg.wait_for_function("!!document.querySelector('%s') && !document.querySelector('.xc-typing')" % BOX, timeout=10000)
    bx = await pg.evaluate("""(() => { const b = document.querySelector('%s'), w = b.closest('.xc-tbw'), prev = w && w.previousElementSibling, l = document.querySelector('.xc-msgs');
      return [b.querySelector('.xc-tb-t').textContent, b.querySelector('.xc-tb-s').textContent, !!w && w.classList.contains('dock'), l.lastElementChild === w,
        prev && prev.dataset.run, prev && (prev.querySelector(':scope > .xc-bub') || {}).textContent, !b.closest('.xc-ai:not(.xc-tbw)'), !!w && !w.querySelector('.xc-bub'),
        b.dataset.term, b.getAttribute('role'), !!w && !w.querySelector('.xc-av, .xc-face, svg.xin-portrait, .xc-who'), !document.querySelector('.xc-bgrow'), b.classList.contains('live'),
        document.querySelectorAll('.xc-msgs .xc-who').length, !!prev && getComputedStyle(prev.querySelector(':scope > .xc-acts')).display === 'none']; })()""" % BOX)
    chat = await pg.evaluate("document.querySelector('.xc-msgs').textContent")
    ui.check('派出去的活：框不塞进那段话里，单独一条（不画头像）紧跟在「好，我去编一下。」下面、在聊天最底下；那段话下面不露「复制」（整条还没说完，站长 11-18）；上面任务名「编译 blink」、下面此刻那一步「准备中」，是按钮、点开看那件活',
             bx == ['编译 blink', '准备中', True, True, 'rlive00001', '好，我去编一下。', True, True, 'task:' + TASK, 'button', True, True, True, 1, True], bx)
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
    # 站长 2026-11-17「我每次点开这个，都是从头在加载一遍」：在做的活点开，打开前已经做过的步骤（打开以后第一次取回来的）一次画好，不逐字敲
    fresh = await pg.evaluate("(() => { const w = document.querySelector('.tm-win'); return [!w.querySelector('.tm-tp'), w.textContent.includes('Makefile')]; })()")
    ui.check('在做的活第一次点开：打开前已经做过的步骤（打开以后才取回来）一次画好、连输出一起，不逐字敲', fresh == [True, True], fresh)
    st['tp_rel']['rtask00b01'] = 2
    typed = True
    try:
        await pg.wait_for_function("!!document.querySelector('.tm-win .tm-tp')", timeout=8000)
    except Exception:
        typed = False
    ui.check('打开以后新来的步骤照旧一个字一个字敲', typed, typed)
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
    st['send2'] = True
    await pg.fill('.xc-row textarea', '在吗')
    await pg.keyboard.press('Enter')
    await pg.wait_for_function("[...document.querySelectorAll('.xc-ai .xc-bub')].some(e => e.textContent === '在的，你说。') && !document.querySelector('.xc-typing')", timeout=10000)
    fol = await pg.evaluate("""(() => { const w = document.querySelector('%s').closest('.xc-tbw'), l = document.querySelector('.xc-msgs'), prev = w.previousElementSibling, me = [...l.querySelectorAll('.xc-me')].pop(), vis = e => getComputedStyle(e.querySelector(':scope > .xc-acts')).display !== 'none';
      return [w.classList.contains('dock'), l.lastElementChild === w, (prev.querySelector(':scope > .xc-bub') || {}).textContent, me.textContent, !!(me.compareDocumentPosition(w) & 4),
        vis(document.querySelector('.xc-ai[data-run="rlive00001"]')), vis(prev), w.classList.contains('own')]; })()""" % BOX)
    ui.check('接着聊了一句：新的一问一答在框上面，框还在聊天最底下（不用翻上去找）；派活那句后面有了别的话，单独算一条、露出复制键；新回答照常露复制键（框不是它这条的）',
             fol == [True, True, '在的，你说。', '在吗', True, True, True, False], fol)

    # 再打开：接着上次取到的地方；做完了，那一页写「已完成 · 用时 2 分钟」
    # 从点开那一刻起记下有没有逐字敲过（.tm-tp 出现过，哪怕同一帧里又敲完）：关着时做的那一步也是打开前就有的
    await pg.evaluate("""(() => { window.__tp = 0;
      new MutationObserver(ms => ms.forEach(m => { if ((m.oldValue || '').includes('tm-tp') || m.target.classList.contains('tm-tp')) window.__tp++; }))
        .observe(document.querySelector('.tm-win'), { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true }); })()""")
    st['tp_rel']['rtask00b01'] = 3
    await pg.click(BOX)
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win .tm-l')].some(r => r.textContent.includes('make -j4') && r.textContent.includes('ok'))", timeout=10000)
    again = [o for r, o, _ in st['tpolls'][n1:] if r == 'rtask00b01']
    ui.check('再打开：从上次取到的地方接着取，不重取', again and min(again) >= 3, again[:4])
    await pg.wait_for_timeout(300)
    gap = await pg.evaluate('window.__tp')
    ui.check('关上以后再点开：关着时做的那一步（打开以后第一次取回来）也一次画好，一个字都不敲', gap == 0, gap)
    st['tp_done']['rtask00b01'] = True
    # 站长 2026-11-18「用时37先结束的，然后下面的话等了一会儿才出来……即使做完了，也要等下面的话发出来才结束」：做完了、前台还在写总结（delivery pending）时框照样在动
    st['tasks'] = [task(status='done', run='rtask00b01', startedAt=now() - 185000, endedAt=now() - 60000, result={'ok': True, 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'at': now() - 60000}, delivery={'state': 'pending'})]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_timeout(1500)
    pend = await pg.evaluate("""(() => { const b = document.querySelector('%s'), w = b.closest('.xc-tbw'), l = document.querySelector('.xc-msgs');
      return [b.classList.contains('live'), w.classList.contains('dock'), l.lastElementChild === w, b.querySelector('.xc-tb-s').textContent, /\\d+ 秒|分/.test(b.querySelector('.xc-tb-sec').textContent), !document.querySelector('.xc-tres')]; })()""" % BOX)
    ui.check('后台做完了、前台还在写总结：框还在动、还在最底下，那一步写「整理结果」，秒数接着走，结果还没画', pend == [True, True, True, '整理结果', True, True], pend)
    st['tasks'] = [task(status='done', run='rtask00b01', startedAt=now() - 185000, endedAt=now() - 60000, result={'ok': True, 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'at': now() - 60000}, delivery={'state': 'delivered', 'at': now()})]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("!!document.querySelector('.tm-win .tm-sum')", timeout=10000)
    await pg.wait_for_function("[...document.querySelectorAll('.xc-tres')].some(e => e.textContent.includes('编好了'))", timeout=10000)
    d = await pg.evaluate(WIN)
    res = await pg.evaluate("""(() => { const r = [...document.querySelectorAll('.xc-tres')].pop(), b = document.querySelector('%s'), w = b.closest('.xc-tbw'), l = document.querySelector('.xc-msgs'), vis = e => getComputedStyle(e.querySelector(':scope > .xc-acts')).display !== 'none';
      return [r.classList.contains('cont'), r.nextElementSibling === w, l.lastElementChild === w, !w.classList.contains('dock'), (r.previousElementSibling.querySelector(':scope > .xc-bub') || {}).textContent,
        !!r.querySelector('.xc-who'), b.classList.contains('live'), b.querySelector('.xc-tb-t').textContent, (b.querySelector('.xc-tb-m') || {}).textContent, b.dataset.term,
        document.querySelectorAll('.xc-msgs .xc-who').length, !document.querySelector('.xc-bgrow'), vis(r), vis(w), [...w.querySelectorAll(':scope > .xc-acts button')].map(x => x.textContent.trim()),
        [...document.querySelectorAll('.xc-msgs .xc-acts button')].some(x => x.textContent.trim() === '详情')]; })()""" % BOX)
    ui.check('做完、话也说出来了：终端那一页写「已完成 · 用时 2 分钟 · 运行 2 条命令」；中间插过话，结果在「在的，你说。」下面另起一条（带头像），框收成一行「编译 blink · 用时 3 分钟」（算到话说出来）接在结果下面、在聊天最后，还能点开；整条只在框下面露一行操作「复制」，没有「详情」',
             d['sum'] == '已完成 · 用时 2 分钟 · 运行 2 条命令' and d['st'] is None and res == [False, True, True, True, '在的，你说。', True, False, '编译 blink', '用时 3 分钟', 'task:' + TASK, 3, True, False, True, ['复制'], False], (d['sum'], d['st'], res))
    await pg.keyboard.press('Escape')
    chip = await pg.evaluate("(() => { const c = document.querySelector('.xc-upchip'); return c && !c.hidden ? c.textContent : null; })()")
    ui.check('结果就在最下面：不用往上翻，顶上不冒提示', chip is None, chip)

    # 换对话：终端关上，不再取
    st['tasks'] = [task(status='running', run='rtask00b01', startedAt=now())]
    st['tp_done']['rtask00b01'] = False
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("document.querySelector('%s').classList.contains('live')" % BOX, timeout=5000)
    redock = await pg.evaluate("(() => { const w = document.querySelector('%s').closest('.xc-tbw'), l = document.querySelector('.xc-msgs'); return [w.classList.contains('dock'), l.lastElementChild === w, w.previousElementSibling.classList.contains('xc-tres')]; })()" % BOX)
    ui.check('做完以后又接着做（比如回复了确认）：框回到聊天最底下，结果留在原处', redock == [True, True, True], redock)
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
    hm = await pg.evaluate("""(() => { const r = document.querySelector('.xc-tres'), b = document.querySelector('%s'), w = b.closest('.xc-tbw'), l = document.querySelector('.xc-msgs'), vis = e => getComputedStyle(e.querySelector(':scope > .xc-acts')).display !== 'none';
      return [r.nextElementSibling === w, r.classList.contains('cont'), !w.classList.contains('dock'), !document.querySelector('.xc-ai[data-run="rlive00001"] .xc-tb'),
        (r.previousElementSibling.querySelector(':scope > .xc-bub') || {}).textContent, document.querySelectorAll('.xc-msgs .xc-who').length, b.classList.contains('live'), (b.querySelector('.xc-tb-m') || {}).textContent,
        document.querySelectorAll('.xc-tb[data-tsid]').length, vis(document.querySelector('.xc-ai[data-run="rlive00001"]')), vis(r), vis(w), l.lastElementChild === w]; })()""" % BOX)
    ui.check('刷新以后：派活那段话、结果、框按顺序排成一条（只有一个「小芯」、一个框），框收成一行「用时 2 分钟」在最下面，只有框下面露操作行',
             hm == [True, True, True, True, '好，我去编一下。', 1, False, '用时 2 分钟', 1, False, False, True, True], hm)
    await pg.evaluate("navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); }")
    await pg.click('.xc-tbw .xc-mcopy')
    cp = await pg.evaluate("window.__copied || ''")
    ui.check('点复制：复制整条（派活那句和结果），不带上面你说的话', '好，我去编一下。' in cp and '编好了' in cp and '帮我编一下 blink' not in cp, cp)
    c0 = st['task_hist_calls']
    await pg.click(BOX)
    await pg.wait_for_function("!!document.querySelector('.tm-win:not([hidden]) .tm-cur')", timeout=10000)
    r2 = await pg.evaluate(WIN)
    ui.check('刷新以后：点框才去取（一次），画出 ls、说的话、make，结尾「已完成 · 用时 2 分钟 · 运行 2 条命令」',
             c0 == 0 and st['task_hist_calls'] == 1 and len(r2['rows']) == 3 and r2['sum'] == '已完成 · 用时 2 分钟 · 运行 2 条命令', (c0, st['task_hist_calls'], r2['rows'], r2['sum']))
    await pg.keyboard.press('Escape')
    # 还在做的活：刷新以后照样在聊天最底下（派活那一轮在历史里，也只有一个框）
    st['tasks'] = [task(status='running', run='rtask00b01', startedAt=now() - 5000)]
    st['conv_hist'] = st['conv_hist'][:1] + [{'run': 'rlive00003', 'started': now() - 500, 'done': True, 'events': [{'t': 'user', 'text': '还要多久'}, {'t': 'text', 'text': '快了。'}, {'t': 'done', 'ok': True}]}]
    await pg.reload()
    await pg.wait_for_function("LimingXinChat.state.sid === '%s' && !!document.querySelector('%s') && [...document.querySelectorAll('.xc-ai .xc-bub')].some(e => e.textContent === '快了。')" % (CONV, BOX), timeout=15000)
    rl = await pg.evaluate("""(() => { const w = document.querySelector('%s').closest('.xc-tbw'), l = document.querySelector('.xc-msgs');
      return [w.classList.contains('dock'), l.lastElementChild === w, (w.previousElementSibling.querySelector(':scope > .xc-bub') || {}).textContent, document.querySelectorAll('.xc-tb[data-tsid]').length,
        !document.querySelector('.xc-ai[data-run="rlive00001"] .xc-tb')]; })()""" % BOX)
    ui.check('刷新以后还在做的活：框在聊天最底下（在最新的「快了。」下面），只有一个框，不在派活那段话里', rl == [True, True, '快了。', 1, True], rl)

    # 结果比任务状态先到（转达那一轮的话到了，任务摘要还说「在做」）：框先落到这时候的最后，结果紧跟在框后面；
    # 框每秒刷新、这一轮说完又轮询任务（还是「在做」），框都不能跳回最底下——不能变成「结果在上、框在最底下」
    st['res_at'] = now() - 400
    st['send3'] = True
    await pg.fill('.xc-row textarea', '好了吗')
    await pg.keyboard.press('Enter')
    await pg.wait_for_function("[...document.querySelectorAll('.xc-tres')].some(e => e.textContent.includes('编好了')) && !document.querySelector('.xc-typing')", timeout=10000)
    await pg.wait_for_timeout(2500)   # 框每秒刷新一次、说完 0.8 秒后轮询一次任务：都过去了再看
    RF = """(() => { const w = document.querySelector('%s').closest('.xc-tbw'), r = [...document.querySelectorAll('.xc-tres')].pop(), l = document.querySelector('.xc-msgs'), me = [...l.querySelectorAll('.xc-me')].pop();
      return [w.classList.contains('dock'), r.nextElementSibling === w, l.lastElementChild === w, me.textContent, !!(me.compareDocumentPosition(w) & 4), document.querySelectorAll('.xc-tres').length]; })()""" % BOX
    first = await pg.evaluate(RF)
    ui.check('结果比任务状态先到：结果和框落在「好了吗」下面，结果在前、框紧跟在结果后面、在聊天最后（框不再停在最底下转）；之后框刷新、轮询到的还是「在做」，也不把框拉回最底下',
             first == [False, True, True, '好了吗', True, 1], first)
    st['tasks'] = [task(status='done', run='rtask00b01', startedAt=now() - 125000, endedAt=st['res_at'], result={'ok': True, 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'at': st['res_at']}, delivery={'state': 'delivered'})]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("!document.querySelector('%s').classList.contains('live')" % BOX, timeout=5000)
    late = await pg.evaluate(RF)
    ui.check('随后轮询到做完：框收成一行、还在结果下面，结果只有一条', late == [False, True, True, '好了吗', True, 1], late)

    # 「更早的消息」翻出派活那一轮（里面有这件活的派活事件）：不再画第二个框，在做的框还在最底下
    st['tasks'] = [task(status='running', run='rtask00b02', startedAt=now() - 5000)]
    st['conv_early'] = st['conv_hist'][:1]
    st['conv_hist'] = [{'run': 'rlive00005', 'started': now() - 300, 'done': True, 'events': [{'t': 'user', 'text': '还在编吗'}, {'t': 'text', 'text': '在编，快了。'}, {'t': 'done', 'ok': True}]}]
    await pg.reload()
    await pg.wait_for_function("LimingXinChat.state.sid === '%s' && !!document.querySelector('.xc-earlier') && !!document.querySelector('%s')" % (CONV, BOX), timeout=15000)
    await pg.click('.xc-earlier')
    await pg.wait_for_function("[...document.querySelectorAll('.xc-ai .xc-bub')].some(e => e.textContent === '好，我去编一下。')", timeout=10000)
    er = await pg.evaluate("""(() => { const w = document.querySelector('%s').closest('.xc-tbw'), l = document.querySelector('.xc-msgs');
      return [document.querySelectorAll('.xc-tb[data-tsid]').length, w.classList.contains('dock'), l.lastElementChild === w, !document.querySelector('.xc-ai[data-run="rlive00001"] .xc-tb'),
        (w.previousElementSibling.querySelector(':scope > .xc-bub') || {}).textContent]; })()""" % BOX)
    ui.check('「更早的消息」翻出派活那一轮：不再画第二个框，在做的框还在聊天最底下（「在编，快了。」下面）', er == [1, True, True, True, '在编，快了。'], er)
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
    """入口已经迁移，li 的历史天启对话仍可打开、继续，保留原来的标志与模型。"""
    pg = await ui.page(browser, 1280, 860)
    st = await ui.xin_mock(pg, authed=True, legacy_harness=True,
                          live=[[{'t': 'text', 'text': '在呢。'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 2000, 'model': 'deepseek-v4.1-flash'}]])
    await open_work(pg)
    await pg.wait_for_selector('.xc-hello')
    default = await pg.evaluate('''() => [document.querySelector('.xc-hello-t').textContent,
        !document.querySelector('.xc-as'), document.querySelector('.xc-mdl').hidden,
        document.querySelector('.xc-row textarea').placeholder]''')
    ui.check('小芯空白页没有切换入口，保留标题、模型按钮状态和输入提示', default == ['小芯', True, True, '给小芯发消息'], default)
    drawer = await pg.evaluate("[...document.querySelectorAll('.xc-dr-keys .xc-key')].map(b => b.textContent.trim())")
    ui.check('小芯侧边栏只有新建对话', drawer == ['新建对话'], drawer)
    await pg.keyboard.press('Control+k')
    await pg.wait_for_selector('.xc-pal:not([hidden]) input')
    await pg.keyboard.type('天启')
    actions = await pg.locator('.xc-pal').inner_text()
    ui.check('命令面板保留旧天启对话搜索，去掉新建入口', '新建天启对话' not in actions and ui.LEGACY_HARNESS['title'] in actions, actions)
    await pg.keyboard.press('Escape')
    await ui.open_legacy_harness(pg)
    await pg.fill('.xc-row textarea', '天启你好')
    await pg.keyboard.press('Enter')
    await pg.wait_for_function(ui.CHAT_DONE + " && [...document.querySelectorAll('.xc-ai .xc-bub')].some(e => e.textContent.includes('在呢。'))", timeout=10000)
    sent = st['sent']
    old = await pg.evaluate('''() => { const a = [...document.querySelectorAll('.xc-ai')].at(-1);
        return [a.querySelector(':scope > .xc-av').classList.contains('xc-tq'), a.querySelector('.xc-who').textContent,
                document.querySelector('.xc-mdl').hidden]; }''')
    ui.check('旧天启在 li 上接着聊：沿用原编号和 Harness，回答保留星标与模型按钮',
             sent.get('sid') == ui.LEGACY_HARNESS['sid'] and sent.get('model') == 'deepseek-v4.1-flash'
             and 'main' not in sent and old == [True, '天启', False], (sent, old))
    await pg.click('.xc-new-b')
    await pg.wait_for_selector('.xc-hello')
    fresh = await pg.evaluate("[LimingXinChat.state.agent, LimingXinChat.state.sessAgent, document.querySelector('.xc-hello-t').textContent]")
    ui.check('从旧天启新建对话会回到小芯', fresh == ['codex', '', '小芯'], fresh)
    await pg.context.close()


async def part5(browser):
    """模型和思考强度：按钮上的像素格、面板里滑过去的底、逐格亮、每档一句说明。"""
    pg = await ui.page(browser, 1280, 860)
    await ui.xin_mock(pg, authed=True, legacy_harness=True)
    await open_work(pg)
    await ui.open_legacy_harness(pg)
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
    """先派活、后说话：话还是在框上面（框单独一条、在最底下，2026-11-17 起），这一轮只有一条带「小芯」；手机上框占满正文那一栏、和正文左边对齐。"""
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
    o = await pg.evaluate("""(() => { const b = document.querySelector('%s'), w = b.closest('.xc-tbw'), m = document.querySelector('.xc-ai[data-run="rlive00001"]'), bub = m.querySelector(':scope > .xc-bub'), r = b.getBoundingClientRect(), br = bub.getBoundingClientRect();
      return [document.querySelectorAll('.xc-ai[data-run="rlive00001"]').length, bub.textContent, !!(m.compareDocumentPosition(w) & 4), !!m.querySelector(':scope > .xc-who'),
        Math.round(r.left) === Math.round(br.left), document.documentElement.scrollWidth <= innerWidth, document.querySelector('.xc-msgs').lastElementChild === w]; })()""" % BOX)
    ui.check('先派活、后说话：话在框上面（这一轮只有一条，带「小芯」），框单独一条在最底下；手机上框和正文左边对齐、不横向滚动', o == [1, '好，我去编一下，编好叫你。', True, True, True, True, True], o)
    await pg.context.close()


async def part7(browser):
    """后台干活时插话（站长 2026-11-17，docs/superpowers/specs/2026-11-17-xin-steer-design.md）：任务主动回来说的一句画在聊天最后、只画一次；
    任务的终端里看得到兄弟中途补充的话（一行「> …」，落在它被送进去的那一步前面）和主动告诉兄弟的那句。"""
    pg = await ui.page(browser, 1280, 860)
    await pg.emulate_media(reduced_motion='reduce')
    front = [[{'t': 'text', 'text': '好，我去查一下。'}, {'t': 'task', 'sid': TASK, 'no': 1, 'title': '查电脑上的 Agent 模型', 'kind': 'research', 'status': 'queued', 'after': [], 'at': now()}],
             [{'t': 'done', 'ok': True, 'code': 0, 'ms': 1500}]]
    st = await ui.xin_mock(pg, authed=True, live=front)
    NOTE = '两份配置写的默认模型不一样，我再核一下实际启动的是哪个'
    run = [{'t': 'user', 'text': '内部要求原文：查电脑上有哪些 Agent 模型'}, {'t': 'tool', 'id': 'a', 'name': 'Bash', 'detail': B('cat ~/.codex/config.toml')},
           {'t': 'tool_end', 'id': 'a', 'name': 'Bash', 'detail': B('cat ~/.codex/config.toml'), 'ok': True, 'out': 'model = "glm-5.3"'},
           {'t': 'user', 'text': '备用的别列，只列实际启用的', 'steer': True}, {'t': 'note', 'text': NOTE},
           {'t': 'tool', 'id': 'b', 'name': 'Bash', 'detail': B('ps aux')}]
    st.update({'tasks': []})

    async def overlay(route):
        body = json.loads(route.request.post_data or '{}')
        op, args = body.get('op'), body.get('args') or {}
        if op == 'poll' and args.get('run') == 'rtask00s01':
            off = int(args.get('off', 0))
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': {'events': run[off:], 'off': len(run), 'done': False}}))
        await route.fallback()
    await pg.route('**/api/xin/call', overlay)
    await open_work(pg)
    await pg.fill('.xc-row textarea', '查一下电脑上有哪些 Agent 模型')
    await pg.click('.xc-send')
    BOX = '.xc-tb[data-tsid="%s"]' % TASK
    await pg.wait_for_function("!!document.querySelector('%s') && !document.querySelector('.xc-typing')" % BOX, timeout=10000)
    sid = await pg.evaluate("LimingXinChat.state.sid")
    st['tasks'] = [task(parent=sid, title='查电脑上的 Agent 模型', kind='research', status='running', startedAt=now() - 60000, run='rtask00s01')]
    st['notes'] = [{'run': 'rnote00001', 'text': NOTE, 'at': now(), 'task': {'sid': TASK, 'no': 1}}]
    await pg.evaluate("LimingXinChat.tasks()")
    await pg.wait_for_function("!!document.querySelector('.xc-ai[data-run=\"rnote00001\"]')", timeout=8000)
    await pg.evaluate("LimingXinChat.tasks()")
    await pg.wait_for_timeout(600)
    n = await pg.evaluate("""(() => { const a = [...document.querySelectorAll('.xc-ai[data-run="rnote00001"]')], all = [...document.querySelectorAll('.xc-msgs .xc-m:not(.dock)')];
      return [a.length, a[0] && a[0].querySelector(':scope > .xc-bub').textContent, all[all.length - 1] === a[0], !!a[0] && !a[0].querySelector('.xc-tb'), !!a[0] && !!a[0].nextElementSibling && a[0].nextElementSibling.classList.contains('dock')]; })()""")
    ui.check('后台主动回来说的一句：画在聊天最后、是小芯的一条消息（不带任务框）、还在做的那件活的框在它下面；再轮询也只画一次', n == [1, NOTE, True, True, True], n)
    await pg.click(BOX)
    await pg.wait_for_function("!!document.querySelector('.tm-win:not([hidden]) .tm-log .tm-ask')", timeout=8000)
    await pg.wait_for_timeout(300)
    tm = await pg.evaluate("""(() => { const w = document.querySelector('.tm-win'), log = w.querySelector('.tm-log'), kids = [...log.children];
      const ask = log.querySelector('.tm-ask'), said = [...log.querySelectorAll('.tm-said')].map(e => e.textContent);
      const i = kids.indexOf(ask), j = kids.findIndex(e => e.classList.contains('tm-said'));
      return [ask.textContent, ask.querySelector('.tm-pp').textContent, said, i > 0 && j > i, kids.slice(0, i).some(e => e.classList.contains('tm-l'))]; })()""")
    ui.check('终端：兄弟中途补充的话是一行「> …」，落在送进去的那一步前面；主动告诉兄弟的那句写成「告诉兄弟：…」',
             tm[0] == '>备用的别列，只列实际启用的' and tm[1] == '>' and any(x.endswith('告诉兄弟：' + NOTE) for x in tm[2]) and tm[3] and tm[4], tm)
    await pg.keyboard.press('Escape')
    await pg.context.close()


async def part_wait(browser):
    """站长 2026-11-18「做任务的时候如果没有输出就一直这个界面太丑了，可以加点等待动画，你自己发挥，要好看」：
    后台还没输出时，提示行下面一排像素方块、一道光扫过去，上面的夜景在动（云飘、流星）；来了第一行方块就让开；做完了夜景不动；减少动态时都不动。"""
    pg = await ui.page(browser, 1280, 860)
    front = [[{'t': 'text', 'text': '好，我去编一下。'}, {'t': 'task', 'sid': TASK, 'no': 1, 'title': '编译 blink', 'kind': 'code', 'status': 'queued', 'after': [], 'at': now()}],
             [{'t': 'done', 'ok': True, 'code': 0, 'ms': 800}]]
    st = await ui.xin_mock(pg, authed=True, live=front)
    st.update({'tasks': [], 'tp': {'rtask00b01': RUN1}, 'tp_rel': {}, 'tp_done': {}})

    async def overlay(route):
        body = json.loads(route.request.post_data or '{}')
        op, args = body.get('op'), body.get('args') or {}
        if op == 'poll' and str(args.get('run', '')).startswith('rtask'):
            run = args['run']
            pub = [e for blk in st['tp'].get(run, [])[:st['tp_rel'].get(run, 0)] for e in blk]
            off = int(args.get('off', 0))
            evs = pub[off:off + 400]
            data = {'events': evs, 'off': off + len(evs), 'done': bool(st['tp_done'].get(run)) and off + len(evs) >= len(pub)}
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'data': data}))
        await route.fallback()
    await pg.route('**/api/xin/call', overlay)
    await open_work(pg)
    await pg.click('.xc-new-b')
    await pg.fill('.xc-row textarea', '帮我编一下 blink')
    await pg.keyboard.press('Enter')
    BOX = '.xc-tb[data-tsid="%s"]' % TASK
    await pg.wait_for_function("!!document.querySelector('%s') && !document.querySelector('.xc-typing')" % BOX, timeout=10000)
    st['tasks'] = [task(status='running', run='rtask00b01', startedAt=now() - 3000)]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("document.querySelector('%s').classList.contains('live')" % BOX, timeout=5000)
    await pg.click(BOX)
    await pg.wait_for_function("!!document.querySelector('.tm-win:not([hidden]) .tm-wait')", timeout=8000)
    await pg.wait_for_timeout(600)
    W = """(() => { const w = document.querySelector('.tm-win'), q = w.querySelector('.tm-wait'), sq = q ? [...q.querySelectorAll('i')] : [], pr = w.querySelector('.tm-pr'), m = w.querySelector('.tm-meteor');
      return [sq.length, sq.length ? getComputedStyle(sq[0]).animationName : '', !!pr && !!q && !!(pr.compareDocumentPosition(q) & 4), getComputedStyle(w.querySelector('.tm-cl1')).animationName,
        m ? getComputedStyle(m).animationName : '', q ? q.getAttribute('aria-hidden') : null, w.querySelectorAll('.tm-log .tm-l').length]; })()"""
    a = await pg.evaluate(W)
    ui.check('后台还没输出：提示行下面一排 14 个像素方块、一道光扫过去，夜景的云在飘、隔一会儿划过一颗流星；读屏不念，不写假的输出',
             a == [14, 'tmscan', True, 'tmdrift', 'tmmeteor', 'true', 0], a)
    await pg.emulate_media(reduced_motion='reduce')
    r = await pg.evaluate(W)
    ui.check('系统开了「减少动态」：方块、云、流星都不动', r[:5] == [14, 'none', True, 'none', 'none'], r)
    await pg.emulate_media(reduced_motion='no-preference')
    st['tp_rel']['rtask00b01'] = 1
    await pg.wait_for_function("[...document.querySelectorAll('.tm-win .tm-l')].some(r => r.textContent.includes('ls'))", timeout=10000)
    try:
        await pg.wait_for_function("!document.querySelector('.tm-win .tm-wait')", timeout=3000)
        gone = True
    except Exception:
        gone = False
    ui.check('来了第一行：方块淡出拿掉', gone, gone)
    st['tp_rel']['rtask00b01'] = 3
    st['tp_done']['rtask00b01'] = True
    st['tasks'] = [task(status='done', run='rtask00b01', startedAt=now() - 5000, endedAt=now(), result={'ok': True, 'text': '编好了。', 'at': now()}, delivery={'state': 'delivered', 'at': now()})]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("!!document.querySelector('.tm-win .tm-sum')", timeout=10000)
    d = await pg.evaluate("(() => { const w = document.querySelector('.tm-win'), m = w.querySelector('.tm-meteor'); return [!w.querySelector('.tm-wait'), getComputedStyle(w.querySelector('.tm-cl1')).animationName, m ? getComputedStyle(m).animationName : 'none']; })()")
    ui.check('做完了：没有方块，夜景不动', d == [True, 'none', 'none'], d)
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
        await part7(browser)
        await part_wait(browser)
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
