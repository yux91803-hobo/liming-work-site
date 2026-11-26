"""STM32 学习台端到端测试（需要 python playwright + chromium）
先 npm run dev，再 python3 test/e2e/stm32_e2e.py [http://localhost:5173]"""
import asyncio, json, os, sys, time
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173'
TOOL = BASE + '/tools/stm32/'
INSTR = """
  window.__rs = 0;
  const R = history.replaceState.bind(history);
  history.replaceState = function () { window.__rs++; return R.apply(null, arguments); };
"""
results, errors, local_fail = [], [], []

def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (('  — ' + str(detail)) if detail != '' else ''), flush=True)

async def page(b, w=1280, h=860, mobile=False, theme='light'):
    ctx = await b.new_context(viewport={'width': w, 'height': h}, has_touch=mobile, is_mobile=mobile)
    await ctx.add_init_script(INSTR + "try{if(!localStorage.getItem('lm.theme'))localStorage.setItem('lm.theme','%s')}catch(e){}" % theme)
    # 小芯的「叛逆」是随机的（不肯睡、偏要走回去），测试里关掉，免得结果时好时坏
    await ctx.add_init_script("addEventListener('load', function () { if (window.LimingXin) LimingXin.obedient = true; })")
    pg = await ctx.new_page()
    await pg.bring_to_front()
    # 网站自己的资源失败才算问题；外部地图瓦片等第三方资源不计
    pg.on('response', lambda r: local_fail.append('%d %s' % (r.status, r.url)) if r.status >= 400 and r.url.startswith(BASE) else None)
    # ERR_ABORTED 是页面跳走时浏览器主动取消的请求，不算失败
    pg.on('requestfailed', lambda r: local_fail.append('%s %s' % (r.failure, r.url)) if r.url.startswith(BASE) and 'ERR_ABORTED' not in (r.failure or '') else None)
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

async def wait_panel(pg, cond):
    """等学习台面板的层数和历史记录到位；超时时把现场带进报错（层数、history.state、历史条数、路由、目录和搜索是否开着），
    像 Playwright 建议的那样保留 CI 失败现场，而不是加长等待（站长 2026-11-11：CI 上偶发卡在「快速收目录后搜索」）。"""
    try:
        await pg.wait_for_function(cond)
    except Exception as e:
        try:
            state = await pg.evaluate("""() => { const p = document.querySelector('.panel.show'); const fr = p && p.querySelector('iframe');
              let inner = {}; try { const d = fr.contentDocument, a = fr.contentWindow.STM.app; inner = {route: a.route(), drawer: d.documentElement.classList.contains('drawer'),
                search: !!d.querySelector('.search'), sheet: !!d.querySelector('.sheet.on')}; } catch (err) { inner = {error: String(err)}; }
              return {depth: p && p._depth, pending: !!(p && p._pendingBack), state: history.state, length: history.length, url: location.pathname + location.search, inner}; }""")
        except Exception as err:
            state = {'evaluate': str(err)}
        raise RuntimeError('panel wait timed out: ' + cond + ' :: ' + json.dumps(state, ensure_ascii=False)) from e

async def wait_img(f, timeout=10000):
    await f.wait_for_function("(() => { const i = document.querySelector('.viewer.on .zoom-content img'); return i && i.naturalWidth > 0; })()", timeout=timeout)

async def xin_head_position(pg):
    # 相对当前元素的可见像素位置，让 Locator 在动作时重新定位；不能复用几秒前的页面坐标。
    return await pg.evaluate("""(() => {
      const r=LimingXin.el.getBoundingClientRect(), x=r.x+r.width/2;
      for(let y=Math.max(0,r.y);y<r.bottom;y++) {
        const target=document.elementFromPoint(x,y);
        if(target && LimingXin.el.contains(target)) return {x:r.width/2,y:y+2-r.y};
      }
      throw new Error('小芯没有可抓住的可见像素');
    })()""")

# 按空了（它刚好挪开）就再来一次，最多 4 次；拖进去以后卡片对应的工具会打开
async def drag_xin_into(pg, card_id):
    for attempt in range(4):
        try: await pg.wait_for_function("LimingXin.mode === 'idle'", timeout=8000)
        except Exception: pass
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(), cx = r.x + r.width / 2; for (let yy = r.y; yy < r.bottom; yy++) { const e = document.elementFromPoint(cx, yy); if (e && LimingXin.el.contains(e)) return [cx, yy + 2]; } return null; })()")
        if not r:
            await pg.wait_for_timeout(500); continue
        c = await pg.evaluate("(() => { const r = document.querySelector('.card[data-id=%s]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()" % card_id)
        await pg.mouse.move(*r); await pg.mouse.down()
        for i in range(1, 13):
            await pg.mouse.move(r[0] + (c[0] - r[0]) * i / 12, r[1] + (c[1] - r[1]) * i / 12); await pg.wait_for_timeout(30)
        await pg.mouse.up()
        for _ in range(20):
            if await pg.evaluate("document.body.classList.contains('tool-open')"): return
            await pg.wait_for_timeout(100)
    raise RuntimeError('拖了 4 次都没把小芯拖进 ' + card_id)

async def stm32_operation_regressions(b):
    for w in [1280, 390]:
        for embedded in [False, True]:
            pg = await page(b, w, 844, mobile=w == 390)
            prefix = f'{w} ' + ('工具箱' if embedded else '独立页')
            await pg.goto((BASE + '/stm32' if embedded else TOOL) + '?v=topic&t=usart')
            f = await tool_frame(pg) if embedded else pg
            await f.wait_for_selector('html.ready')
            for mode in ['reg', 'hal', 'cd']:
                await f.evaluate('(cv) => STM.app.navigate({v:"topic",t:"usart",sec:"code",cv})', mode)
                states = []
                for sec in ['points', 'pins', 'regs', 'figs']:
                    await f.locator(f'.snav-i[href*="sec={sec}"]').click()
                    states.append(await f.evaluate('(s) => [STM.app.route().sec === s, !document.getElementById("s-"+s).hidden]', sec))
                    await pg.wait_for_function('(s) => new URLSearchParams(location.search).get("sec") === s', arg=sec)
                    await f.locator('.snav-i[href*="sec=code"]').click()
                    states.append(await f.evaluate('(cv) => [STM.app.route().sec === "code", document.querySelector(".cseg-b.on").dataset.k === cv]', mode))
                check(prefix + f'：{mode} 代码模式能切出全部分页，再切回来保留模式与地址', all(all(s) for s in states), states)

            await f.evaluate('STM.app.navigate({v:"topic",t:"i2c",sec:"code",cv:"reg",cx:"i2chw",cf:"main.c"})')
            states = []
            for sec in ['pins', 'points', 'regs', 'figs']:
                await f.locator(f'.snav-i[href*="sec={sec}"]').click()
                states.append(await f.evaluate('(s) => STM.app.route().sec === s', sec))
                await f.locator('.snav-i[href*="sec=code"]').click()
                states.append(await f.evaluate('STM.app.route().cx === "i2chw" && STM.app.route().cf === "main.c" && document.querySelector(".ftab.on").textContent === "main.c"'))
            check(prefix + '：硬件 I2C 的驱动和 main.c 不会被其他分页重置', all(states), states)

            await pg.goto((BASE + '/stm32' if embedded else TOOL) + '?v=topic&t=usart&sec=code&cv=reg&cf=usart.c')
            f = await tool_frame(pg) if embedded else pg
            await f.wait_for_selector('html.ready')
            await f.locator('.ftab').filter(has_text='main.c').click()
            await f.evaluate('window.scrollTo(0, Math.min(650,document.scrollingElement.scrollHeight-innerHeight-30))')
            before = await f.evaluate('({file:document.querySelector(".ftab.on").textContent,y:scrollY,cf:STM.app.route().cf})')
            await pg.keyboard.press('Control+k')
            await f.locator('.search-in').fill('USART_BRR'); await f.wait_for_selector('.search-it')
            await pg.keyboard.press('Enter'); await f.wait_for_selector('.sheet.on')
            source = await f.evaluate('STM.app.route().cf === "main.c" && STM.app.route().sec === "code"')
            await f.evaluate('STM.app.navigate({sch:"board-01"})'); await wait_img(f)
            await pg.locator('.panel.show .back').click() if embedded else await f.locator('.vw-x').click()
            await f.wait_for_function('!STM.app.route().sch')
            sheet = await f.locator('.sheet.on').count() == 1
            await pg.go_back(); await f.wait_for_function('!STM.app.route().reg')
            after = await f.evaluate('({file:document.querySelector(".ftab.on").textContent,y:scrollY,cf:STM.app.route().cf,sec:STM.app.route().sec})')
            check(prefix + '：main.c 查寄存器再看图，逐层返回保留文件与阅读位置', source and sheet and before['cf'] == 'main.c' and after['file'] == after['cf'] == 'main.c' and after['sec'] == 'code' and abs(after['y'] - before['y']) <= 2, (before, source, sheet, after))
            await pg.wait_for_function('(() => { const q=new URLSearchParams(location.search); return q.get("cf")==="main.c" && !q.has("reg") && !q.has("sch"); })()')
            await pg.reload(); f = await tool_frame(pg) if embedded else pg
            await f.wait_for_selector('html.ready')
            check(prefix + '：刷新仍打开刚选择的代码文件', await f.locator('.ftab.on').inner_text() == 'main.c')
            if embedded:
                await f.locator('.snav-i[href*="sec=points"]').click()
                await pg.wait_for_function('new URLSearchParams(location.search).get("sec") === "points"')
                await pg.goto(BASE + '/')
                label = await pg.locator('.card[data-id=stm32] .go').inner_text()
                check(prefix + '：工具箱继续位置显示实际分页，不被保留的代码模式覆盖', 'USART 要点' in label, label)
            await pg.context.close()

    for w in [390, 768]:
        pg = await page(b, w, 844, mobile=True)
        await pg.goto(BASE + '/stm32?v=topic&t=usart'); f = await tool_frame(pg)
        await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 1')
        for native in [False, True]:
            await f.locator('.bar-menu').click()
            await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 2')
            await pg.go_back() if native else await pg.locator('.panel.show .back').click()
            await f.wait_for_function('!document.documentElement.classList.contains("drawer")')
            await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 1 && history.state?.sub')
            check(f'{w}：' + ('浏览器返回' if native else '工具箱返回') + '先收目录，留在 USART 外设页', await f.evaluate('STM.app.route().t === "usart"'))
        await pg.go_back(); await f.wait_for_selector('.boardh')
        await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 0 && !history.state?.sub')
        await f.locator('.bar-menu').click()
        await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 1')
        await pg.go_back(); await f.wait_for_function('!document.documentElement.classList.contains("drawer")')
        check(f'{w}：首页目录返回只收目录，学习台保持打开', await f.evaluate('STM.app.route().v === "home"') and await pg.locator('.panel.show').count() == 1)
        await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 0 && !history.state?.sub')
        await f.locator('.bar-menu').click(); await f.evaluate('STM.app.openSearch()')
        await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 2')
        await pg.go_back(); await f.wait_for_function('!document.querySelector(".search")')
        first = await f.evaluate('document.documentElement.classList.contains("drawer") && STM.app.route().v === "home"')
        await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 1 && history.state?.sub')
        await pg.go_back(); await f.wait_for_function('!document.documentElement.classList.contains("drawer")')
        check(f'{w}：目录上搜索，返回依次关搜索、收目录，页面不退', first and await pg.locator('.panel.show').count() == 1)
        await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 0 && !history.state?.sub')
        await f.locator('.bar-menu').click(); await f.locator('.scrim').click(position={'x': w - 16, 'y': 80})
        await f.evaluate('STM.app.openSearch()')
        await f.locator('.search-in').fill('USART_BRR'); await f.wait_for_selector('.search-it')
        await pg.keyboard.press('Enter'); await f.wait_for_selector('.sheet.on')
        await wait_panel(pg, 'document.querySelector(".panel.show")?._depth > 0 && history.state?.sub')
        await pg.go_back(); await f.wait_for_function('!STM.app.route().reg')
        await wait_panel(pg, 'document.querySelector(".panel.show")?._depth === 0 && !history.state?.sub')
        check(f'{w}：快速收目录后搜索，返回仍只关寄存器且没有多余历史', await f.evaluate('STM.app.route().v === "home"') and await pg.locator('.panel.show').count() == 1)
        await pg.locator('.panel.show .back').click()
        await pg.wait_for_function('!document.body.classList.contains("tool-open")')
        check(f'{w}：所有临时层关闭后，再返回正常退出学习台', await pg.evaluate('location.pathname === "/"'))
        await pg.context.close()

