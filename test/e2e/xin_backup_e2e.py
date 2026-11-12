#!/usr/bin/env python3
"""设置里的「机外备份」一行（docs/xin-reliability-usage-design.md 的 C 部分）。

- 打开设置才去取备份列表（GET /api/xin/backups），不打开不取。
- 有备份：写最近一次是哪天、共几份，旁边「下载」直接下载最近那份（/api/xin/backup?date=…）。
- 最近一次超过 2 天：提醒「已经 N 天没备份了」。
- 还没有备份：写「还没有备份」，没有下载。
- 网站没开备份（404）：这一行不出现。

运行：先起本地预览（5173），再 python3 test/e2e/xin_backup_e2e.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
import xin_work_e2e as wk  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402


def day(n):
    return ((datetime.now(timezone.utc) + timedelta(hours=8)).date() - timedelta(days=n)).isoformat()


async def setup(browser, backups, status=200, w=1280, h=860, mobile=False, theme='light'):
    pg = await ui.page(browser, w, h, mobile=mobile, theme=theme)
    st = await wk.backend(pg)
    st['backup_gets'] = 0

    async def handle(route):
        st['backup_gets'] += 1
        if status != 200:
            return await route.fulfill(status=status, json={'error': 'disabled'})
        return await route.fulfill(json={'backups': backups})
    await pg.route('**/api/xin/backups', handle)
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show', timeout=15000)
    if w < 1180:   # 没有左栏：设置收在侧边栏里，先拉开
        await pg.click('.xc-list-b')
    await pg.wait_for_selector('.xc.wb.show .xc-set-b', state='visible', timeout=15000)
    return pg, st


async def open_settings(pg):
    await pg.click('.xc-set-b')
    await pg.wait_for_timeout(500)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        two = [{'v': 1, 'date': day(0), 'at': 0, 'size': 612345, 'sha256': 'a' * 64}, {'v': 1, 'date': day(1), 'at': 0, 'size': 600000, 'sha256': 'b' * 64}]

        # 1. 不打开设置不取；打开后写最近一次、共几份，「下载」指向最近那份
        pg, st = await setup(browser, two)
        await pg.wait_for_timeout(800)
        ui.check('没打开设置时不去取备份列表', st['backup_gets'] == 0, st['backup_gets'])
        await open_settings(pg)
        await pg.wait_for_selector('.xc-set .xc-bk:not([hidden]) .xc-bk-dl', timeout=10000)
        row = await pg.evaluate("(() => { const r = document.querySelector('.xc-set .xc-bk'), a = r.querySelector('.xc-bk-dl'); return {text: r.innerText.replace(/\\s+/g, ' '), href: a.getAttribute('href'), dl: a.hasAttribute('download'), warn: r.classList.contains('warn')}; })()")
        ok = '机外备份' in row['text'] and '今天' in row['text'] and '共 2 份' in row['text'] and row['href'] == '/api/xin/backup?date=' + day(0) and row['dl'] and not row['warn']
        ui.check('有备份：最近一次今天、共 2 份，下载最近那份', ok, row)
        await pg.context.close()

        # 2. 最近一次 3 天前：提醒
        pg, st = await setup(browser, [{'v': 1, 'date': day(3), 'at': 0, 'size': 1, 'sha256': 'c' * 64}])
        await open_settings(pg)
        await pg.wait_for_selector('.xc-set .xc-bk:not([hidden])', timeout=10000)
        row = await pg.evaluate("(() => { const r = document.querySelector('.xc-set .xc-bk'); return {text: r.innerText.replace(/\\s+/g, ' '), warn: r.classList.contains('warn')}; })()")
        ui.check('最近一次超过 2 天：提醒已经几天没备份', '已经 3 天没备份' in row['text'] and row['warn'], row)
        await pg.context.close()

        # 3. 还没有备份
        pg, st = await setup(browser, [])
        await open_settings(pg)
        await pg.wait_for_selector('.xc-set .xc-bk:not([hidden])', timeout=10000)
        row = await pg.evaluate("(() => { const r = document.querySelector('.xc-set .xc-bk'); return {text: r.innerText.replace(/\\s+/g, ' '), dl: !!r.querySelector('.xc-bk-dl:not([hidden])')}; })()")
        ui.check('还没有备份：写出来，没有下载', '还没有备份' in row['text'] and not row['dl'], row)
        await pg.context.close()

        # 4. 网站没开备份：这一行不出现
        pg, st = await setup(browser, [], status=404)
        await open_settings(pg)
        await pg.wait_for_timeout(800)
        hidden = await pg.evaluate("(() => { const r = document.querySelector('.xc-set .xc-bk'); return !r || r.hidden; })()")
        ui.check('没开备份：这一行不出现', hidden)
        await pg.context.close()

        # 5. 平板、手机宽度，深色：这一行能用、不横向溢出
        for w, h in ((768, 1024), (390, 844)):
            pg, st = await setup(browser, two, w=w, h=h, mobile=True, theme='dark')
            await open_settings(pg)
            await pg.wait_for_selector('.xc-set .xc-bk:not([hidden]) .xc-bk-dl', timeout=10000)
            box = await pg.evaluate("(() => { const r = document.querySelector('.xc-set .xc-bk-dl').getBoundingClientRect(); return [Math.round(r.right), innerWidth, document.documentElement.scrollWidth <= innerWidth]; })()")
            ui.check('%d 宽深色：机外备份一行在屏幕里、不横向溢出' % w, box[0] <= box[1] and box[2], box)
            await pg.context.close()

        await browser.close()
    bad = [name for name, ok in ui.results if not ok]
    real = [e for e in ui.errors if 'Failed to load resource' not in e]
    print('\n==== %d/%d 通过 ====' % (len(ui.results) - len(bad), len(ui.results)))
    if real:
        print('JS 报错：', real[:5])
    return not bad and not real and not ui.local_fail


if __name__ == '__main__':
    sys.exit(0 if asyncio.run(main()) else 1)
