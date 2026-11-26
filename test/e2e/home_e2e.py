"""工具箱首页的动效（原来在 xin_motion_e2e.py 里，2026-11-26 小芯、天启删了，只留首页本身的检查）：
主题按钮的扩散换色、卡片插画、指针追光和 ✻ 迸火花。"""
import asyncio, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import stm32_e2e as ui
from playwright.async_api import async_playwright

# 数 View Transition 用了几次、当时 <html> 上挂的是哪个场景；过渡没走成记进 __vterr
VT = """window.__vt = []; window.__vterr = []; if (document.startViewTransition) { const o = document.startViewTransition.bind(document);
  document.startViewTransition = cb => { const t = o(cb); t.ready.catch(e => window.__vterr.push(e.name)); requestAnimationFrame(() => window.__vt.push([...document.documentElement.classList].filter(c => c.startsWith('vt-')).join(' '))); return t; }; }"""


async def theme(browser):
    pg = await ui.page(browser, 1280, 860)
    await pg.add_init_script(VT)
    await pg.goto(ui.BASE + '/')
    await pg.wait_for_selector('#themeBtn')
    before = await pg.evaluate("document.documentElement.dataset.theme")
    await pg.click('#themeBtn')
    await pg.wait_for_timeout(900)
    home = await pg.evaluate("[window.__vt.slice(), document.documentElement.dataset.theme, document.documentElement.classList.contains('vt-theme'), window.__vterr]")
    ui.check('首页的主题按钮：深浅色从点的地方一圈圈扩散着换（View Transition，场景 vt-theme），做完把场景类去掉',
             home[0] == ['vt-theme'] and home[1] != before and not home[2] and home[3] == [], home)
    await pg.context.close()


async def cards(browser):
    pg = await ui.page(browser, 1280, 860)
    await pg.goto(ui.BASE + '/')
    await pg.wait_for_selector('.card[data-id="map"] .w-beacons')
    arts = await pg.evaluate("""(() => ({
      ids: [...document.querySelectorAll('.card[data-id]')].map(c => c.dataset.id),
      cats: [...document.querySelectorAll('.cat-h')].map(h => h.textContent.trim()),
      world: document.querySelectorAll('.card[data-id="map"] .w-beacons .b-ring').length,
      chip: document.querySelectorAll('.card[data-id="stm32"] .traces .tr-sig').length,
      xin: !!document.querySelector('#xinWork, .xc, .xw') || typeof window.LimingXinChat !== 'undefined',
      mascot: !!window.LimingXin && !!document.querySelector('#xinTrack'),
    }))()""")
    ui.check('首页只剩世界地图和 STM32 两张卡（天启和小芯聊天删了），页面上的小人还在',
             sorted(arts['ids']) == ['map', 'stm32'] and not arts['xin'] and arts['mascot'], arts)
    ui.check('首页卡片插画：世界地图有坐标信标脉冲、STM32 有 PCB 铜箔脉冲走线', arts['world'] == 4 and arts['chip'] >= 6, arts)
    cbox = await pg.locator('.card[data-id="map"]').bounding_box()
    await pg.mouse.move(cbox['x'] + 120, cbox['y'] + 60)
    await pg.wait_for_timeout(60)
    mx = await pg.evaluate("document.querySelector('.card[data-id=\"map\"]').style.getPropertyValue('--mx')")
    await pg.click('.hd .spark')
    sparks_on = await pg.evaluate("document.querySelectorAll('.hm-spark').length")
    ui.check('首页指针追光与像素迸发火花：鼠标移过卡片写入 --mx 追光坐标，点 ✻ 迸出 8 颗像素火花',
             bool(mx) and sparks_on == 8, (mx, sparks_on))
    await pg.context.close()


async def main():
    async with async_playwright() as p:
        exe = os.environ.get('CHROMIUM_PATH')
        browser = await p.chromium.launch(**({'executable_path': exe} if exe else {}))
        await theme(browser)
        await cards(browser)
        await browser.close()
    n = len(ui.results); ok = sum(1 for r in ui.results if r[1])
    print('==== %d/%d 通过 ====' % (ok, n))
    return ok == n and not ui.local_fail

if __name__ == '__main__':
    sys.exit(0 if asyncio.run(main()) else 1)
