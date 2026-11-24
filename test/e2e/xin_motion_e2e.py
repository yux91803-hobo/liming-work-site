"""小芯工作台动画（站长 2026-11-19「做吧，兄弟支持你」）。设计 docs/superpowers/specs/2026-11-19-xin-motion-design.md
每条都查：新来的才动、动画名对、「减少动态」时不动。"""
import asyncio, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import stm32_e2e as ui
import json
import xin_term_e2e as T
from playwright.async_api import async_playwright

# 首页露没露出来：从页面一开始每一帧都看，直到工作台完全不透明（淡入的那 0.2 秒里首页也会透出来）
SEEN = """document.addEventListener('DOMContentLoaded', () => { window.__homeSeen = 0; const tick = () => {
  const h = document.getElementById('home'), w = document.querySelector('.xc.wb.show'), solid = !!w && getComputedStyle(w).opacity === '1';
  if (h && !solid && getComputedStyle(h).visibility !== 'hidden' && h.getBoundingClientRect().height > 0) window.__homeSeen++;
  if (!solid) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });"""
# 数 View Transition 用了几次、当时 <html> 上挂的是哪个场景；过渡没走成（比如换页那一步超时被浏览器掐掉）记进 __vterr
VT = """window.__vt = []; window.__vterr = []; if (document.startViewTransition) { const o = document.startViewTransition.bind(document);
  document.startViewTransition = cb => { const t = o(cb); t.ready.catch(e => window.__vterr.push(e.name)); requestAnimationFrame(() => window.__vt.push([...document.documentElement.classList].filter(c => c.startsWith('vt-')).join(' '))); return t; }; }"""


async def deep_link(browser):
    pg = await ui.page(browser, 390, 844, True)
    await ui.xin_mock(pg, authed=True)
    await pg.add_init_script(SEEN)
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    await pg.wait_for_timeout(800)
    r = await pg.evaluate("[window.__homeSeen, document.documentElement.classList.contains('xc-boot-work')]")
    ui.check('直接打开工作台：首页一帧都不露（以前先闪约 0.3 秒首页；工作台淡入时也不透出来），淡入完了才放开', r == [0, False], r)
    await pg.context.close()


async def home_to_work(browser, reduce):
    pg = await ui.page(browser, 1280, 860)
    await ui.xin_mock(pg, authed=True)
    await pg.add_init_script(VT)
    if reduce:
        await pg.emulate_media(reduced_motion='reduce')
    await pg.goto(ui.BASE + '/')
    await pg.wait_for_selector('.xw-head')
    t0 = asyncio.get_running_loop().time()
    await pg.click('.xw-head')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    took = round(asyncio.get_running_loop().time() - t0, 2)
    await pg.wait_for_timeout(800)
    r = await pg.evaluate("[window.__vt, document.documentElement.classList.contains('vt-work'), window.__vterr]")
    if reduce:
        ui.check('减少动态：从首页进工作台不做过渡，直接打开', r == [[], False, []], r)
    else:
        ui.check('从首页点进工作台：用 View Transition（像素点阵溶解），做完把场景类去掉', r == [['vt-work'], False, []], r)
    # 以前换页那一步里等两帧，可过渡期间浏览器不出新帧，干等到 4 秒超时才打开（首页定住 4 秒多）
    ui.check('从首页点进工作台：马上开始（1.5 秒内工作台就出来，过渡没有超时被掐掉）', took < 1.5 and r[2] == [], (took, r[2]))
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


# 发出去那一下逐帧记：消息区滚到哪、你那条在哪、气泡从哪起飞
STEADY = """window.__st = []; const B = document.querySelector('.xc-body'); const t0 = performance.now(); const tick = () => {
  const me = [...document.querySelectorAll('.xc-me')].pop();
  window.__st.push([B.scrollTop, B.scrollHeight - B.clientHeight, me ? Math.round(me.getBoundingClientRect().top) : null]);
  if (performance.now() - t0 < 700) requestAnimationFrame(tick); }; requestAnimationFrame(tick);"""