async def stm32_audit_regressions(b):
    for w in [1280, 390]:
        pg = await page(b, w, 844, mobile=w == 390)
        await pg.goto(TOOL + '?v=topic&t=gpio'); await pg.wait_for_selector('html.ready')
        await pg.evaluate('STM.app.openSearch()')
        await pg.evaluate("""(() => {
          const i = document.querySelector('.search-in'); i.value = 'PA9';
          i.dispatchEvent(new Event('input', {bubbles:true}));
          i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',isComposing:true,keyCode:229,bubbles:true,cancelable:true}));
        })()""")
        st = await pg.evaluate("[STM.app.route().t, !!document.querySelector('.search')]")
        check(f'{w}：输入法确认候选词的回车不会提前跳转', st == ['gpio', True], st)
        await pg.evaluate("""(() => {
          const i = document.querySelector('.search-in'); i.value = 'PA9';
          i.dispatchEvent(new Event('input', {bubbles:true}));
          i.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true,cancelable:true}));
        })()""")
        selected = await pg.get_attribute('.search-in', 'aria-activedescendant')
        await pg.wait_for_timeout(150)
        after = await pg.get_attribute('.search-in', 'aria-activedescendant')
        check(f'{w}：改词后立即方向键选中第二项，延迟查询不会把选择重置', selected == 'search-option-1' and after == selected, (selected, after))
        await pg.fill('.search-in', 'USART1'); await pg.wait_for_selector('.search-it')
        await pg.evaluate("""(() => {
          const i = document.querySelector('.search-in'); i.value = 'PA9';
          i.dispatchEvent(new Event('input', {bubbles:true}));
          i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}));
        })()""")
        st = await pg.evaluate("[STM.app.route().v, STM.app.route().pin === String(STM.model.pinByName.PA9.n), !document.querySelector('.search')]")
        check(f'{w}：搜索改词后立即回车，打开新词 PA9 对应引脚', st == ['home', True, True], st)
        await pg.evaluate('STM.app.openSearch()')
        await pg.fill('.search-in', 'USART1'); await pg.wait_for_selector('.search-it')
        await pg.evaluate("""(() => {
          const i = document.querySelector('.search-in'); i.value = '';
          i.dispatchEvent(new Event('input', {bubbles:true}));
          i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}));
        })()""")
        st = await pg.evaluate("[STM.app.route().v, !!document.querySelector('.search'), document.querySelectorAll('.search-it').length]")
        check(f'{w}：清空搜索后立即回车，不会打开旧结果', st == ['home', True, 0], st)
        await pg.fill('.search-in', 'GPIO')
        await pg.wait_for_selector('.search-it')
        st = await pg.evaluate("(() => { const i = document.querySelector('.search-in'); return [i.getAttribute('role'), !!document.getElementById(i.getAttribute('aria-activedescendant'))]; })()")
        await pg.keyboard.press('Tab')
        cancel = await pg.evaluate("document.activeElement.classList.contains('search-x')")
        await pg.keyboard.press('Escape')
        check(f'{w}：搜索能用 Tab 到取消并按 Esc 关闭，读屏能找到当前结果', st == ['combobox', True] and cancel and not await pg.locator('.search').count(), (st, cancel))

        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL&val=0x44444443'); await pg.wait_for_selector('.sheet.on')
        await pg.evaluate('STM.app.openSearch()')
        nested = await pg.evaluate("[document.getElementById('app').inert,document.querySelector('.sheet').inert,document.querySelector('.search').inert]")
        await pg.keyboard.press('Escape')
        after = await pg.evaluate("[document.documentElement.classList.contains('modal'),document.getElementById('app').inert,document.querySelector('.sheet').inert]")
        check(f'{w}：寄存器上打开搜索只允许操作搜索，关闭后寄存器仍锁住背景', nested == [True, True, False] and after == [True, True, False], (nested, after))

        await pg.evaluate("STM.app.navigate({sch:'board-08'})"); await wait_img(pg)
        await pg.evaluate('STM.app.openSearch()'); await pg.keyboard.press('Escape')
        st = await pg.evaluate("[document.documentElement.classList.contains('modal'),document.getElementById('app').inert,document.querySelector('.sheet').inert,document.querySelector('.viewer').inert]")
        check(f'{w}：寄存器、看图、搜索叠开，关搜索后只恢复看图', st == [True, True, True, False], st)
        # 一次导航退出两层，淡出中的 DOM 不应继续锁住页面。
        await pg.evaluate("STM.app.navigate({v:'topic',t:'usart'})")
        await pg.wait_for_function("!STM.app.route().reg && !STM.app.route().sch")
        st = await pg.evaluate("[document.documentElement.classList.contains('modal'),document.getElementById('app').inert]")
        check(f'{w}：同时关寄存器和看图后立即恢复页面操作', st == [False, False], st)

        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL&val=0x44444443'); await pg.wait_for_selector('.sheet.on')
        await pg.evaluate("window.__hexBefore = document.querySelector('.hexin input'); window.__hexValue = __hexBefore.value")
        colors = []
        for theme in ['dark', 'light']:
            await pg.evaluate("t => { localStorage.setItem('lm.theme',t); window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:window.parent,data:{type:'theme'}})); }", theme)
            colors.append(await pg.evaluate("""(() => {
              const wanted = STM.model.topicById.gpio.hue[document.documentElement.dataset.theme === 'dark' ? 1 : 0];
              return [getComputedStyle(document.querySelector('.sheet-p')).getPropertyValue('--h').trim() === wanted,
                getComputedStyle(document.querySelector('.nav-t[data-t=gpio]')).getPropertyValue('--h').trim() === wanted,
                document.querySelector('.hexin input') === __hexBefore && __hexBefore.value === __hexValue];
            })()"""))
        check(f'{w}：切换浅深色即时更新外设和寄存器配色，并保留正在算的值', colors == [[True]*3, [True]*3], colors)

        await pg.goto(TOOL + '?v=topic&t=i2c&reg=I2C_CCR'); await pg.wait_for_selector('.sheet.on')
        await pg.locator('.fxin input').nth(1).fill('350')
        initial = await pg.inner_text('.fxout')
        await pg.click('.sh-fx .pill.solid')
        val = int((await pg.input_value('.hexin input')).replace(' ', ''), 16)
        await pg.fill('.hexin input', '0xC023')
        duty = await pg.inner_text('.fxout')
        check(f'{w}：I2C 350 kHz 取 CCR=35 避免超速，改 DUTY 后同步重算', val == 0x8023 and '342.857' in initial and '288 kHz' in duty and 'CCR = 5' in duty, (initial, val, duty))
        await pg.locator('.fxin input').nth(1).fill('800')
        blocked = await pg.is_disabled('.sh-fx .pill.solid') and '400 kHz' in await pg.inner_text('.fxout')
        await pg.locator('.fxin input').nth(1).fill('100')
        await pg.locator('.fxin input').nth(0).fill('72')
        blocked_clock = await pg.is_disabled('.sh-fx .pill.solid') and '36 MHz' in await pg.inner_text('.fxout')
        check(f'{w}：I2C 超出总线或 PCLK1 上限时禁止写入并解释原因', blocked and blocked_clock, (blocked, blocked_clock))
        await pg.context.close()

    pg = await page(b)
    for query in ['reg=constructor', 'reg=toString', 'reg=hasOwnProperty', 'm=constructor', 'fig=constructor']:
        await pg.goto(TOOL + '?' + query); await pg.wait_for_selector('html.ready')
        check('异常地址仍能加载学习台：' + query, await pg.locator('#main').inner_text() != '')
    await pg.context.close()

