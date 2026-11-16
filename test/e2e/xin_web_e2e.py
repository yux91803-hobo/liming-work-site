"""Preview delivery: actual iframe interaction, isolated scripts, recovery, and ready-only links."""
import asyncio
import json
import os
import time
from pathlib import Path
from playwright.async_api import async_playwright, expect
import stm32_e2e as ui

ID = 'a' * 32
URL = '/xin/preview.html?id=' + ID
CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
HTML = '''<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>奶龙小岛</title><style>
body{margin:0;min-height:100vh;display:grid;place-content:center;text-align:center;background:#fff5d9;font-family:system-ui;color:#654421}#dragon{font-size:90px;margin:30px}button{font:inherit;border:0;border-radius:20px;background:#ffcd45;padding:14px 32px}.dancing{transform:rotate(-12deg)}
</style></head><body><h1>奶龙小岛</h1><div id="dragon">🐥</div><button id="dance">一起跳舞</button><p id="state">今天也要开心</p><script>
window.danceClicks=0;document.getElementById('dance').onclick=()=>{window.danceClicks++;setTimeout(()=>{document.getElementById('dragon').classList.add('dancing');document.getElementById('state').textContent='我跳起来啦';},120);};
</script></body></html>'''

async def loaded(frame):
    # The preview shows the frame as soon as it sets srcdoc; the artwork's own script runs after its button is parsed,
    # and the emoji font can arrive later and move the centred button. Click only after load and fonts settle.
    await frame.locator('#dance').evaluate("async el => { const d = el.ownerDocument; if (d.readyState !== 'complete') await new Promise(r => d.defaultView.addEventListener('load', r, {once: true})); await d.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }")

