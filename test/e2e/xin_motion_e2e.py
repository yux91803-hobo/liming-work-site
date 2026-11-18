"""小芯工作台动画（站长 2026-11-19「做吧，兄弟支持你」）。设计 docs/superpowers/specs/2026-11-19-xin-motion-design.md
每条都查：新来的才动、动画名对、「减少动态」时不动。"""
import asyncio, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import stm32_e2e as ui
from playwright.async_api import async_playwright

# 首页露没露出来：从页面一开始每一帧都看，工作台出来就停
SEEN = """document.addEventListener('DOMContentLoaded', () => { window.__homeSeen = 0; const tick = () => {
  const h = document.getElementById('home'), w = document.querySelector('.xc.wb.show');
  if (h && !w && getComputedStyle(h).visibility !== 'hidden' && h.getBoundingClientRect().height > 0) window.__homeSeen++;
  if (!w) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });"""
# 数 View Transition 用了几次、当时 <html> 上挂的是哪个场景
VT = """window.__vt = []; if (document.startViewTransition) { const o = document.startViewTransition.bind(document);
  document.startViewTransition = cb => { const t = o(cb); requestAnimationFrame(() => window.__vt.push([...document.documentElement.classList].filter(c => c.startsWith('vt-')).join(' '))); return t; }; }"""


async def deep_link(browser):
    pg = await ui.page(browser, 390, 844, True)
    await ui.xin_mock(pg, authed=True)
    await pg.add_init_script(SEEN)
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    await pg.wait_for_timeout(300)
    r = await pg.evaluate("[window.__homeSeen, document.documentElement.classList.contains('xc-boot-work')]")
    ui.check('直接打开工作台：首页一帧都不露（以前先闪约 0.3 秒首页），工作台出来就放开', r == [0, False], r)
    await pg.context.close()


async def home_to_work(browser, reduce):
    pg = await ui.page(browser, 1280, 860)
    await ui.xin_mock(pg, authed=True)
    await pg.add_init_script(VT)
    if reduce:
        await pg.emulate_media(reduced_motion='reduce')
    await pg.goto(ui.BASE + '/')
    await pg.wait_for_selector('.xw-head')
    await pg.click('.xw-head')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    await pg.wait_for_timeout(800)
    r = await pg.evaluate("[window.__vt, document.documentElement.classList.contains('vt-work')]")
    if reduce:
        ui.check('减少动态：从首页进工作台不做过渡，直接打开', r == [[], False], r)
    else:
        ui.check('从首页点进工作台：用 View Transition（像素点阵溶解），做完把场景类去掉', r == [['vt-work'], False], r)
    await pg.context.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        await deep_link(browser)
        await home_to_work(browser, False)
        await home_to_work(browser, True)
        await browser.close()
    n = len(ui.results); ok = sum(1 for r in ui.results if r[1])
    print('==== %d/%d 通过 ====' % (ok, n))
    return ok == n and not ui.local_fail

if __name__ == '__main__':
    sys.exit(0 if asyncio.run(main()) else 1)