async def send_steady(browser, phone):
    # 以前飞的气泡起点在输入框里，探出消息区底下：消息区多出一截能滚，发完先往下滚、气泡飞上去以后又弹回来，整屏跳一下（手机上约 60px）
    pg = await (ui.page(browser, 390, 844, True) if phone else ui.page(browser, 1280, 860))
    where = '手机上' if phone else '电脑上'
    await ui.xin_mock(pg, authed=True, live=[[{'t': 'text', 'text': '好。'}], [{'t': 'done', 'ok': True, 'code': 0, 'ms': 900}]])
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    await pg.click('.xc-new-b')
    await pg.fill('.xc-row textarea', '帮我看看')
    await pg.evaluate(STEADY)
    await (pg.click('.xc-send') if phone else pg.keyboard.press('Enter'))
    await pg.wait_for_timeout(900)
    st = await pg.evaluate('window.__st')
    tops = [r[2] for r in st if r[2] is not None]
    ui.check(where + '发消息：整屏不跳（消息区不多出能滚的一截，你那条一出来就停在原位）',
             max(r[0] for r in st) == 0 and max(r[1] for r in st) <= 0 and len(tops) > 5 and max(tops) - min(tops) <= 1, (st[:6], len(st)))
    fly = await pg.evaluate("""(() => { const m = [...document.querySelectorAll('.xc-me')].pop(), b = m.querySelector('.xc-bub'), r = b.getBoundingClientRect(),
      body = document.querySelector('.xc-body').getBoundingClientRect(); return [Math.round(r.bottom + parseFloat(b.style.getPropertyValue('--fy'))), Math.round(body.bottom)]; })()""")
    ui.check(where + '发消息：气泡从消息区最下面（紧挨着输入框）起飞', fly[1] - 80 <= fly[0] <= fly[1], fly)
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
    isle = await pg.evaluate("(() => { const i = document.querySelector('.xc-isle'); return [i.classList.contains('bump'), getComputedStyle(i).animationName, getComputedStyle(i, '::after').animationName]; })()")
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
        ui.check('减少动态：任务框不搭、不绕光、做完不盖章不迸火花、不滑；小芯岛不鼓', build == 'none' and orbit in ('none', '') and done[:3] == [False, 0, 'none'] and not done[4] and not isle[0], (build, orbit, done, isle))
    else:
        ui.check('派活：任务框从左到右一格格搭起来（xcbuild）', build == 'xcbuild', build)
        ui.check('派活：小芯岛鼓一下（xcbump）、亮一圈往外扩的光（xcring2）', isle == [True, 'xcbump', 'xcring2'], isle)
        ui.check('在做：一颗像素小彗星绕着框边跑（::before 的 xcorbit）', orbit == 'xcorbit', orbit)
        ui.check('做完：✓ 盖章（xcstamp），迸出 6 颗像素火花，结果淡入（xcin），任务框平滑滑下去（FLIP）', done == [True, 6, 'xcstamp', 'xcin', True], done)
        ui.check('火花放完就拿掉', after == 0, after)
    await pg.context.close()


async def dots_and_theme(browser):
    pg = await ui.page(browser, 1280, 860)
    st = await ui.xin_mock(pg, authed=True)
    st['tasks'] = [T.task(status='running', run='rtask00b01', startedAt=T.now() - 3000), dict(T.task(status='running', run='rtask00b02', startedAt=T.now() - 5000), sid='stask00bl2', no=2, title='查资料')]
    await pg.add_init_script(VT)
    await pg.goto(ui.BASE + '/')
    await pg.wait_for_selector('#themeBtn')
    before = await pg.evaluate("document.documentElement.dataset.theme")
    await pg.click('#themeBtn')
    await pg.wait_for_timeout(900)
    home = await pg.evaluate("[window.__vt.slice(), document.documentElement.dataset.theme, document.documentElement.classList.contains('vt-theme')]")
    ui.check('首页的主题按钮：深浅色从点的地方一圈圈扩散着换（View Transition，场景 vt-theme），做完把场景类去掉', home[0] == ['vt-theme'] and home[1] != before and not home[2], (before, home))
    await pg.click('.xw-head')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    await pg.wait_for_timeout(700)
    await pg.evaluate('LimingXinChat.tasks()')
    await pg.click('.xc-isle')
    await pg.wait_for_selector('.xc-work.in .wk-c.live')
    await pg.wait_for_timeout(300)
    dots = await pg.evaluate("[...document.querySelectorAll('.xc-work.in .wk-c.live .wk-ic')].map(e => [getComputedStyle(e, '::after').animationName, getComputedStyle(e, '::after').animationDelay])")
    ui.check('在做的小方点：呼吸式明暗（xcbreathe），各自错开节拍（延迟不一样）', len(dots) >= 2 and all(d[0] == 'xcbreathe' for d in dots) and len(set(d[1] for d in dots)) == len(dots), dots)
    await pg.keyboard.press('Escape')
    n = len(await pg.evaluate('window.__vt'))
    await pg.keyboard.press('Control+k')
    await pg.wait_for_selector('.xc-pal.in .xc-pal-i')
    await pg.keyboard.type('深色' if (await pg.evaluate("document.documentElement.dataset.theme")) == 'light' else '浅色')
    await pg.wait_for_timeout(200)
    box = await pg.evaluate("(r => [r.left, r.top, r.right, r.bottom])(document.querySelector('.xc-pal.in .xc-pal-i.on').getBoundingClientRect())")
    await pg.keyboard.press('Enter')
    await pg.wait_for_timeout(900)
    wb = await pg.evaluate("[window.__vt.slice(%d), window.__vterr]" % n)
    ui.check('工作台命令面板换深浅色：同样一圈圈扩散着换（几次过渡都没被掐掉）', wb == [['vt-theme'], []], wb)
    # 用键盘选的：没有点的位置，圈从选中的那一项扩散开（以前用的是很久以前最后点过的地方，这里是小芯岛）
    at = await pg.evaluate("['--vt-x', '--vt-y'].map(k => parseFloat(document.documentElement.style.getPropertyValue(k)))")
    ui.check('键盘选「换成深色/浅色」：圈从选中的那一项扩散开，不从很久以前点过的地方', box[0] <= at[0] <= box[2] and box[1] <= at[1] <= box[3], (at, box))
    await pg.wait_for_timeout(300)
    await pg.keyboard.press('Control+k')
    await pg.wait_for_selector('.xc-pal.in .xc-pal-i')
    await pg.keyboard.type('深色' if (await pg.evaluate("document.documentElement.dataset.theme")) == 'light' else '浅色')
    await pg.wait_for_timeout(200)
    box = await pg.evaluate("(r => [r.left, r.top, r.right, r.bottom])(document.querySelector('.xc-pal.in .xc-pal-i.on').getBoundingClientRect())")
    x, y = box[0] + 300, (box[1] + box[3]) / 2
    await pg.mouse.click(x, y)
    await pg.wait_for_timeout(900)
    at = await pg.evaluate("['--vt-x', '--vt-y'].map(k => parseFloat(document.documentElement.style.getPropertyValue(k)))")
    ui.check('用鼠标点「换成深色/浅色」：圈从点的那个位置扩散开', abs(at[0] - x) < 2 and abs(at[1] - y) < 2, (at, (x, y)))
    await pg.context.close()


