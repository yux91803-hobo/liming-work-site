"""STM32 学习台端到端测试（需要 python playwright + chromium）
先 npm run dev，再 python3 test/e2e/stm32_e2e.py [http://localhost:5173]"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173'
TOOL = BASE + '/tools/stm32/'
INSTR = """
  window.__rs = 0;
  const R = history.replaceState.bind(history);
  history.replaceState = function () { window.__rs++; return R.apply(null, arguments); };
"""
results, errors = [], []

def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (('  — ' + str(detail)) if detail != '' else ''), flush=True)

async def page(b, w=1280, h=860, mobile=False, theme='light'):
    ctx = await b.new_context(viewport={'width': w, 'height': h}, has_touch=mobile, is_mobile=mobile)
    await ctx.add_init_script(INSTR + "try{if(!localStorage.getItem('lm.theme'))localStorage.setItem('lm.theme','%s')}catch(e){}" % theme)
    pg = await ctx.new_page()
    pg.on('pageerror', lambda e: errors.append('pageerror ' + pg.url + ' :: ' + str(e)))
    pg.on('console', lambda m: errors.append('console.error ' + m.text) if m.type == 'error' else None)
    return pg

async def tool_frame(pg):
    for _ in range(120):
        for f in pg.frames:
            if '/tools/stm32/' in f.url:
                try:
                    if await f.evaluate("document.documentElement.classList.contains('ready')"): return f
                except Exception: pass
        await pg.wait_for_timeout(100)
    raise RuntimeError('stm32 iframe not ready')

async def wait_img(f, timeout=10000):
    await f.wait_for_function("(() => { const i = document.querySelector('.viewer.on .zoom-content img'); return i && i.naturalWidth > 0; })()", timeout=timeout)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()

        # ---------- 1. 独立打开：学习地图 → 主题 → 寄存器 → 返回 ----------
        pg = await page(b)
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        await pg.hover('.trow[href*="t=usart"]')
        lit = await pg.evaluate("document.querySelectorAll('.home-chip .pin.lit').length")
        check('首页：指到 USART，芯片上点亮它的引脚', lit == 31, lit)
        await pg.click('.trow[href*="t=usart"]'); await pg.wait_for_selector('.topic')
        check('进入 USART 主题页', 'v=topic&t=usart' in pg.url and await pg.inner_text('.th-code') == 'USART', pg.url)
        secs = await pg.evaluate("[...document.querySelectorAll('.snav-i')].map(a => a.textContent)")
        check('主题页分节齐全', secs == ['要点', '课件', '引脚', '寄存器', '代码', '图'], secs)
        await pg.click('.rrow[data-reg="USART_BRR"]'); await pg.wait_for_selector('.sheet.on')
        await pg.click('.sh-fx .pill.solid'); await pg.wait_for_timeout(150)
        hexv = await pg.input_value('.hexin input')
        code = await pg.inner_text('.sh-code figure.code pre')
        check('波特率助手：72 MHz / 115200 → BRR = 0x271', hexv.replace(' ', '') == '0x00000271' and 'USART1->BRR' in code, hexv + ' | ' + code.splitlines()[0])
        await pg.wait_for_timeout(400)
        check('计算值写进地址（可分享）', 'val=0x00000271' in pg.url, pg.url)
        await pg.go_back(); await pg.wait_for_timeout(400)
        check('返回：关掉寄存器面板，留在主题页', not await pg.evaluate("!!document.querySelector('.sheet.on')") and 'reg=' not in pg.url)
        await pg.go_back(); await pg.wait_for_timeout(300)
        check('再返回：回到学习地图', await pg.evaluate("!!document.querySelector('.home')"))

        # ---------- 2. 位段条与常用配置 ----------
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL&i=GPIOA'); await pg.wait_for_selector('.sheet.on')
        await pg.click('.bits-row:last-child .bits-cells button.bit:last-child')   # 位 0 → MODE0 = 01
        hexv = await pg.input_value('.hexin input')
        code = await pg.inner_text('.sh-code figure.code pre')
        check('点一下位 0：值和读-改-写代码同步', hexv.replace(' ', '') == '0x44444445' and 'GPIOA->CRL' in code and '&=' not in code.split('\n')[0] or '|' in code, hexv + ' | ' + code.splitlines()[0])
        await pg.click('.qchip >> nth=0'); await pg.wait_for_timeout(150)
        hexv = await pg.input_value('.hexin input')
        hal = await pg.evaluate("(() => { const f = [...document.querySelectorAll('.sh-code figure.code')][1]; return f && !f.hidden ? f.innerText : ''; })()")
        check('常用配置「LED1 推挽输出」→ 0x44444443，并给出 HAL 写法', hexv.replace(' ', '') == '0x44444443' and 'GPIO_InitStruct' in hal, hexv)
        grp = await pg.inner_text('.fgroup-h >> nth=7')
        check('GPIO 字段按引脚分组并标出板上用途', 'PA0' in grp and 'LED1' in grp, grp)

        # ---------- 3. 芯片引脚 ----------
        await pg.goto(TOOL + '?v=chip'); await pg.wait_for_selector('.chipv')
        await pg.fill('.filter input', 'USART1'); await pg.wait_for_timeout(500)
        n = await pg.evaluate("document.querySelectorAll('.chipv .pin.lit').length")
        check('芯片页筛选 USART1 点亮对应引脚', n >= 4 and 'q=USART1' in pg.url, n)
        await pg.click('.chipv [data-pin="101"] .hit', force=True); await pg.wait_for_timeout(500)
        det = await pg.inner_text('.pdetail')
        check('点 101 脚：详情列出 USART1_TX 和板上用途', 'PA9' in det and 'USART1_TX' in det and 'STLink' in det)
        await pg.click('.pdetail a.sig:has-text("USART1_TX")'); await pg.wait_for_selector('.topic')
        check('从信号跳到所属外设', 't=usart' in pg.url)

        # ---------- 4. 课件查看器 ----------
        await pg.goto(TOOL + '?v=course'); await pg.wait_for_selector('.coursev')
        await pg.click('.vol >> nth=0 >> .chap >> nth=0'); await wait_img(pg)
        for _ in range(20):
            await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(30)
        await pg.wait_for_timeout(600)
        cnt = await pg.inner_text('.vw-n')
        check('课件连续翻 20 页', cnt.startswith('21 /'), cnt)
        check('翻页地址跟上（只替换不新增记录）', 'cw=v20-21' in pg.url, pg.url)
        await pg.go_back(); await pg.wait_for_timeout(400)
        check('返回关闭查看器，回到课件目录', not await pg.evaluate("!!document.querySelector('.viewer.on')") and await pg.evaluate("!!document.querySelector('.coursev')"))
        cont = await pg.evaluate("(document.querySelector('.cont') || {}).textContent || ''")
        check('课件目录记住读到的页', '21' in cont, cont)
        await pg.goto(TOOL + '?v=course&cw=v20-134'); await wait_img(pg)
        check('有勘误的页显示勘误', await pg.evaluate("!document.querySelector('.vw-er-b').hidden") and 'HAL_UART_Transmit' in await pg.inner_text('.vw-er'))

        # ---------- 5. 搜索 ----------
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        await pg.keyboard.press('/'); await pg.wait_for_selector('.search.on')
        for q, want in [('USART_BRR', 'USART_BRR'), ('UART1', 'USART'), ('GPIOA_CRL', 'GPIOx_CRL'), ('PA 9', 'PA9'), ('串口', 'USART')]:
            await pg.fill('.search-in', q); await pg.wait_for_timeout(200)
            first = await pg.evaluate("[...document.querySelectorAll('.search-it b')].slice(0,3).map(b => b.textContent)")
            check('搜索「%s」' % q, any(want in x for x in first), first)
        await pg.fill('.search-in', 'USART_BRR'); await pg.wait_for_timeout(200); await pg.keyboard.press('Enter')
        await pg.wait_for_selector('.sheet.on')
        check('搜索结果回车直接打开寄存器', 'reg=USART_BRR' in pg.url)

        # ---------- 6. 深链 / 旧链接 ----------
        for qs, test, name in [
            ('?cw=v20-16', "document.querySelector('.vw-n') && document.querySelector('.vw-n').textContent.startsWith('16 /')", '课件第 16 页'),
            ('?tab=pins&q=PA9', "location.search.includes('v=chip') && document.querySelector('.filter input').value === 'PA9'", '旧链接 tab=pins'),
            ('?tab=regs&reg=GPIO_CRH&i=GPIOB', "!!document.querySelector('.sheet.on') && document.querySelector('.sh-expr').textContent === 'GPIOB->CRH'", '旧链接 tab=regs'),
            ('?tab=chip&page=board-05', "!!document.querySelector('.viewer.on') && location.search.includes('v=board')", '旧链接原理图'),
            ('?tab=code&snip=' + 'USART1 中断收发', "location.search.includes('t=usart')", '旧链接代码片段'),
        ]:
            await pg.goto(TOOL + qs); await pg.wait_for_timeout(1200)
            check('深链：' + name, await pg.evaluate(test), pg.url)

        # ---------- 7. 架构图缩略图都能加载 ----------
        await pg.goto(TOOL + '?v=topic&t=tim'); await pg.wait_for_selector('.fgrid')
        await pg.evaluate("document.querySelector('.fgrid').scrollIntoView()")
        await pg.wait_for_timeout(300)
        for i in range(8):
            await pg.mouse.wheel(0, 900); await pg.wait_for_timeout(150)
        await pg.wait_for_timeout(1500)
        bad = await pg.evaluate("[...document.querySelectorAll('.fgrid img')].filter(i => !(i.complete && i.naturalWidth > 0)).length + document.querySelectorAll('.fgrid .thumb.missing').length")
        check('TIM 主题 27 张图的缩略图全部加载', bad == 0, bad)
        await pg.context.close()

        # ---------- 8. 嵌在工具箱里：返回键逐层退回 ----------
        pg = await page(b)
        await pg.goto(BASE + '/stm32'); f = await tool_frame(pg)
        await f.click('.trow[href*="t=i2c"]'); await f.wait_for_selector('.topic')
        await f.click('.rrow[data-reg="I2C_CCR"]'); await f.wait_for_selector('.sheet.on')
        await f.click('.sh-meta .pgchip'); await wait_img(f)
        depth = lambda: f.evaluate("({ v: !!document.querySelector('.viewer.on'), s: !!document.querySelector('.sheet.on'), t: !!document.querySelector('.topic') })")
        await pg.go_back(); await pg.wait_for_timeout(600); d1 = await depth()
        check('外壳返回 1：关查看器，寄存器还在', not d1['v'] and d1['s'], d1)
        await pg.go_back(); await pg.wait_for_timeout(600); d2 = await depth()
        check('外壳返回 2：关寄存器，回到 I2C 页', not d2['s'] and d2['t'], d2)
        await pg.go_back(); await pg.wait_for_timeout(600)
        check('外壳返回 3：回到学习地图', await f.evaluate("!!document.querySelector('.home')"))
        await pg.go_back(); await pg.wait_for_timeout(900)
        check('外壳返回 4：关闭工具', not await pg.evaluate("!!document.querySelector('#stage .panel.show')") and await pg.evaluate("location.pathname") == '/')
        # 连续翻页后返回
        await pg.goto(BASE + '/stm32?v=course&cw=v21-1'); f = await tool_frame(pg); await wait_img(f)
        rs0 = (await pg.evaluate('__rs')) + (await f.evaluate('__rs'))
        await f.focus('.vw-x') if await f.evaluate("getComputedStyle(document.querySelector('.vw-x')).display !== 'none'") else await f.focus('.viewer .icon-btn[aria-label="下一页"]')
        for _ in range(100):
            await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(25)
        await pg.wait_for_timeout(900)
        rs = (await pg.evaluate('__rs')) + (await f.evaluate('__rs')) - rs0
        cnt = await f.inner_text('.vw-n')
        check('嵌入：按住方向键翻 100 页，页码正确', cnt.startswith('101 /'), cnt)
        check('嵌入：翻页期间地址写入被节流', rs <= 40, '%d 次' % rs)
        check('外壳地址跟到当前页', 'cw=v21-101' in await pg.evaluate('location.search'), await pg.evaluate('location.search'))
        await pg.go_back(); await pg.wait_for_timeout(700)
        check('翻页后返回只关查看器', not await f.evaluate("!!document.querySelector('.viewer.on')") and await pg.evaluate("!!document.querySelector('#stage .panel.show')"))
        # 外壳切主题
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(300)
        await pg.click('#themeBtn'); await pg.wait_for_timeout(200)
        await pg.click('.card[data-id=stm32]'); f = await tool_frame(pg)
        check('工具箱切到深色后，学习台也是深色', await f.evaluate("document.documentElement.getAttribute('data-theme')") == 'dark')
        await pg.context.close()

        # ---------- 9. 手机 ----------
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        order = await pg.evaluate("['.home-h','.home-chip','.path'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().top))")
        check('手机首页：标题 → 芯片 → 学习路径', order[0] < order[1] < order[2], order)
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL'); await pg.wait_for_selector('.sheet.on')
        box = await pg.evaluate("(() => { const r = document.querySelector('.sheet-p').getBoundingClientRect(); const v = document.querySelector('.sh-valrow .pill').getBoundingClientRect(); return [r.width, v.right]; })()")
        check('手机：寄存器面板全屏，复位按钮不被截断', box[0] >= 389 and box[1] <= 390, box)
        overflow = await pg.evaluate("document.documentElement.scrollWidth > innerWidth")
        check('手机：页面没有横向溢出', not overflow)
        await pg.goto(TOOL + '?cw=v21-10'); await wait_img(pg)
        st = await pg.query_selector('.vw-stage'); bb = await st.bounding_box(); y = bb['y'] + bb['height'] / 2
        await pg.evaluate("""([x0, x1, y]) => {
          const s = document.querySelector('.vw-stage');
          const ev = (t, x) => s.dispatchEvent(new PointerEvent(t, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
          ev('pointerdown', x0); ev('pointermove', (x0 + x1) / 2); ev('pointermove', x1); ev('pointerup', x1);
        }""", [bb['x'] + 330, bb['x'] + 60, y])
        await pg.wait_for_timeout(600)
        check('手机：左滑翻到下一页', (await pg.inner_text('.vw-n')).startswith('11 /'))
        await pg.context.close()

        # ---------- 10. 编程思维：把三章每一道题都实际做一遍 ----------
        pg = await page(b)
        await pg.goto(TOOL + '?v=think'); await pg.wait_for_selector('.tk-ch')
        check('编程思维总览：三章 + 五步骨架', await pg.evaluate("document.querySelectorAll('.tk-ch').length") == 3 and await pg.evaluate("document.querySelectorAll('.tk-skbox .skstrip li').length") == 5)
        SOLVE = """async (sel) => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const box = document.querySelector(sel); const log = [];
          const q = box.__q;
          return log;
        }"""
        async def solve_current(scope):
            """做当前显示的那一道题：先故意错一次，看提示，再做对。返回 (类型, 错误提示是否对得上, 是否解出)"""
            info = await pg.evaluate("""(scope) => {
              const box = document.querySelector(scope + ' .q:not(.solved)'); if (!box) return null;
              return { type: [...box.classList].find(c => c.startsWith('q-') && c !== 'q').slice(2), text: box.querySelector('.q-q').textContent };
            }""", scope)
            if not info: return None
            data = await pg.evaluate("""(text) => {
              for (const c of STM32_THINK.chapters) {
                for (const w of c.why) if (w.q && w.q.q === text) return w.q;
                for (const t of c.tasks) for (const q of t.qs) if (q.q === text) return q;
              }
              return null; }""", info['text'])
            hint_ok = True
            box = scope + ' .q:not(.solved)'
            if info['type'] == 'choice':
                wrong = [i for i, o in enumerate(data['opts']) if not o.get('ok')]
                right = [i for i, o in enumerate(data['opts']) if o.get('ok')][0]
                if wrong:
                    await pg.click(f'{box} .q-opt >> nth={wrong[0]}')
                    fb = await pg.inner_text(f'{box} .q-fb')
                    hint_ok = data['opts'][wrong[0]]['why'][:12] in fb
                await pg.click(f'{box} .q-opt >> nth={right}')
            elif info['type'] == 'fill':
                await pg.fill(f'{box} .q-fill input', 'zzz'); await pg.click(f'{box} .q-fill .pill')
                fb = await pg.inner_text(f'{box} .q-fb'); hint_ok = '提示 1' in fb
                await pg.fill(f'{box} .q-fill input', data['answers'][0]); await pg.click(f'{box} .q-fill .pill')
            else:   # order / parsons
                want = data['lines'] if info['type'] == 'parsons' else [x['t'] for x in sorted(data['items'], key=lambda x: x['rank'])]
                if info['type'] == 'parsons' and data.get('extra'):
                    await pg.evaluate("""([sel, t]) => { [...document.querySelectorAll(sel + ' .q-pool .q-chip')].find(b => b.querySelector('.q-t').textContent === t).click(); }""", [box, data['extra'][0]['t']])
                    for t in want[:-1]:
                        await pg.evaluate("""([sel, t]) => { [...document.querySelectorAll(sel + ' .q-pool .q-chip')].find(b => b.querySelector('.q-t').textContent === t).click(); }""", [box, t])
                    await pg.click(f'{box} .q-check')
                    fb = await pg.inner_text(f'{box} .q-fb'); hint_ok = '不该放进来' in fb
                    await pg.evaluate("(sel) => { [...document.querySelectorAll(sel + ' .q-ans .q-chip:not(.lock)')].reverse().forEach(b => b.click()); }", box)
                for t in want:
                    placed = await pg.evaluate("(sel) => [...document.querySelectorAll(sel + ' .q-ans .q-chip .q-t')].map(x => x.textContent)", box)
                    if t in placed: continue
                    await pg.evaluate("""([sel, t]) => { [...document.querySelectorAll(sel + ' .q-pool .q-chip')].find(b => b.querySelector('.q-t').textContent === t).click(); }""", [box, t])
                await pg.click(f'{box} .q-check')
            await pg.wait_for_timeout(80)
            solved = await pg.evaluate("(t) => [...document.querySelectorAll('.q.solved .q-q')].some(x => x.textContent === t)", info['text'])
            return info['type'], hint_ok, solved
        for chap in ['gpio', 'usart', 'i2c']:
            await pg.goto(TOOL + '?v=think&t=' + chap + '&p=1'); await pg.wait_for_selector('.tk-card')
            ncards = await pg.evaluate("(id) => STM32_THINK.chapters.find(c => c.id === id).why.length", chap)
            why_ok = True
            for k in range(ncards):
                r = await solve_current('.tk-card')
                if r and not (r[1] and r[2]): why_ok = False
                await pg.click('.tk-cardnav .pill.solid')
                await pg.wait_for_timeout(120)
            check(chap.upper() + '：「为什么」%d 张卡片走完，题目提示对得上' % ncards, why_ok and 'p=2' in pg.url, pg.url)
            await pg.wait_for_selector('.tk-step')
            await pg.click('.tk-step >> nth=1 >> summary'); await pg.wait_for_timeout(150)
            hl = await pg.evaluate("document.querySelectorAll('.tk-code .seg.on').length")
            check(chap.upper() + '：点开骨架第 2 步，完整程序里对应的行高亮', hl >= 1, hl)
            await pg.click('.tk-endrow .tk-next'); await pg.wait_for_selector('.tk-task')
            for part in (3, 4):
                if part == 4:
                    await pg.goto(TOOL + '?v=think&t=' + chap + '&p=4'); await pg.wait_for_selector('.tk-task')
                stats = {'n': 0, 'hint': 0, 'solved': 0}
                for _ in range(80):
                    r = await solve_current('.tk-stage')
                    if r is None:
                        nxt = await pg.query_selector('.tk-stage .tk-go')
                        if nxt: await nxt.click(); await pg.wait_for_timeout(80); continue
                        break
                    stats['n'] += 1; stats['hint'] += 1 if r[1] else 0; stats['solved'] += 1 if r[2] else 0
                    go = await pg.query_selector('.tk-stage .tk-go')
                    if go: await go.click(); await pg.wait_for_timeout(80)
                finals = await pg.evaluate("document.querySelectorAll('.tk-final').length")
                tasks = await pg.evaluate("(a) => STM32_THINK.chapters.find(c => c.id === a[0]).tasks.filter(t => t.kind === a[1]).length", [chap, 'guided' if part == 3 else 'transfer'])
                check('%s：第 %d 段 %d 道题全部做完，错答都给出对应提示' % (chap.upper(), part, stats['n']), stats['n'] > 0 and stats['hint'] == stats['n'] and stats['solved'] == stats['n'] and finals == tasks, stats)
            await pg.goto(TOOL + '?v=think'); await pg.wait_for_selector('.tk-ch')
            st = await pg.evaluate("(id) => document.querySelector('.tk-ch[href*=\"t=' + id + '\"] .tk-ch-h span').textContent", chap)
            check(chap.upper() + '：进度保存，总览显示已完成', st == '已完成', st)
        await pg.goto(TOOL + '?v=topic&t=usart'); await pg.wait_for_selector('.topic')
        check('外设页有编程思维入口', await pg.evaluate("!!document.querySelector('.thinkin')"))
        await pg.context.close()
        pg = await page(b, 390, 844, mobile=True)
        overflow = []
        for qs in ['?v=think', '?v=think&t=gpio&p=1', '?v=think&t=usart&p=2', '?v=think&t=i2c&p=3']:
            await pg.goto(TOOL + qs); await pg.wait_for_timeout(700)
            if await pg.evaluate("document.documentElement.scrollWidth > innerWidth"): overflow.append(qs)
        check('手机：编程思维各页没有横向溢出', not overflow, overflow)
        await pg.context.close()
        await b.close()

    print('\n==== %d/%d 通过 ====' % (sum(1 for r in results if r[1]), len(results)))
    real = [e for e in errors if 'Failed to load resource' not in e]
    print('JS 报错：%d' % len(real)); [print('  ' + e[:300]) for e in real[:20]]
    print('资源 404：%d' % (len(errors) - len(real)))

asyncio.run(main())
