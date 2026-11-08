"""Deletion preview: no implicit approval, exact confirmation, per-conversation keep and responsive layouts."""
import asyncio,os,time
from pathlib import Path
from playwright.async_api import async_playwright
import stm32_e2e as ui

async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True,**({'executable_path':os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        shots=os.environ.get('XIN_RETENTION_SCREENSHOTS')
        if shots:Path(shots).mkdir(parents=True,exist_ok=True)
        for w in (1280,1024,768,390):
            for theme in ('light','dark'):
                pg=await ui.page(b,w,860,mobile=w==390,theme=theme)
                st=await ui.xin_mock(pg,authed=True)
                st['retention']={'enabled':False,'days':30,'token':'latest-preview','eligible':[{'sid':'sretain001','title':'定时器：输入捕获','lastActivity':int(time.time()*1000)-40*86400000,'runs':4,'tasks':1,'keep':False}],
                    'excluded':[{'sid':'sretain002','title':'正在学 GPIO','lastActivity':int(time.time()*1000),'runs':2,'tasks':0,'keep':False,'reasonText':'最近 30 天内仍有活动'}],
                    'impact':['清理原话及本地副本，保留记忆短引文、日期和标题。','工程文件和天启会话保留。','开启后按同样规则处理未来符合条件的默认对话。'],'pending':[]}
                await pg.goto(ui.BASE+'/#xin');await pg.wait_for_selector('.xc-list-b');await pg.click('.xc-list-b');await pg.click('.xc-set-b');await pg.click('.xc-retention')
                await pg.wait_for_selector('.xr-confirm')
                await pg.wait_for_function("getComputedStyle(document.querySelector('.xc')).transform==='none' && getComputedStyle(document.querySelector('.xc-drawer')).visibility==='hidden'")
                assert await pg.locator('.xr-on').is_disabled()
                assert 'retention_set' not in st['ops']
                assert '定时器：输入捕获' in await pg.locator('.xr-list').inner_text()
                assert await pg.evaluate('document.documentElement.scrollWidth<=innerWidth')
                if shots:await pg.screenshot(path=str(Path(shots)/f'{w}-{theme}.png'))
                await pg.locator('.xr-list .xr-keep').click()
                await pg.wait_for_function("document.querySelector('.xr-list')?.children.length===0")
                assert st['retention_keep']=={'sid':'sretain001','keep':True}
                await pg.locator('.xr-confirm input').check();await pg.click('.xr-on')
                await pg.wait_for_selector('.xr-off')
                assert st['retention_args']=={'enabled':True,'token':'latest-preview','confirm':'processed-chat-30-days'}
                await pg.locator('.xr-off').click();await pg.wait_for_selector('.xr-confirm')
                assert st['retention_args']=={'enabled':False}
                await pg.context.close()
        await b.close()
        print('PASS retention confirmation, preserve, disable and 8 responsive light/dark layouts',flush=True)
asyncio.run(main())
