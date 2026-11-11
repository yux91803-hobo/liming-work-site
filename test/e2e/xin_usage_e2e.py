#!/usr/bin/env python3
"""小芯的额度光环、额度卡和用量页（docs/xin-reliability-usage-design.md 的 B 部分）。

- 头像外一圈光环：颜色跟着控制器给的 glow（ok 绿 / warn 黄 / high 红 / out 红且变暗），没有读数不上色；
  小芯在干活时呼吸更快；系统设了减少动态就不动。
- 头像是单独的按钮（读屏念「额度…」），点开额度卡：每个模型 5 小时和每周两行、重置时间、预计用完、读取时间；
  Esc 关掉、焦点回到头像；手机上从底部升起来、不横向溢出。点卡片标题其余部分照旧进工作台。
- 额度卡的「用量」打开工作台里的用量页：额度、今天 / 7 天 / 30 天、合计、30 根柱（没数据的日子是空柱）、按模型列表和图例；
  切换范围不再请求。

运行：先起本地预览（5173），再 python3 test/e2e/xin_usage_e2e.py
"""
import asyncio
import os
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
import xin_work_e2e as wk  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

NOW = int(time.time() * 1000)
H = 3600 * 1000


def usage():
    bj = datetime.now(timezone.utc) + timedelta(hours=8)
    days = []
    for i in range(29, -1, -1):
        d = (bj - timedelta(days=i)).strftime('%Y-%m-%d')
        models = {}
        if i in (0, 1, 3, 10, 20):
            models['claude-opus-4.6'] = {'input': 120000 + i * 1000, 'cached': 80000, 'output': 9000, 'runs': 6}
        if i in (0, 3):
            models['gemini-3.8-flash-high'] = {'input': 300000, 'cached': 0, 'output': 40000, 'runs': 2}
        if i == 1:
            models['deepseek-v4.1-flash'] = {'input': 50000, 'cached': 20000, 'output': 4000, 'runs': 3}
        days.append({'date': d, 'models': models})
    tot = lambda r: {'input': sum(m['input'] for x in r for m in x['models'].values()), 'cached': sum(m['cached'] for x in r for m in x['models'].values()),
                     'output': sum(m['output'] for x in r for m in x['models'].values()), 'runs': sum(m['runs'] for x in r for m in x['models'].values())}
    totals = {'today': tot(days[-1:]), 'd7': tot(days[-7:]), 'd30': tot(days)}
    for t in totals.values():
        t['hit'] = t['cached'] / t['input'] if t['input'] else None
    return {
        'quotas': [
            {'key': 'opus', 'name': 'Opus', 'checkedAt': NOW - 3 * 60000, 'windows': [
                {'id': '3p-5h', 'kind': '5h', 'used': 0.72, 'resetAt': NOW + int(1.5 * H), 'reset': False, 'forecastAt': NOW + H},
                {'id': '3p-weekly', 'kind': 'week', 'used': 0.41, 'resetAt': NOW + 3 * 24 * H, 'reset': False, 'forecastAt': None}]},
            {'key': 'gemini', 'name': 'Gemini', 'checkedAt': NOW - 2 * H, 'windows': [
                {'id': 'gemini-5h', 'kind': '5h', 'used': 0, 'resetAt': NOW - 60000, 'reset': True, 'forecastAt': None},
                {'id': 'gemini-weekly', 'kind': 'week', 'used': 0.09, 'resetAt': NOW + 5 * 24 * H, 'reset': False, 'forecastAt': None}]}],
        'days': days, 'totals': totals, 'since': NOW - 40 * 24 * H, 'now': NOW,
        'names': {'claude-opus-4.6': 'Claude Opus 4.6', 'gemini-3.8-flash-high': 'Gemini 3.8 Flash High', 'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash'}}