async def site_interactive_polish(browser):
    pg = await ui.page(browser, 1280, 860)
    await ui.xin_mock(pg, authed=True)
    await pg.goto(ui.BASE + '/')
    await pg.wait_for_selector('.card.art-sky .sky-orb')
    arts = await pg.evaluate("""(() => ({
      sky: !!document.querySelector('.card[data-id="tianqi"].art-sky .sky-const .c-line'),
      world: document.querySelectorAll('.card[data-id="map"] .w-beacons .b-ring').length,
      chip: document.querySelectorAll('.card[data-id="stm32"] .traces .tr-sig').length,
    }))()""")
    ui.check('首页卡片插画：天启有深空星盘与星群连线、世界地图有坐标信标脉冲、STM32 有 PCB 铜箔脉冲走线',
             arts['sky'] and arts['world'] == 4 and arts['chip'] >= 6, arts)
    cbox = await pg.locator('.card[data-id="tianqi"]').bounding_box()
    await pg.mouse.move(cbox['x'] + 120, cbox['y'] + 60)
    await pg.wait_for_timeout(60)
    mx = await pg.evaluate("document.querySelector('.card[data-id=\"tianqi\"]').style.getPropertyValue('--mx')")
    await pg.click('.hd .spark')
    sparks_on = await pg.evaluate("document.querySelectorAll('.hm-spark').length")
    ui.check('首页指针追光与像素迸发火花：鼠标移过卡片写入 --mx 追光坐标，点 ✻ 迸出 8 颗像素火花',
             bool(mx) and sparks_on == 8, (mx, sparks_on))
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show .xc-hello-mk .xc-hello-orb')
    mk_box = await pg.locator('.xc-hello-mk').bounding_box()
    await pg.mouse.move(mk_box['x'] + mk_box['width'] + 110, mk_box['y'] - 40)
    await pg.wait_for_timeout(60)
    tilt = await pg.evaluate("(() => { const m = document.querySelector('.xc-hello-mk'); return [m.style.getPropertyValue('--hx'), m.style.getPropertyValue('--ex')]; })()")
    await pg.click('.xc-hello-mk')
    hop = await pg.evaluate("(() => { const m = document.querySelector('.xc-hello-mk'); return [m.classList.contains('hop'), m.querySelectorAll('.xc-hspark').length, m.querySelector('.xc-face').classList.contains('f-happy')]; })()")
    await pg.emulate_media(reduced_motion='reduce')
    await pg.click('.xc-hello-mk')
    red_orb = await pg.evaluate("getComputedStyle(document.querySelector('.xc-hello-orb')).animationName")
    ui.check('小芯空状态：双轨暖星环、指针 3D 磁吸倾角与眼神跟随、点击笑脸弹跳迸火花，减少动态时自动静止',
             all(tilt) and hop == [True, 8, True] and red_orb == 'none', (tilt, hop, red_orb))
    await pg.context.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        await deep_link(browser)
        await home_to_work(browser, False)
        await home_to_work(browser, True)
        await send_and_reply(browser, False)
        await send_and_reply(browser, True)
        await send_steady(browser, True)
        await send_steady(browser, False)
        await history_still(browser)
        await task_box(browser, False)
        await task_box(browser, True)
        await dots_and_theme(browser)
        await site_interactive_polish(browser)
        await browser.close()
    n = len(ui.results); ok = sum(1 for r in ui.results if r[1])
    print('==== %d/%d 通过 ====' % (ok, n))
    return ok == n and not ui.local_fail

if __name__ == '__main__':
    sys.exit(0 if asyncio.run(main()) else 1)