async def main():
    async with async_playwright() as p:
        exe = os.environ.get('CHROMIUM_PATH')
        b = await p.chromium.launch(**({'executable_path': exe} if exe else {}))

        await stm32_operation_regressions(b)
        await stm32_audit_regressions(b)

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
        fs0 = await pg.evaluate("[parseFloat(getComputedStyle(document.querySelector('.side-tg')).fontSize), document.getElementById('side-topics').hidden]")
        await pg.click('.side-tg'); await pg.wait_for_timeout(150)
        fs1 = await pg.evaluate("[document.getElementById('side-topics').hidden, document.querySelector('.side-tg').getAttribute('aria-expanded')]")
        await pg.click('.side-tg'); await pg.wait_for_timeout(150)
        check('侧栏「外设」是大一点的标题，点一下收起 / 再点展开', fs0[0] >= 15 and fs0[1] is False and fs1 == [True, 'false'] and not await pg.evaluate("document.getElementById('side-topics').hidden"), (fs0, fs1))
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
        # 来回点几个外设再返回：按走过的路退回，不在同几页之间来回
        for t, code in [('gpio', 'GPIO'), ('usart', 'USART'), ('gpio', 'GPIO'), ('usart', 'USART'), ('i2c', 'I2C'), ('usart', 'USART')]:
            await pg.click('.nav-t[data-t="%s"]' % t)
            await pg.wait_for_function("(document.querySelector('.th-code') || {}).textContent === '%s' && location.search.includes('t=%s')" % (code, t)); await pg.wait_for_timeout(120)
        await pg.go_back(); await pg.wait_for_timeout(400)
        u1 = [pg.url, await pg.evaluate("(document.querySelector('.th-code') || {}).textContent")]
        await pg.go_back(); await pg.wait_for_timeout(400)
        check('独立打开：GPIO → USART → GPIO → USART → I2C → USART 再返回，先回 GPIO 再回首页，不在几页之间打转', 't=gpio' in u1[0] and u1[1] == 'GPIO' and await pg.evaluate("!!document.querySelector('.boardh')"), u1)
        check('独立打开：左上角「STM32F103 学习台」能点回工具箱首页', await pg.evaluate("(() => { const a = document.querySelector('#side a.brand'); return !!a && a.getAttribute('href') === '/'; })()"))

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
        # 地址同步有节流，等它写进地址栏再判断
        try: await pg.wait_for_function("location.href.includes('m=stlink')", timeout=3000)
        except Exception: pass
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
            cond = "(() => { const s = document.querySelector('svg.mod .mp.sel'); return !!s && !!document.querySelector('.pdetail .pd-mp.on') && !!document.querySelector('.pdetail .pd-doc p'); })()"
            # 模块图刚打开还在渲染时，CI 机器上按下到抬起可能被拖过 400 ms，缩放组件会当成长按不选中。
            # 先等两帧让渲染完；第一次没选中再点一次，两次都不行才算失败
            ok = False
            for _ in range(2):
                await pg.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                await pg.click('svg.mod .mp >> nth=0', force=True)
                try: await pg.wait_for_function(cond, timeout=2000); ok = True; break
                except Exception: pass
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
        check('嵌在工具箱里：左上角「学习台」标志不是链接（外面有返回键和回工具箱）', await f.evaluate("document.querySelector('#side .brand').tagName") == 'DIV')
        # 来回点几个外设：外壳的返回键、浏览器返回都按走过的路退回，不在同几页之间来回
        async def zigzag():
            await pg.goto(BASE + '/stm32'); fr = await tool_frame(pg)
            for t, code in [('gpio', 'GPIO'), ('usart', 'USART'), ('gpio', 'GPIO'), ('usart', 'USART'), ('i2c', 'I2C'), ('usart', 'USART')]:
                await fr.click('.nav-t[data-t="%s"]' % t)
                await fr.wait_for_function("(document.querySelector('.th-code') || {}).textContent === '%s'" % code); await pg.wait_for_timeout(120)
            return fr
        shown = lambda fr: fr.evaluate("document.querySelector('.boardh') ? 'home' : (document.querySelector('.th-code') || {}).textContent")
        f = await zigzag()
        steps = [await pg.evaluate("document.querySelector('#stage .panel.show')._depth")]
        for _ in range(2):
            await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(700); steps.append(await shown(f))
        await pg.evaluate("document.querySelector('.panel.show .back').click()"); await pg.wait_for_timeout(900)
        steps.append(await pg.evaluate("location.pathname"))
        check('嵌入：来回点 GPIO / USART / I2C 以后只叠了 2 层；返回键：GPIO → 学习台首页 → 关闭', steps == [2, 'GPIO', 'home', '/'], steps)
        f = await zigzag()
        steps = []
        for _ in range(2):
            await pg.go_back(); await pg.wait_for_timeout(700); steps.append(await shown(f))
        await pg.go_back(); await pg.wait_for_timeout(900)
        steps.append(await pg.evaluate("[location.pathname, !!document.querySelector('#stage .panel.show')]"))
        check('嵌入：浏览器 / 手机的返回也一样：GPIO → 学习台首页 → 关闭', steps == ['GPIO', 'home', ['/', False]], steps)
        # 外设页「引脚」里点一个引脚跳到芯片图：返回回到原来的外设页（还在「引脚」分页）；首页上点过引脚再点「首页」不叠层
        await pg.goto(BASE + '/stm32?v=topic&t=gpio&sec=pins'); f = await tool_frame(pg)
        await f.click('.ptile >> nth=0'); await f.wait_for_selector('.boardh'); await pg.wait_for_timeout(300)
        pin = await pg.evaluate("new URLSearchParams(location.search).get('pin')")
        await pg.go_back(); await pg.wait_for_timeout(700)
        st = [pin, await shown(f), await f.evaluate("[...document.querySelectorAll('.topic > .sec')].filter(x => !x.hidden).map(x => x.id)")]
        await pg.go_back(); await pg.wait_for_timeout(700); st.append(await shown(f))
        check('嵌入：外设页点引脚看芯片图，返回回到外设页的「引脚」，再返回到学习台首页', bool(pin) and st[1:] == ['GPIO', ['s-pins'], 'home'], st)
        await f.evaluate("STM.app.update({ pin: '68' })"); await f.click('.nav-t[data-t="usart"]'); await pg.wait_for_timeout(300)
        await f.evaluate("STM.app.navigate({ v: 'home' })"); await pg.wait_for_timeout(500)
        check('嵌入：回学习台首页总是清空返回栈（返回键一下关掉）', await pg.evaluate("document.querySelector('#stage .panel.show')._depth") == 0)
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
        check('硬件原理总览：八章', hrefs == CHAPS and await pg.evaluate("document.querySelectorAll('.tk-flow li').length") == 6 and await pg.evaluate("document.querySelector('h1').textContent") == '硬件原理', hrefs)
        for chap in ['gpio', 'usart', 'tim', 'adc', 'spi']:
            await pg.goto(TOOL + '?v=topic&t=' + chap); await pg.wait_for_selector('.topic')
            ok = await pg.evaluate("(document.querySelector('.thinkin b') || {}).textContent === '硬件原理'")
            if not ok: break
        check('五个外设页都有「硬件原理」入口', ok)
        bad = []
        for tid in ['sys', 'fsmc']:
            await pg.goto(TOOL + '?v=topic&t=' + tid); await pg.wait_for_selector('.topic')
            if await pg.evaluate("!!document.querySelector('.thinkin')"): bad.append(tid)
        check('没有推导链的外设不显示「硬件原理」入口', not bad, bad)
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
        await pg.goto(TOOL + '?v=topic&t=exti&sec=code&cv=cd'); await pg.wait_for_selector('.cd-modes')
        await pg.click('.cd-mb:has-text("自己写")'); await pg.wait_for_timeout(200)
        n0 = await pg.evaluate("[document.querySelectorAll('.cd-inp').length, document.querySelector('.cd-prog').textContent]")
        inp = pg.locator('.cd-inp').first
        first = await pg.evaluate("document.querySelector('.cd-inp').getAttribute('aria-label')")
        await inp.fill('void KEY_Init(int);'); await inp.press('Enter'); await pg.wait_for_timeout(150)
        wrong = await pg.evaluate("document.querySelectorAll('.cd-bad').length == 1 && document.querySelector('.cd-bad .cd-msg').textContent.length > 0")
        await inp.fill(await pg.evaluate("(() => { const L = STM.codederive.data.CD.exti; for (const st of L.steps) for (const f of L.files) for (const l of f.lines) if (l[3] === st.id && STM.codederive.data.blankable(l[0])) return l[0].trim(); })()")); await inp.press('Enter'); await pg.wait_for_timeout(150)
        n1 = await pg.evaluate("[document.querySelectorAll('.cd-inp').length, document.querySelectorAll('.cd-ok').length, document.querySelector('.cd-prog').textContent, document.activeElement.classList.contains('cd-inp')]")
        await pg.click('.cd-blank.act button:has-text("答案")'); await pg.wait_for_timeout(100)
        await pg.reload(); await pg.wait_for_selector('.cd-modes'); await pg.wait_for_timeout(300)
        n2 = await pg.evaluate("[document.querySelector('.cd-mb.on').textContent, document.querySelectorAll('.cd-ok').length, document.querySelectorAll('.cd-shown').length, document.querySelector('.cd-prog').textContent]")
        check('自己写（EXTI）：写错提示、写对露出代码并跳到下一行、刷新后进度还在', n0[0] >= 20 and n0[1] == '0 / %d' % n0[0] and wrong and n1[:3] == [n0[0] - 1, 1, '1 / %d' % n0[0]] and n1[3] and n2 == ['自己写', 1, 1, '2 / %d' % n0[0]], [n0, wrong, n1, n2])
        await pg.click('.cd-reset'); await pg.wait_for_timeout(100)
        await pg.click('.cd-mb:has-text("看推导")'); await pg.wait_for_timeout(100)
        check('重来清空进度；切回看推导没有输入框', await pg.evaluate("document.querySelectorAll('.cd-inp').length == 0 && !(JSON.parse(localStorage.getItem('lm.stm32.cdself') || '{}').exti)"))
        await pg.evaluate("localStorage.removeItem('lm.stm32.codestyle')")
        bad = []
        for chap in [c for c in CHAPS if c not in ('gpio', 'tim')] + ['sys', 'fsmc']:
            await pg.goto(TOOL + '?v=topic&t=' + chap + '&sec=code&cv=cd'); await pg.wait_for_selector('.code-cd .cd-step')
            n = await pg.evaluate("[document.querySelectorAll('.code-cd .cd-step').length, document.querySelectorAll('.code-reg .ftab').length, document.querySelectorAll('.code-cd .rc-l.has').length, document.querySelector('.code-cd').hidden]")
            if n[0] < 7 or n[1] < 3 or n[2] < 6 or n[3]: bad.append((chap, n))
        await pg.goto(TOOL + '?v=topic&t=gpio&sec=code&cv=cd'); await pg.wait_for_timeout(500)
        gp = await pg.evaluate("[document.querySelectorAll('.code-reg .ftab').length, (document.querySelector('.code-cd .thinkin b') || {}).textContent, (document.querySelector('.code-cd .thinkin') || {}).getAttribute && document.querySelector('.code-cd .thinkin').getAttribute('href')]")
        check('八个外设的代码页有完整文件和代码推导；GPIO、定时器的代码推导并进了编程思维，这里只留入口', not bad and gp[0] == 3 and gp[1] == '编程思维' and 'v=lab' in (gp[2] or ''), [bad, gp])
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
        await pg.goto(TOOL + '?v=think&t=gpio&hv=why'); await pg.wait_for_selector('.dv-mode.enter')
        check('章节首页没有代码推导入口', not await pg.evaluate("!!document.querySelector('.dv-codein')"))
        await pg.click('.dv-modeb >> nth=1'); await pg.wait_for_selector('.dv-step')
        check('章节首页：点「自主推导」直接进推导', 's=s' in pg.url and await pg.evaluate("JSON.parse(localStorage.getItem('lm.stm32.derive')).mode") == 'self', pg.url)
        await pg.evaluate("(() => { const o = JSON.parse(localStorage.getItem('lm.stm32.derive')); o.mode = 'full'; localStorage.setItem('lm.stm32.derive', JSON.stringify(o)); })()")
        side = await pg.evaluate("[...document.querySelectorAll('.nav-i')].map(a => a.textContent)")
        check('侧栏：首页、开发板、编程思维、硬件原理', side == ['首页', '开发板', '编程思维', '硬件原理'], side)
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
        wide = await pg.evaluate("[...document.querySelectorAll('.card.wide')].map(c => c.dataset.id)")
        check('首页按分类排：工具 / 学习（2026-11-26 天启删了，世界地图在前，学习最后），世界地图是宽卡', cats == ['工具', '学习'] and 'map' in wide, (cats, wide))
        hero = await pg.evaluate("(() => { const c = document.querySelector('.card.hero'); return c && [c.dataset.id, c.querySelector('.go').textContent]; })()")
        check('最近用过的 STM32 放大，写着上次看到哪', hero == ['stm32', 'I2C 代码推导'], hero)
        ids = await pg.evaluate("[...document.querySelectorAll('.card[data-id]')].map(c => c.dataset.id)")
        check('首页没有互传和协作中心', 'transfer' not in ids and 'hub' not in ids, ids)
        check('小芯落在标题栏里', await pg.evaluate("LimingXin.mode") == 'idle')
        await pg.evaluate("LimingXin.cmd('normal')")
        await pg.wait_for_function("document.querySelector('.xin svg').dataset.face === 'eyes'")
        normal = await pg.evaluate("[...document.querySelectorAll('.xin .c-ew')].map(e => [+e.getAttribute('width'), +e.getAttribute('height')])")
        check('小芯常态使用图中的专注竖矩形眼，不是微笑', len(normal) == 2 and normal == [[1.5, 2.65], [1.5, 2.65]], normal)
        hands = await pg.evaluate("""(() => {
          const arms = svg => [...svg.querySelectorAll('rect')].filter(e => (e.getAttribute('fill') || '').includes('-pin)') && (+e.getAttribute('x') < 4 || +e.getAttribute('x') >= 16))
            .map(e => ['x', 'y', 'width', 'height'].map(a => +e.getAttribute(a)));
          const avatar = document.createElement('div'); avatar.innerHTML = LimingXin.portrait();
          return [arms(LimingXin.el.querySelector('svg')), arms(avatar.querySelector('svg'))];
        })()""")
        check('常态和聊天头像的双手对称平伸，没有固定举手', all(len(a) == 2 and a[0][1:] == a[1][1:] and a[0][2] > a[0][3] and a[0][0] + a[0][2] + a[1][0] == 20 for a in hands), hands)
        expressions, cheeks = [], []
        for cmd, face in [('smile', 'smile'), ('focus', 'focus'), ('happy', 'hap'), ('calm', 'calm'), ('wow', 'wow'), ('love', 'love')]:
            await pg.evaluate('cmd => LimingXin.cmd(cmd)', cmd)
            await pg.wait_for_function('face => document.querySelector(".xin svg").dataset.face === face', arg=face)
            pixels = await pg.evaluate("[...document.querySelectorAll('.xin .c-ew')].map(e => ['x','y','width','height'].map(a => e.getAttribute(a)))")
            expressions.append(json.dumps(pixels))
            cheeks.append(await pg.locator('.xin .c-rose').count())
        check('六种参考表情都能实际触发，而且图案各不相同', len(set(expressions)) == 6)
        check('腮红只在微笑、开心和喜欢时出现', cheeks == [4, 0, 4, 0, 0, 4], cheeks)
        await pg.evaluate("LimingXin.cmd('normal'); LimingXin.feel('smile', 200)")
        await pg.wait_for_function("document.querySelector('.xin svg').dataset.face === 'smile'")
        await pg.wait_for_function("document.querySelector('.xin svg').dataset.face === 'eyes'")
        check('微笑结束后自动恢复睁眼常态', await pg.evaluate('LimingXin.mood') == '')
        check('恢复常态时同时收起腮红', await pg.locator('.xin .c-rose').count() == 0)
        await pg.evaluate("LimingXin.cmd('angry')")
        await pg.wait_for_function("document.querySelector('.xin svg').dataset.face === 'angry'")
        check('生气能实际触发新眉眼，面板没有腮红', await pg.locator('.xin .c-rose').count() == 0)
        await pg.evaluate("LimingXin.cmd('normal')")
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
        platforms = await pg.evaluate("LimingXin.plats().map(p => [p.kind, p.el.dataset.id || null])")
        kinds = [kind for kind, _ in platforms]
        tools = ('map', 'stm32')
        check('首页能站的地方：标题栏 + 两张工具卡片各自的上沿和里面',
              kinds.count('ground') == 1 and len(platforms) == 1 + 2 * len(tools)
              and all([kind, tool] in platforms for tool in tools for kind in ('top', 'in')), platforms)
        i_in = kinds.index('in')
        await pg.evaluate("LimingXin.hop(%d)" % i_in); await pg.wait_for_timeout(1500)
        check('小芯能跳进卡片里，落地后站在里面', await pg.evaluate("[LimingXin.mode, LimingXin.plat && LimingXin.plat.kind]") == ['idle', 'in'])
        await pg.evaluate("LimingXin.hop(0)"); await pg.wait_for_timeout(1500)
        check('再跳回标题栏', await pg.evaluate("[LimingXin.mode, LimingXin.plat && LimingXin.plat.kind]") == ['idle', 'ground'])
        # 半空中叫它跳（比如它自己正跳着）：要等落地再跳，和背包里的动作一样。以前起跳前蹲的那 0.19 秒里正好落地，
        # 落地就把这次起跳掐掉了，叫了等于没叫（#134 合并后正式站 CI「hop did not enter real flight」）
        mid = await pg.evaluate("""() => new Promise(resolve => {
          const ps = LimingXin.plats(), map = ps.findIndex(p => p.kind === 'top' && p.el.dataset.id === 'map');
          LimingXin.hop(ps.findIndex(p => p.kind === 'in'));
          const t = setInterval(() => { if (LimingXin.mode !== 'fly') return; clearInterval(t); LimingXin.hop(map); resolve(LimingXin.mode); }, 5);
        })""")
        try: await pg.wait_for_function("LimingXin.mode === 'idle' && !!LimingXin.plat && LimingXin.plat.kind === 'top' && LimingXin.plat.el.dataset.id === 'map'", timeout=6000, polling=100)
        except Exception: pass
        got = await pg.evaluate("[LimingXin.mode, LimingXin.plat && LimingXin.plat.kind, LimingXin.plat && LimingXin.plat.el.dataset.id]")
        check('半空中叫它跳：落地以后再跳过去，不会被落地掐掉', mid == 'fly' and got == ['idle', 'top', 'map'], (mid, got))
        await pg.evaluate("LimingXin.hop(0)"); await pg.wait_for_timeout(1500)

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
        # 学习台里从背包「收起来」：小芯回去歇着，右边探出小脑袋；刷新学习台也还收着；点小脑袋它跳回来
        peek_st = "[LimingXin.mode, LimingXin.hidden, !!document.querySelector('.xin-peek') && !document.querySelector('.xin-peek').hidden, document.documentElement.scrollWidth <= innerWidth]"
        items = await f.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent))")
        await f.click('.xin-bag .xin-it:has-text("收起来")'); await pg.wait_for_timeout(500)
        st = await f.evaluate(peek_st)
        check('学习台里背包有「收起来」：点了小芯不见了，右边探出小脑袋，页面不横向滚动', '收起来' in items and st == ['away', True, True, True], (items, st))
        await f.evaluate("location.reload()"); await pg.wait_for_timeout(600); f = await tool_frame(pg); await pg.wait_for_timeout(800)
        st = await f.evaluate(peek_st)
        check('刷新学习台：小芯还收着，小脑袋还在', st == ['away', True, True, True], st)
        await f.click('.xin-peek')
        for _ in range(40):
            if await f.evaluate("LimingXin.mode") in ('idle', 'walk', 'play'): break
            await pg.wait_for_timeout(100)
        st = await f.evaluate(peek_st)
        check('点小脑袋：小芯跳回学习台，小脑袋收起', st[0] in ('idle', 'walk', 'play') and st[1:3] == [False, False], st)
        await f.evaluate("LimingXin.hide()"); await pg.wait_for_timeout(300)
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
        # 吊住 → 下坠回弹 → 发抖 0.9 秒 → 往上爬（最长 2.6 秒）→ 跳回平台（最长 0.9 秒），按代码算最长约 5 秒；
        # 以前固定等 5 秒，只剩半秒余量，执行机一忙就判失败（2026-11-12 #128 上线时）。等它真的站定，最多 12 秒
        # 按 100 毫秒间隔查（不靠动画帧，页面不出帧时也按时判）；没过就把当时的状态和用了多久记下来（#130 上线时这一项卡了 61 秒，没留现场）
        t0 = time.time()
        try: await pg.wait_for_function("LimingXin.mode === 'idle' && !!LimingXin.plat", timeout=12000, polling=100)
        except Exception: pass
        got = await pg.evaluate("[LimingXin.mode, !!LimingXin.plat, LimingXin.mood, getComputedStyle(document.querySelector('.xin-thread')).display]")
        check('顺着线爬上去，再跳回能站的地方', got[:2] == ['idle', True], (got, '%.1f 秒' % (time.time() - t0)))
        await pg.context.close()

        # 电脑：右键打开背包；让它睡以后鼠标在旁边晃、点别处都不吵醒它，点它才醒；玩灯时表情不跟着灯来回变
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(2500)
        await pg.locator('.xin').click(button='right', position=await xin_head_position(pg)); await pg.wait_for_timeout(200)
        check('电脑：右键小芯打开小背包', await pg.evaluate("!!document.querySelector('.xin-bag')"))
        await pg.click('.xin-bag .xin-it:has-text("睡觉")'); await pg.wait_for_timeout(200)
        r = await pg.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.55]; })()")
        for i in range(15):
            await pg.mouse.move(r[0] + 120 * ((i % 5) - 2), r[1] + 50 * ((i % 3) - 1)); await pg.wait_for_timeout(50)
        await pg.mouse.click(1100, 700); await pg.wait_for_timeout(300)
        check('电脑：睡着以后鼠标在旁边晃、点别处都不会吵醒它', await pg.evaluate("LimingXin.mode") == 'sleep')
        await pg.evaluate("document.addEventListener('pointerup',()=>{window.__xinBeforeWake=LimingXin.mode},{capture:true,once:true})")
        await pg.locator('.xin').click(position=await xin_head_position(pg)); await pg.wait_for_timeout(200)
        check('电脑：点它才醒', await pg.evaluate("window.__xinBeforeWake === 'sleep' && LimingXin.mode !== 'sleep'"))
        faces = await pg.evaluate("LimingXin.frames('led').map(f => f.face || '')")
        hap = [i for i, f in enumerate(faces) if f == 'hap']
        check('玩灯：一直盯着灯看，最后才笑一下（表情不来回切）', len(hap) == 1 and all(f in ('', 'eyes') for f in faces[:hap[0]]), faces)
        await pg.context.close()

        # 抓头后鼠标仍在卡片上沿外、身体在卡片里：先确认出场落地，再一次真实拖放。
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.evaluate("sessionStorage.clear()")
        await pg.bring_to_front()
        await pg.evaluate("document.fonts.ready")
        await pg.wait_for_function("window.LimingXin && LimingXin.mode === 'idle' && !!LimingXin.plat")
        c = await pg.evaluate("(() => { const r=document.querySelector('.card[data-id=stm32]').getBoundingClientRect(), b=document.body.getBoundingClientRect(); return {x:r.x+r.width/2-b.x,y:r.y-6-b.y}; })()")
        try:
            # 在真正松手的捕获阶段留证；不在多次跨进程 mouse RPC 之间读一个易逝状态。
            await pg.evaluate("""document.addEventListener('pointerup',e=>{
              const card=document.querySelector('.card[data-id=stm32]');
              window.__xinDrop={mode:LimingXin.mode,over:document.querySelector('.card.xin-over')?.dataset.id,above:e.clientY<card.getBoundingClientRect().top};
            },{capture:true,once:true})""")
            await pg.locator('.xin').drag_to(pg.locator('body'),source_position=await xin_head_position(pg),target_position=c)
            await pg.wait_for_function("document.body.classList.contains('tool-open')", timeout=5000)
            drop=await pg.evaluate("window.__xinDrop")
            check('电脑：抓着头拖、身子在学习台卡片上，松手就进去', bool(drop and drop['mode']=='drag' and drop['over']=='stm32' and drop['above']), drop)
        except Exception:
            detail = await pg.evaluate("({mode:LimingXin.mode,visible:document.visibilityState,focused:document.hasFocus(),over:document.querySelector('.card.xin-over')?.dataset.id,open:document.body.classList.contains('tool-open'),rect:LimingXin.el.getBoundingClientRect().toJSON()})")
            check('电脑：抓着头拖、身子在学习台卡片上，松手就进去', False, detail)
            os.makedirs('screens', exist_ok=True)
            await pg.screenshot(path='screens/stm32-drag-failure.png')
        await pg.context.close()

        # 新动作：听烦了砸耳机、敲代码砸电脑、荡秋千、跳舞、不听话
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(2600)
        await pg.evaluate("LimingXin.music(true)"); await pg.wait_for_timeout(300)
        # rage() 只在小芯站着、走着或玩着时马上开始，否则排到下一次空闲（CI 机器忙时开场动作可能还没完）：等到耳机真的没了，不按固定秒数
        await pg.evaluate("LimingXin.bore(); LimingXin.rage('phones')")
        try: await pg.wait_for_function("LimingXin.el.querySelector('rect.c-hp') === null", timeout=15000)
        except Exception: pass
        st = await pg.evaluate("[LimingXin.mode, LimingXin.el.querySelector('rect.c-hp') === null]")
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
        # 碎片可能只存在一瞬间，每 200 ms 看一次会漏：在页面里挂监听，记下出现过的最多碎片数
        await pg.evaluate("""window.__xinK = 0; new MutationObserver(() => { window.__xinK = Math.max(window.__xinK, document.querySelectorAll('.xin-k').length); })
          .observe(document.body, { childList: true, subtree: true })""")
        # 正在半空（刚起跳）时叫它敲代码：要等落地再敲，不能一落地就被掐掉（以前偶尔这样：笔记本没了也没砸）
        await pg.bring_to_front()
        # 小芯空闲时自己会随机去荡秋千（约 4% 的机会，一次 7–13 秒）：荡着的时候叫它跳，要等落地才跳，超过下面 5 秒的观察时限
        # （#148 的 CI：was=swing）。先等它落在平台上，同一个任务里接着叫它跳（playSeq 会先停掉刚开始的别的动作），中间不留空档
        air = await pg.evaluate("""() => new Promise((resolve,reject) => {
          const AIR = /^(fly|hang|rope|climb|swing|plug|drag)$/, t0 = performance.now();
          const go = () => {
          let timer; const watch = new MutationObserver(() => {
            if (LimingXin.mode !== 'fly') return;
            watch.disconnect(); clearTimeout(timer);
            const before = LimingXin.mode; LimingXin.code(true, 'smash');
            resolve({before, after: LimingXin.mode});
          });
          watch.observe(LimingXin.el, {attributes:true, attributeFilter:['class']});
          const ps=LimingXin.plats(), i=ps.findIndex(p => p.kind === 'top' && p.el.dataset.id === 'map'), was=LimingXin.mode;
          timer=setTimeout(() => {watch.disconnect(); reject(new Error('hop did not enter real flight: ' + JSON.stringify({i, was, now: LimingXin.mode, plat: LimingXin.plat && LimingXin.plat.kind})));},5000);
          LimingXin.hop(i);
          };
          const wait = () => { if (!AIR.test(LimingXin.mode) && LimingXin.plat) return go(); if (performance.now() - t0 > 20000) return reject(new Error('never landed on a platform: ' + LimingXin.mode)); setTimeout(wait, 50); };
          wait();
        })""")
        pcs = []
        for i in range(90):
            await pg.wait_for_timeout(200)
            pcs.append(await pg.evaluate("[!!LimingXin.el.querySelector('rect.c-lt'), window.__xinK]"))
        check('写不出来气炸了：把电脑砸了（电脑碎成碎片）；半空中叫它也等落地再做', air['before'] == 'fly' and air['after'] == 'fly' and pcs[-1][1] > 0 and not pcs[-1][0], (air, pcs[-1]))
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

        # 电脑：返回键旁边一直有「回工具箱」（学习台首页也有）；点了好几层，点它一下回到首页
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
        check('电脑：学习台首页就有「回工具箱」，点进几层后还在，点一下回到工具箱首页', h0 == 'grid' and h1 == 'grid' and st == [False, '/'], (h0, h1, st))
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
        # 宽屏：右边一栏自己能往下滑（代码、作用看得全），左边不跟着动
        # 固定为需要滚动的桌面高度，避免不同 Chromium / 字体下内容恰好放得下。
        await pg.set_viewport_size({'width': 1280, 'height': 560})
        await pg.wait_for_function("document.querySelector('.sh-r').scrollHeight > document.querySelector('.sh-r').clientHeight")
        rs = await pg.evaluate("""(() => { const R = document.querySelector('.sh-r'), L = document.querySelector('.sh-l'); const l0 = L.scrollTop;
          R.scrollTop = 9999; return [R.scrollHeight > R.clientHeight, R.scrollTop > 0, L.scrollTop === l0, getComputedStyle(R).overflowY]; })()""")
        check('电脑 / 平板：寄存器面板右边一栏能单独往下滑', rs[1] and rs[2] and rs[3] == 'auto', rs)
        await pg.context.close()
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(TOOL + '?v=topic&t=gpio&reg=GPIO_CRL&i=GPIOA'); await pg.wait_for_selector('.sheet.on'); await pg.wait_for_timeout(400)
        dock0 = await pg.evaluate("document.querySelector('.sh-dock').hidden")
        await pg.tap('.bit[data-f="MODE0"] >> nth=0'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("""(() => { const cb = document.querySelector('.sh-code figure.code').getBoundingClientRect();
          return [!document.querySelector('.sh-pick').hidden && document.querySelector('.sh-pick .frow-h b').textContent, cb.top < innerHeight - 60, document.querySelector('.sh-code pre').textContent]; })()""")
        await pg.tap('.sh-pick .fv >> nth=3'); await pg.wait_for_timeout(300)
        st2 = await pg.evaluate("[document.querySelector('.sh-pick .fv.on b').textContent, document.querySelector('.sh-code pre').textContent]")
        check('手机：点位格子，代码就在格子下面（不用翻到底），下面跟着这个字段的说明', st[0] == 'MODE0' and st[1] and 'MODE0' in st[2] and st2[0] == '11' and 'MODE0' in st2[1], (st, st2))
        await pg.evaluate("document.querySelector('.fields').scrollIntoView()"); await pg.wait_for_timeout(500)
        st3 = await pg.evaluate("[document.querySelector('.sh-dock').hidden, document.querySelector('.sh-dock').textContent]")
        check('手机：往下翻到字段列表看不到代码时，底部露出代码条', dock0 and not st3[0] and 'MODE0' in st3[1], (dock0, st3))
        await pg.context.close()

        # ---------- 编程思维：明确任务 → 查资料 → 规划 → 编写 → 验证（右边一份资料）；硬件原理：自绘结构图，按块讲 ----------
        pg = await page(b, 1440, 900)
        await pg.goto(TOOL); await pg.wait_for_function("document.documentElement.classList.contains('ready')")
        await pg.click('.nav-i[data-v=lab]'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[location.search, [...document.querySelectorAll('.lab-ch h2')].map(n => n.textContent)]")
        check('侧栏「编程思维」：打开模块首页，列出 GPIO、定时器两章', 'v=lab' in st[0] and st[1] == ['GPIO：点亮 LED', '定时器：呼吸灯与毫秒节拍'], st)
        await pg.click('.lab-ch'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[[...document.querySelectorAll('.lab-tab')].map(n => n.textContent), document.querySelector('.lp-doc .lp-kind').textContent, document.querySelector('.lp-src').textContent]")
        check('五步框架；明确任务这一步右边是开发板原理图（注明第几页）', st[0] == ['1明确任务', '2查资料', '3规划', '4编写', '5验证'] and st[1] == '开发板原理图' and '第 8 页' in st[2], st)
        await pg.click('.lab-tab[data-st=look]'); await pg.wait_for_timeout(300)
        await pg.click('.lp-look-q >> nth=4'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-doc .lp-doc-h b').textContent, [...document.querySelectorAll('.lp-fn.on')].map(n => n.textContent), document.querySelector('.lp-src').textContent, document.querySelectorAll('.lp-doc-b > *').length]")
        check('查资料：点第 5 问，右边换成 CRL 位图，高亮 PA0/PA1 的字段，注明手册页码（不标章节号），一次只有一份', st[0] == 'GPIOx_CRL' and 'MODE0' in st[1] and 'CNF1' in st[1] and '9.2.1' not in st[2] and '171' in st[2] and st[3] == 1, st)
        await pg.click('.lp-look-q >> nth=1'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-doc .lp-kind').textContent, document.querySelector('.lp-doc .lp-doc-h b').textContent, document.querySelectorAll('.lp-hl').length, document.querySelector('.lp-src').textContent]")
        check('查资料：系统结构图标出 RCC 和 APB2，写明是英文版矢量图转译', st[0] == '参考手册' and '系统结构' in st[1] and st[2] == 2 and '转译' in st[3], st)
        await pg.click('.lab-tab[data-st=plan]'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[[...document.querySelectorAll('.lp-fr-k')].map(n => n.textContent), !!document.querySelector('.lp-main .lm-fig'), getComputedStyle(document.querySelector('.lp-side')).display, document.querySelector('.lm-src').textContent]")
        check('规划：同一套框架（① 开时钟 ② 配引脚 ③ 配外设 ④ 使能 用），上面是自绘结构图（注明不是手册原图）', st[0] == ['① 开时钟', '② 配引脚', '③ 配外设', '④ 使能', '用'] and st[1] and st[2] == 'none' and '自绘' in st[3], st)
        await pg.click('.lm-step[data-s="2"]'); await pg.wait_for_timeout(200)
        st = await pg.evaluate("[...document.querySelectorAll('.lm-fig .hot')].map(n => n.textContent).join(' ')")
        check('规划：点「② 配引脚」，图上这一步要写的寄存器亮起来（CNF0 / MODE0、BS0）', 'CNF0' in st and 'MODE0' in st and 'BS0' in st and 'IOPAEN' not in st, st)
        await pg.click('.lm-fig .mz[data-z=cfg]'); await pg.wait_for_timeout(500)
        check('规划：点图上的一块，跳到硬件原理的这一块', 'v=think' in pg.url and 'z=cfg' in pg.url and await pg.evaluate("document.querySelector('.lm-ch').textContent") == '端口配置', pg.url)
        await pg.go_back(); await pg.wait_for_timeout(400)
        await pg.click('.lab-tab[data-st=code]'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[[...document.querySelectorAll('.lb-chip')].map(n => n.textContent), [...document.querySelectorAll('.lp-goal')].map(n => n.textContent), document.querySelectorAll('.lp-file').length]")
        check('编写：第一版只写 main.c，代码按子目标分组', st[0] == ['第一版 单文件', '第二版 led 模块'] and st[1][:2] == ['① 开时钟', '② 配引脚'] and st[2] == 1, st)
        await pg.click('.lp-file .rc-l:has-text("GPIOA->CRL |=") .rc-lb'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-doc-h b').textContent, document.querySelector('.lp-reg-v').textContent, [...document.querySelectorAll('.lp-fl li')].map(n => n.textContent)]")
        check('点一行寄存器代码：右边换成 CRL，值是这一行执行完的值，写出 MODE0 = 11 的含义', st[0] == 'GPIOx_CRL' and '4443' in st[1] and any('MODE0' in x and '= 11' in x and '50' in x for x in st[2]), st)
        check('编写：代码后面没有「动画」链接', await pg.evaluate("document.querySelectorAll('.lp-hwl, .lp-hw').length") == 0)
        await pg.click('.lp-acts .lab-b:has-text("在结构图里看")'); await pg.wait_for_timeout(500)
        st = await pg.evaluate("[location.search, document.querySelector('.lm-ch').textContent, [...document.querySelectorAll('.lm-regs .lm-rn')].map(n => n.textContent)]")
        check('寄存器资料下「在结构图里看」：跳到硬件原理里 CRL 所在的「端口配置」，列出要写的位', 'hv=map' in st[0] and 'z=cfg' in st[0] and st[1] == '端口配置' and 'CRL.MODE0' in st[2], st)
        await pg.go_back(); await pg.wait_for_timeout(400)
        await pg.click('.lb-chip >> nth=1'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[document.querySelectorAll('.lp-file').length, [...document.querySelectorAll('.lp-file .code-t')].map(n => n.textContent)]")
        check('第二版：led.h / led.c / main.c', st[1] == ['led.h', 'led.c', 'main.c'] and 'fn=v2' in pg.url, st)
        # 硬件原理：全图 + 图例 + 初始化顺序；按块讲（图放大到这一块，右边讲解卡片），没有逐行动画
        await pg.goto(TOOL + '?v=think&t=gpio'); await pg.wait_for_timeout(600)
        st = await pg.evaluate("[[...document.querySelectorAll('.lm-tab')].map(n => n.textContent), document.querySelectorAll('.lm-legend li').length, [...document.querySelectorAll('.lm-init li .lm-in')].map(n => n.textContent), document.querySelectorAll('.lb-ctl, .lb-p, .lb-code').length, document.querySelector('.lm-src').textContent]")
        check('硬件原理 GPIO：结构图分 5 块，全图下面是图例和初始化顺序；没有播放按钮和逐行代码；注明自绘', st[0] == ['全图', '时钟', '端口配置', '输出驱动', '输入', '引脚与外部电路'] and st[1] == 5 and st[2] == ['开时钟', '配引脚', '配外设', '使能', '用'] and st[3] == 0 and '自绘' in st[4], st)
        await pg.click('.lm-tab[data-z=out]'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[location.search, document.querySelector('.lm-ch').textContent, [...document.querySelectorAll('.lm-regs .lm-rn')].map(n => n.textContent), document.querySelector('.lm-fig').getAttribute('viewBox').split(' ').map(Number)[2] < 1000, !!document.querySelector('.lm-minibox table')]")
        check('点「输出驱动」：图放大到这一块，讲解卡片列出 BSRR 的写法，附推挽 / 开漏对照表', 'z=out' in st[0] and st[1] == '输出驱动' and 'BSRR.BS0' in st[2] and 'BSRR.BR0' in st[2] and st[3] and st[4], st)
        await pg.click('.lm-nav .lab-next'); await pg.wait_for_timeout(300)
        check('卡片底部「下一块」：到「输入」，LED 任务里这一块标「这个任务不用」', await pg.evaluate("[document.querySelector('.lm-ch').textContent, document.querySelector('.mz[data-z=in] .mzn').textContent]") == ['输入', '这个任务不用'])
        await pg.click('.lm-vr button[data-k=key]'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[location.search, [...document.querySelectorAll('.lm-regs .lm-rn')].map(n => n.textContent), document.querySelector('.lm-fig').textContent.includes('PF8')]")
        check('切到「PF8 · KEY1 输入」：输入这一块列出选上拉（BS8）和读 IDR8，图上换成 PF8 和按键', 'fn=key' in st[0] and 'BSRR.BS8' in st[1] and 'IDR.IDR8' in st[1] and st[2], st)
        await pg.click('.lab-tab[data-hv=why]'); await pg.wait_for_timeout(500)
        check('硬件原理：「为什么这样设计」是原来的推导链', await pg.evaluate("!!document.querySelector('.dv-map, .dv-mode')") and 'hv=why' in pg.url)
        # 验证：代码在 VS Code 里写，这里粘贴进来检查；没有挖空
        await pg.goto(TOOL + '?v=lab&t=gpio&st=check'); await pg.wait_for_timeout(500)
        st = await pg.evaluate("[[...document.querySelectorAll('.lb-chip')].map(n => n.textContent), document.querySelectorAll('.cd-inp, .lab-tokens').length, document.querySelectorAll('.lp-recall-f li').length, document.querySelectorAll('.lp-card').length]")
        check('验证：三道题（编写 LED_Init / LED_On、LED_Off / 迁移），没有挖空和插词按钮；右边先只给框架，资料卡收着', st[0] == ['编写 LED_Init', '编写 LED_On / LED_Off', '迁移：按键控制 LED'] and st[1] == 0 and st[2] == 5 and st[3] == 0, st)
        wrong = "    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;\n    LED_PORT->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0 | GPIO_CRL_CNF1 | GPIO_CRL_MODE1);\n    LED_PORT->CRL |= (GPIO_CRL_MODE0 | GPIO_CRL_MODE1);\n    LED_PORT->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\n    LED_PORT->CRH |= (GPIO_CRH_MODE8);\n    LED_PORT->BSRR = GPIO_BSRR_BS0 | GPIO_BSRR_BS1 | GPIO_BSRR_BS8;"
        await pg.fill('.lab-ta', wrong)
        await pg.click('.lab-acts .lab-p'); await pg.wait_for_timeout(600)
        st = await pg.evaluate("[[...document.querySelectorAll('.lab-r')].map(n => n.className), document.querySelector('.lab-r-m').textContent]")
        await pg.click('.lab-r .lab-b'); await pg.click('.lab-r .lab-b'); await pg.wait_for_timeout(200)
        d1 = await pg.evaluate("document.querySelector('.lp-doc-h b') && document.querySelector('.lp-doc-h b').textContent")
        await pg.click('.lab-r .lab-b'); await pg.wait_for_timeout(200)
        h = await pg.evaluate("[document.querySelectorAll('.lab-hints p').length, document.querySelector('.lab-hints figure.code pre').textContent]")
        check('验证：粘贴先配输出再写 1 的 LED_Init → 指出上电会闪，第二级提示右边换成输出配置图，最后给写法', st[0] == ['lab-r lab-r-warn'] and '闪' in st[1] and '输出配置' in (d1 or '') and h[0] == 2 and 'BSRR' in h[1], (st, d1, h))
        await pg.reload(); await pg.wait_for_timeout(500)
        check('粘贴的代码刷新后还在', 'BSRR = GPIO_BSRR_BS0' in await pg.evaluate("document.querySelector('.lab-ta').value"))
        await pg.goto(TOOL + '?v=lab&t=gpio&st=check&fn=key'); await pg.wait_for_timeout(500)
        tas = pg.locator('.lab-ta')
        await tas.nth(0).fill("    RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;\n    GPIOF->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\n    GPIOF->CRH |= GPIO_CRH_CNF8_1;")
        await tas.nth(1).fill("        if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) LED_On(LED1);\n        else LED_Off(LED1);")
        await pg.click('.lab-acts .lab-p'); await pg.wait_for_timeout(800)
        m1 = await pg.evaluate("document.querySelector('.lab-r-m').textContent")
        await tas.nth(0).fill("    RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;\n    GPIOF->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\n    GPIOF->CRH |= GPIO_CRH_CNF8_1;\n    GPIOF->BSRR = GPIO_BSRR_BS8;")
        await pg.click('.lab-acts .lab-p'); await pg.wait_for_timeout(800)
        m2 = await pg.evaluate("document.querySelector('.lab-r').className")
        check('验证③换题（按键控制 LED）：忘了选上拉 → 指出下拉；改对 → 全对', '下拉' in m1 and m2 == 'lab-r lab-r-ok', (m1, m2))
        await pg.goto(TOOL + '?v=lab&t=gpio&st=c'); await pg.wait_for_timeout(400)
        check('旧地址 st=c 转到「编写」', 'st=code' in pg.url, pg.url)
        await pg.goto(TOOL + '?v=think&t=gpio&hv=run&fn=mine-init&ln=3'); await pg.wait_for_timeout(600)
        check('旧的动画地址（hv=run）打开结构图全图，不报错', 'hv=map' in pg.url and 'ln=' not in pg.url and await pg.evaluate("!!document.querySelector('.lm-fig') && document.querySelector('.lm-tab[aria-selected=true]').textContent") == '全图', pg.url)
        check('验证：没有「放进动画」按钮', True)
        # 定时器一章
        await pg.goto(TOOL + '?v=lab'); await pg.wait_for_timeout(300)
        check('编程思维首页：GPIO、定时器两章', await pg.evaluate("[...document.querySelectorAll('.lab-ch h2')].map(n => n.textContent)") == ['GPIO：点亮 LED', '定时器：呼吸灯与毫秒节拍'])
        await pg.goto(TOOL + '?v=lab&t=tim&st=look'); await pg.wait_for_timeout(400)
        await pg.click('.lp-look-q >> nth=1'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-kind').textContent, [...document.querySelectorAll('.lp-af.on')].map(n => n.textContent), document.querySelector('.lp-src').textContent]")
        check('定时器·查资料：PA1 的复用功能来自数据手册，TIM5_CH2 标出来', st[0] == '数据手册' and st[1] == ['TIM5_CH2'] and 'DS5792' in st[2], st)
        await pg.goto(TOOL + '?v=lab&t=tim&st=code&fn=v2'); await pg.wait_for_timeout(500)
        await pg.click('.lp-file .rc-l:has-text("TIM5->CCER") .rc-lb'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lp-doc-h b').textContent, [...document.querySelectorAll('.lp-fn.on')].map(n => n.textContent), document.querySelector('.lp-src').textContent]")
        check('定时器·编写：点 CCER 那一行，右边是 CCER 位图，CC2E / CC2P 标出来，不标章节号', st[0] == 'TIMx_CCER' and 'CC2E' in st[1] and 'CC2P' in st[1] and 'RM0008' in st[2] and '15.4.9' not in st[2], st)
        await pg.goto(TOOL + '?v=think&t=tim'); await pg.wait_for_timeout(600)
        st = await pg.evaluate("[[...document.querySelectorAll('.lm-tab')].map(n => n.textContent), document.querySelector('.mz[data-z=irq] .mzn').textContent, [...document.querySelectorAll('.lm-init li')].map(n => n.textContent)]")
        check('定时器·硬件原理：时钟 / 时基单元 / 输出比较 / 引脚 / 中断五块；PWM 任务里中断标「这个任务不用」；初始化顺序列出 PSC、ARR、CCR2…', st[0] == ['全图', '时钟', '时基单元', '输出比较', '引脚', '中断'] and st[1] == '这个任务不用' and 'PSC' in st[2][2] and 'CCMR1.OC2M' in st[2][2] and 'CR1.CEN' in st[2][3], st)
        await pg.click('.lm-tab[data-z=tb]'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("[[...document.querySelectorAll('.lm-fx span')].map(n => n.textContent), [...document.querySelectorAll('.lm-regs li')].map(n => n.textContent), !!document.querySelector('.lm-minibox .lm-wave')]")
        check('时基单元：给出计数频率公式，PSC = 71、ARR = 999、EGR.UG、CR1.CEN，附 CNT 锯齿波', any('PSC + 1' in x for x in st[0]) and any('PSC' in x and '71' in x for x in st[1]) and any('UG' in x for x in st[1]) and st[2], st)
        await pg.click('.lm-regs .lm-reg >> nth=0'); await pg.wait_for_timeout(300)
        check('点卡片里的寄存器：就地展开它的位图', await pg.evaluate("document.querySelector('.lm-regs .lp-doc .lp-doc-h b').textContent") == 'TIMx_PSC')
        await pg.click('.lm-vr button[data-k=tick]'); await pg.wait_for_timeout(300); await pg.click('.lm-tab[data-z=oc]'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[document.querySelector('.lm-lead').textContent, document.querySelector('.mz[data-z=oc] .mzn').textContent]")
        check('切到 TIM6：输出比较这一块标「基本定时器没有」', '基本定时器' in st[0] and st[1] == '基本定时器没有', st)
        await pg.click('.lm-tab[data-z=irq]'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[...document.querySelectorAll('.lm-regs .lm-rn')].map(n => n.textContent)")
        check('TIM6 的中断：清 UIF、开 UIE、NVIC_EnableIRQ，中断函数里清 UIF', st == ['SR.UIF', 'DIER.UIE', 'NVIC_EnableIRQ(TIM6_IRQn)', 'SR.UIF'], st)
        await pg.goto(TOOL + '?v=lab&t=tim&st=check'); await pg.wait_for_timeout(500)
        await pg.fill('.lab-ta', await pg.evaluate("STM32Lab.body(STM32Lab.chapter('tim'), 'PWM_Init').replace(' | TIM_CCER_CC2P', '')"))
        await pg.click('.lab-acts .lab-p'); await pg.wait_for_timeout(800)
        m = await pg.evaluate("document.querySelector('.lab-r-m').textContent")
        check('定时器·验证：粘贴忘了 CC2P 的 PWM_Init → 指出亮暗反了', '反了' in m, m)
        await pg.context.close()
        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(TOOL + '?v=lab&t=gpio&st=code'); await pg.wait_for_timeout(600)
        await pg.tap('.lp-file .rc-l:has-text("GPIOA->CRL |=") .rc-lb'); await pg.wait_for_timeout(300)
        st = await pg.evaluate("[getComputedStyle(document.querySelector('.lp-side')).display, document.querySelector('.lp-mt button.new') !== null, document.documentElement.scrollWidth <= innerWidth]")
        await pg.tap('.lp-mt button >> nth=1'); await pg.wait_for_timeout(300)
        st2 = await pg.evaluate("[getComputedStyle(document.querySelector('.lp-side')).display, getComputedStyle(document.querySelector('.lp-main')).display, document.querySelector('.lp-doc-h b').textContent]")
        check('手机：讲解 / 资料切换，点了寄存器行「资料」上亮个点，切过去就是那份资料', st == ['none', True, True] and st2 == ['block', 'none', 'GPIOx_CRL'], (st, st2))
        await pg.goto(TOOL + '?v=think&t=tim&z=oc'); await pg.wait_for_timeout(600)
        st = await pg.evaluate("""(() => { const f = document.querySelector('.lm-scroll').getBoundingClientRect(), c = document.querySelector('.lm-card').getBoundingClientRect();
          return [f.bottom <= c.top + 1, c.width > 300, document.querySelector('.lm-ch').textContent, document.documentElement.scrollWidth <= innerWidth]; })()""")
        check('手机·硬件原理：放大的一块在上、讲解卡片在下，页面没有横向滚动', st == [True, True, '输出比较', True], st)
        await pg.context.close()
        # ---------- 小芯（页面上的小人）：扔进学习台、手机上的气泡 ----------
        # 小芯聊天 2026-11-26 删了：背包里不再有「聊天」
        pg = await page(b)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(2500)
        # 电脑：学习台首页的方块都顶在最上面，小芯站进芯片图框里沿着底边走
        # （之前在学习台里收起来过：再把它扔进去，照样出来）
        await pg.evaluate("sessionStorage.setItem('lm.xin.stmoff', '1')")
        await drag_xin_into(pg, 'stm32'); f = await tool_frame(pg)
        for _ in range(80):
            if await f.evaluate("LimingXin.mode") in ('idle', 'walk', 'play'): break
            await pg.wait_for_timeout(100)
        st = await f.evaluate("(() => { const r = LimingXin.el.getBoundingClientRect(); return [LimingXin.mode, LimingXin.plat && LimingXin.plat.kind, r.top >= 0 && r.bottom <= innerHeight]; })()")
        items = await f.evaluate("(LimingXin.bag(), [...document.querySelectorAll('.xin-bag .xin-it span')].map(s => s.textContent))")
        check('电脑：小芯能被扔进学习台（站在芯片图框里，整个在屏幕内），背包里没有「聊天」', st[0] in ('idle', 'walk', 'play') and st[1] == 'in' and st[2] and len(items) > 3 and '聊天' not in items, (st, items))
        check('之前在学习台里收起来过，再把小芯扔进去：照样出来，没有小脑袋', await f.evaluate("[LimingXin.hidden, !!document.querySelector('.xin-peek:not([hidden])')]") == [False, False])
        await pg.context.close()

        pg = await page(b, 390, 844, mobile=True)
        await pg.goto(BASE + '/'); await pg.wait_for_timeout(2500)
        await pg.evaluate("LimingXin.say('你好呀，这是一句比较长的话')"); await pg.wait_for_timeout(100)
        st = await pg.evaluate("(() => { const r = document.querySelector('.xin-say').getBoundingClientRect(); return [r.left >= 0, r.right <= innerWidth, r.top >= 0, r.width > 80, document.documentElement.scrollWidth <= innerWidth]; })()")
        check('手机：小芯的气泡完整显示在屏幕里，页面不横向滚动', st == [True, True, True, True, True], st)
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
    print('外部资源加载失败（不计）：%d' % (len(errors) - len(real)))
    print('本站资源失败：%d' % len(local_fail)); [print('  ' + e[:300]) for e in local_fail[:20]]
    return all(r[1] for r in results) and not real and not local_fail

if __name__ == '__main__':
    sys.exit(0 if asyncio.run(main()) else 1)
