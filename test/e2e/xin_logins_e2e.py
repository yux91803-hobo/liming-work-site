#!/usr/bin/env python3
"""浏览器第二步：用站长的登录（docs/xin-browser-v2-design.md）。

- 任务等你登录：右栏卡片按钮写「登录」；详情里写着要登录哪个网站，三个按钮：
  「打开登录窗口」（login_open {sid}，小芯的屏幕直接以接管打开登录窗口）、「已登录，继续」（task_tell approve）、「跳过登录」（task_tell deny）。
- 详情里写「用你的登录：…」（任务点名的网站）。
- 设置里「网站登录」：点「查看」才去取列表（不打开不叫醒电脑）；列出网站和保存日期；「删除」；填网址「登录新网站」打开登录窗口，「保存登录」存好。
- 电脑、平板、手机宽度，浅色深色：不横向溢出。

运行：先起本地预览（5173），再 python3 test/e2e/xin_logins_e2e.py
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
import xin_work_e2e as wk  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

NOW = int(time.time() * 1000)
Q = '要你登录 bilibili.com：点「打开登录窗口」，在小芯的屏幕上自己登录（它看不到你输的密码、验证码），登录后点「已登录，继续」。'


async def setup(browser, w=1280, h=860, mobile=False, theme='light'):
    pg = await ui.page(browser, w, h, mobile=mobile, theme=theme)
    st = await wk.backend(pg)
    wait = next(t for t in st['tasks'] if t['sid'] == 'staskwait01')
    wait.update({'title': '看 B 站收藏', 'question': Q, 'browserStep': {'kind': 'login', 'site': 'bilibili.com', 'saved': False}, 'sites': ['lcsc.com.cn']})
    st.update({'login_ops': [], 'sites': [{'site': 'bilibili.com', 'saved': NOW - 86400000, 'count': 12}, {'site': 'lcsc.com.cn', 'saved': NOW, 'count': 5}], 'window': None})

    async def handle(route):
        body = json.loads(route.request.post_data or '{}')
        op, args = body.get('op'), body.get('args') or {}
        if op in ('logins', 'login_open', 'login_done', 'login_remove'):
            st['login_ops'].append([op, args])
            if op == 'login_remove':
                st['sites'] = [x for x in st['sites'] if x['site'] != args.get('site')]
            if op == 'login_open':
                st['window'] = {'site': 'bilibili.com'}
                return await route.fulfill(json={'ok': True, 'data': {'url': ui.BASE + '/icons/icon-192.png?login=1', 'expiresAt': 'z', 'control': True, 'terminal': False, 'site': 'bilibili.com'}})
            if op == 'login_done':
                st['window'] = None
                return await route.fulfill(json={'ok': True, 'data': {'ok': True, 'saved': ['bilibili.com']}})
            return await route.fulfill(json={'ok': True, 'data': {'ok': True, 'sites': st['sites'], 'window': st['window']}})
        await route.fallback()
    await pg.route('**/api/xin/call', handle)
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show', timeout=15000)
    return pg, st


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))

        # 1. 任务等你登录（电脑宽度，浅色、深色）
        for theme in ('light', 'dark'):
            pg, st = await setup(browser, theme=theme)
            card = pg.locator('.wk-c[data-tsid=staskwait01] .wk-b')
            await card.wait_for(timeout=10000)
            ui.check('%s：右栏等你登录的任务，按钮写「登录」' % theme, (await card.inner_text()).strip() == '登录', await card.inner_text())
            await card.click()
            await pg.wait_for_selector('.xc-sheet:not([hidden]) .xc-tk-login', timeout=10000)
            det = await pg.evaluate("""(() => { const s = document.querySelector('.xc-sheet');
              return {q: s.querySelector('.xc-tk-q').textContent, btn: [...s.querySelectorAll('.xc-tk-login button')].map(b => b.textContent),
                sites: [...s.querySelectorAll('.xc-tk-dir')].map(p => p.textContent).join('|'), reply: !!s.querySelector('.xc-tk-in'),
                fit: document.documentElement.scrollWidth <= innerWidth}; })()""")
            ok = 'bilibili.com' in det['q'] and det['btn'] == ['打开登录窗口', '已登录，继续', '跳过登录'] and '用你的登录：lcsc.com.cn' in det['sites'] and det['reply'] and det['fit']
            ui.check('%s：详情写要登录哪个网站，三个按钮；写着任务带哪些网站的登录；也能直接回一句' % theme, ok, det)
            await pg.click('.xc-tk-login button:has-text("打开登录窗口")')
            await pg.wait_for_selector('.xs:not([hidden]) .xs-fr:not([hidden])', timeout=10000)
            scr = await pg.evaluate("[document.querySelector('.xs-fr').src, document.querySelector('.xs-tip').textContent, document.querySelector('.xs').classList.contains('ctl')]")
            ui.check('%s：「打开登录窗口」→ 小芯的屏幕直接以接管打开登录窗口，提示说它看不到你输的东西' % theme,
                     st['login_ops'] == [['login_open', {'sid': 'staskwait01'}]] and scr[0].endswith('login=1') and '看不到' in scr[1] and scr[2], (st['login_ops'], scr))
            await pg.click('.xs-x')
            await pg.wait_for_timeout(300)
            ui.check('%s：关掉屏幕：接管过，链接作废' % theme, 'screen_off' in st['ops'], st['ops'][-3:])
            if theme == 'light':
                await pg.click('.xc-tk-login button:has-text("已登录，继续")')
                await pg.wait_for_function("document.querySelector('.xc-tk-note') && document.querySelector('.xc-tk-note').textContent", timeout=10000)
                tell = {k: v for k, v in (st.get('task_tell') or {}).items() if k != 'clientId'}
                ui.check('「已登录，继续」→ task_tell approve', tell == {'sid': 'staskwait01', 'decision': 'approve'}, st.get('task_tell'))
            else:
                await pg.click('.xc-tk-login button:has-text("跳过登录")')
                await pg.wait_for_function("document.querySelector('.xc-tk-note') && document.querySelector('.xc-tk-note').textContent", timeout=10000)
                tell = {k: v for k, v in (st.get('task_tell') or {}).items() if k != 'clientId'}
                ui.check('「跳过登录」→ task_tell deny', tell == {'sid': 'staskwait01', 'decision': 'deny'}, st.get('task_tell'))
            await pg.context.close()

        # 2. 设置里「网站登录」：电脑、平板、手机
        for w, h, mobile, theme in ((1280, 860, False, 'light'), (768, 1024, True, 'light'), (390, 844, True, 'dark')):
            pg, st = await setup(browser, w, h, mobile=mobile, theme=theme)
            if w < 1180:
                await pg.click('.xc-list-b')
            await pg.wait_for_selector('.xc.wb.show .xc-set-b', state='visible', timeout=15000)
            await pg.click('.xc-set-b')
            await pg.wait_for_selector('.xc-set .xc-lg', timeout=10000)
            await pg.wait_for_timeout(300)
            ui.check('%d 宽：打开设置不去取网站登录（不叫醒电脑）' % w, not [o for o in st['login_ops'] if o[0] == 'logins'], st['login_ops'])
            await pg.click('.xc-set .xc-lg > .xc-btn')
            await pg.wait_for_selector('.xc-set .xc-lg-l li', timeout=10000)
            rows = await pg.evaluate("[...document.querySelectorAll('.xc-set .xc-lg-l li')].map(li => [li.querySelector('span').textContent, li.querySelector('small').textContent, li.querySelector('button').textContent])")
            ui.check('%d 宽：「查看」列出保存了登录的网站和日期，各有「删除」' % w, [r[0] for r in rows] == ['bilibili.com', 'lcsc.com.cn'] and all(r[2] == '删除' and '月' in r[1] for r in rows), rows)
            fit = await pg.evaluate("(() => { const r = document.querySelector('.xc-set .xc-lg').getBoundingClientRect(); return [Math.round(r.right) <= innerWidth, document.documentElement.scrollWidth <= innerWidth]; })()")
            ui.check('%d 宽%s：网站登录这一行在屏幕里、不横向溢出' % (w, '深色' if theme == 'dark' else ''), fit == [True, True], fit)
            if w == 1280:
                await pg.click('.xc-set .xc-lg-l li:first-child button')
                await pg.wait_for_function("document.querySelectorAll('.xc-set .xc-lg-l li').length === 1", timeout=10000)
                ui.check('「删除」：只删那一个网站', ['login_remove', {'site': 'bilibili.com'}] in st['login_ops'], st['login_ops'])
                await pg.fill('.xc-set .xc-lg-in', 'https://www.bilibili.com')
                await pg.click('.xc-set .xc-lg-add .xc-btn:has-text("登录新网站")')
                await pg.wait_for_selector('.xs:not([hidden]) .xs-fr:not([hidden])', timeout=10000)
                ui.check('「登录新网站」：带网址打开登录窗口', ['login_open', {'url': 'https://www.bilibili.com'}] in st['login_ops'], st['login_ops'])
                await pg.click('.xs-x')
                await pg.click('.xc-set .xc-lg-add .xc-btn:has-text("保存登录")')
                for _ in range(50):
                    if [o[0] for o in st['login_ops']][-2:] == ['login_done', 'logins']:
                        break
                    await pg.wait_for_timeout(100)
                ops = [o[0] for o in st['login_ops']]
                ui.check('「保存登录」：存好关掉登录窗口，再取一次列表', ops[-2:] == ['login_done', 'logins'], ops)
            await pg.context.close()

        await browser.close()
    bad = [name for name, ok in ui.results if not ok]
    real = [e for e in ui.errors if 'Failed to load resource' not in e]
    print('\n==== %d/%d 通过 ====' % (len(ui.results) - len(bad), len(ui.results)))
    if real:
        print('JS 报错：', real[:5])
    if ui.local_fail:
        print('本站资源失败：', ui.local_fail[:5])
    return not bad and not real and not ui.local_fail


if __name__ == '__main__':
    sys.exit(0 if asyncio.run(main()) else 1)
