"""Browser regressions for durable queue, native steer and typed publication approval."""
import asyncio
import os
import sys
import time
from pathlib import Path
from playwright.async_api import async_playwright
import stm32_e2e as ui

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        pg = await ui.page(browser)
        st = await ui.xin_mock(pg, authed=True)
        st['hold'] = True
        await pg.goto(ui.BASE + '/#xin')
        await pg.locator('.xc-row textarea').fill('first message')
        await pg.keyboard.press('Enter')
        await pg.wait_for_function('LimingXinChat.state.run')
        await pg.locator('.xc-row textarea').fill('change direction now')
        await pg.keyboard.press('Enter')
        await pg.wait_for_selector('.xc-qsteer')
        before = await pg.evaluate("JSON.parse(localStorage.getItem('lm.xin.queue.snew000001'))")
        assert len(before) == 1 and before[0]['id']
        st['active'] = {'run': 'rlive00001', 'off': 0, 'started': int(time.time()*1000)}
        await pg.reload()
        await pg.wait_for_selector('.xc-me.queued .xc-qsteer')
        assert await pg.locator('.xc-me.queued').count() == 1
        assert await pg.locator('.xc-me.queued .xc-bub').inner_text() == 'change direction now'
        print('PASS reload restores one queued message without sending it twice', flush=True)
        await pg.locator('.xc-qsteer').click()
        await pg.wait_for_function("document.querySelector('.xc-qtag').textContent === '已送入当前任务'")
        assert st['steer']['clientId'] == before[0]['id'] and st['steer']['run'] == 'rlive00001'
        assert await pg.evaluate("localStorage.getItem('lm.xin.queue.snew000001')") is None
        assert await pg.evaluate('LimingXinChat.state.run') == 'rlive00001'
        print('PASS native steer uses the saved message id and preserves the current turn', flush=True)
        now = int(time.time()*1000)
        task = {'sid':'stask00001','no':1,'parent':'snew000001','title':'发布有冲突的改动','kind':'code','model':'glm-5.3','status':'waiting',
                'created':now,'endedAt':now,'dir':'/data/workspace/demo','after':[],'turns':1,'question':'将删除 1 个原文件，允许这次写回吗？',
                'approval':{'kind':'publish','id':'publish'},'result':{'ok':False,'text':'结果已准备','at':now}}
        st['tasks']=[task]
        await pg.evaluate('LimingXinChat.tasks()')
        await pg.wait_for_selector('.xc-tstrip:not([hidden])')
        await pg.locator('.xc-tstrip').click()
        await pg.wait_for_selector('.xc-tl-i')
        await pg.locator('.xc-tl-i').click()
        await pg.wait_for_selector('.xc-tk-act .xc-btn')
        assert await pg.locator('.xc-tk-act .xc-btn').all_text_contents() == ['允许这一次','拒绝']
        assert await pg.locator('.xc-tk-in').count() == 0
        await pg.get_by_role('button', name='拒绝', exact=True).click()
        await pg.wait_for_function("document.querySelector('.xc-tk-note').textContent.length > 0")
        assert st['task_tell']['decision'] == 'deny'
        print('PASS publication conflict requires an explicit decision; text cannot approve it', flush=True)
        task['status']='waiting'
        task['approval']={'kind':'input','id':'input-1'}
        task['question']='请输入需要分析的目标名称'
        await pg.locator('.xc-sh-x').click()
        await pg.evaluate('LimingXinChat.tasks()')
        await pg.locator('.xc-tstrip').click()
        await pg.locator('.xc-tl-i').click()
        await pg.wait_for_selector('.xc-tk-in')
        await pg.locator('.xc-tk-in').fill('main')
        await pg.locator('.xc-tk-act .xc-btn').click()
        await pg.wait_for_function("document.querySelector('.xc-tk-note').textContent.length > 0")
        assert st['task_tell']['text']=='main' and 'decision' not in st['task_tell']
        print('PASS native input question accepts a typed answer', flush=True)
        await pg.context.close()
        idle=await ui.page(browser)
        idle_state=await ui.xin_mock(idle,authed=True)
        await idle.add_init_script("localStorage.setItem('lm.xin.sid','snew000001')")
        await idle.goto(ui.BASE+'/#xin')
        await idle.wait_for_function(ui.CHAT_DONE)
        await idle.wait_for_timeout(1200)
        before=idle_state['ops'].count('tasks')
        await idle.evaluate("dispatchEvent(new Event('pagehide'))")
        await idle.wait_for_timeout(400)
        assert idle_state['ops'].count('tasks')==before
        print('PASS closing an idle page does not wake the VM just to clear presence',flush=True)
        await idle.context.close()
        # Late send results/errors and late history must stay with their originating conversation.
        for scenario in ('new_success','switch_success','switch_error','switch_queue','newer_send'):
            tab=await ui.page(browser);mock=await ui.xin_mock(tab,authed=True);mock['hold']=True
            await tab.add_init_script("localStorage.setItem('lm.xin.sid','sorigin001')")
            started=asyncio.Event();release=asyncio.Event();second=asyncio.Event();release_second=asyncio.Event()
            async def delayed(route):
                import json
                body=json.loads(route.request.post_data or '{}')
                if body.get('op')!='send':return await route.fallback()
                args=body.get('args') or {};is_first=args.get('text')=='message from A'
                if is_first:started.set();await release.wait()
                else:second.set();await release_second.wait()
                data={'error':'fixture_failure','msg':'A send failed'} if scenario=='switch_error' and is_first else {'sid':'sorigin001' if is_first else 'ssecond001','run':'rorigin001' if is_first else 'rsecond001','agent':'codex'}
                await route.fulfill(status=200,content_type='application/json',body=json.dumps({'ok':True,'data':data}))
            await tab.route('**/api/xin/call',delayed)
            await tab.goto(ui.BASE+'/#xin');await tab.wait_for_function('LimingXinChat.state.sid==="sorigin001" && !LimingXinChat.state.loadingConversation')
            await tab.locator('.xc-row textarea').fill('message from A');await tab.locator('.xc-send').click();await started.wait()
            if scenario=='switch_queue':
                await tab.locator('.xc-row textarea').fill('queued message from A');await tab.locator('.xc-send').click()
                await tab.wait_for_selector('.xc-me.queued')
            if scenario.startswith('switch'):
                await tab.evaluate("location.hash='xin=shist00001'")
                await tab.wait_for_function('LimingXinChat.state.sid==="shist00001" && !LimingXinChat.state.loadingConversation')
                expected='shist00001'
            else:
                await tab.locator('.xc-new-b').click();expected=''
            await tab.locator('.xc-row textarea').fill('draft belonging to B')
            if scenario=='newer_send':
                await tab.locator('.xc-row textarea').fill('message from B');await tab.locator('.xc-send').click();await second.wait()
            async with tab.expect_response(lambda r:r.url.endswith('/api/xin/call') and r.request.post_data_json.get('op')=='send'):
                release.set()
            if scenario=='switch_error':await tab.wait_for_function("Object.keys(localStorage).some(k=>k.startsWith('lm.xin.unsent.'))")
            await tab.evaluate('() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
            assert await tab.evaluate('LimingXinChat.state.sid')==expected,scenario
            assert not await tab.evaluate('LimingXinChat.state.run'),scenario
            if scenario=='switch_queue':
                assert not second.is_set(),scenario
                assert await tab.evaluate("JSON.parse(localStorage.getItem('lm.xin.queue.sorigin001')||'[]').some(q=>q.text==='queued message from A')"),scenario
                assert not await tab.evaluate("(LimingXinChat.state.queue||[]).some(q=>q.text==='queued message from A')"),scenario
            if scenario=='newer_send':
                assert await tab.evaluate('LimingXinChat.state.sending')
                release_second.set();await tab.wait_for_function('LimingXinChat.state.run==="rsecond001"')
                assert await tab.evaluate('LimingXinChat.state.sid')=='ssecond001'
            else:
                assert await tab.locator('.xc-row textarea').input_value()=='draft belonging to B'
                assert not await tab.evaluate('LimingXinChat.state.sending')
            print('PASS conversation generation '+scenario,flush=True)
            await tab.context.close()
        tab=await ui.page(browser);await ui.xin_mock(tab,authed=True)
        entered=asyncio.Event();gate=asyncio.Event()
        async def late_history(route):
            import json
            body=json.loads(route.request.post_data or '{}')
            if body.get('op')=='history' and body.get('args',{}).get('sid')=='slatehistory01':
                entered.set();await gate.wait()
            return await route.fallback()
        await tab.route('**/api/xin/call',late_history)
        await tab.goto(ui.BASE+'/#xin');await tab.evaluate("location.hash='xin=slatehistory01'");await entered.wait()
        await tab.locator('.xc-new-b').click();gate.set()
        await tab.wait_for_timeout(150)
        assert await tab.evaluate('!LimingXinChat.state.sid && !LimingXinChat.state.run')
        assert await tab.locator('.xc-hello').count()==1
        print('PASS new chat invalidates a late history response',flush=True)
        await tab.context.close()
        screenshots = os.environ.get('XIN_SCREENSHOTS')
        if screenshots:
            Path(screenshots).mkdir(parents=True, exist_ok=True)
            for width in (1280,768,1024,390):
                for theme in ('light','dark'):
                    pg=await ui.page(browser,width,860,mobile=width==390,theme=theme)
                    st=await ui.xin_mock(pg,authed=True);st['hold']=True
                    await pg.goto(ui.BASE+'/#xin')
                    await pg.locator('.xc-row textarea').fill('后台任务编译中')
                    await pg.locator('.xc-send').click()
                    await pg.wait_for_function('LimingXinChat.state.run')
                    await pg.locator('.xc-row textarea').fill('请同时核对 PB5 的复用映射')
                    await pg.locator('.xc-send').click()
                    await pg.wait_for_selector('.xc-qsteer')
                    assert await pg.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    await pg.screenshot(path=str(Path(screenshots)/f'xin-{width}-{theme}.png'))
                    await pg.context.close()
            print('PASS 8 viewport/theme screenshots without horizontal overflow',flush=True)
        assert not ui.errors, ui.errors
        assert not ui.local_fail, ui.local_fail
        await browser.close()

if __name__=='__main__':
    asyncio.run(main())