async def click_dance(page, label):
    await page.bring_to_front()
    frame = page.frame_locator('#frame')
    await loaded(frame)
    button = frame.locator('#dance')
    await button.evaluate("""() => {
      window.previewInputs = [];
      for (const type of ['pointerdown','pointerup','mousedown','mouseup','touchstart','touchend','click']) {
        document.addEventListener(type, e => {
          const point = e.changedTouches?.[0] || e;
          window.previewInputs.push({type, trusted:e.isTrusted, target:e.target.id, x:point.clientX, y:point.clientY});
          window.previewInputs = window.previewInputs.slice(-16);
        }, true);
      }
    }""")
    try:
        # Loading and font work can outlive popup activation. Confirm actual focus just before
        # the sole input; mobile uses the same native touch path as a person using a phone.
        await page.bring_to_front()
        await page.wait_for_function('document.hasFocus()', timeout=5000)
        await button.focus()
        await expect(button).to_be_focused(timeout=5000)
        if await page.evaluate('navigator.maxTouchPoints > 0'):
            await button.tap()
        else:
            await button.click()
        # A click acknowledgement can precede the iframe's paint / event work. Wait for its actual
        # observable result, without clicking twice or bypassing the real input event.
        await expect(frame.locator('#state')).to_have_text('我跳起来啦', timeout=5000)
        await expect(frame.locator('#dragon')).to_have_class('dancing', timeout=5000)
        assert await button.evaluate('() => window.danceClicks') == 1
        clicks = await button.evaluate("() => window.previewInputs.filter(e => e.type === 'click')")
        assert len(clicks) == 1 and clicks[0]['trusted'] and clicks[0]['target'] == 'dance'
    except Exception:
        detail = await button.evaluate("el => ({ready:document.readyState,visible:document.visibilityState,focused:document.hasFocus(),handler:typeof el.onclick,clicks:window.danceClicks,state:document.getElementById('state').textContent,rect:el.getBoundingClientRect().toJSON(),inputs:window.previewInputs,active:document.activeElement?.id,viewport:{width:innerWidth,height:innerHeight,offsetX:visualViewport?.offsetLeft,offsetY:visualViewport?.offsetTop}})")
        detail['pageFocused'] = await page.evaluate('document.hasFocus()')
        print('PREVIEW_CLICK ' + json.dumps({'case':label,'detail':detail}), flush=True)
        Path('screens').mkdir(exist_ok=True)
        await page.screenshot(path='screens/xin-web-failure-' + label + '.png')
        raise

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        for scenario in ('ready', 'waking', 'login', 'missing', 'invalid'):
            context = await browser.new_context(viewport={'width': 390, 'height': 860})
            page = await context.new_page()
            requests = []
            async def asset(route):
                requests.append(route.request.url)
                if scenario == 'login':
                    return await route.fulfill(status=401, json={'msg': '请先登录'})
                if scenario == 'missing':
                    return await route.fulfill(status=404, json={'msg': '找不到这个预览'})
                if scenario == 'waking' and len(requests) == 1:
                    return await route.fulfill(status=503, json={'state':'waking','retryAfter':2})
                await route.fulfill(status=200, content_type='text/html', body=HTML, headers={'Content-Security-Policy': CSP})
            await page.route('**/api/xin/preview/**', asset)
            await page.goto(ui.BASE + (URL if scenario != 'invalid' else '/xin/preview.html?id=../escape'))
            if scenario in ('ready', 'waking'):
                await page.wait_for_selector('#frame:not([hidden])')
                frame = page.frame_locator('#frame')
                await click_dance(page, scenario)
                assert await frame.locator('body').evaluate('() => self.origin') == 'null'
                assert await frame.locator('body').evaluate("() => {try{return parent.document.title}catch(e){return e.name}}") == 'SecurityError'
                assert await frame.locator('body').evaluate("async () => {try {await fetch('/api/xin/me');return 'escaped'}catch{return 'blocked'}}") == 'blocked'
                assert await page.locator('#download').get_attribute('href') == '/api/xin/preview/' + ID + '/index.html?download=1'
                assert len(requests) == (2 if scenario == 'waking' else 1)
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            else:
                await page.wait_for_function("!document.getElementById('reload').disabled")
                assert await page.locator('#frame').is_hidden()
                status = await page.locator('#status').inner_text()
                assert ('登录' in status if scenario == 'login' else '找不到' in status if scenario == 'missing' else '不完整' in status)
                if scenario == 'invalid': assert not requests
            print('PASS isolated web preview ' + scenario, flush=True)
            await context.close()

        page = await ui.page(browser)
        state = await ui.xin_mock(page, authed=True)
        now = int(time.time()*1000)
        task = {'sid':'staskweb001','no':1,'parent':'snew000001','title':'奶龙互动网页','kind':'code','model':'kimi-k3.1-pro','status':'done','created':now,'endedAt':now,'dir':'/data/workspace/demo','turns':1,'web':True,'result':{'ok':True,'text':'我画好了。[打开预览]('+URL+')','at':now},'preview':{'ready':True,'url':URL},'delivery':{'state':'pending'}}
        state['tasks'] = [task]
        await page.add_init_script("localStorage.setItem('lm.xin.sid','snew000001')")
        async def history(route):
            body = route.request.post_data_json or {}
            if body.get('op') != 'history': return await route.fallback()
            events = [] if task['delivery']['state'] == 'pending' else [{'t':'text','text':task['result']['text'],'taskResult':{'sid':task['sid'],'status':'done','at':now,'endedAt':now}}]
            await route.fulfill(json={'ok':True,'data':{'session':{'sid':'snew000001','agent':'codex'},'tasks':[task],'runs':[{'run':'rhandoff001','started':now+1,'done':True,'events':events}],'active':None}})
        await page.route('**/api/xin/call', history)
        await page.goto(ui.BASE + '/#xin')
        await page.wait_for_function(ui.CHAT_DONE)
        assert await page.locator('.xc-tres').count() == 0
        task['delivery']['state'] = 'delivered'
        await page.evaluate('LimingXinChat.tasks()')
        await page.wait_for_selector('.xc-tres')
        assert await page.locator('.xc-tres').count() == 1
        await page.reload()
        await page.wait_for_function(ui.CHAT_DONE)
        assert await page.locator('.xc-tres').count() == 1
        # 结果正文里已经有这个网页的链接：下面不再重复放「打开网页」（站长 2026-11-16），能打开网页的地方还是正好一个
        links = await page.evaluate("[...document.querySelectorAll('.xc-tres a[href]')].filter(a => a.getAttribute('href') === %s).length" % json.dumps(URL))
        assert links == 1, links
        assert await page.locator('.xc-preview').count() == 0
        await page.context.close()
        print('PASS pending handoff waits for delivery; reload merges one result with its saved message; one link to the page, no duplicate button', flush=True)

        shots = os.environ.get('XIN_WEB_SCREENSHOTS')
        if shots: Path(shots).mkdir(parents=True, exist_ok=True)
        for width in (1280, 768, 1024, 390):
            for theme in ('light', 'dark'):
                page = await ui.page(browser, width, 860, mobile=width == 390, theme=theme)
                state = await ui.xin_mock(page, authed=True)
                await page.add_init_script("localStorage.setItem('lm.xin.sid','snew000001')")
                now = int(time.time()*1000)
                task = {'sid':'staskweb001','no':1,'parent':'snew000001','title':'奶龙互动网页','kind':'code','model':'kimi-k3.1-pro','status':'running','created':now,'dir':'/data/workspace/demo','turns':1,'web':True,'stage':'checking'}
                state['tasks'] = [task]
                await page.goto(ui.BASE + '/#xin')
                await page.wait_for_function(ui.CHAT_DONE)
                await page.evaluate('LimingXinChat.tasks()')
                assert await page.locator('.xc-preview').count() == 0
                task.update(status='done', endedAt=now, result={'ok':True,'text':'我画好了，点下面的预览就能看。','at':now}, preview={'ready':True,'url':URL})
                await page.evaluate('LimingXinChat.tasks()')
                await page.wait_for_selector('.xc-preview')
                await page.wait_for_function("getComputedStyle(document.querySelector('.xc')).transform === 'none'")
                assert await page.locator('.xc-preview').first.get_attribute('href') == URL
                text = await page.locator('.xc-msgs').inner_text()
                assert '我画好了' in text and all(x not in text for x in ('Kimi','kimi','分身','任务 1'))
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                if shots: await page.screenshot(path=str(Path(shots)/f'chat-{width}-{theme}.png'))
                # The wrapper uses the same API contract as production, including CSP on delivered bytes.
                async def ready_asset(route):
                    await route.fulfill(status=200, content_type='text/html', body=HTML, headers={'Content-Security-Policy': CSP})
                await page.context.route('**/api/xin/preview/**', ready_asset)
                await page.emulate_media(color_scheme=theme)
                async with page.expect_popup() as opened:
                    await page.locator('.xc-preview').first.click()
                preview = await opened.value
                await preview.emulate_media(color_scheme=theme)
                await preview.wait_for_selector('#frame:not([hidden])')
                await click_dance(preview, str(width) + '-' + theme)
                assert await preview.evaluate('document.documentElement.scrollWidth <= innerWidth')
                if shots: await preview.screenshot(path=str(Path(shots)/f'preview-{width}-{theme}.png'))
                await page.context.close()
        assert not ui.errors, ui.errors
        assert not ui.local_fail, ui.local_fail
        print('PASS ready-only result links and 8 responsive light/dark layouts', flush=True)
        await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
