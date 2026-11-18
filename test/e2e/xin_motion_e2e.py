"""小芯工作台动画（站长 2026-11-19「做吧，兄弟支持你」）。设计 docs/superpowers/specs/2026-11-19-xin-motion-design.md
每条都查：新来的才动、动画名对、「减少动态」时不动。"""
import asyncio, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import stm32_e2e as ui
import json
import xin_term_e2e as T
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


async def send_and_reply(browser, reduce):
    pg = await ui.page(browser, 1280, 860)
    await ui.xin_mock(pg, authed=True, live=[[{'t': 'text', 'text': '第一段。\n\n第二段。\n\n- 第三条\n- 第四条'}], [{'t': 'done', 'ok': True, 'code': 0, 'ms': 900}]])
    if reduce:
        await pg.emulate_media(reduced_motion='reduce')
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    await pg.click('.xc-new-b')
    await pg.fill('.xc-row textarea', '帮我看看')
    await pg.keyboard.press('Enter')
    await pg.wait_for_selector('.xc-me .xc-bub')
    me = await pg.evaluate("(() => { const b = [...document.querySelectorAll('.xc-me')].pop(); const s = getComputedStyle(b.querySelector('.xc-bub')); return [s.animationName, b.classList.contains('fly'), (b.querySelector('.xc-bub').style.getPropertyValue('--fy') || '').trim() !== '']; })()")
    await pg.wait_for_function("[...document.querySelectorAll('.xc-ai .xc-md')].some(e => e.textContent.includes('第二段'))", timeout=10000)
    ai = await pg.evaluate("""(() => { const m = [...document.querySelectorAll('.xc-ai')].filter(e => e.textContent.includes('第二段')).pop(), kids = [...m.querySelectorAll(':scope > .xc-bub > .xc-md > *')];
      return [kids.map(k => getComputedStyle(k).animationName), kids.map(k => parseFloat(getComputedStyle(k).animationDelay)), getComputedStyle(m.querySelector(':scope > .xc-bub'), '::after').animationName]; })()""")
    if reduce:
        ui.check('减少动态：发出去的话和回答都不飞、不逐段淡入、不扫光', me[0] == 'none' and set(ai[0]) <= {'none'} and ai[2] in ('none', ''), (me, ai))
    else:
        ui.check('发消息：你的话从输入框飞上去变成气泡（xcfly，带位移）', me == ['xcfly', True, True], me)
        ui.check('小芯的回答一段段淡入（xcline，延迟依次变大），整条有一道微光扫过（xcshine）',
                 len(ai[0]) >= 3 and set(ai[0]) == {'xcline'} and ai[1] == sorted(ai[1]) and ai[1][0] < ai[1][-1] and ai[2] == 'xcshine', ai)
    await pg.context.close()


async def history_still(browser):
    pg = await ui.page(browser, 1280, 860)
    await ui.xin_mock(pg, authed=True)
    await pg.add_init_script("if (!sessionStorage.getItem('__h')) { sessionStorage.setItem('__h', '1'); localStorage.setItem('lm.xin.sid','shist00001'); }")
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_function("LimingXinChat.state.sid === 'shist00001' && !!document.querySelector('.xc-ai .xc-md')", timeout=10000)
    old = await pg.evaluate("[...document.querySelectorAll('.xc-msgs .xc-md > *, .xc-msgs .xc-me > .xc-bub')].map(k => getComputedStyle(k).animationName)")
    ui.check('历史里的消息打开时不飞、不逐段淡入', len(old) > 0 and set(old) <= {'none'}, old)
    await pg.context.close()


async def task_box(browser, reduce):
    pg = await ui.page(browser, 1280, 860)
    front = [[{'t': 'text', 'text': '我派后台去编一下 blink。'}, {'t': 'task', 'sid': T.TASK, 'no': 1, 'title': '编译 blink', 'kind': 'code', 'status': 'queued', 'after': [], 'at': T.now()}],
             [{'t': 'done', 'ok': True, 'code': 0, 'ms': 900}]]
    st = await ui.xin_mock(pg, authed=True, live=front)
    st['tasks'] = []
    if reduce:
        await pg.emulate_media(reduced_motion='reduce')
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    await pg.click('.xc-new-b')
    await pg.fill('.xc-row textarea', '帮我编一下 blink')
    await pg.keyboard.press('Enter')
    BOX = '.xc-tb[data-tsid="%s"]' % T.TASK
    await pg.wait_for_selector(BOX)
    build = await pg.evaluate("getComputedStyle(document.querySelector('%s')).animationName" % BOX)
    st['tasks'] = [T.task(status='running', run='rtask00b01', startedAt=T.now() - 3000)]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_function("document.querySelector('%s').classList.contains('live')" % BOX, timeout=5000)
    orbit = await pg.evaluate("getComputedStyle(document.querySelector('%s'), '::before').animationName" % BOX)
    await pg.wait_for_function("!document.querySelector('.xc-typing')", timeout=10000)
    y0 = await pg.evaluate("document.querySelector('%s').getBoundingClientRect().top" % BOX)
    st['tasks'] = [T.task(status='done', run='rtask00b01', startedAt=T.now() - 9000, endedAt=T.now(), result={'ok': True, 'text': '编好了：`/data/workspace/blink/build/app.hex`。', 'at': T.now()}, delivery={'state': 'delivered', 'at': T.now()})]
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.wait_for_selector('.xc-tres')
    done = await pg.evaluate("""(() => { const b = document.querySelector('%s'), r = document.querySelector('.xc-tres'), w = b.closest('.xc-tbw');
      return [b.classList.contains('stamp'), b.querySelectorAll('.xc-spark').length, getComputedStyle(b.querySelector('.xc-tb-i')).animationName, getComputedStyle(r).animationName,
        w.getAnimations().some(a => a.effect && a.effect.getKeyframes().some(k => String(k.transform || '').includes('translateY')))]; })()""" % BOX)
    await pg.wait_for_timeout(1000)
    after = await pg.evaluate("document.querySelectorAll('.xc-spark').length")
    if reduce:
        ui.check('减少动态：任务框不搭、不绕光、做完不盖章不迸火花、不滑', build == 'none' and orbit in ('none', '') and done[:3] == [False, 0, 'none'] and not done[4], (build, orbit, done))
    else:
        ui.check('派活：任务框从左到右一格格搭起来（xcbuild）', build == 'xcbuild', build)
        ui.check('在做：一颗像素小彗星绕着框边跑（::before 的 xcorbit）', orbit == 'xcorbit', orbit)
        ui.check('做完：✓ 盖章（xcstamp），迸出 6 颗像素火花，结果淡入（xcin），任务框平滑滑下去（FLIP）', done == [True, 6, 'xcstamp', 'xcin', True], done)
        ui.check('火花放完就拿掉', after == 0, after)
    await pg.context.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        await deep_link(browser)
        await home_to_work(browser, False)
        await home_to_work(browser, True)
        await send_and_reply(browser, False)
        await send_and_reply(browser, True)
        await history_still(browser)
        await task_box(browser, False)
        await task_box(browser, True)
        await browser.close()
    n = len(ui.results); ok = sum(1 for r in ui.results if r[1])
    print('==== %d/%d 通过 ====' % (ok, n))
    return ok == n and not ui.local_fail

if __name__ == '__main__':
    sys.exit(0 if asyncio.run(main()) else 1)