async def setup(browser, w=1280, h=860, mobile=False, theme='light', glow='warn', live=False, reduced=False):
    pg = await ui.page(browser, w, h, mobile=mobile, theme=theme)
    if reduced:
        await pg.emulate_media(reduced_motion='reduce')
    st = await wk.backend(pg, main='smain000001')
    st['glow'] = glow
    st['usage'] = usage()
    if not live:
        st['tasks'] = [t for t in st['tasks'] if t['status'] not in ('running', 'queued')]
    await pg.goto(ui.BASE + '/')
    await pg.wait_for_selector('#xinWork .xc-glow', timeout=15000)
    return pg, st


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))

        # 1. 光环颜色跟着 glow；没有读数不上色
        for glow, cls in (('warn', 'g-warn'), ('high', 'g-high'), ('out', 'g-out'), ('ok', 'g-ok'), (None, '')):
            pg, st = await setup(browser, glow=glow)
            await pg.wait_for_timeout(600)
            got = await pg.evaluate("[...document.querySelector('#xinWork .xc-glow').classList].filter(c=>c.startsWith('g-')).join(' ')")
            ui.check('光环：glow=%s → %s' % (glow, cls or '不上色'), got == cls, got)
            await pg.context.close()

        # 2. 干活时呼吸更快；减少动态时不动
        pg, st = await setup(browser, live=True)
        await pg.wait_for_function("document.querySelector('#xinWork .xc-glow').classList.contains('busy')", timeout=10000)
        busy = await pg.evaluate("parseFloat(getComputedStyle(document.querySelector('#xinWork .xc-glow'),'::before').animationDuration)")
        await pg.context.close()
        pg, st = await setup(browser)
        await pg.wait_for_timeout(600)
        idle = await pg.evaluate("parseFloat(getComputedStyle(document.querySelector('#xinWork .xc-glow'),'::before').animationDuration)")
        ui.check('有活在做时光环呼吸更快', 0 < busy < idle, (busy, idle))
        await pg.context.close()
        pg, st = await setup(browser, live=True, reduced=True)
        await pg.wait_for_timeout(600)
        anim = await pg.evaluate("getComputedStyle(document.querySelector('#xinWork .xc-glow'),'::before').animationName")
        ui.check('减少动态：光环不动，只留颜色', anim == 'none', anim)
        await pg.context.close()

        # 3. 点头像出额度卡；内容；Esc 关、焦点回头像；卡片标题其余部分照旧进工作台
        pg, st = await setup(browser)
        av = pg.locator('#xinWork .xc-glow')
        label = await av.get_attribute('aria-label')
        ui.check('头像是单独的按钮，读屏念「额度…」', (label or '').startswith('额度') and await av.evaluate("e => e.tagName === 'BUTTON' && !e.closest('.xw-head')"), label)
        await av.click()
        await pg.wait_for_selector('.xq[role=dialog] .xq-row', timeout=10000)
        card = await pg.evaluate("""(() => { const q = document.querySelector('.xq'); return {names: [...q.querySelectorAll('.xq-name')].map(e => e.textContent),
          rows: [...q.querySelectorAll('.xq-row')].map(e => e.innerText.replace(/\\s+/g, ' ')), fc: [...q.querySelectorAll('.xq-fc')].map(e => e.textContent),
          at: [...q.querySelectorAll('.xq-at')].map(e => e.textContent), more: !!q.querySelector('.xq-more')}; })()""")
        ok = card['names'] == ['Opus', 'Gemini'] and len(card['rows']) == 4 and '5 小时' in card['rows'][0] and '72%' in card['rows'][0] and '重置' in card['rows'][0] \
            and '每周' in card['rows'][1] and '已重置' in card['rows'][2] and len(card['fc']) == 1 and '用完' in card['fc'][0] and card['at'][0].endswith('读取') and card['more']
        ui.check('额度卡：每个模型两行（已用、重置）、预计用完、读取时间、「用量」入口', ok, card)
        ui.check('额度卡打开时焦点在卡片里', await pg.evaluate("!!document.activeElement.closest('.xq')"))
        await pg.keyboard.press('Escape')
        await pg.wait_for_timeout(200)
        gone = await pg.evaluate("[!document.querySelector('.xq'), document.activeElement === document.querySelector('#xinWork .xc-glow')]")
        ui.check('Esc 关掉额度卡，焦点回到头像', gone == [True, True], gone)
        await pg.click('#xinWork .xw-head')
        await pg.wait_for_selector('.xc.wb.show', timeout=10000)
        ui.check('点卡片标题其余部分照旧进工作台', True)
        await pg.wait_for_timeout(600)
        side = await pg.evaluate("(() => { const b = document.querySelector('.xc-dr-hd .xc-glow'); return b ? [...b.classList].filter(c => c.startsWith('g-')).join(' ') : 'none'; })()")
        ui.check('工作台左上角的小芯头像也有光环（建好时就上色）', side == 'g-warn', side)
        await pg.context.close()

        # 4. 键盘：Tab 能到头像
        pg, st = await setup(browser)
        reached = False
        for _ in range(12):
            await pg.keyboard.press('Tab')
            if await pg.evaluate("document.activeElement === document.querySelector('#xinWork .xc-glow')"):
                reached = True
                break
        ui.check('Tab 能到头像按钮', reached)
        await pg.context.close()

        # 5. 用量页：从额度卡进；范围切换不再请求；30 根柱（空日子空柱）；按模型列表、图例
        pg, st = await setup(browser)
        await pg.click('#xinWork .xc-glow')
        await pg.wait_for_selector('.xq .xq-more', timeout=10000)
        await pg.click('.xq .xq-more')
        await pg.wait_for_selector('.xc.show .xc-sheet:not([hidden]) .xu-chart', timeout=15000)
        page = await pg.evaluate("""(() => { const s = document.querySelector('.xc-sheet'); return {title: s.querySelector('.xc-sh-hd b').textContent,
          quota: s.querySelectorAll('.xq-row').length, tabs: [...s.querySelectorAll('.xu-rg')].map(e => e.textContent), on: (s.querySelector('.xu-rg.on') || {}).textContent,
          days: s.querySelectorAll('.xu-day').length, empty: s.querySelectorAll('.xu-day.empty').length, legend: [...s.querySelectorAll('.xu-lg li')].map(e => e.textContent),
          models: [...s.querySelectorAll('.xu-m')].map(e => e.innerText.replace(/\\s+/g, ' ')), sum: s.querySelector('.xu-sum').textContent}; })()""")
        ok = page['title'] == '用量' and page['quota'] == 4 and page['tabs'] == ['今天', '7 天', '30 天'] and page['on'] == '7 天' and page['days'] == 7 \
            and len(page['legend']) >= 2 and any('Claude Opus 4.6' in m for m in page['models']) and '缓存命中' in page['sum']
        ui.check('用量页：额度、范围（默认 7 天）、合计含缓存命中、7 根柱、图例和按模型列表', ok, page)
        calls = st.get('usage_calls')
        await pg.click('.xc-sheet .xu-rg:has-text("30 天")')
        await pg.wait_for_timeout(300)
        days30 = await pg.evaluate("[document.querySelectorAll('.xc-sheet .xu-day').length, document.querySelectorAll('.xc-sheet .xu-day.empty').length]")
        ui.check('30 天：30 根柱，没数据的日子是空柱', days30[0] == 30 and days30[1] == 25, days30)
        await pg.click('.xc-sheet .xu-rg:has-text("今天")')
        await pg.wait_for_timeout(300)
        ui.check('切换范围不再请求', st.get('usage_calls') == calls, (calls, st.get('usage_calls')))
        tip = await pg.evaluate("(() => { const d = document.querySelectorAll('.xc-sheet .xu-day'); return d.length ? d[d.length - 1].getAttribute('aria-label') : ''; })()")
        ui.check('柱子有读屏说明（日期和用量）', '今天' in (tip or '') or '月' in (tip or ''), tip)
        await pg.context.close()

        # 6. 各宽度、浅色深色：额度卡和用量页不横向溢出；手机上额度卡贴底
        for w, h, mobile in ((1280, 860, False), (1024, 768, False), (768, 1024, True), (390, 844, True)):
            for theme in ('light', 'dark'):
                pg, st = await setup(browser, w, h, mobile=mobile, theme=theme)
                await pg.click('#xinWork .xc-glow')
                await pg.wait_for_selector('.xq .xq-row', timeout=10000)
                box = await pg.evaluate("(() => { const r = document.querySelector('.xq').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.bottom), innerWidth, innerHeight, document.documentElement.scrollWidth <= innerWidth]; })()")
                inside = box[0] >= 0 and box[1] <= box[3] and box[5]
                bottom = (box[2] >= box[4] - 1) if w < 600 else True
                ui.check('%d 宽%s：额度卡在屏幕里%s' % (w, '深色' if theme == 'dark' else '', '、贴底' if w < 600 else ''), inside and bottom, box)
                await pg.click('.xq .xq-more')
                await pg.wait_for_selector('.xc-sheet:not([hidden]) .xu-chart', timeout=15000)
                await pg.wait_for_timeout(300)
                fit = await pg.evaluate("(() => { const s = document.querySelector('.xc-sheet'); return [s.scrollWidth <= s.clientWidth + 1, document.documentElement.scrollWidth <= innerWidth]; })()")
                ui.check('%d 宽%s：用量页不横向溢出' % (w, '深色' if theme == 'dark' else ''), fit == [True, True], fit)
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
