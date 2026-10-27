"""STM32 端到端实测（需要 python playwright + chromium）：先 npm run dev，再 python3 test/e2e/stm32_e2e.py [http://localhost:5173]"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173'
INSTR = """
  window.__rs = 0; window.__ps = 0;
  const R = history.replaceState.bind(history), P = history.pushState.bind(history);
  history.replaceState = function () { window.__rs++; return R.apply(null, arguments); };
  history.pushState = function () { window.__ps++; return P.apply(null, arguments); };
"""
results, errors = [], []

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (('  — ' + str(detail)) if detail != '' else ''), flush=True)

async def new_page(b, w=1280, h=900, mobile=False):
    ctx = await b.new_context(viewport={'width': w, 'height': h}, has_touch=mobile, is_mobile=mobile)
    await ctx.add_init_script(INSTR)
    pg = await ctx.new_page()
    pg.on('pageerror', lambda e: errors.append('pageerror ' + pg.url + ' :: ' + str(e)))
    pg.on('console', lambda m: errors.append('console.error ' + m.text) if m.type == 'error' else None)
    return pg

async def tool_frame(pg):
    for _ in range(100):
        for f in pg.frames:
            if '/tools/stm32/' in f.url:
                try:
                    if await f.evaluate("!!document.querySelector('.seg.ready')"): return f
                except Exception: pass
        await pg.wait_for_timeout(100)
    raise RuntimeError('stm32 iframe not ready')

async def wait_shown(f, timeout=8000):
    await f.wait_for_function("document.querySelector('#viewer.open') && document.querySelector('#vwContent.shown img')", timeout=timeout)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()

        # ---------- 1. 嵌在工具箱里：连续翻课件 + 返回键层级 ----------
        pg = await new_page(b)
        await pg.goto(BASE + '/stm32'); f = await tool_frame(pg)
        await f.click('.seg-btn[data-tab=course]'); await pg.wait_for_timeout(300)
        await f.click('.cw-main'); await wait_shown(f)
        start = await f.evaluate("document.getElementById('vwCount').textContent")
        rs0 = (await pg.evaluate('__rs')) + (await f.evaluate('__rs'))
        N = 120
        for _ in range(N):
            await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(30)
        await pg.wait_for_timeout(900)
        rs1 = (await pg.evaluate('__rs')) + (await f.evaluate('__rs'))
        cnt = await f.evaluate("document.getElementById('vwCount').textContent")
        cur = int(cnt.split('/')[0])
        check('翻页 %d 次后页码正确' % N, cur == min(int(start.split('/')[0]) + N, int(cnt.split('/')[1])), start + ' → ' + cnt)
        check('翻页期间地址写入次数（两个页面合计）', rs1 - rs0 <= 40, '%d 次 / %d 次翻页' % (rs1 - rs0, N))
        purl = await pg.evaluate('location.pathname + location.search')
        check('外壳地址跟到当前页', ('cw=v20-%d' % cur) in purl, purl)
        await pg.wait_for_function("document.querySelector('#vwContent.shown img')", timeout=8000) if False else None
        await f.wait_for_function("document.querySelector('#vwContent.shown')", timeout=8000)
        await pg.go_back(); await pg.wait_for_timeout(700)
        v_open = await f.evaluate("document.getElementById('viewer').classList.contains('open')")
        tool_open = await pg.evaluate("!!document.querySelector('#stage .panel.show')")
        purl = await pg.evaluate('location.pathname + location.search')
        check('第一次返回：只关查看器，工具还开着', (not v_open) and tool_open, purl)
        check('关查看器后地址去掉 cw', 'cw=' not in purl, purl)
        await pg.go_back(); await pg.wait_for_timeout(900)
        tool_open = await pg.evaluate("!!document.querySelector('#stage .panel.show')")
        check('第二次返回：关闭工具回首页', (not tool_open) and await pg.evaluate("location.pathname") == '/', await pg.evaluate('location.href'))
        # 再打开 → 查看器 → 返回，仍然一层一层
        await pg.click('.card[data-id=stm32]'); f = await tool_frame(pg); await pg.wait_for_timeout(600)
        await f.click('.seg-btn[data-tab=course]'); await f.click('.cw-main'); await wait_shown(f)
        await pg.go_back(); await pg.wait_for_timeout(700)
        check('重新打开后返回仍只关查看器',
              (not await f.evaluate("document.getElementById('viewer').classList.contains('open')")) and await pg.evaluate("!!document.querySelector('#stage .panel.show')"))
        await pg.context.close()

        # ---------- 2. 深链（经工具箱外壳） ----------
        async def deep(qs):
            pg = await new_page(b); await pg.goto(BASE + '/stm32' + qs); f = await tool_frame(pg); await pg.wait_for_timeout(1200); return pg, f
        pg, f = await deep('?cw=v20-16'); await wait_shown(f)
        check('深链 ?cw=v20-16 打开课件第 16 页', (await f.evaluate("document.getElementById('vwCount').textContent")).startswith('16/'))
        await pg.context.close()
        pg, f = await deep('?tab=chip&page=board-05'); await wait_shown(f)
        check('深链 ?page=board-05 打开原理图', await f.evaluate("document.getElementById('viewer').classList.contains('open')"),
              await f.evaluate("document.getElementById('vwTitle').textContent"))
        await pg.context.close()
        pg, f = await deep('?reg=GPIO_CRL&f=MODE3&i=GPIOB&y=3')
        await f.wait_for_function("document.getElementById('pane-regs').textContent.includes('GPIO_CRL')", timeout=8000)
        check('深链 ?reg=GPIO_CRL 打开寄存器', await f.evaluate("document.querySelector('.seg-btn[aria-selected=true]').dataset.tab") == 'regs')
        await pg.context.close()
        pg, f = await deep('?tab=pins&q=PA9')
        check('深链 ?q=PA9 填入引脚搜索', await f.evaluate("document.getElementById('q').value") == 'PA9')
        await pg.context.close()

        # ---------- 3. 独立打开：跨页跳转、搜索、快速打字 ----------
        pg = await new_page(b); await pg.goto(BASE + '/tools/stm32/'); await pg.wait_for_function("document.querySelector('.seg.ready')")
        await pg.click('.seg-btn[data-tab=course]'); await pg.wait_for_timeout(300)
        await pg.click('.cw-row:has(.cw-code) .cw-code')
        await pg.wait_for_timeout(1500)
        tab = await pg.evaluate("document.querySelector('.seg-btn[aria-selected=true]').dataset.tab")
        check('课件「代码」跳到代码片段', tab == 'code', await pg.evaluate('location.search'))
        await pg.click('.seg-btn[data-tab=course]'); await pg.wait_for_timeout(300)
        await pg.click('.cw-row:has(.cw-pin) .cw-pin'); await pg.wait_for_timeout(500)
        qv = await pg.evaluate("document.getElementById('q').value")
        check('课件「引脚」跳到引脚并填好搜索', bool(qv) and await pg.evaluate("document.querySelector('.seg-btn[aria-selected=true]').dataset.tab") == 'pins', qv)
        await pg.fill('#q', ''); await pg.click('#q')
        rs0 = await pg.evaluate('__rs')
        await pg.keyboard.type('USART1 TX PA9 TIM2 CH1 PB6', delay=20); await pg.wait_for_timeout(700)
        check('快速输入 26 字的地址写入次数', await pg.evaluate('__rs') - rs0 <= 6, await pg.evaluate('__rs') - rs0)
        check('最终地址和输入一致', 'q=USART1+TX+PA9+TIM2+CH1+PB6' in await pg.evaluate('location.search'))
        await pg.fill('#q', ''); await pg.keyboard.press('Escape')
        await pg.keyboard.press('Control+k'); await pg.wait_for_timeout(1500)
        for qs, want in [('UART1', 'PA9'), ('IIC', None), ('GPIO_CRL', 'GPIOx_CRL'), ('PA 9', 'PA9')]:
            await pg.fill('.lm-search-input', qs); await pg.wait_for_timeout(300)
            got = await pg.evaluate("[...document.querySelectorAll('.lm-result strong')].map(x=>x.textContent)")
            ok = len(got) > 0 and (want is None or want in got[:6])
            check('全局搜索「%s」' % qs, ok, got[:5])
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
        esc1 = await pg.evaluate("!!document.querySelector('.lm-dialog[open]')")
        if esc1: await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
        check('（观察）搜索框有字时 Esc 一次就关闭搜索', not esc1, '需要按两次' if esc1 else '')
        # 独立打开时查看器的返回
        await pg.click('.seg-btn[data-tab=course]'); await pg.click('.cw-main'); await wait_shown(pg)
        for _ in range(30): await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(25)
        await pg.wait_for_timeout(600); await pg.go_back(); await pg.wait_for_timeout(700)
        check('独立打开：返回关闭查看器并清掉 cw', (not await pg.evaluate("document.getElementById('viewer').classList.contains('open')")) and 'cw=' not in await pg.evaluate('location.search'),
              await pg.evaluate('location.search'))
        # 代码片段高亮缓存后：切分类多次，内容与复制文本不变
        await pg.click('.seg-btn[data-tab=code]'); await pg.click('#codeCats .cat[data-cat="全部"]'); await pg.wait_for_timeout(200)
        a = await pg.evaluate("document.getElementById('codeList').textContent")
        await pg.click('#codeCats .cat[data-cat=\"串口\"]'); await pg.click('#codeCats .cat[data-cat=\"全部\"]'); await pg.wait_for_timeout(200)
        b2 = await pg.evaluate("document.getElementById('codeList').textContent")
        check('代码片段切分类后内容一致（高亮缓存）', a == b2 and await pg.evaluate("document.querySelectorAll('#codeList .hl-kw').length") > 50)
        await pg.context.close()

        # ---------- 4. 手机尺寸：课件左右滑翻页 ----------
        pg = await new_page(b, 390, 844, mobile=True)
        await pg.goto(BASE + '/tools/stm32/?cw=v21-10'); await wait_shown(pg)
        st = await pg.query_selector('#vwStage'); bb = await st.bounding_box()
        y = bb['y'] + bb['height'] / 2
        await pg.evaluate("""([x0, x1, y]) => {
          const s = document.getElementById('vwStage');
          const ev = (t, x) => s.dispatchEvent(new PointerEvent(t, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
          ev('pointerdown', x0); ev('pointermove', (x0 + x1) / 2); ev('pointermove', x1); ev('pointerup', x1);
        }""", [bb['x'] + 330, bb['x'] + 60, y])
        await pg.wait_for_timeout(600)
        check('手机：左滑翻到下一页', (await pg.evaluate("document.getElementById('vwCount').textContent")).startswith('11/'),
              await pg.evaluate("document.getElementById('vwCount').textContent"))
        await pg.screenshot(path='shot-mobile-cw.png')
        await pg.context.close()
        await b.close()

    print('\n==== %d/%d 通过 ====' % (sum(1 for r in results if r[1]), len(results)))
    real = [e for e in errors if 'Failed to load resource' not in e]
    print('JS 报错：%d' % len(real)); [print('  ' + e[:300]) for e in real[:20]]
    print('资源 404：%d' % (len(errors) - len(real)))

asyncio.run(main())
