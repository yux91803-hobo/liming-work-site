"""世界地图回归：真实 MapLibre、浏览器和国家数据，第三方搜索 / 瓦片用可控响应。
先 npm run dev，再 python3 test/e2e/map_e2e.py [http://localhost:5173]。
"""
import asyncio, base64, json, os, sys
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
STYLES = {theme: {'version': 8, 'sources': {}, 'layers': [
    {'id': 'bg', 'type': 'background', 'paint': {'background-color': color}}]}
    for theme, color in [('light', '#e5e9e0'), ('dark', '#172530')]}
PLACE = {'name': '上海', 'display_name': '上海, 中国', 'lat': '31.2304', 'lon': '121.4737'}
results, errors, local_fail = [], [], []

def check(name, ok, detail=''):
    results.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + name + (' — ' + str(detail) if detail else ''), flush=True)

class Search:
    def __init__(self): self.pending, self.replies, self.failures = {}, {}, set()

    async def handle(self, route):
        query = parse_qs(urlparse(route.request.url).query)['q'][0]
        if query in self.failures: return await route.fulfill(status=503, body='unavailable')
        if query in self.replies:
            return await route.fulfill(json=self.replies[query])
        self.pending[query] = route

    async def wait(self, query):
        for _ in range(100):
            if query in self.pending: return
            await asyncio.sleep(0.02)
        raise AssertionError('search not received: ' + query)

    async def reply(self, query, items):
        await self.wait(query)
        await self.pending.pop(query).fulfill(json=items)

async def page(browser, *, reduced=True, width=1280, theme='light', broken=(), country_gate=None, healthy=True):
    ctx = await browser.new_context(viewport={'width': width, 'height': 860}, is_mobile=width < 700, has_touch=width < 700,
                                    reduced_motion='reduce' if reduced else 'no-preference')
    await ctx.add_init_script("localStorage.setItem('lm.theme', %s);localStorage.setItem('wm.layerMig1','1');localStorage.setItem('wm.layer2','vector');" % json.dumps(theme))
    pg = await ctx.new_page(); pg.set_default_timeout(10000)
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and m.text.startswith('MAP_ERROR') else None)
    pg.on('response', lambda r: local_fail.append(str(r.status) + ' ' + r.url) if r.status >= 400 and r.url.startswith(BASE) and not any(urlparse(r.url).path.endswith(s) for s in broken) else None)
    pg.on('requestfailed', lambda r: local_fail.append(str(r.failure) + ' ' + r.url) if r.url.startswith(BASE) and 'ERR_ABORTED' not in (r.failure or '') else None)
    async def style(route):
        name = urlparse(route.request.url).path.rsplit('/', 1)[-1]
        if name in broken: return await route.fulfill(status=503, body='unavailable')
        return await route.fulfill(json=STYLES['dark' if name.startswith('dark') else 'light'])
    await pg.route('https://**', lambda r: r.fulfill(content_type='image/png', body=PNG))
    await pg.route('**/styles/*.json*', style)
    search = Search(); await pg.route('**/search?**', search.handle)
    if country_gate:
        async def countries(route):
            await country_gate.wait(); await route.continue_()
        await pg.route('**/data/countries.json', countries)
    await pg.goto(BASE + '/tools/map/', wait_until='domcontentloaded')
    await pg.wait_for_function("!!window.__map && !!__map.getLayer('country-hit')")
    await pg.evaluate("__map.on('error',e=>{if(!e.testFailure) console.error('MAP_ERROR',e.error?.message)});void 0")
    if healthy:
        await pg.evaluate("__map.fire('sourcedata', {sourceId:'openmaptiles',tile:{state:'loaded'}})")
    return pg, search

async def submit(pg, query):
    await pg.fill('#q', query); await pg.press('#q', 'Enter')

async def layer(pg, key):
    await pg.click('#layersBtn'); await pg.click('[data-layer="%s"]' % key)
    await pg.wait_for_function("key => document.querySelector('.opt.on').dataset.layer === key", arg=key)
    await pg.wait_for_function("id => !!__map.getSource(id)", arg={'vector': 'countries', 'amap': 'amap', 'sat': 'esri', 'amapSat': 's'}[key])

