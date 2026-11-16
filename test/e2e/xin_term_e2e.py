#!/usr/bin/env python3
"""小芯的实时终端（docs/superpowers/plans/2026-11-16-xin-workbench-round2-b.md）。

1. 组件本身（site/xin/term.js）：命令、输出前 3 行、内部命令不画、网页的地址栏和标题、改动的红绿行、做完收成一行、
   打字机和减少动态、手机上不横向滚动。

运行：先起本地预览（5173），再 python3 test/e2e/xin_term_e2e.py
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

OUT20 = '\n'.join('arm-none-eabi-gcc -c src/f%02d.c -o build/f%02d.o' % (i, i) for i in range(20))
DIFF = '\n'.join(['--- update /data/workspace/blink/src/led.c', '@@ -10,6 +10,7 @@'] + ['-  old %d' % i for i in range(5)] + ['+  new %d' % i for i in range(6)])
WEB_OUT = '网址：https://example.com/a\n标题：示例\n正文……'


async def open_work(pg):
    await pg.goto(ui.BASE + '/#xin-work')
    await pg.wait_for_selector('.xc.wb.show .xc-msgs')
    await pg.wait_for_function('!!window.LimingXinTerm')


async def part1(browser):
    pg = await ui.page(browser, 1280, 860)
    await ui.xin_mock(pg, authed=True)
    try:
        await open_work(pg)
    except Exception as e:  # noqa: BLE001
        ui.check('页面上有终端组件（window.LimingXinTerm）', False, str(e)[:120])
        await pg.context.close()
        return
    r = await pg.evaluate("""(o) => {
      const T = LimingXinTerm, t = T.create({ title: '编译 blink', live: true }), box = document.querySelector('.xc-msgs');
      box.appendChild(t.el);
      t.feed({ t: 'tool', id: 'c1', name: 'Bash', detail: "/bin/bash -lc 'cd blink && make -j4'" }, false);
      t.feed({ t: 'tool_end', id: 'c1', name: 'Bash', detail: "/bin/bash -lc 'cd blink && make -j4'", ok: true, out: o.out20 }, false);
      const cmd = t.el.querySelector('.tm-l.tm-k-cmd');
      const before = t.rows();
      const internal = [T.line({ name: 'Bash', detail: "/bin/bash -lc 'xin task new --kind code 帮我写点灯程序'" }), T.line({ name: 'Bash', detail: 'xin finish_event deliver' })];
      t.feed({ t: 'tool', id: 'x1', name: 'Bash', detail: "/bin/bash -lc 'xin task new --kind code 帮我写点灯程序'" }, false);
      const after = t.rows();
      t.feed({ t: 'tool', id: 'w1', name: 'Bash', detail: 'xin browser open https://example.com/a' }, false);
      const web = t.el.querySelector('.tm-l.tm-k-web'), loading = !!web.querySelector('.tm-load') && web.classList.contains('tm-run');
      t.feed({ t: 'tool_end', id: 'w1', name: 'Bash', detail: 'xin browser open https://example.com/a', ok: true, out: o.web }, false);
      t.feed({ t: 'tool_end', id: 'e1', name: 'Edit', detail: 'update /data/workspace/blink/src/led.c', ok: true, out: o.diff }, false);
      const ed = t.el.querySelector('.tm-l.tm-k-edit');
      t.status('编译中', 12);
      return { cmd: [cmd.querySelector('.tm-v').textContent, cmd.querySelector('.tm-a').textContent, cmd.querySelector('.tm-pre').textContent.split('\\n').length, (cmd.querySelector('.tm-more') || {}).textContent, cmd.classList.contains('tm-ok')],
        internal: internal, rows: [before, after],
        web: [loading, web.querySelector('.tm-host').textContent, web.querySelector('.tm-pg').textContent, web.classList.contains('tm-ok')],
        edit: [ed.querySelector('.tm-a').textContent, ed.querySelectorAll('.tm-dl.tm-add').length > 0, ed.querySelectorAll('.tm-dl.tm-del').length > 0, ed.querySelectorAll('.tm-dl').length, (ed.querySelector('.tm-more') || {}).textContent],
        st: [t.el.querySelector('.tm-sv').textContent, t.el.querySelector('.tm-ss').textContent, t.el.getAttribute('aria-live')] };
    }""", {'out20': OUT20, 'diff': DIFF, 'web': WEB_OUT})
    ui.check('命令：$ 和去掉外壳、cd 的命令；输出只露前 3 行，下面「… 还有 17 行」；成功标绿', r['cmd'] == ['$', 'make -j4', 3, '… 还有 17 行', True], r['cmd'])
    ui.check('内部命令（派活、交付）不画：line 返回 null，行数不变', r['internal'] == [None, None] and r['rows'][0] == r['rows'][1], (r['internal'], r['rows']))
    ui.check('打开网页：自己画的地址栏（不带 https://）和加载条，做完写上标题', r['web'] == [True, 'example.com/a', '示例', True], r['web'])
    ui.check('改文件：写短路径，红绿行，超过 8 行收起「… 还有 N 行」', r['edit'][0] == 'src/led.c' and r['edit'][1] and r['edit'][2] and r['edit'][3] == 8 and r['edit'][4] == '… 还有 5 行', r['edit'])
    ui.check('状态行：在干什么和秒数；终端里的变化不让读屏念（aria-live=off）', r['st'] == ['编译中', '· 12 秒', 'off'], r['st'])
    more = await pg.evaluate("""() => { const b = document.querySelector('.tm-l.tm-k-cmd .tm-more'); b.click(); return [document.querySelector('.tm-l.tm-k-cmd .tm-pre').textContent.split('\\n').length, !document.querySelector('.tm-l.tm-k-cmd .tm-more')]; }""")
    ui.check('点「还有 17 行」：输出全部展开', more == [20, True], more)
    s = await pg.evaluate("""() => { const t = LimingXinTerm.create({ title: '查资料', live: true }); document.querySelector('.xc-msgs').appendChild(t.el);
      t.feed({ t: 'tool_end', id: 'e', name: 'Edit', detail: 'update /w/a.c', ok: true, out: '' }, false);
      t.feed({ t: 'tool', id: 'c', name: 'Bash', detail: 'ls' }, false); t.feed({ t: 'tool_end', id: 'c', name: 'Bash', detail: 'ls', ok: true, out: 'a.c' }, false);
      t.feed({ t: 'tool', id: 'w', name: 'Bash', detail: 'xin browser open https://example.com' }, false); t.feed({ t: 'tool_end', id: 'w', name: 'Bash', detail: 'xin browser open https://example.com', ok: true, out: '' }, false);
      const sum = t.finish('done', 125000); window.__t = t;
      return [sum.textContent, sum.getAttribute('aria-expanded'), t.el.classList.contains('tm-shut'), !!t.el.querySelector('.tm-st'), LimingXinTerm.summary({ cmd: 2 }, null, 18000)]; }""")
    ui.check('做完收成一行：干完了 · 用时 2 分钟 · 1 条命令 · 改了 1 个文件 · 看了 1 个网页；收着、不再转圈；前台一段写「在电脑上做了 18 秒」',
             s[0] == '查资料干完了 · 用时 2 分钟 · 1 条命令 · 改了 1 个文件 · 看了 1 个网页' and s[1:4] == ['false', True, False] and s[4] == '在电脑上做了 18 秒 · 2 条命令', s)
    o = await pg.evaluate("""async () => { const t = window.__t, b = t.el.querySelector('.tm-sum'); b.click(); await new Promise(r => setTimeout(r, 450));
      const r = t.el.querySelector('.tm-ls').getBoundingClientRect(); return [b.getAttribute('aria-expanded'), t.el.classList.contains('tm-open'), r.height > 40]; }""")
    ui.check('点那一行：展开看全部记录（aria-expanded 跟着变）', o == ['true', True, True], o)
    ty = await pg.evaluate("""async () => { const t = LimingXinTerm.create({ live: true }); document.querySelector('.xc-msgs').appendChild(t.el);
      const cmd = 'arm-none-eabi-objcopy -O ihex build/app.elf build/app.hex';
      t.feed({ t: 'tool', id: 'k', name: 'Bash', detail: cmd }, true);
      const a = t.el.querySelector('.tm-a'), first = a.textContent.length;
      await new Promise(r => setTimeout(r, 700)); return [first < cmd.length, a.textContent === cmd]; }""")
    ui.check('打字机：命令一个字一个字敲出来，一行不到 0.7 秒就敲完', ty == [True, True], ty)
    await pg.context.close()
    # 减少动态：不打字，一次画完
    pg = await ui.page(browser, 1280, 860)
    await pg.emulate_media(reduced_motion='reduce')
    await ui.xin_mock(pg, authed=True)
    await open_work(pg)
    rm = await pg.evaluate("""() => { const t = LimingXinTerm.create({ live: true }); document.querySelector('.xc-msgs').appendChild(t.el);
      t.feed({ t: 'tool', id: 'k', name: 'Bash', detail: 'make flash' }, true); return t.el.querySelector('.tm-a').textContent; }""")
    ui.check('系统设了减少动态：不打字，命令一次画完', rm == 'make flash', rm)
    await pg.context.close()
    # 手机：很长的命令和输出不横向滚动
    pg = await ui.page(browser, 390, 844, mobile=True, theme='dark')
    await ui.xin_mock(pg, authed=True)
    await open_work(pg)
    w = await pg.evaluate("""() => { const t = LimingXinTerm.create({ title: '很长的命令', live: true }); document.querySelector('.xc-msgs').appendChild(t.el);
      const c = 'arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb -Wall -O2 -ffunction-sections -fdata-sections -Iinc -Idrivers/CMSIS/Device/ST/STM32F1xx/Include -c src/main.c -o build/main.o';
      t.feed({ t: 'tool', id: 'k', name: 'Bash', detail: c }, false); t.feed({ t: 'tool_end', id: 'k', name: 'Bash', detail: c, ok: false, out: c + '\\n' + 'error: ' + 'x'.repeat(300) }, false);
      const r = t.el.getBoundingClientRect(); return [document.documentElement.scrollWidth <= innerWidth, r.right <= innerWidth + 1, t.el.querySelector('.tm-l.tm-k-cmd').classList.contains('tm-bad')]; }""")
    ui.check('390 宽深色：很长的命令和报错不横向滚动，失败标红', w == [True, True, True], w)
    await pg.context.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))
        await part1(browser)
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
