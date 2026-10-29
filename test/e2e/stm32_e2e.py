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
    # 小芯的「叛逆」是随机的（不肯睡、偏要走回去），测试里关掉，免得结果时好时坏
    await ctx.add_init_script("addEventListener('load', function () { if (window.LimingXin) LimingXin.obedient = true; })")
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

        # ---------- 1. 独立打开：首页 → 主题 → 寄存器 → 返回 ----------
        pg = await page(b)
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        top = await pg.evaluate("[...document.querySelectorAll('.mtags:not(.msub) .mtag')].map(b => b.textContent)")
        check('首页：模块收成分组，首屏只有 STM32 + 5 组', top == ['STM32', '基础', '存储', '通信', '传感', '显示'] and not await pg.is_visible('.msub'), top)
        check('首页：没有引脚筛选框', await pg.evaluate("!document.querySelector('.boardh .filter') && !document.querySelector('.pd-quick')"))
        await pg.click('.mgrp:has-text("存储")')
        sub = await pg.evaluate("[...document.querySelectorAll('.msub .mtag')].map(b => b.textContent)")
        check('点「存储」展开这组的模块', sub == ['M24C02', 'W25Q32', 'SD 卡', 'SRAM', 'NAND'], sub)
        await pg.hover('.msub .mtag:has-text("M24C02")')
        lit = await pg.evaluate("[...document.querySelectorAll('.boardh .chip .pin.lit')].map(g => g.dataset.pin).sort()")
        check('首页：指到 M24C02 标签，芯片上点亮 PB10 / PB11', lit == ['69', '70'], lit)
        await pg.click('.mgrp:has-text("存储")')
        check('再点「存储」收起', not await pg.is_visible('.msub'))
        side = await pg.evaluate("[...document.querySelectorAll('.nav-t')].map(a => a.textContent)")
        check('侧栏外设只写缩写', side == ['RCC', 'GPIO', 'EXTI', 'USART', 'I2C', 'TIM', 'DMA', 'ADC', 'SPI', 'FSMC'], side)
        await pg.click('.nav-t[data-t="usart"]'); await pg.wait_for_selector('.topic')
        check('进入 USART 主题页', 'v=topic&t=usart' in pg.url and await pg.inner_text('.th-code') == 'USART', pg.url)
        secs = await pg.evaluate("[...document.querySelectorAll('.snav-i')].map(a => a.textContent)")
        check('主题页分节齐全（课件已去掉）', secs == ['要点', '引脚', '寄存器', '代码', '图'], secs)
        vis = await pg.evaluate("[...document.querySelectorAll('.topic > .sec')].filter(x => !x.hidden).map(x => x.id)")
        check('外设页分页：一次只显示一页（默认「要点」）', vis == ['s-points'], vis)
        await pg.click('.snav-i:has-text("寄存器")'); await pg.wait_for_timeout(600)
        vis = await pg.evaluate("[...document.querySelectorAll('.topic > .sec')].filter(x => !x.hidden).map(x => x.id)")
        check('点「寄存器」标签：只剩寄存器这一页，地址记下分页', vis == ['s-regs'] and 'sec=regs' in pg.url, (vis, pg.url))
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
        check('再返回：回到首页', await pg.evaluate("!!document.querySelector('.boardh')"))

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
        grp = await pg.inner_text('.fgroup-h >> nth=0')
        order = await pg.evaluate("[...document.querySelectorAll('.fields .frow-h b')].slice(0, 4).map(b => b.textContent)")
        check('字段从低位到高位往下排', order == ['MODE0', 'CNF0', 'MODE1', 'CNF1'], order)
        check('GPIO 字段按引脚分组并标出板上用途', 'PA0' in grp and 'LED1' in grp, grp)

        # ---------- 3. 首页：芯片引脚 + 板载模块 ----------
        await pg.goto(TOOL + '?v=chip'); await pg.wait_for_selector('.boardh .chip')
        check('旧地址 v=chip 打开首页', 'v=' not in pg.url)
        await pg.goto(TOOL + '?q=USART1'); await pg.wait_for_selector('.boardh .chip'); await pg.wait_for_timeout(300)
        n = await pg.evaluate("document.querySelectorAll('.boardh .chip .pin.lit').length")
        check('旧链接 q=USART1 仍然点亮对应引脚', n >= 4, n)
        await pg.click('.boardh [data-pin="101"] .hit', force=True); await pg.wait_for_timeout(500)
        det = await pg.inner_text('.pdetail')
        check('点 101 脚：详情列出 USART1_TX，并指出接到 ST-Link 口的 TX', 'PA9' in det and 'USART1_TX' in det and 'ST-Link' in det, det[:80])
        await pg.click('.pdetail .mlink'); await pg.wait_for_selector('svg.mod')
        st = await pg.evaluate("[document.querySelector('.mod .mp.sel').dataset.mp, document.querySelector('.pdetail h2').textContent, document.querySelector('.msub .mtag.on').textContent, document.querySelector('.mgrp.on').textContent]")
        check('跳到 ST-Link 模块图，选中 TX 脚，「通信」组自动展开', st == ['p6', 'TX', 'ST-Link', '通信'] and 'm=stlink' in pg.url, st)
        await pg.click('.pdetail .mcubtn'); await pg.wait_for_selector('.boardh .chip .pin.sel')
        await pg.wait_for_timeout(500)
        sel = await pg.evaluate("document.querySelector('.boardh .chip .pin.sel').dataset.pin")
        check('点「PA9」回到芯片图并选中 101 脚', sel == '101' and 'pin=101' in pg.url, (sel, pg.url))
        await pg.click('.pdetail a.sig:has-text("USART1_TX")'); await pg.wait_for_selector('.topic')
        check('从信号跳到所属外设', 't=usart' in pg.url)
        await pg.goto(TOOL); await pg.wait_for_selector('.mtags')
        groups = await pg.evaluate("[...document.querySelectorAll('.mgrp')].map(b => b.textContent)")
        tags = ['STM32']; bad = []
        async def check_mod(tg):
            await pg.wait_for_selector('svg.mod')
            mp = await pg.evaluate("document.querySelectorAll('svg.mod .mp').length")
            await pg.click('svg.mod .mp >> nth=0', force=True); await pg.wait_for_timeout(200)
            ok = await pg.evaluate("(() => { const s = document.querySelector('svg.mod .mp.sel'); return !!s && !!document.querySelector('.pdetail .pd-mp.on') && !!document.querySelector('.pdetail .pd-doc p'); })()")
            if mp < 3 or not ok: bad.append((tg, mp, ok))
        for gname in groups:
            await pg.click('.mgrp:has-text("%s")' % gname); await pg.wait_for_timeout(150)
            if not await pg.is_visible('.msub'):      # 只有一个模块的组：直接打开
                tags.append(gname); await check_mod(gname); continue
            subs = await pg.evaluate("[...document.querySelectorAll('.msub .mtag')].map(b => b.textContent)")
            for tg in subs:
                tags.append(tg)
                await pg.click('.msub .mtag:has-text("%s")' % tg); await check_mod(tg)
        check('%d 个模块图都能打开、点脚选中、右边列出全部脚' % (len(tags) - 1), len(tags) >= 9 and not bad, bad or tags)
        await pg.goto(TOOL + '?m=eeprom&mp=p6'); await pg.wait_for_selector('.pd-conn')
        conn = await pg.inner_text('.pd-conn')
        docs = await pg.evaluate("[...document.querySelectorAll('.pdetail .pd-row h3')].map(h => h.textContent)")
        role = await pg.inner_text('.pdetail .pd-doc p')
        check('M24C02 第 6 脚 SCL 接 PB10（69 脚），下面只讲作用，不画主芯片小图', 'PB10' in conn and '69' in conn and docs == ['接到', '作用'] and '时钟' in role and not await pg.evaluate("!!document.querySelector('.pd-mini')"), [conn, docs, role[:30]])

        # ---------- 4. 原理图查看器；课件入口已去掉 ----------
        await pg.goto(TOOL + '?v=board'); await pg.wait_for_selector('.boardv')
        await pg.evaluate("STM.app.navigate({ sch: 'board-01' })"); await wait_img(pg)
        for _ in range(6):
            await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(60)
        await pg.wait_for_timeout(600)
        cnt = await pg.inner_text('.vw-n')
        check('原理图连续翻 6 页', cnt.startswith('7 /'), cnt)
        check('翻页地址跟上（只替换不新增记录）', 'sch=board-07' in pg.url, pg.url)
        await pg.go_back(); await pg.wait_for_timeout(400)
        check('返回关闭查看器，回到开发板页', not await pg.evaluate("!!document.querySelector('.viewer.on')") and await pg.evaluate("!!document.querySelector('.boardv')"))
        await pg.goto(TOOL + '?v=course&cw=v20-134'); await pg.wait_for_timeout(800)
        check('旧的课件地址打开首页', await pg.evaluate("!!document.querySelector('.boardh') && !document.querySelector('.viewer.on')") and not await pg.evaluate("[...document.querySelectorAll('.nav-i')].some(a => a.textContent.includes('课件'))"))

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
        await pg.keyboard.press('/'); await pg.wait_for_selector('.search.on')
        await pg.fill('.search-in', 'USART1_IRQHandler'); await pg.wait_for_timeout(250)
        first = await pg.evaluate("(document.querySelector('.search-it b') || {}).textContent")
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(600)
        check('搜索代码里的函数名：打开对应的寄存器文件', first == 'usart.c' and 'cf=usart.c' in pg.url and await pg.evaluate("document.querySelector('.ftab.on').textContent") == 'usart.c', [first, pg.url])
        await pg.goto(TOOL + '?m=eeprom'); await pg.wait_for_selector('.pd-links')
        await pg.click('.pd-links a.linkbtn:has-text("eeprom.c")'); await pg.wait_for_timeout(600)
        check('模块图：从 M24C02 直接打开 eeprom.c', 't=i2c' in pg.url and await pg.evaluate("[document.querySelector('.cseg-b.on').textContent, document.querySelector('.ftab.on').textContent].join()") == '寄存器,eeprom.c', pg.url)

        # ---------- 6. 深链 / 旧链接 ----------
        for qs, test, name in [
            ('?sch=board-05', "document.querySelector('.vw-n') && document.querySelector('.vw-n').textContent.startsWith('5 /')", '原理图第 5 页'),
            ('?tab=pins&q=PA9', "!location.search.includes('v=') && !!document.querySelector('.boardh .chip [data-pin=\"101\"].lit')", '旧链接 tab=pins'),
            ('?tab=regs&reg=GPIO_CRH&i=GPIOB', "!!document.querySelector('.sheet.on') && document.querySelector('.sh-expr').textContent === 'GPIOB->CRH'", '旧链接 tab=regs'),
            ('?tab=chip&page=board-05', "!!document.querySelector('.viewer.on') && location.search.includes('v=board')", '旧链接原理图'),
            ('?tab=code&snip=' + 'USART1 中断收发', "location.search.includes('t=usart')", '旧链接代码片段'),
        ]:
            await pg.goto(TOOL + qs); await pg.wait_for_timeout(1200)
            check('深链：' + name, await pg.evaluate(test), pg.url)

        # ---------- 7. 架构图缩略图都能加载 ----------
        await pg.goto(TOOL + '?v=topic&t=tim&sec=figs'); await pg.wait_for_selector('.fgrid')
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
        await f.click('.nav-t[data-t="i2c"]'); await f.wait_for_selector('.topic')
        await f.click('.snav-i:has-text("寄存器")'); await f.click('.rrow[data-reg="I2C_CCR"]'); await f.wait_for_selector('.sheet.on')
        await f.evaluate("STM.app.navigate({ sch: 'board-04' })"); await wait_img(f)
        depth = lambda: f.evaluate("({ v: !!document.querySelector('.viewer.on'), s: !!document.querySelector('.sheet.on'), t: !!document.querySelector('.topic') })")
        await pg.go_back(); await pg.wait_for_timeout(600); d1 = await depth()
        check('外壳返回 1：关查看器，寄存器还在', not d1['v'] and d1['s'], d1)
        await pg.go_back(); await pg.wait_for_timeout(600); d2 = await depth()
        check('外壳返回 2：关寄存器，回到 I2C 页', not d2['s'] and d2['t'], d2)
        await pg.go_back(); await pg.wait_for_timeout(600)
        check('外壳返回 3：回到首页', await f.evaluate("!!document.querySelector('.boardh')"))
        await pg.go_back(); await pg.wait_for_timeout(900)
        check('外壳返回 4：关闭工具', not await pg.evaluate("!!document.querySelector('#stage .panel.show')") and await pg.evaluate("location.pathname") == '/')
        # 连续翻页后返回
        await pg.goto(BASE + '/stm32?v=board&sch=board-01'); f = await tool_frame(pg); await wait_img(f)
        rs0 = (await pg.evaluate('__rs')) + (await f.evaluate('__rs'))
        await f.focus('.vw-x') if await f.evaluate("getComputedStyle(document.querySelector('.vw-x')).display !== 'none'") else await f.focus('.viewer .icon-btn[aria-label="下一页"]')
        for _ in range(14):
            await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(25)
        await pg.wait_for_timeout(900)
        rs = (await pg.evaluate('__rs')) + (await f.evaluate('__rs')) - rs0
        cnt = await f.inner_text('.vw-n')
        check('嵌入：按住方向键翻 14 页，页码正确', cnt.startswith('15 /'), cnt)
        check('嵌入：翻页期间地址写入被节流', rs <= 12, '%d 次' % rs)
        check('外壳地址跟到当前页', 'sch=board-15' in await pg.evaluate('location.search'), await pg.evaluate('location.search'))
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
        check('手机首页：没选引脚时不显示空的详情框', not await pg.is_visible('.pdetail'))
        await pg.goto(TOOL + '?pin=101'); await pg.wait_for_selector('.pd-h')
        order = await pg.evaluate("['.chipv-stage','.mtags','.pdetail'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().top))")
        check('手机首页：芯片图 → 模块标签 → 详情', order[0] < order[1] < order[2], order)
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        await pg.click('.bar-menu'); await pg.wait_for_timeout(350)
        dr = await pg.evaluate("(() => { const r = document.querySelector('#side').getBoundingClientRect(); return [document.documentElement.classList.contains('drawer'), Math.round(r.left), Math.round(r.width)]; })()")
        check('手机：点菜单从左边滑出侧栏', dr[0] and dr[1] == 0 and dr[2] > 200, dr)
        await pg.click('#side .nav-t[data-t="gpio"]'); await pg.wait_for_selector('.topic')
        check('手机：侧栏点 GPIO 进入外设页，侧栏收起', not await pg.evaluate("document.documentElement.classList.contains('drawer')") and 't=gpio' in pg.url)
        await pg.click('.bar-menu'); await pg.wait_for_timeout(300); await pg.click('.scrim', position={'x': 370, 'y': 400}); await pg.wait_for_timeout(300)
        check('手机：点遮罩收起侧栏', not await pg.evaluate("document.documentElement.classList.contains('drawer')"))
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL'); await pg.wait_for_selector('.sheet.on')
        box = await pg.evaluate("(() => { const r = document.querySelector('.sheet-p').getBoundingClientRect(); const v = document.querySelector('.sh-valrow .pill').getBoundingClientRect(); return [r.width, v.right]; })()")
        check('手机：寄存器面板全屏，复位按钮不被截断', box[0] >= 389 and box[1] <= 390, box)
        overflow = await pg.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
        check('手机：页面没有横向溢出', not overflow)
        await pg.goto(TOOL + '?v=board&sch=board-05'); await wait_img(pg)
        st = await pg.query_selector('.vw-stage'); bb = await st.bounding_box(); y = bb['y'] + bb['height'] / 2
        await pg.evaluate("""([x0, x1, y]) => {
          const s = document.querySelector('.vw-stage');
          const ev = (t, x) => s.dispatchEvent(new PointerEvent(t, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
          ev('pointerdown', x0); ev('pointermove', (x0 + x1) / 2); ev('pointermove', x1); ev('pointerup', x1);
        }""", [bb['x'] + 330, bb['x'] + 60, y])
        await pg.wait_for_timeout(600)
        check('手机：左滑翻到下一页', (await pg.inner_text('.vw-n')).startswith('6 /'))
        await pg.context.close()

        # ---------- 10. 编程思维总览、外设页入口、手机布局 ----------
        CHAPS = ['gpio', 'exti', 'usart', 'i2c', 'tim', 'dma', 'adc', 'spi']
        pg = await page(b)
        await pg.goto(TOOL + '?v=think'); await pg.wait_for_selector('.tk-ch')
        hrefs = await pg.evaluate("[...document.querySelectorAll('.tk-ch')].map(a => new URL(a.href).searchParams.get('t'))")
        check('设计原理总览：八章推导链', hrefs == CHAPS and await pg.evaluate("document.querySelectorAll('.tk-flow li').length") == 6 and await pg.evaluate("document.querySelector('h1').textContent") == '设计原理', hrefs)
        for chap in ['gpio', 'usart', 'tim', 'adc', 'spi']:
            await pg.goto(TOOL + '?v=topic&t=' + chap); await pg.wait_for_selector('.topic')
            ok = await pg.evaluate("(document.querySelector('.thinkin b') || {}).textContent === '设计原理'")
            if not ok: break
        check('五个外设页都有「设计原理」入口', ok)
        bad = []
        for tid in ['sys', 'fsmc']:
            await pg.goto(TOOL + '?v=topic&t=' + tid); await pg.wait_for_selector('.topic')
            if await pg.evaluate("!!document.querySelector('.thinkin')"): bad.append(tid)
        check('没有推导链的外设不显示「设计原理」入口', not bad, bad)
        await pg.context.close()
        # 外设页代码：寄存器（完整文件）/ HAL 库 / 代码推导
        pg = await page(b)
        await pg.goto(TOOL + '?v=topic&t=exti&sec=code'); await pg.wait_for_selector('.cd-files')
        st = await pg.evaluate("[[...document.querySelectorAll('.cseg-b')].map(b => b.textContent), document.querySelector('.cseg-b.on').textContent, !document.querySelector('.code-reg').hidden, document.querySelector('.code-hal').hidden, document.querySelector('.code-cd').hidden]")
        check('外设页代码：寄存器 / HAL 库 / 代码推导三页，默认寄存器', st == [['寄存器', 'HAL 库', '代码推导'], '寄存器', True, True, True], st)
        st = await pg.evaluate("[[...document.querySelectorAll('.code-reg .ftab')].map(b => b.textContent), document.querySelectorAll('.code-reg .rc-plan, .code-reg .rc-l.has, .code-reg button.rc-lb').length, document.querySelectorAll('.code-reg .rc-cm').length]")
        check('寄存器页：只放完整的 .h / .c / main.c，带注释，不写思路', st[0] == ['key.h', 'key.c', 'main.c'] and st[1] == 0 and st[2] >= 8, st)
        await pg.click('.code-reg .ftab:has-text("key.c")'); await pg.wait_for_timeout(100)
        vis = await pg.evaluate("[...document.querySelectorAll('.code-reg .rc-fn')].map(x => !x.hidden)")
        check('点文件名切换文件', vis == [False, True, False], vis)
        await pg.click('.cseg-b:has-text("HAL")'); await pg.wait_for_timeout(600)
        check('切到 HAL 库写法', await pg.evaluate("document.querySelector('.code-reg').hidden && !document.querySelector('.code-hal').hidden && document.querySelectorAll('.code-hal .snip').length > 0") and 'cv=hal' in pg.url, pg.url)
        await pg.click('.cseg-b:has-text("代码推导")'); await pg.wait_for_timeout(600)
        n = await pg.evaluate("[document.querySelector('.code-cd').hidden, document.querySelectorAll('.code-cd .cd-step').length, document.querySelectorAll('.code-cd .rc-l.has').length]")
        check('切到代码推导：分步推出文件，能点开理由', not n[0] and n[1] >= 8 and n[2] >= 10 and 'cv=cd' in pg.url, [n, pg.url])
        await pg.click('.code-cd .rc-l.has .rc-lb >> nth=2'); await pg.wait_for_timeout(100)
        why = await pg.inner_text('.code-cd .rc-l.open .rc-why')
        check('代码推导里点一行展开原因', '原因' in why, why[:60])
        # 自己写：挡住代码行，写对了才露出来，进度记在本机
        await pg.goto(TOOL + '?v=topic&t=gpio&sec=code&cv=cd'); await pg.wait_for_selector('.cd-modes')
        await pg.click('.cd-mb:has-text("自己写")'); await pg.wait_for_timeout(200)
        n0 = await pg.evaluate("[document.querySelectorAll('.cd-inp').length, document.querySelector('.cd-prog').textContent]")
        inp = pg.locator('.cd-inp').first
        await inp.fill('#define LED1 2'); await inp.press('Enter'); await pg.wait_for_timeout(150)
        wrong = await pg.evaluate("document.querySelectorAll('.cd-bad').length == 1 && document.querySelector('.cd-bad .cd-msg').textContent.length > 0")
        await inp.fill('#define LED1 1'); await inp.press('Enter'); await pg.wait_for_timeout(150)
        n1 = await pg.evaluate("[document.querySelectorAll('.cd-inp').length, document.querySelectorAll('.cd-ok').length, document.querySelector('.cd-prog').textContent, document.activeElement.classList.contains('cd-inp')]")
        await pg.click('.cd-blank.act button:has-text("答案")'); await pg.wait_for_timeout(100)
        await pg.reload(); await pg.wait_for_selector('.cd-modes'); await pg.wait_for_timeout(300)
        n2 = await pg.evaluate("[document.querySelector('.cd-mb.on').textContent, document.querySelectorAll('.cd-ok').length, document.querySelectorAll('.cd-shown').length, document.querySelector('.cd-prog').textContent]")
        check('自己写：写错提示、写对露出代码并跳到下一行、刷新后进度还在', n0[0] >= 20 and n0[1] == '0 / %d' % n0[0] and wrong and n1[:3] == [n0[0] - 1, 1, '1 / %d' % n0[0]] and n1[3] and n2 == ['自己写', 1, 1, '2 / %d' % n0[0]], [n0, wrong, n1, n2])
        await pg.click('.cd-reset'); await pg.wait_for_timeout(100)
        await pg.click('.cd-mb:has-text("看推导")'); await pg.wait_for_timeout(100)
        check('重来清空进度；切回看推导没有输入框', await pg.evaluate("document.querySelectorAll('.cd-inp').length == 0 && !(JSON.parse(localStorage.getItem('lm.stm32.cdself') || '{}').gpio)"))
        await pg.evaluate("localStorage.removeItem('lm.stm32.codestyle')")
        bad = []
        for chap in CHAPS + ['sys', 'fsmc']:
            await pg.goto(TOOL + '?v=topic&t=' + chap + '&sec=code&cv=cd'); await pg.wait_for_selector('.code-cd .cd-step')
            n = await pg.evaluate("[document.querySelectorAll('.code-cd .cd-step').length, document.querySelectorAll('.code-reg .ftab').length, document.querySelectorAll('.code-cd .rc-l.has').length, document.querySelector('.code-cd').hidden]")
            if n[0] < 7 or n[1] < 3 or n[2] < 6 or n[3]: bad.append((chap, n))
        check('十个外设的代码页都有完整文件和代码推导', not bad, bad)
        bad = []
        for t, want, cx, files in [('i2c', ['软件 I2C', '硬件 I2C'], 'i2chw', 'i2c2.c'), ('tim', ['节拍 + PWM', '输入捕获', 'N 个脉冲'], 'timpulse', 'pulse.c'), ('adc', ['单通道', '多通道 + DMA'], 'adcdma', 'adc_dma.c')]:
            await pg.goto(TOOL + '?v=topic&t=' + t + '&sec=code&cv=reg'); await pg.wait_for_selector('.cd-vars')
            got = await pg.evaluate("[...document.querySelectorAll('.cd-var')].map(b => b.textContent)")
            await pg.click('.cd-var:has-text("%s")' % want[-1]); await pg.wait_for_timeout(500)
            ft = await pg.evaluate("[...document.querySelectorAll('.ftab')].map(b => b.textContent)")
            if got != want or ('cx=' + (cx if t != 'tim' else 'timpulse')) not in pg.url or files not in ft: bad.append((t, got, pg.url, ft))
        check('I2C / TIM / ADC：课件的另外几个案例可以切换（硬件 I2C、输入捕获、N 个脉冲、多通道 + DMA）', not bad, bad)
        cd = await pg.evaluate("STM.codederive.data.CD.gpio.files.map(f => f.name)")
        check('GPIO：led.h / led.c / main.c', cd == ['led.h', 'led.c', 'main.c'], cd)
        bad = []
        for old, want in [('?v=think&t=gpio&s=code', 'v=topic&t=gpio&sec=code&cv=cd'), ('?v=think&t=fsmc', 'v=topic&t=fsmc&sec=code&cv=cd'), ('?v=think&t=sys', 'v=topic&t=sys&sec=code&cv=cd')]:
            await pg.goto(TOOL + old); await pg.wait_for_selector('.topic'); await pg.wait_for_timeout(300)
            if not pg.url.endswith(want): bad.append((old, pg.url))
        check('旧的代码推导链接转到外设页的代码推导', not bad, bad)
        txt = await pg.evaluate("STM.codederive.fileText(STM.codederive.data.CD.gpio.files[0])")
        check('led.h 带头文件保护和函数声明', '#ifndef __LED_H' in txt and 'void LED_On(uint8_t n);' in txt and '#endif' in txt, txt[:60])
        await pg.goto(TOOL + '?v=think&t=gpio'); await pg.wait_for_selector('.dv-mode.enter')
        check('章节首页没有代码推导入口', not await pg.evaluate("!!document.querySelector('.dv-codein')"))
        await pg.click('.dv-modeb >> nth=1'); await pg.wait_for_selector('.dv-step')
        check('章节首页：点「自主推导」直接进推导', 's=s' in pg.url and await pg.evaluate("JSON.parse(localStorage.getItem('lm.stm32.derive')).mode") == 'self', pg.url)
        await pg.evaluate("(() => { const o = JSON.parse(localStorage.getItem('lm.stm32.derive')); o.mode = 'full'; localStorage.setItem('lm.stm32.derive', JSON.stringify(o)); })()")
        side = await pg.evaluate("[...document.querySelectorAll('.nav-i')].map(a => a.textContent)")
        check('侧栏只有首页、开发板', side == ['首页', '开发板'], side)
        txt = await pg.evaluate("STM.codederive.fileText(STM.codederive.data.CD.gpio.files[1])")
        check('复制出来的代码带注释', '// ' in txt and 'GPIO' in txt, txt[:80])
        await pg.context.close()
        pg = await page(b, 390, 844, mobile=True)
        overflow = []
        pages = ['?v=topic&t=' + c + '&sec=code&cv=' + k for c in CHAPS + ['sys', 'fsmc'] for k in ['reg', 'cd']] + ['?v=topic&t=fsmc', '', '?m=lcd', '?m=beep&mp=g', '?m=led', '?m=eeprom&mp=p6', '?v=think'] + ['?v=think&t=' + c for c in CHAPS] + ['?v=think&t=i2c&s=s3', '?v=think&t=i2c&s=s6', '?v=think&t=i2c&s=s12', '?v=think&t=i2c&s=s14', '?v=think&t=i2c&s=s19', '?v=think&t=i2c&s=s21',
                 '?v=think&t=gpio&s=s13', '?v=think&t=usart&s=s11', '?v=think&t=tim&s=s11', '?v=think&t=adc&s=s11', '?v=think&t=spi&s=s11', '?v=think&t=i2c&s=review']
        for qs in pages:
            await pg.goto(TOOL + qs); await pg.wait_for_timeout(600)
            if await pg.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"): overflow.append(qs)
        check('手机：%d 个页面没有横向溢出' % len(pages), not overflow, overflow)
        clipped = []
        for qs in ['?v=topic&t=' + c + '&sec=code&cv=' + k for c in CHAPS + ['sys', 'fsmc'] for k in ['reg', 'hal', 'cd']]:
            await pg.goto(TOOL + qs); await pg.wait_for_timeout(600)
            n = await pg.evaluate("Array.from(document.querySelectorAll('.rc-c, .rc-cm, .rc-sig')).filter(c => c.getClientRects().length && (c.scrollWidth > c.clientWidth + 1 || c.closest('.rc-code').scrollWidth > c.closest('.rc-code').clientWidth + 1)).length")
            if n: clipped.append((qs, n))
        check('手机：代码长行折行，没有被截掉的行', not clipped, clipped)
        await pg.context.close()

        # ---------- 11. 编程思维 · I2C 推导链：自主推导模式把 22 环的每一道题都答一遍 ----------
        pg = await page(b)
        await pg.goto(TOOL + '?v=think&t=i2c'); await pg.wait_for_selector('.dv-map')
        check('I2C 推导章首页：推导链 22 环、7 条主干结论、两种学法', await pg.evaluate("document.querySelectorAll('.dv-node').length") == 22 and await pg.evaluate("document.querySelectorAll('.dv-factl li').length") == 7 and await pg.evaluate("document.querySelectorAll('.dv-modeb').length") == 2)
        await pg.click('.dv-modeb >> nth=1'); await pg.wait_for_selector('.dv-step')
        await pg.goto(TOOL + '?v=think&t=i2c'); await pg.wait_for_selector('.dv-map')
        check('切到自主推导：结论在推出来之前隐藏', await pg.evaluate("document.querySelectorAll('.dv-node-g').length") == 0 and await pg.evaluate("document.querySelectorAll('.dv-factl li.locked').length") == 7)
        ANSWER = """async ([chid, id]) => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const ch = STM32_DERIVE[chid], C = STM32DeriveCore, a = C.allAsks(ch)[id];
          const box = document.querySelector('.dv-ask[data-ask="' + id + '"]');
          const fbText = () => (box.querySelector('.dv-fb') || {}).textContent || '';
          const r = { id, type: a.type, wrongOk: true, solved: false };
          if (a.type === 'choice') {
            const btns = [...box.querySelectorAll('.dv-opt')];
            const find = (t) => btns.find(b => b.textContent.replace(/\\s/g, '') === t.replace(/\\*\\*|`|\\[\\[s\\d+\\]\\]|\\{F\\d\\}/g, (m) => m.startsWith('[[') ? '问题' + (C.stepById(ch)[m.slice(2, -2)]._i + 1) : m.startsWith('{') ? m.slice(1, -1) : '').replace(/\\s/g, ''));
            const wrong = a.opts.find(o => !o.ok), right = a.opts.find(o => o.ok);
            if (wrong) { const wb = find(wrong.t); wb.click(); await sleep(30); const t = fbText(); r.wrongOk = t.includes('你默认了') && t.includes(wrong.assume) && t.includes('反例') && !!box.querySelector('.fb-back'); }
            find(right.t).click();
          } else if (a.type === 'fill') {
            const inp = box.querySelector('.dv-fill input'), go = box.querySelector('.dv-fill .pill');
            inp.value = 'zzz'; go.click(); await sleep(30); r.wrongOk = fbText().includes('提示');
            inp.value = a.answers[0]; go.click();
          } else if (a.type === 'explain') {
            const ta = box.querySelector('textarea'); ta.value = '因为大家都松手了，上拉电阻把线拉到 VCC'; box.querySelector('.dv-row .pill').click(); await sleep(30);
            r.wrongOk = box.querySelectorAll('.dv-pt input:checked').length >= 1 && !!box.querySelector('.dv-model');
            [...box.querySelectorAll('.dv-explain .pill')].pop().click();
          } else if (a.type === 'order') {
            const it = C.orderItems(ch, a), want = it.texts;
            const norm = (s) => s.replace(/\\s+/g, '');
            const pick = (t) => { const c = [...box.querySelectorAll('.dv-opool .dv-chip')].find(b => norm(b.textContent) === norm(t)); c.click(); };
            [...want].reverse().forEach(pick); box.querySelector('.dv-row .pill').click(); await sleep(30);
            r.wrongOk = fbText().includes('先后不对') && box.querySelectorAll('.dv-chip.bad').length === 2;
            if (a.fn) r.wrongOk = r.wrongOk && !!box.querySelector('.dv-osim .dv-simres');
            [...box.querySelectorAll('.dv-oans .dv-chip')].reverse().forEach(b => b.click());
            want.forEach(pick); box.querySelector('.dv-row .pill').click();
          }
          await sleep(40);
          r.solved = box.classList.contains('solved');
          return r;
        }"""
        async def walk(chid, n):
            total = {'asks': 0, 'wrongOk': 0, 'solved': 0, 'gated': 0}
            bad = []
            for k in range(1, n + 1):
                await pg.goto(TOOL + '?v=think&t=%s&s=s%d' % (chid, k)); await pg.wait_for_selector('.dv-step')
                for _ in range(10):
                    cur = await pg.evaluate("(() => { const b = [...document.querySelectorAll('.dv-ask:not(.soft):not(.solved)')]; return b.length ? b[0].dataset.ask : null; })()")
                    if not cur: break
                    gated = await pg.evaluate("!document.querySelector('.dv-gist')")
                    r = await pg.evaluate(ANSWER, [chid, cur])
                    total['asks'] += 1; total['wrongOk'] += r['wrongOk']; total['solved'] += r['solved']; total['gated'] += gated
                    if not (r['wrongOk'] and r['solved']): bad.append(r)
                    cont = await pg.query_selector('.dv-cont')
                    if cont: await cont.click(); await pg.wait_for_timeout(60)
                if not await pg.evaluate("!!document.querySelector('.dv-gist')"): bad.append('s%d 没走到结论' % k)
            return total, bad
        total, bad = await walk('i2c', 22)
        check('I2C 自主推导：%d 道题逐一停下（答完才继续），错答都指出「默认了什么 + 反例 + 回看哪一环」，最后都答对' % total['asks'], total['asks'] >= 30 and not bad and total['gated'] == total['asks'], bad[:3] or total)
        for chid in ['gpio', 'usart', 'tim', 'adc', 'spi']:
            n = await pg.evaluate("(id) => STM32_DERIVE[id].steps.length", chid)
            total, bad = await walk(chid, n)
            check('%s 自主推导：%d 环 %d 道题逐一停下、错答有针对的反馈、全部答对' % (chid.upper(), n, total['asks']), total['asks'] >= 12 and not bad and total['gated'] == total['asks'], bad[:3] or total)
        await pg.goto(TOOL + '?v=think&t=i2c'); await pg.wait_for_selector('.dv-map')
        check('22 环都标记为推完，主干结论全部解锁', await pg.evaluate("document.querySelectorAll('.dv-node.done').length") == 22 and await pg.evaluate("document.querySelectorAll('.dv-factl li.locked').length") == 0)
        check('首页出现「常卡的地方」入口', await pg.evaluate("!!document.querySelector('.dv-revin')"))
        await pg.click('.dv-revin'); await pg.wait_for_selector('.dv-rv')
        nrv = await pg.evaluate("document.querySelectorAll('.dv-rv').length"); roots = await pg.evaluate("document.querySelectorAll('.dv-roots li').length")
        check('常卡的地方：按推理环节归类，列出最常出岔子的环节和上次的错误想法', nrv >= 10 and roots >= 1 and await pg.evaluate("!!document.querySelector('.dv-rv-w li')"), (nrv, roots))
        rid = await pg.evaluate("document.querySelector('.dv-rv .dv-ask-choice').dataset.ask")
        right = await pg.evaluate("(id) => { const a = STM32DeriveCore.allAsks(STM32_DERIVE.i2c)[id.split('~')[0]]; return a.opts.findIndex(o => o.ok); }", rid)
        await pg.evaluate("""([id, k]) => { const box = document.querySelector('.dv-ask[data-ask="' + id + '"]'); const a = STM32DeriveCore.allAsks(STM32_DERIVE.i2c)[id.split('~')[0]];
          const norm = s => s.replace(/\\*\\*|`/g, '').replace(/\\s/g, ''); [...box.querySelectorAll('.dv-opt')].find(b => norm(b.textContent) === norm(a.opts[k].t)).click(); }""", [rid, right])
        await pg.wait_for_timeout(100)
        st = await pg.evaluate("(id) => { const s = JSON.parse(localStorage.getItem('lm.stm32.derive')).ch.i2c.stuck; return [s.streak[id], s.due[id] > Date.now()]; }", rid.split('~')[0])
        check('复习答对一次：间隔拉长到明天', st[0] == 1 and st[1], st)

        # 完整推导模式：交换代码行、模拟器、小部件
        await pg.goto(TOOL + '?v=think&t=i2c'); await pg.click('.dv-modeb >> nth=0')
        await pg.goto(TOOL + '?v=think&t=i2c&s=s19'); await pg.wait_for_selector('.dv-fn')
        check('完整推导：整段推理一次展开，题目可选（虚线框）', await pg.evaluate("document.querySelectorAll('.dv-ask.soft').length >= 2 && !!document.querySelector('.dv-gist')"))
        fn = '.dv-fn >> nth=1'   # i2c_stop
        await pg.click('.dv-fn >> nth=1 >> .dv-line.has .dv-lb >> nth=0')
        check('点一行看理由和出处', await pg.evaluate("(() => { const l = document.querySelectorAll('.dv-fn')[1].querySelector('.dv-line.open .dv-lwhy'); return !!l && !l.hidden && !!l.querySelector('.dv-fc, .dv-sl'); })()"))
        await pg.click(fn + ' >> .dv-fn-tools .pill')
        await pg.evaluate("""(() => { const f = document.querySelectorAll('.dv-fn')[1]; const ls = [...f.querySelectorAll('.dv-line.has .dv-lb')].filter(b => !b.closest('.pre'));
          const t = (s) => ls.find(b => b.textContent.replace(/\\s|ⓘ/g, '') === s); t('SDA_L();').click(); t('SCL_H();').click(); })()""")
        await pg.wait_for_selector('.dv-swap .dv-wave')
        sw = await pg.inner_text('.dv-fn >> nth=1 >> .dv-swap')
        check('交换停止函数前两步（课件写法）：说出原因并在模拟里看到「重复起始 + 空报文」', '不能换' in sw and '空报文' in sw, sw[:120])
        await pg.goto(TOOL + '?v=think&t=i2c&s=s21'); await pg.wait_for_selector('.dv-simctl')
        p0 = await pg.inner_text('.dv-simctl ~ div .dv-simfacts')
        await pg.click('.dv-simctl .dv-sw input'); await pg.wait_for_timeout(100)
        p1 = await pg.inner_text('.dv-simctl ~ div .dv-simfacts')
        check('写一个字节的模拟：拔掉 EEPROM 后返回 1', '返回 0' in p0 and '0x5A' in p0 and '返回 1' in p1, (p0, p1))
        await pg.goto(TOOL + '?v=think&t=i2c&s=s3'); await pg.wait_for_selector('.dv-bus')
        v0 = await pg.inner_text('.dv-busv-t'); await pg.click('.dv-dev >> nth=0'); v1 = await pg.inner_text('.dv-busv-t')
        check('共线实验：推挽一高一低报短路，改成同电平就没有冲突', '短路' in v0 and '没有冲突' in v1, (v0[:30], v1[:30]))
        await pg.goto(TOOL + '?v=think&t=i2c&s=s6'); await pg.wait_for_selector('.dv-rc')
        await pg.evaluate("(() => { const r = document.querySelector('.dv-rcc input'); r.value = 13; r.dispatchEvent(new Event('input')); })()")
        rc = await pg.inner_text('.dv-rcr')
        check('上拉实验：100 kΩ 时上升时间超标', '超过标准模式' in rc, rc[:80])
        await pg.goto(TOOL + '?v=think&t=i2c&s=s12'); await pg.wait_for_selector('.dv-addr')
        await pg.click('.dv-bit.epin >> nth=2'); ad = await pg.inner_text('.dv-addro')
        check('地址字节：E0 接 VCC 变成 0xA2，板上 EEPROM 不应答', '0xA2' in ad and '对不上' in ad, ad[:60])
        await pg.goto(TOOL + '?v=think&t=i2c&s=s14'); await pg.wait_for_selector('.dv-page')
        check('页回卷：从 0x0E 写 4 个，后两个落回 0x00、0x01', await pg.evaluate("[...document.querySelectorAll('.dv-gc.wrap')].length") == 2)
        # 通用单片机模拟器的小部件
        await pg.goto(TOOL + '?v=think&t=usart&s=s11'); await pg.wait_for_selector('.dv-term')
        check('USART：模拟器里电脑收到 hello', await pg.evaluate("[...document.querySelectorAll('.dv-term')].some(t => t.textContent.includes('hello'))"))
        await pg.goto(TOOL + '?v=think&t=gpio&s=s12'); await pg.wait_for_selector('.dv-fn')
        await pg.click('.dv-fn >> nth=0 >> .dv-fn-tools .pill')
        await pg.evaluate("""(() => { const f = document.querySelectorAll('.dv-fn')[0]; const ls = [...f.querySelectorAll('.dv-line.has .dv-lb')].filter(b => !b.closest('.pre'));
          ls[0].click(); ls[2].click(); })()""")
        await pg.wait_for_selector('.dv-swap .dv-simres')
        sw = await pg.inner_text('.dv-fn >> nth=0 >> .dv-swap')
        check('GPIO：交换「开时钟」和「清 CRL」→ 说出原因，模拟里 LED1 不再亮', '不能换' in sw and '时钟' in sw, sw[:160])
        await pg.goto(TOOL + '?v=think&t=tim&s=s10'); await pg.wait_for_selector('.dv-lamp')
        check('定时器：模拟结果里有 LED 灯和波形', await pg.evaluate("!!document.querySelector('.dv-sim .dv-lamp') && !!document.querySelector('.dv-sim .dv-wave, .dv-sim svg')"))
        await pg.goto(TOOL + '?v=think&t=adc&s=s11'); await pg.wait_for_selector('.dv-simctl input[type=range]')
        await pg.evaluate("(() => { const r = document.querySelector('.dv-simctl input[type=range]'); r.value = 100; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()")
        await pg.wait_for_timeout(200)
        adc = await pg.evaluate("document.querySelector('.dv-simctl').closest('.dv-sim').querySelector('.dv-term').textContent")
        import re as _re
        m = _re.search(r'ADC =\s*(\d+)', adc)
        check('ADC：电位器拧到 1.00 V，读数约 1241', bool(m) and abs(int(m.group(1)) - 1241) <= 12, adc[:80])
        await pg.goto(TOOL + '?v=think&t=spi&s=s11'); await pg.wait_for_selector('.dv-term')
        check('SPI：模拟器读出 W25Q32 的 ID EF4016', await pg.evaluate("[...document.querySelectorAll('.dv-term')].some(t => t.textContent.includes('EF4016'))"))
        await pg.goto(TOOL + '?v=topic&t=i2c'); await pg.wait_for_selector('.thinkin')
        th = await pg.inner_text('.thinkin')
        check('I2C 资料页的入口显示推导进度', '22 / 22' in th or '复习' in th, th)
        await pg.goto(TOOL + '?v=think&t=i2c&s=s99'); await pg.wait_for_selector('.dv-map')
        check('不存在的环节回到章节首页', 's=' not in pg.url.split('?')[-1] or 's=s99' not in pg.url)
        await pg.context.close()
        for theme in ['dark']:
            pg = await page(b, theme=theme)
            await pg.goto(TOOL + '?v=think&t=i2c&s=s10'); await pg.wait_for_selector('.dv-wave')
            await pg.screenshot(path='/tmp/stm32-derive-%s.png' % theme)
            await pg.context.close()

        # ---------- 12. 工具箱首页：分类、继续上次、小芯 ----------
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(BASE + '/')
        await pg.evaluate("localStorage.setItem('lm.shell.recent', JSON.stringify(['stm32'])); localStorage.setItem('lm.shell.stm32', 'v=topic&t=i2c&sec=code&cv=cd')")
        await pg.reload(); await pg.wait_for_timeout(1500)
        cats = await pg.evaluate("[...document.querySelectorAll('.cat-h')].map(h => h.textContent)")
        check('首页按分类排：学习 / 工具', cats == ['学习', '工具'], cats)
        hero = await pg.evaluate("(() => { const c = document.querySelector('.card.hero'); return c && [c.dataset.id, c.querySelector('.go').textContent]; })()")
        check('最近用过的 STM32 放大，写着上次看到哪', hero == ['stm32', 'I2C 代码推导'], hero)
        ids = await pg.evaluate("[...document.querySelectorAll('.card[data-id]')].map(c => c.dataset.id)")
        check('首页没有互传和协作中心', 'transfer' not in ids and 'hub' not in ids, ids)
        check('小芯落在标题栏里', await pg.evaluate("LimingXin.mode") == 'idle')
        await pg.click('#searchBtn'); await pg.fill('#q', 'zzzz'); await pg.wait_for_timeout(100)
        check('搜不到时小芯难过', await pg.evaluate("LimingXin.mood") == 'sad' and await pg.is_visible('#empty'))
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        check('关掉搜索，小芯恢复', await pg.evaluate("LimingXin.mood") != 'sad')
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        c = await pg.evaluate("(() => { const r = document.querySelector('.card[data-id=map]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        cdp = await pg.context.new_cdp_session(pg)
        async def touch(kind, x=0, y=0):
            await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y}]})
        await touch('touchStart', *r)
        for i in range(1, 13):
            await touch('touchMove', r[0] + (c[0] - r[0]) * i / 12, r[1] + (c[1] - r[1]) * i / 12); await pg.wait_for_timeout(30)
        over = await pg.evaluate("[LimingXin.mode, (document.querySelector('.card.xin-over') || {dataset: {}}).dataset.id, scrollY]")
        check('手机：按住小芯拖到世界地图卡上，卡片亮起、页面不滚动', over == ['drag', 'map', 0], over)
        await touch('touchEnd'); await pg.wait_for_timeout(1200)
        check('松手打开世界地图', await pg.evaluate("location.pathname") == '/map' and await pg.evaluate("!!document.querySelector('#stage .panel.show')"))
        await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1400)
        check('回到首页，小芯掉回标题栏', await pg.evaluate("[location.pathname, LimingXin.mode]") == ['/', 'idle'])
        kinds = await pg.evaluate("LimingXin.plats().map(p => p.kind)")
        check('首页能站的地方：标题栏 + 每张卡片的上沿和里面', kinds.count('ground') == 1 and kinds.count('top') == 2 and kinds.count('in') == 2, kinds)
        i_in = kinds.index('in')
        await pg.evaluate("LimingXin.hop(%d)" % i_in); await pg.wait_for_timeout(1500)
        check('小芯能跳进卡片里，落地后站在里面', await pg.evaluate("[LimingXin.mode, LimingXin.plat && LimingXin.plat.kind]") == ['idle', 'in'])
        await pg.evaluate("LimingXin.hop(0)"); await pg.wait_for_timeout(1500)
        check('再跳回标题栏', await pg.evaluate("[LimingXin.mode, LimingXin.plat && LimingXin.plat.kind]") == ['idle', 'ground'])

        # 正常点开 STM32：学习台里没有小芯；关掉以后首页的小芯还在原地
        before = await pg.evaluate("LimingXin.el.style.transform")
        await pg.click('.card[data-id=stm32]', position={'x': 20, 'y': 20}); f = await tool_frame(pg); await pg.wait_for_timeout(1200)
        check('正常打开学习台：里面没有小芯', await f.evaluate("LimingXin.mode") == 'away')
        await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1500)
        while await pg.evaluate("!!document.querySelector('.panel.show .back')"):
            await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1500)
        check('关掉学习台：首页小芯还在原来的地方', await pg.evaluate("[LimingXin.mode, LimingXin.el.style.transform]") == ['idle', before], before)

        # 把小芯拖到 STM32 卡片上扔进去：学习台里出现小芯；关掉以后它跳回首页
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        c = await pg.evaluate("(() => { const r = document.querySelector('.card[data-id=stm32]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        await touch('touchStart', *r)
        for i in range(1, 13):
            await touch('touchMove', r[0] + (c[0] - r[0]) * i / 12, r[1] + (c[1] - r[1]) * i / 12); await pg.wait_for_timeout(30)
        await touch('touchEnd'); f = await tool_frame(pg); await pg.wait_for_timeout(1200)
        for _ in range(40):
            if await f.evaluate("LimingXin.mode") not in ('away', 'rope', 'fly'): break
            await pg.wait_for_timeout(100)
        inside = await f.evaluate("[LimingXin.mode, !!LimingXin.plat]")
        check('扔进 STM32 卡片：小芯出现在学习台里', inside[1] and inside[0] in ('idle', 'walk', 'play'), inside)
        await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1500)
        while await pg.evaluate("!!document.querySelector('.panel.show .back')"):
            await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(1500)
        out = await pg.evaluate("[LimingXin.mode, LimingXin.plat && LimingXin.plat.kind, sessionStorage.getItem('lm.xin.in')]")
        check('关掉学习台：小芯跳回首页标题栏，学习台里的歇着', out == ['idle', 'ground', None] and await f.evaluate("LimingXin.mode") == 'away', out)
        check('小芯脚下没有影子横线', await pg.evaluate("!document.querySelector('.xin-sh')"))
        # 背包：长按打开，喂饼干、戴耳机、收起来再用 ✻ 叫回来
        await pg.wait_for_timeout(1500)
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        await touch('touchStart', *r); await pg.wait_for_timeout(700); await touch('touchEnd'); await pg.wait_for_timeout(200)
        items = await pg.evaluate("[...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent)")
        check('长按小芯打开小背包', items[:5] == ['饼干', '电池', '小球', 'LED', '耳机'] and '收起来' in items, items)
        await pg.click('.xin-bag .xin-it:has-text("饼干")'); await pg.wait_for_timeout(400)
        for _ in range(20):   # 正在半空时会等落地再吃
            if await pg.evaluate("LimingXin.mode") == 'play': break
            await pg.wait_for_timeout(100)
        check('从背包喂饼干：小芯抱着饼干吃', await pg.evaluate("LimingXin.mode") == 'play' and not await pg.evaluate("!!document.querySelector('.xin-bag')"))
        await pg.wait_for_timeout(4500)
        await pg.evaluate("LimingXin.bag()"); await pg.click('.xin-bag .xin-it:has-text("耳机")'); await pg.wait_for_timeout(300)
        check('戴上耳机：头上有耳机', await pg.evaluate("!!LimingXin.el.querySelector('rect.c-hp')"))
        await pg.evaluate("LimingXin.bag()")
        check('戴着耳机时背包里是「摘耳机」', await pg.evaluate("[...document.querySelectorAll('.xin-bag .xin-it span')].some(s => s.textContent === '摘耳机')"))
        await pg.click('.xin-bag .xin-it:has-text("收起来")'); await pg.wait_for_timeout(300)
        check('收起来：小芯不见了，✻ 可以点', await pg.evaluate("[LimingXin.mode, document.querySelector('.hd .spark').classList.contains('xin-call')]") == ['away', True])
        await pg.click('.hd .spark'); await pg.wait_for_timeout(2200)
        check('点 ✻：小芯顺着线降下来', await pg.evaluate("[LimingXin.mode, document.querySelector('.hd .spark').classList.contains('xin-call')]") == ['idle', False])
        # 扔到最下面空白处：下面没有落脚点，射线吊住，再爬上去
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        await touch('touchStart', *r)
        for i in range(1, 13):
            await touch('touchMove', r[0], r[1] + (760 - r[1]) * i / 12); await pg.wait_for_timeout(30)
        await touch('touchEnd'); await pg.wait_for_timeout(500)
        hang = await pg.evaluate("[LimingXin.mode, LimingXin.mood, getComputedStyle(document.querySelector('.xin-thread')).display]")
        check('扔到下面没有落脚点：射一根线吊住，吓得发抖', hang == ['hang', 'scared', 'block'], hang)
        await pg.wait_for_timeout(5000)
        check('顺着线爬上去，再跳回能站的地方', await pg.evaluate("[LimingXin.mode, !!LimingXin.plat]") == ['idle', True])
        await pg.context.close()

        # 电脑：右键打开背包；让它睡以后鼠标在旁边晃、点别处都不吵醒它，点它才醒；玩灯时表情不跟着灯来回变
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(2500)
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        await pg.mouse.click(r[0], r[1], button='right'); await pg.wait_for_timeout(200)
        check('电脑：右键小芯打开小背包', await pg.evaluate("!!document.querySelector('.xin-bag')"))
        await pg.click('.xin-bag .xin-it:has-text("睡觉")'); await pg.wait_for_timeout(200)
        for i in range(15):
            await pg.mouse.move(r[0] + 120 * ((i % 5) - 2), r[1] + 50 * ((i % 3) - 1)); await pg.wait_for_timeout(50)
        await pg.mouse.click(1100, 700); await pg.wait_for_timeout(300)
        check('电脑：睡着以后鼠标在旁边晃、点别处都不会吵醒它', await pg.evaluate("LimingXin.mode") == 'sleep')
        await pg.mouse.click(r[0], r[1]); await pg.wait_for_timeout(200)
        check('电脑：点它才醒', await pg.evaluate("LimingXin.mode") != 'sleep')
        faces = await pg.evaluate("LimingXin.frames('led').map(f => f.face || '')")
        hap = [i for i, f in enumerate(faces) if f == 'hap']
        check('玩灯：一直盯着灯看，最后才笑一下（表情不来回切）', len(hap) == 1 and all(f in ('', 'eyes') for f in faces[:hap[0]]), faces)
        await pg.context.close()

        # 电脑：抓着头拖，鼠标停在卡片上沿外面、身子挂在卡片里，也能扔进去
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.evaluate("sessionStorage.clear()"); await pg.wait_for_timeout(2500)
        r = await pg.evaluate("""(() => { const r = LimingXin.el.getBoundingClientRect(), cx = r.x + r.width / 2;
          for (let yy = r.y; yy < r.bottom; yy++) { const e = document.elementFromPoint(cx, yy); if (e && LimingXin.el.contains(e)) return [cx, yy + 2]; }
          return [cx, r.y + r.height / 2]; })()""")
        c = await pg.evaluate("(() => { const r = document.querySelector('.card[data-id=stm32]').getBoundingClientRect(); return [r.x + r.width / 2, r.y]; })()")
        await pg.mouse.move(r[0], r[1]); await pg.mouse.down(); await pg.mouse.move(c[0], c[1] - 6, steps=6); await pg.mouse.up()
        await pg.wait_for_timeout(1200)
        check('电脑：抓着头拖、身子在学习台卡片上，松手就进去', await pg.evaluate("document.body.classList.contains('tool-open')"))
        await pg.context.close()

        # 新动作：听烦了砸耳机、敲代码砸电脑、荡秋千、跳舞、不听话
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(2600)
        await pg.evaluate("LimingXin.music(true)"); await pg.wait_for_timeout(300)
        await pg.evaluate("LimingXin.bore(); LimingXin.rage('phones')"); await pg.wait_for_timeout(3800)
        st = await pg.evaluate("[!!document.querySelector('.xin-k') || true, LimingXin.el.querySelector('rect.c-hp') === null]")
        check('听歌听烦了：把耳机扯下来砸了（耳机没了）', st[1], st)
        await pg.wait_for_timeout(5000)
        await pg.evaluate("LimingXin.bag()"); await pg.click('.xin-bag .xin-it:has-text("耳机")'); await pg.wait_for_timeout(300)
        check('刚砸完耳机再给它戴：不戴（摇头、吐舌头）', await pg.evaluate("LimingXin.el.querySelector('rect.c-hp') === null"))
        await pg.wait_for_timeout(3000)
        items = await pg.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it')].map(b => b.textContent))")
        check('背包里有敲代码、跳舞、秋千', all(k in items for k in ('敲代码', '跳舞', '秋千')), items)
        await pg.click('.xin-bag .xin-it:has-text("敲代码")'); await pg.wait_for_timeout(1500)
        check('敲代码：掏出笔记本', await pg.evaluate("!!LimingXin.el.querySelector('rect.c-lt')"))
        await pg.wait_for_timeout(16000)
        await pg.evaluate("LimingXin.code(true, 'smash')")
        pcs = []
        for i in range(60):
            await pg.wait_for_timeout(200)
            pcs.append(await pg.evaluate("[!!LimingXin.el.querySelector('rect.c-lt'), document.querySelectorAll('.xin-k').length]"))
        check('写不出来气炸了：把电脑砸了（电脑碎成碎片）', any(k[1] > 0 for k in pcs) and not pcs[-1][0], pcs[-1])
        await pg.wait_for_timeout(4000)
        await pg.evaluate("(() => { const ps = LimingXin.plats(); LimingXin.hop(ps.findIndex(p => p.kind === 'top' && p.el.dataset.id === 'map')); })()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("LimingXin.swing()")
        modes = []
        for i in range(40):
            await pg.wait_for_timeout(300); modes.append(await pg.evaluate("LimingXin.mode"))
        thr = await pg.evaluate("getComputedStyle(document.querySelector('.xin-thread')).display")
        check('荡秋千：吊着线来回荡，最后松手落到平台上', 'swing' in modes and modes[-1] in ('idle', 'walk', 'play', 'sleep') and thr == 'none', modes[::4])
        faces = await pg.evaluate("LimingXin.frames('dance').map(f => f.face)")
        check('跳舞：有转身（背过去）和笑', 'back' in faces and faces.count('hap') > 10)
        await pg.context.close()

        # 电脑：学习台里点了好几层，返回键旁边的「回工具箱」一下回到首页
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(1200)
        await pg.click('.card[data-id=stm32]'); f = await tool_frame(pg); await pg.wait_for_timeout(600)
        hb = "getComputedStyle(document.querySelector('.panel[data-id=stm32] .home-b')).display"
        h0 = await pg.evaluate(hb)
        await f.click('.nav-t[data-t="usart"]'); await pg.wait_for_timeout(400)
        await f.click('.nav-t[data-t="gpio"]'); await pg.wait_for_timeout(400)
        await f.click('.snav-i:has-text("寄存器")'); await pg.wait_for_timeout(400)
        h1 = await pg.evaluate(hb)
        await pg.click('.panel[data-id=stm32] .home-b'); await pg.wait_for_timeout(1200)
        st = await pg.evaluate("[document.body.classList.contains('tool-open'), location.pathname]")
        check('电脑：学习台首页不显示「回工具箱」，点进几层后显示，点一下回到工具箱首页', h0 == 'none' and h1 == 'grid' and st == [False, '/'], (h0, h1, st))
        await pg.click('.card[data-id=stm32]'); await pg.wait_for_timeout(1500)
        await pg.click('.panel[data-id=stm32] .back'); await pg.wait_for_timeout(1200)
        check('回工具箱以后再打开学习台：返回键一下关掉', await pg.evaluate("[document.body.classList.contains('tool-open'), location.pathname]") == [False, '/'])
        await pg.context.close()

        # 寄存器面板：左右联动、取值列表代替下拉框、没有「已改」字样、代码下面讲寄存器是干啥的；手机上位格子下面直接显示选中字段，底部露着代码
        pg = await page(b)
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_BSRR&i=GPIOA'); await pg.wait_for_selector('.sheet.on'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[document.querySelectorAll('.sheet .selctl, .sheet .switch').length, document.querySelectorAll('.fields .fvals').length > 10, !!document.querySelector('.sh-about p') && document.querySelector('.sh-about p').textContent.includes('BS')]")
        check('寄存器面板：字段下面没有下拉框 / 开关，改成取值列表；代码下面有「作用」', st[0] == 0 and st[1] and st[2], st)
        await pg.click('.fields .frow-h:has(b:text-is("BS1"))'); await pg.wait_for_timeout(200)
        check('点左边的字段：右边位格子里对应的位高亮', await pg.evaluate("[...document.querySelectorAll('.bit.pick')].map(n => n.dataset.f)") == ['BS1'])
        await pg.click('.bit[data-f="BS11"]'); await pg.wait_for_timeout(800)
        st = await pg.evaluate("""(() => { const row = document.querySelector('.fields .frow.pick'), r = row.getBoundingClientRect(), b = document.querySelector('.sh-body').getBoundingClientRect();
          return [row.querySelector('.frow-h b').textContent, r.top >= b.top && r.bottom <= b.bottom, getComputedStyle(row.querySelector('.frow-h b'), '::after').content, row.querySelector('.fv.on b').textContent]; })()""")
        check('点右边的位：左边滚到那个字段并选中，名字变色、不写「已改」，当前值标在列表里', st[0] == 'BS11' and st[1] and st[2] in ('none', 'normal', '') and st[3] == '1', st)
        await pg.context.close()
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL&i=GPIOA'); await pg.wait_for_selector('.sheet.on'); await pg.wait_for_timeout(400)
        dock0 = await pg.evaluate("document.querySelector('.sh-dock').hidden")
        await pg.tap('.bit[data-f="MODE0"] >> nth=0'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[!document.querySelector('.sh-pick').hidden && document.querySelector('.sh-pick .frow-h b').textContent, document.querySelector('.sh-dock').hidden, document.querySelector('.sh-dock').textContent]")
        await pg.tap('.sh-pick .fv >> nth=3'); await pg.wait_for_timeout(300)
        st2 = await pg.evaluate("[document.querySelector('.sh-pick .fv.on b').textContent, document.querySelector('.sh-dock').textContent]")
        check('手机：点位格子，下面直接出现这个字段；底部露着寄存器写法，跟着改', dock0 and st[0] == 'MODE0' and not st[1] and 'CRL' in st[2] and st2[0] == '11' and 'MODE0' in st2[1], (dock0, st, st2))
        await pg.context.close()

        # 直接打开学习台（不经过工具箱首页）：没有小芯
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(TOOL + '?v=topic&t=i2c&sec=code&cv=cd'); await pg.wait_for_timeout(2000)
        check('直接打开学习台：没有小芯', await pg.evaluate("LimingXin.mode") == 'away')
        await pg.context.close()
        await b.close()

    print('\n==== %d/%d 通过 ====' % (sum(1 for r in results if r[1]), len(results)))
    real = [e for e in errors if 'Failed to load resource' not in e]
    print('JS 报错：%d' % len(real)); [print('  ' + e[:300]) for e in real[:20]]
    print('资源 404：%d' % (len(errors) - len(real)))

asyncio.run(main())