async def main():
    async with async_playwright() as p:
        opts = {'args': ['--enable-unsafe-swiftshader']}
        if os.environ.get('CHROMIUM_PATH'): opts['executable_path'] = os.environ['CHROMIUM_PATH']
        b = await p.chromium.launch(**opts)
        try:
            pg, search = await page(b)
            check('空输入不显示清除按钮；收起的图层不能被键盘聚焦',
                  not await pg.is_visible('#clear') and await pg.evaluate("document.querySelector('#sheet').inert"))
            await submit(pg, 'old'); await search.wait('old')
            await submit(pg, 'new'); await search.wait('new'); await pg.wait_for_timeout(150)
            state = await pg.evaluate("[document.querySelector('#results').hidden,document.querySelector('#search').classList.contains('busy')]")
            check('连续搜索：旧请求取消后不弹旧结果，也不停止新请求的加载提示', state == [True, True], state)
            await search.reply('old', [])
            await search.reply('new', [dict(PLACE, name='新结果')]); await pg.wait_for_selector('#results button')
            check('只展示最后一次搜索结果', await pg.text_content('#results b') == '新结果')
            await pg.fill('#q', 'changed')
            check('改字后立即隐藏上一次的结果', not await pg.is_visible('#results'))
            await submit(pg, 'clear'); await search.wait('clear'); await pg.click('#clear')
            await search.reply('clear', [PLACE]); await pg.wait_for_timeout(150)
            check('清空时取消搜索，迟到的结果不重新弹出', not await pg.is_visible('#results') and await pg.input_value('#q') == '' and not await pg.is_visible('#clear'))
            await submit(pg, 'escape'); await search.wait('escape'); await pg.press('#q', 'Escape')
            await search.reply('escape', [PLACE]); await pg.wait_for_timeout(150)
            check('Esc 关闭搜索并取消在途请求', not await pg.is_visible('#results') and not await pg.locator('#search').evaluate("e=>e.classList.contains('busy')"))
            await submit(pg, 'outside'); await search.wait('outside'); await pg.mouse.click(600, 600)
            await search.reply('outside', [PLACE]); await pg.wait_for_timeout(150)
            check('点地图后迟到的搜索结果不会盖回来', not await pg.is_visible('#results'))
            search.replies['keyboard'] = [dict(PLACE, name='第一项'), dict(PLACE, name='第二项')]
            await submit(pg, 'keyboard'); await pg.wait_for_selector('#results button')
            await pg.press('#q', 'ArrowUp')
            check('搜索方向键可从输入框选中最后一项', await pg.evaluate('document.activeElement.textContent') == '第二项中国')
            await pg.keyboard.press('ArrowDown'); await pg.keyboard.press('Enter')
            await pg.wait_for_selector('.pin')
            check('方向键与 Enter 可选择结果并定位', await pg.input_value('#q') == '第一项' and not await pg.is_visible('#results'))
            search.replies['bad'] = [{'lat': 'NaN', 'lon': '121'}, dict(PLACE, name='<img src=x onerror=alert(1)>', boundingbox=['50', '20', '120', '123'])]
            await submit(pg, 'bad'); await pg.wait_for_selector('#results button')
            check('过滤坏坐标，地点名按文字显示，坏边界仍可安全定位', await pg.locator('#results button').count() == 1 and await pg.locator('#results img').count() == 0)
            await pg.click('#results button'); await pg.wait_for_selector('.pin')
            await pg.evaluate('__map.jumpTo({center:[121.4737,31.2304],zoom:16,bearing:23})')
            before = await pg.locator('.pin').bounding_box()
            await layer(pg, 'amap'); center = await pg.evaluate('__map.getCenter().toArray()')
            after = await pg.locator('.pin').bounding_box()
            check('高德切换同时修正相机和标记，原位置不漂移', abs(center[0] - 121.47822306) < 1e-7 and abs(center[1] - 31.22845774) < 1e-7 and abs(before['x'] - after['x']) < 1 and abs(before['y'] - after['y']) < 1, center)
            await layer(pg, 'vector'); state = await pg.evaluate('({c:__map.getCenter().toArray(),z:__map.getZoom(),b:__map.getBearing()})')
            check('切回矢量还原坐标，并保留缩放与方向', abs(state['c'][0] - 121.4737) < 1e-7 and abs(state['c'][1] - 31.2304) < 1e-7 and state['z'] == 16 and state['b'] == 23, state)
            await pg.evaluate("__map.fire('sourcedata',{sourceId:'openmaptiles',tile:{state:'loaded'}})")
            await layer(pg, 'vector')
            await pg.evaluate("for(let i=0;i<8;i++)__map.fire('error',{sourceId:'openmaptiles',testFailure:true,error:new Error('unavailable')})")
            await pg.wait_for_timeout(150)
            check('重选已加载的矢量图层，不把零星瓦片错误误判成全部失败', await pg.evaluate("document.querySelector('.opt.on').dataset.layer") == 'vector')
            await pg.click('#compass'); await pg.wait_for_timeout(550)
            check('指北按钮恢复正北并隐藏', abs(await pg.evaluate('__map.getBearing()')) < 0.01 and not await pg.is_visible('#compass'))
            await pg.click('#layersBtn'); await pg.keyboard.press('Shift+Tab')
            check('图层面板打开后焦点留在选项内', await pg.evaluate("document.activeElement.dataset.layer") == 'amapSat')
            await pg.keyboard.press('Escape')
            check('Esc 收起图层并还原按钮焦点', await pg.evaluate("!document.body.classList.contains('sheet') && document.activeElement.id === 'layersBtn' && document.querySelector('#sheet').inert && !document.querySelector('#tools').inert"))
            await pg.evaluate("window.__geoCalls=0;navigator.geolocation.getCurrentPosition=(ok,bad)=>{__geoCalls++;window.__geoOK=ok;window.__geoBad=bad};void 0")
            await pg.click('#locate'); await pg.evaluate("document.querySelector('#locate').click()")
            check('定位等待期间只发起一次请求', await pg.evaluate("__geoCalls === 1 && document.querySelector('#locate').disabled"))
            await pg.evaluate('__geoBad({code:1})')
            check('拒绝定位权限有提示，按钮可重试', await pg.text_content('#toast') == '未获得定位权限' and not await pg.is_disabled('#locate'))
            await pg.click('#locate'); await pg.evaluate('__geoOK({coords:{latitude:31.2304,longitude:121.4737}})')
            check('定位成功显示当前位置并结束等待', await pg.locator('.me').count() == 1 and not await pg.is_disabled('#locate') and abs((await pg.evaluate('__map.getCenter().lng')) - 121.4737) < 1e-7)
            search.replies['斐济'] = []
            await submit(pg, '斐济'); await pg.wait_for_selector('#results button'); await pg.click('#results button')
            state = await pg.evaluate('({c:__map.getCenter().toArray(),z:__map.getZoom()})')
            check('本地国家搜索：斐济在太平洋且缩到群岛范围', abs(state['c'][0]) > 170 and state['z'] > 5, state)
            search.failures.add('中国')
            await submit(pg, '中国'); await pg.wait_for_selector('#results button')
            check('搜索服务失败仍能从本地数据查国家，并结束加载提示', await pg.text_content('#results b') == '中国' and not await pg.locator('#search').evaluate("e=>e.classList.contains('busy')"))
            await pg.press('#q', 'Escape')
            await pg.evaluate('__map.jumpTo({center:[105,33],zoom:3,bearing:0})')
            await pg.wait_for_function("__map.isSourceLoaded('countries')")
            await pg.mouse.click(640, 430); await pg.wait_for_selector('.cpop')
            check('低倍点选国家显示名称和高亮', '中国' in await pg.text_content('.cpop') and (await pg.evaluate("__map.getFilter('country-hl')"))[-1] == 'China')
            await pg.context.close()

            # 把国家数据加载推迟到启动超时之后，重现“先搜到地点，4 秒后被拉走”。
            gate = asyncio.Event(); pg, search = await page(b, reduced=False, country_gate=gate)
            search.replies['early'] = [PLACE]
            await submit(pg, 'early'); await pg.wait_for_selector('#results button'); await pg.click('#results button')
            await pg.wait_for_timeout(4700); gate.set()
            state = await pg.evaluate('({c:__map.getCenter().toArray(),z:__map.getZoom()})')
            check('启动期间选中地点，后续欢迎动画不会抢走视角', abs(state['c'][0] - 121.4737) < 1e-7 and state['z'] > 12, state)
            await pg.wait_for_function("__map.isSourceLoaded('countries')")
            await pg.context.close()

            pg, _ = await page(b, reduced=False)
            await pg.click('#layersBtn'); await pg.keyboard.press('Escape')
            await pg.evaluate("""window.__decodes=0;Image.prototype.decode=function(){return new Promise(r=>setTimeout(r,++__decodes===1?550:30))};
              document.querySelector('[data-layer=amap]').click();document.querySelector('[data-layer=sat]').click();""")
            await pg.wait_for_timeout(800)
            await pg.wait_for_function("!!__map.getSource('esri')")
            state = await pg.evaluate("[document.querySelector('.opt.on').dataset.layer,localStorage.getItem('wm.layer2'),!!__map.getSource('esri')]")
            check('连续切图层：旧截图晚完成也不能覆盖最后一次选择', state == ['sat', 'sat', True], state)
            await pg.evaluate("""Image.prototype.decode=function(){return new Promise(r=>setTimeout(r,100))};
              document.querySelector('[data-layer=amap]').click();localStorage.setItem('lm.theme','dark');postMessage({type:'theme'},location.origin);""")
            await pg.wait_for_timeout(400)
            state = await pg.evaluate("[document.querySelector('.opt.on').dataset.layer,localStorage.getItem('wm.layer2'),document.documentElement.dataset.theme,document.querySelector('meta[name=theme-color]').content]")
            check('切层同时换主题，保留选择并同步浏览器主题色', state == ['amap', 'amap', 'dark', '#0d1117'], state)
            await pg.wait_for_timeout(1800)
            check('图层过渡截图按时撤掉', not await pg.locator('#snap').evaluate("e=>e.classList.contains('on')"))
            await pg.evaluate("Image.prototype.decode=function(){return new Promise(()=>{})};document.querySelector('[data-layer=amapSat]').click()")
            await pg.wait_for_function("!!__map.getSource('s')", timeout=5000)
            check('截图解码卡住时仍能切图层，不无限等待', await pg.evaluate("document.querySelector('.opt.on').dataset.layer === 'amapSat'"))
            await pg.context.close()

            pg, _ = await page(b, healthy=False)
            await pg.evaluate("""__map.fire('sourcedata',{sourceId:'openmaptiles',tile:{state:'loading'}});
              for(let i=0;i<9;i++)__map.fire('error',{sourceId:'openmaptiles',testFailure:true,error:new Error('unavailable')});""")
            await pg.wait_for_function("document.querySelector('.opt.on').dataset.layer === 'amap'")
            check('加载中不算成功：瓦片持续失败可自动回退，保留用户偏好', await pg.evaluate("localStorage.getItem('wm.layer2')") == 'vector')
            await pg.context.close()

            pg, _ = await page(b, broken=('liberty-zh.json', 'dark-zh.json'), healthy=False)
            check('样式资源都失败时仍打开高德，页面可操作且不改偏好', await pg.evaluate("!!__map.getSource('amap') && localStorage.getItem('wm.layer2') === 'vector'"))
            await layer(pg, 'sat')
            check('样式失败后仍可切卫星图', await pg.evaluate("!!__map.getSource('esri')"))
            await pg.context.close()
            pg, _ = await page(b, broken=('dark-zh.json',), theme='dark')
            check('只有深色样式失败时借用可用样式，地图正常打开', await pg.evaluate("document.querySelector('.opt.on').dataset.layer === 'vector' && !!__map.getLayer('country-hit')"))
            await pg.context.close()

            pg, _ = await page(b, width=390, theme='dark')
            await pg.click('#layersBtn')
            await pg.wait_for_timeout(100)
            state = await pg.evaluate("""['#top','#tools','#sheet'].every(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}) && document.documentElement.scrollWidth===innerWidth""")
            check('390 手机深色：搜索、按钮、图层都在屏幕内，不横向溢出', state)
            cdp = await pg.context.new_cdp_session(pg)
            grip = await pg.locator('.grip').bounding_box(); x, y = grip['x'] + 15, grip['y'] + 2
            async def touch(kind, dy=0):
                await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind in ('touchEnd', 'touchCancel') else [{'x': x, 'y': y + dy}]})
            await touch('touchStart'); await touch('touchMove', 70); await touch('touchCancel')
            check('手机图层下滑被系统取消后，面板复位而不留半截', await pg.evaluate("document.body.classList.contains('sheet') && document.querySelector('#sheet').style.transform === ''"))
            await touch('touchStart'); await touch('touchMove', 80); await touch('touchEnd')
            check('手机图层下滑可收起，恢复地图操作', await pg.evaluate("!document.body.classList.contains('sheet') && !document.querySelector('#map').inert"))
            await pg.context.close()
        finally:
            await b.close()
    print('\n地图 %d/%d 通过；JS 报错 %d；本站资源失败 %d' % (sum(results), len(results), len(errors), len(local_fail)), flush=True)
    for e in errors + local_fail: print(e[:300], flush=True)
    return all(results) and not errors and not local_fail

if __name__ == '__main__': sys.exit(0 if asyncio.run(main()) else 1)
