"""Actual study input produces evidence; reference answers, Tianqi and disabled reporting do not masquerade as mastery."""
import asyncio,os
from playwright.async_api import async_playwright
import stm32_e2e as ui

async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True,**({'executable_path':os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        for mode in ('default','harness','off'):
            pg=await ui.page(b,390,860,mobile=True)
            st=await ui.xin_mock(pg,authed=True)
            if mode=='harness': await pg.add_init_script("localStorage.setItem('lm.xin.agent','harness')")
            if mode=='off': await pg.add_init_script("localStorage.setItem('lm.xin.learning','0')")
            await pg.goto(ui.TOOL+'?v=lab&t=gpio&st=check')
            await pg.wait_for_selector('.lab-ta')
            await pg.clock.install()
            code=await pg.evaluate("STM32Lab.body(STM32Lab.chapter('gpio'),'LED_Init')")
            await pg.locator('.lab-ta').fill(code)
            await pg.locator('.lab-acts .lab-p').click()
            await pg.clock.fast_forward(16000)
            await pg.wait_for_timeout(100)
            if mode=='default':
                await pg.wait_for_function("true")
                for _ in range(20):
                    if st.get('learning_events'): break
                    await asyncio.sleep(.05)
                events=st.get('learning_events',[])
                assert len(events)==1 and events[0]['answer']==code and events[0]['correct'] is True and events[0]['independent'] is True,events
                await pg.get_by_role('button',name='参考答案',exact=True).click()
                await pg.locator('.lab-acts .lab-p').click()
                await pg.clock.fast_forward(16000)
                for _ in range(20):
                    if len(st.get('learning_events',[]))>=2: break
                    await asyncio.sleep(.05)
                assert st['learning_events'][-1]['independent'] is False
                await pg.reload();await pg.wait_for_selector('.lab-ta');await pg.clock.install()
                await pg.locator('.lab-ta').fill(code+'\n ')
                await pg.locator('.lab-acts .lab-p').click();await pg.clock.fast_forward(16000)
                for _ in range(20):
                    if len(st.get('learning_events',[]))>=3: break
                    await asyncio.sleep(.05)
                assert st['learning_events'][-1]['independent'] is False
            else: assert not st.get('learning_events')
            assert await pg.evaluate('document.documentElement.scrollWidth<=innerWidth')
            await pg.context.close()
            print('PASS learning evidence '+mode,flush=True)
        await b.close()
asyncio.run(main())
