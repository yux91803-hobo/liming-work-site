#!/usr/bin/env python3
"""「天启」独立入口（/tianqi 和 /tools/tianqi/）：
- 没配好：显示「天启还没配好」，只发一次 GET /api/tq/me，不碰 /api/xin/
- 已配好已登录（1280）：照 Harness 桌面端三栏——左边对话记录常驻、中间对话、右边文件终端预览，无小芯入口；发话带 agent='harness'、model、effort，
  不带 context/ctxLabel/main；只调 TQ_OPS（docs/superpowers/specs/2026-11-19-tianqi-harness-workbench-design.md）
- Ctrl+B 收窄条、Ctrl+J 开关右栏；文件在右栏打开，markdown 能预览；设置里换外观（夜空 / 星图）
- 天启插件面板（左栏底部「插件」），Purge / REA 开关走 li2 的接口
- 没登录：登录框是天启的星，登录走 POST /api/tq/login
- 网关没配好：ping 回 ready=false，显示「天启的网关还没配好」，输入框和发送键禁用
- 唤醒中：send 回 accepted/waking，状态行显示「已收到 · 唤醒中」，随后送达并回话
- 首页：「工具」分类有「天启」卡片，点开地址变 /tianqi，iframe 地址为 /tools/tianqi/?embed=1，返回键不挡菜单键

运行：先 npm run dev，再 python3 test/e2e/xin_tianqi_e2e.py
"""
import asyncio
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stm32_e2e as ui  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402


def load_tq_ops():
    src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'xin.js')
    with open(src_path, 'r', encoding='utf-8') as f:
        text = f.read()
    m = re.search(r"export const TQ_OPS = new Set\(\[([^\]]+)\]\)", text)
    if not m:
        raise RuntimeError('TQ_OPS not found in src/xin.js')
    return set(re.findall(r"'([^']+)'", m.group(1)))


TQ_OPS = load_tq_ops()
# 计划模式那一轮天启交回来的计划（第一行 # 标题，编号列步骤）
PLAN_MD = '# 把 LED 闪烁改成 200 ms\n\n现在主循环里是 `HAL_Delay(500)`，亮灭各半秒。\n\n1. 把 `main.c` 里的延时改成 200\n2. 编译，确认没有新警告\n3. 核对固件大小没有异常\n\n不做：烧录到板子（li2 没接开发板）。'


PLUG_DESC = {'purge': '提示词与规则管理', 'rea': 'Ghidra 本地分析工具'}
PLUG_LOOK = """(() => { const s = document.querySelector('.xc-sheet'), r = s.getBoundingClientRect(), cs = getComputedStyle(s);
  const alpha = c => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[\\s,\\/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const px = (e, k) => parseFloat(getComputedStyle(e)[k]) || 0, hd = s.querySelector('.xc-sh-hd'), list = s.querySelector('.xc-sh-list');
  const kids = [...list.children], content = kids.length ? kids[kids.length - 1].getBoundingClientRect().bottom - kids[0].getBoundingClientRect().top : 0;
  const need = hd.getBoundingClientRect().height + px(hd, 'marginTop') + px(hd, 'marginBottom') + content + px(list, 'paddingTop') + px(list, 'paddingBottom')
    + px(s, 'paddingTop') + px(s, 'paddingBottom') + px(s, 'borderTopWidth') + px(s, 'borderBottomWidth');
  const grip = s.querySelector('.xc-sh-grip'), on = s.querySelector('.xc-sw[aria-checked=true]');
  const probe = document.createElement('i'); probe.style.background = 'var(--star)'; s.appendChild(probe); const star = getComputedStyle(probe).backgroundColor; probe.remove();
  return { w: Math.round(r.width), cx: Math.round((r.left + r.right) / 2), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom),
    iw: innerWidth, ih: innerHeight, h: Math.round(r.height), need: Math.round(need), alpha: alpha(cs.backgroundColor),
    grip: !!grip && getComputedStyle(grip).display !== 'none' && grip.getBoundingClientRect().height > 0,
    desc: [...s.querySelectorAll('.xc-tg-t span')].map(e => e.textContent), onBg: on ? getComputedStyle(on).backgroundColor : null, star }; })()"""


async def tianqi_mock(pg, enabled=True, authed=True, ready=True, waking_send=False, xin_enabled=False):
    st = {
        'enabled': enabled,
        'authed': authed,
        'ready': ready,
        'waking_send': waking_send,
        'delivery_checks': 0,
        'polls': 0,
        'last_text': '',
        'tq_calls': [],
        'tq_ops': [],
        'sends': [],
        'xin_reqs': [],
        'plugins': {'purge': True, 'rea': False},
        'plugin_updates': [],
        'files_reqs': [],
        'hist_perm': None,     # 旧对话记下的权限（history 的 session.perm）
        'hist_plan': False,    # 旧对话里有一轮计划、后面又按计划执行过
        'hist_work': None,     # 旧对话的工作区（history 的 session.work）
        'hist_extra': [],      # 旧对话后面再接的几轮（各测试自己造内容）
        'files_uploads': False,  # 工作目录根下多一个 uploads 文件夹（工作区选择里不该列它）
        'files_gate': None,    # 设成 asyncio.Event 时，列目录的 files 停住、等测试放行（照 MSW 的 delay('infinite') 测「读取中」）
        'term_runs': [],       # 终端里输的命令（term_run 的参数）
        'term_polls': {},      # 每条命令取了几次输出
        'sessions': [
            {'sid': 'stq000001', 'agent': 'harness', 'title': '天启旧对话', 'turns': 1, 'updated': 1762214400000},
        ],
    }

    async def handle_xin(route):
        req = route.request
        st['xin_reqs'].append({'method': req.method, 'url': req.url, 'post': req.post_data})
        op = (req.post_data_json or {}).get('op') if req.method == 'POST' else None
        data = {'enabled': xin_enabled, 'authed': xin_enabled and st['authed']} if req.method == 'GET' else {
            'ok': True, 'data': {'name': 'li', 'state': 'running'} if op == 'status' else {}}
        await route.fulfill(status=200, content_type='application/json', json=data)

    async def handle_tq(route):
        req = route.request
        path = req.url.split('/api/tq/')[1].split('?')[0]
        st['tq_calls'].append('%s /api/tq/%s' % (req.method, path))

        def ok(body):
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(body))

        if path == 'me':
            return await ok({'enabled': st['enabled'], 'authed': st['authed'], 'stream': False})

        body = json.loads(req.post_data or '{}') if req.method == 'POST' else {}
        if path == 'login':
            ok_pw = body.get('password') == 'pw-ok-123456'
            if ok_pw:
                st['authed'] = True
            return await ok({'ok': True} if ok_pw else {'error': 'bad_pw', 'msg': '密码不对'}) if ok_pw else await route.fulfill(status=401, content_type='application/json', body=json.dumps({'msg': '密码不对'}))
        if path == 'logout':
            st['authed'] = False
            return await ok({'ok': True})

        if path != 'call':
            return await ok({'ok': False, 'state': 'error', 'msg': 'unsupported path: ' + path})

        op, args = body.get('op'), body.get('args') or {}
        st['tq_ops'].append(op)
        if op not in TQ_OPS:
            return await route.fulfill(status=400, content_type='application/json', body=json.dumps({'error': 'not_in_tianqi', 'msg': '天启没有这个功能'}))

        if op == 'status':
            return await ok({'ok': True, 'data': {'name': 'li2', 'state': 'running'}})
        if op == 'wake':
            return await ok({'ok': True, 'data': {'state': 'running', 'action': 'none'}})
        if op == 'ping':
            return await ok({'ok': True, 'data': {'ready': st['ready'], 'role': 'tianqi'}})
        if op == 'deliveries':
            return await ok({'ok': True, 'data': {'rows': []}})
        if op == 'sessions':
            return await ok({'ok': True, 'data': {'sessions': st['sessions']}})
        if op == 'plugins':  # 每个插件带一句说明，和控制器回的一样（PLUG_DESC）
            return await ok({'ok': True, 'data': {'plugins': [
                {'name': name, 'on': on, 'agent': 'harness', 'desc': PLUG_DESC.get(name, '')} for name, on in st['plugins'].items()
            ]}})
        if op == 'plugin_set':
            st['plugin_updates'].append(args)
            st['plugins'][args['name']] = args['on']
            return await ok({'ok': True, 'data': {'on': args['on']}})
        if op == 'history':
            sess = {'sid': args.get('sid'), 'agent': 'harness', 'title': '天启旧对话', 'model': 'deepseek-v4.1-flash'}
            if st['hist_perm']:
                sess['perm'] = st['hist_perm']
            if st['hist_work'] is not None:
                sess['work'] = st['hist_work']
            runs = [{'run': 'rhist0001', 'events': [{'t': 'user', 'text': '老问题'}, {'t': 'text', 'text': '老回答'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 800, 'model': 'deepseek-v4.1-flash'}], 'done': True}]
            if st['hist_plan']:
                runs += [
                    {'run': 'rhist0002', 'events': [{'t': 'user', 'text': '把 LED 改快一点', 'plan': True}, {'t': 'text', 'text': PLAN_MD}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 900, 'plan': True}], 'done': True},
                    {'run': 'rhist0003', 'events': [{'t': 'user', 'text': '按计划执行'}, {'t': 'text', 'text': '改好了，编译通过。'}, {'t': 'done', 'ok': True, 'code': 0, 'ms': 900}], 'done': True},
                ]
            runs += st['hist_extra']
            return await ok({'ok': True, 'data': {'session': sess, 'runs': runs, 'active': None}})
        if op == 'files':
            p = args.get('path') or '/data/workspace'
            st['files_reqs'].append(p)
            if p.endswith('.md'):
                return await ok({'ok': True, 'data': {'path': p, 'work': '/data/workspace', 'size': 64, 'mtime': 1763520000000, 'text': '# 天启的笔记\n\nPC13 接板上的 LED，低电平亮。'}})
            if st['files_gate'] is not None:
                await st['files_gate'].wait()
            return await ok({'ok': True, 'data': {'dir': True, 'path': p, 'work': '/data/workspace', 'entries': [
                {'name': 'stm32-blink', 'dir': True, 'mtime': 1763520000000},
                {'name': 'notes.md', 'dir': False, 'size': 64, 'mtime': 1763520000000},
            ] + ([{'name': 'uploads', 'dir': True, 'mtime': 1763520000000}] if st['files_uploads'] and p == '/data/workspace' else [])}})
        if op == 'term_run':
            st['term_runs'].append(args)
            return await ok({'ok': True, 'data': {'id': 't%07d' % len(st['term_runs'])}})
        if op == 'term_poll':
            tid = args.get('id', '')
            cmd = st['term_runs'][int(tid[1:]) - 1]['cmd']
            k = st['term_polls'][tid] = st['term_polls'].get(tid, 0) + 1
            end = {'done': True, 'code': 0, 'timedOut': False, 'truncated': False, 'ms': 1200}
            if cmd == 'sleep 99':
                steps = [{'out': '', 'off': 0, **end, 'code': 124, 'timedOut': True, 'ms': 60000}]
            elif cmd == 'yes':
                steps = [{'out': 'y\n' * 5, 'off': 10, **end, 'truncated': True, 'ms': 300}]
            else:   # 输出分两次给：先给一段、没跑完，再给剩下的
                steps = [{'out': 'total 8\n', 'off': 8, 'done': False}, {'out': 'drwxr-xr-x stm32-blink\n', 'off': 31, **end}]
            return await ok({'ok': True, 'data': steps[min(k, len(steps)) - 1]})
        if op == 'usage':
            return await ok({'ok': True, 'data': {'quotas': [], 'days': [], 'totals': {}, 'names': {}, 'sources': {}}})
        if op == 'send':
            st['sends'].append(args)
            st['last_text'] = args.get('text', '')
            st['polls'] = 0
            if st['waking_send']:
                st['waking_send'] = False
                return await ok({
                    'ok': False,
                    'accepted': True,
                    'state': 'waking',
                    'msg': '已收到 · 唤醒中',
                    'retryAfter': 1,
                    'delivery': {'id': 'dtq0001', 'state': 'pending', 'wait': {'state': 'waking'}},
                })
            return await ok({'ok': True, 'data': {'sid': args.get('sid') or 'stqnew0001', 'run': 'rtq%04d' % len(st['sends']), 'agent': 'harness'}})
        if op == 'delivery':
            st['delivery_checks'] += 1
            if st['delivery_checks'] == 1:
                return await ok({'ok': True, 'data': {'id': 'dtq0001', 'state': 'pending', 'wait': {'state': 'waking'}}})
            return await ok({'ok': True, 'data': {'id': 'dtq0001', 'state': 'delivered', 'result': {'sid': 'stqwake001', 'run': 'rtqwake01', 'agent': 'harness'}}})
        if op == 'poll':
            st['polls'] += 1
            reply = '唤醒后回复完成。' if args.get('run') == 'rtqwake01' else '你好，我是天启。'
            planned = bool(st['sends'] and st['sends'][-1].get('plan'))
            evs = [
                dict({'t': 'user', 'text': st['last_text']}, **({'plan': True} if planned else {})),
                {'t': 'text', 'text': PLAN_MD if planned else reply},
                dict({'t': 'done', 'ok': True, 'code': 0, 'ms': 1200, 'model': 'deepseek-v4.1-flash'}, **({'plan': True} if planned else {})),
            ]
            return await ok({'ok': True, 'data': {'events': evs, 'off': len(evs), 'done': True}})
        return await ok({'ok': True, 'data': {}})

    await pg.route('**/api/xin/**', handle_xin)
    await pg.route('**/api/tq/**', handle_tq)
    return st


def xin_operations(state):
    return [json.loads(req['post']).get('op') for req in state['xin_reqs'] if req['post']]

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROMIUM_PATH']} if os.environ.get('CHROMIUM_PATH') else {}))

        # 1. 没配好
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=False, authed=False)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc .xc-hint')
        await pg.wait_for_timeout(400)
        hint_text = await pg.text_content('.xc .xc-hint')
        body_text = await pg.evaluate('document.body.innerText')
        ui.check(
            '没配好：写「天启还没配好」，只发一次 GET /api/tq/me，/api/xin/ 零请求，界面没有「小芯」',
            '天启还没配好' in (hint_text or '') and st['tq_calls'] == ['GET /api/tq/me'] and st['xin_reqs'] == [] and '小芯' not in body_text,
            (hint_text, st['tq_calls'], st['xin_reqs']),
        )
        await pg.context.close()

        # 2. 配好、登录了（1280）
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        await pg.wait_for_selector('.tq-side .xc-si')
        await pg.wait_for_selector('.tq-pane .xc-fi')
        info = await pg.evaluate("""(() => {
          const r = s => document.querySelector(s).getBoundingClientRect();
          const side = r('.tq-side'), mid = r('.tq-mid'), right = r('.tq-right');
          return {
            fullScreen: document.querySelector('.xc.wb.tq-mode')?.clientWidth === innerWidth,
            columns: side.right <= mid.left && mid.right <= right.left && side.width > 200 && right.width > 300,
            brand: document.querySelector('.tq-brand h1')?.textContent,
            star: !!document.querySelector('.tq-brand .xc-tq'),
            sky: document.querySelectorAll('.xc.tq-mode canvas.tq-sky').length,
            tabs: [...document.querySelectorAll('.tq-tab:not([hidden])')].map(e => e.textContent.trim()),
            planTabHidden: document.querySelector('#tq-tab-plan').hidden,
            foot: [...document.querySelectorAll('.tq-side-foot .tq-row')].filter(e => e.offsetParent).map(e => e.textContent.trim()),
            history: [...document.querySelectorAll('.tq-side .xc-si-t')].map(e => e.textContent),
            files: [...document.querySelectorAll('.tq-pane .xc-fi-n')].map(e => e.textContent),
            noXiaoxinControls: !document.querySelector('.xc-as,.xc-mainb,.xc-dailyb,.xc-set-b,.xc-wb-b'),
            placeholder: document.querySelector('.xc-row textarea')?.placeholder,
            bodyText: document.body.innerText,
          };
        })()""")
        ui.check('三栏：左边对话记录常驻、中间对话、右边文件终端预览，夜空三层画布，页面无小芯功能', info['fullScreen'] and info['columns']
                 and info['brand'] == '天启' and info['star'] and info['sky'] == 3 and info['noXiaoxinControls']
                 and info['tabs'] == ['文件', '终端', '预览'] and info['planTabHidden'] and info['foot'] == ['设置', '插件']
                 and info['history'] == ['天启旧对话'] and 'stm32-blink' in info['files'] and st['files_reqs'][:1] == ['/data/workspace']
                 and info['placeholder'] == '给天启发消息' and '小芯' not in info['bodyText'], info)
        # 照 Linear 改版（docs/superpowers/specs/2026-11-20-tianqi-linear-design.md）：层次靠底色和细线——面板实心、没有毛玻璃；
        # 输入框没有大阴影；品牌星、标签下划线不发光；用系统字体（国内打不开 Google Fonts，不从外面加载样式表）
        look = await pg.evaluate("""(() => { const cs = s => getComputedStyle(document.querySelector(s));
          const alpha = c => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[\\s,\\/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
          const g = cs('.tq-side .tq-glass');
          return { blur: g.backdropFilter || 'none', alpha: alpha(g.backgroundColor), boxShadow: cs('.tq-box').boxShadow,
            markGlow: cs('.tq-brand-mark').filter, inkGlow: cs('.tq-tab-ink').boxShadow, font: cs('.xc.tq-mode').fontFamily,
            ext: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href).filter(h => !h.startsWith(location.origin)) }; })()""")
        ui.check('照 Linear：面板实心、没有毛玻璃；输入框没有大阴影；品牌星、标签下划线不发光；用系统字体，不加载外面的样式表',
                 look['blur'] == 'none' and look['alpha'] == 1 and '80px' not in look['boxShadow'] and look['markGlow'] == 'none'
                 and look['inkGlow'] == 'none' and bool(re.match(r'^\s*(Inter|-apple-system|system-ui|"SF Pro)', look['font'])) and not look['ext'], look)
        # 站长 11-20：模型名旁边那个信号格样子的思考强度不符合星空，换成一排星星：一样大，亮着的是天启的金色
        em = await pg.evaluate("""(() => { const bs = [...document.querySelectorAll('.tq-instruments .xc-mdl .xc-em b')];
          const probe = document.createElement('i'); probe.style.background = 'var(--star)'; document.querySelector('.tq-instruments').appendChild(probe);
          const star = getComputedStyle(probe).backgroundColor; probe.remove();
          return { n: bs.length, clip: bs.map(b => getComputedStyle(b).clipPath.startsWith('polygon')), h: [...new Set(bs.map(b => Math.round(b.getBoundingClientRect().height)))],
            on: bs.filter(b => b.classList.contains('on')).map(b => getComputedStyle(b).backgroundColor === star) }; })()""")
        ui.check('天启的思考强度是一排星星（不是信号格）：一样大，亮着的是天启的金色',
                 em['n'] >= 3 and all(em['clip']) and len(em['h']) == 1 and len(em['on']) > 0 and all(em['on']), em)
        await pg.locator('.tq-side .xc-si', has_text='天启旧对话').click()
        await pg.get_by_text('老回答', exact=True).wait_for()
        ui.check('对话记录常驻左栏，点历史对话打开并更新标题，左栏不收起', await pg.locator('.tq-side .xc-drawer').is_visible()
                 and await pg.locator('.tq-mid-head h2').text_content() == '天启旧对话'
                 and st['tq_ops'].count('history') == 1, st['tq_ops'])
        # 照 Linear：左栏每行一样高（32px），选中的一行只换底色、没有竖条；顶栏是「工作区 / 标题」一行（面包屑，不再是胶囊）；
        # 右栏标签下划线 0.2 秒到位、不回弹；发送键是圆角方块。左栏打开对话后隔 250ms 重读列表，等选中的那一行画出来再量
        await pg.wait_for_selector('.tq-side .xc-si.cur')
        lay = await pg.evaluate("""(() => { const q = s => document.querySelector(s), cs = s => getComputedStyle(q(s));
          const rows = [...document.querySelectorAll('.tq-side .xc-si')].map(e => Math.round(e.getBoundingClientRect().height));
          const sel = q('.tq-side .xc-sli:has(.xc-si.cur)'), w = q('#tq-work').getBoundingClientRect(), t = q('.tq-mid-head h2').getBoundingClientRect();
          return { rows, selShadow: sel ? getComputedStyle(sel).boxShadow : null, workFirst: w.right <= t.left + 1,
            sameLine: Math.abs((w.top + w.bottom) - (t.top + t.bottom)) < 4, workBorder: cs('#tq-work').borderTopWidth,
            sep: getComputedStyle(q('#tq-work'), '::after').content, ink: cs('.tq-tab-ink').transitionDuration, send: cs('.xc-send').borderTopLeftRadius,
            workCut: q('#tq-work span').scrollWidth > q('#tq-work span').clientWidth }; })()""")
        ui.check('照 Linear：左栏每行 32px、选中只换底色；顶栏是「工作区 / 标题」一行，地方够时工作区名字不截断；标签下划线 0.2 秒不回弹；发送键是圆角方块',
                 set(lay['rows']) == {32} and lay['selShadow'] == 'none' and lay['workFirst'] and lay['sameLine'] and lay['workBorder'] == '0px' and not lay['workCut']
                 and lay['sep'] == '"/"' and lay['ink'] == '0.2s' and lay['send'] in ('8px', '9px'), lay)
        await pg.locator('.tq-pane .xc-fi', has_text='notes.md').click()
        await pg.get_by_role('button', name='预览', exact=True).click()
        await pg.wait_for_selector('#tq-p-prev:not([hidden]) .tq-pv-fig pre')
        pv = await pg.text_content('#tq-p-prev .tq-pv-fig pre')
        ui.check('文件在右栏打开、聊天还在；markdown 点「预览」在「预览」标签里显示', '天启的笔记' in (pv or '')
                 and await pg.get_by_text('老回答', exact=True).is_visible() and st['files_reqs'][-1] == '/data/workspace/notes.md', (pv, st['files_reqs']))
        await pg.get_by_role('button', name='新建对话').click()
        await pg.get_by_text('从一个问题开始探索').wait_for()
        await pg.keyboard.press('Control+b')
        rail = await pg.evaluate("document.querySelector('.tq-frame').dataset.left")
        await pg.keyboard.press('Control+b')
        await pg.keyboard.press('Control+j')
        closed = await pg.evaluate("document.querySelector('.tq-frame').dataset.right")
        await pg.keyboard.press('Control+j')
        opened = await pg.evaluate("document.querySelector('.tq-frame').dataset.right")
        ui.check('Ctrl+B 把左栏收成窄条、Ctrl+J 收起和打开右栏', (rail, closed, opened) == ('rail', 'closed', 'open'), (rail, closed, opened))
        await pg.locator('#tq-tab-prev').click()
        await pg.keyboard.press('ArrowRight')
        wrapped = await pg.evaluate("[document.activeElement.id, document.querySelector('#tq-tab-files').getAttribute('aria-selected'), document.querySelector('#tq-tab-plan').getAttribute('aria-selected')]")
        ui.check('右栏标签用方向键切换：从「预览」往右绕回「文件」，跳过藏着的「计划」', wrapped == ['tq-tab-files', 'true', 'false'], wrapped)
        await pg.get_by_role('button', name='设置', exact=True).click()
        await pg.wait_for_selector('#tq-settings.on')
        await pg.get_by_role('radio', name='星图').click()
        await pg.wait_for_function("document.documentElement.dataset.theme === 'light'")
        saved = await pg.evaluate("localStorage.getItem('lm.tq.theme')")
        await pg.get_by_role('radio', name='夜空').click()
        await pg.wait_for_function("document.documentElement.dataset.theme === 'dark'")
        await pg.keyboard.press('Escape')
        await pg.wait_for_selector('#tq-settings', state='hidden')
        ui.check('设置里换外观：星图是浅色、夜空是深色，存在天启自己的 lm.tq.theme，Esc 关掉', saved == 'light', saved)
        trigger = pg.get_by_role('button', name='插件', exact=True)
        await trigger.click()
        panel = pg.get_by_role('region', name='天启插件')
        purge = panel.get_by_role('switch', name='Purge')
        rea = panel.get_by_role('switch', name='REA 逆向')
        await rea.wait_for()
        initial = (await purge.get_attribute('aria-checked'), await rea.get_attribute('aria-checked'))
        await rea.click()
        await pg.wait_for_function("document.querySelector('.xc-plug-rea [role=switch]').getAttribute('aria-checked') === 'true'")
        await pg.keyboard.press('Escape')
        focus_restored = await trigger.evaluate('e => document.activeElement === e')
        await trigger.click()
        await rea.wait_for()
        plug = await pg.evaluate(PLUG_LOOK)
        ui.check('照 Linear：电脑上插件页居中、宽不超过 440；每个插件下面一行说明；开着的开关是金色（天启的星）',
                 plug['w'] <= 440 and abs(plug['cx'] - plug['iw'] / 2) < 2 and plug['desc'] == ['提示词与规则管理', 'Ghidra 本地分析工具']
                 and plug['onBg'] == plug['star'] and plug['alpha'] == 1, plug)
        ui.check('天启插件面板向 li2 保存开关，关闭后恢复键盘焦点', initial == ('true', 'false') and focus_restored
                 and await rea.get_attribute('aria-checked') == 'true'
                 and st['plugin_updates'] == [{'agent': 'harness', 'name': 'rea', 'on': True}]
                 and not st['xin_reqs'], (initial, focus_restored, st['plugin_updates']))
        await panel.get_by_role('button', name='关掉').click()
        await pg.fill('.xc-row textarea', '帮我查个问题')
        await pg.press('.xc-row textarea', 'Enter')
        await pg.wait_for_function(ui.CHAT_DONE + " && [...document.querySelectorAll('.xc-ai .xc-bub')].some(e => e.textContent.includes('你好，我是天启'))", timeout=10000)
        sent = st['sends'][-1]
        after_text = await pg.evaluate("""(() => ({
          who: document.querySelector('.xc-ai .xc-who')?.textContent,
          star: !!document.querySelector('.xc-ai .xc-tq'),
          bodyText: document.body.innerText,
        }))()""")
        bad_ops = [op for op in st['tq_ops'] if op not in TQ_OPS]
        ui.check(
            '发消息：agent==harness、带 model/effort、不带 context/ctxLabel/main，回复写天启+星，只调用 TQ_OPS，/api/xin/ 零请求',
            sent.get('agent') == 'harness' and bool(sent.get('model')) and bool(sent.get('effort'))
            and 'context' not in sent and 'ctxLabel' not in sent and 'main' not in sent
            and after_text['who'] == '天启' and after_text['star'] and '小芯' not in after_text['bodyText']
            and not bad_ops and st['xin_reqs'] == [],
            (sent, after_text, bad_ops, st['xin_reqs']),
        )
        await pg.context.close()

        # 2b. 权限和计划（第 2 个 PR）：输入框里的权限按钮切这个对话的、完全权限要再确认；计划模式那一句带 plan，
        #     计划出来后对话里一张卡片、右栏「计划」打开；只读时「按计划执行」不能点；按计划执行用对话的权限；设置里改默认权限
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        perm = pg.locator('#tq-perm')
        first = (await perm.get_attribute('aria-label'), await perm.text_content(), await pg.locator('#tq-plan').get_attribute('aria-pressed'))
        await perm.click()
        menu = pg.get_by_role('menu', name='这个对话的权限')
        await menu.wait_for()
        opts = await menu.get_by_role('menuitemradio').evaluate_all("es => es.map(e => [e.querySelector('.tq-opt-t > span').textContent, e.getAttribute('aria-checked')])")
        focused = await pg.evaluate("document.activeElement?.dataset?.perm")
        await menu.get_by_role('menuitemradio', name='只读').click()
        ro_label = await perm.text_content()
        await perm.click()
        await pg.get_by_role('menuitemradio', name='完全权限').click()
        confirm = await pg.locator('.tq-confirm').text_content()
        await pg.get_by_role('button', name='取消').click()
        still_ro = await perm.text_content()
        await pg.get_by_role('menuitemradio', name='工作区内修改').click()
        ui.check('权限按钮：默认完全权限；弹出三档（当前那档打勾、焦点在它上面）；切只读；切完全权限要再确认，取消就不换；换成工作区内修改',
                 first == ('权限：完全权限', '完全', 'false') and opts == [['只读', 'false'], ['工作区内修改', 'false'], ['完全权限', 'true']]
                 and focused == 'danger-full-access' and ro_label == '只读' and '能改 li2 上的任何文件' in (confirm or '')
                 and still_ro == '只读' and await perm.text_content() == '工作区' and not await menu.is_visible(),
                 (first, opts, focused, ro_label, confirm, still_ro))
        await perm.click()
        await menu.wait_for()
        await pg.keyboard.press('Escape')
        esc = (await menu.is_visible(), await pg.locator('.xc.wb.show.tq-mode').count(), await perm.evaluate('e => document.activeElement === e'))
        await pg.locator('#tq-plan').click()
        plan_on = await pg.evaluate("""(() => ({ pressed: document.querySelector('#tq-plan').getAttribute('aria-pressed'),
          box: document.querySelector('.tq-box').classList.contains('plan'), ph: document.querySelector('.tq-entry textarea').placeholder }))()""")
        ui.check('Esc 只收起权限弹层（天启不关、焦点回按钮）；点「计划」进计划模式：输入框变蓝、提示换成先出计划',
                 esc == (False, 1, True) and plan_on == {'pressed': 'true', 'box': True, 'ph': '说说要做什么，天启先出计划'}, (esc, plan_on))
        await pg.fill('.xc-row textarea', '把 LED 改快一点')
        await pg.press('.xc-row textarea', 'Enter')
        await pg.wait_for_selector('.tq-plan-card')
        await pg.wait_for_function(ui.CHAT_DONE)
        # 这一轮还在收尾时「按计划执行」是灰的，做完才能点
        await pg.wait_for_function("!document.querySelector('.tq-plan-card [data-plan-act=run]').disabled")
        sent = st['sends'][-1]
        card = await pg.evaluate("""(() => {
          const c = document.querySelector('.tq-plan-card'), m = c.closest('.xc-ai');
          return { title: c.querySelector('.tq-pc-top span').textContent, sum: c.querySelector('p').textContent,
            bubble: m ? getComputedStyle(m.querySelector(':scope > .xc-bub')).display : '',
            acts: [...c.querySelectorAll('.tq-acts button')].map(b => [b.textContent, b.disabled]),
            tag: [...document.querySelectorAll('.xc-me .tq-plan-tag')].map(e => e.textContent),
            tab: !document.querySelector('#tq-tab-plan').hidden && document.querySelector('#tq-tab-plan').getAttribute('aria-selected'),
            doc: document.querySelector('#tq-p-plan:not([hidden]) .tq-plan-doc h4')?.textContent,
            steps: document.querySelectorAll('#tq-p-plan .tq-plan-doc ol > li').length,
            ph: document.querySelector('.tq-entry textarea').placeholder };
        })()""")
        ui.check('计划模式发出去带 plan、权限是对话的；计划出来：用户那句标「计划」，回答换成计划卡片（标题、3 步），右栏「计划」打开、有标题和三步',
                 sent.get('plan') is True and sent.get('perm') == 'workspace-write' and card['title'] == '计划：把 LED 闪烁改成 200 ms'
                 and card['sum'].startswith('3 步') and card['bubble'] == 'none' and card['tag'] == ['计划']
                 and card['acts'] == [['按计划执行', False], ['继续改计划', False], ['看计划', False]]
                 and card['tab'] == 'true' and card['doc'] == '把 LED 闪烁改成 200 ms' and card['steps'] == 3
                 and card['ph'] == '说说要做什么，天启先出计划', (sent, card))
        await perm.click()
        await pg.get_by_role('menuitemradio', name='只读').click()
        ro_card = await pg.evaluate("""(() => { const c = document.querySelector('.tq-plan-card');
          return [c.querySelector('[data-plan-act=run]').disabled, c.querySelector('.tq-btn-note')?.textContent || ''] })()""")
        await perm.click()
        await pg.get_by_role('menuitemradio', name='工作区内修改').click()
        n_sends = len(st['sends'])
        await pg.locator('.tq-plan-card').get_by_role('button', name='按计划执行').click()
        await pg.wait_for_function("[...document.querySelectorAll('.xc-me .xc-bub')].some(e => e.textContent === '按计划执行')")
        await pg.wait_for_function(ui.CHAT_DONE + " && [...document.querySelectorAll('.xc-ai .xc-bub')].some(e => e.textContent.includes('你好，我是天启'))", timeout=10000)
        run_sent = st['sends'][-1] if len(st['sends']) > n_sends else {}
        after = await pg.evaluate("""(() => ({ pressed: document.querySelector('#tq-plan').getAttribute('aria-pressed'),
          acts: [...document.querySelector('.tq-plan-card').querySelectorAll('.tq-acts button')].map(b => b.textContent),
          ph: document.querySelector('.tq-entry textarea').placeholder }))()""")
        ui.check('只读时「按计划执行」不能点并说明；换回工作区内修改后点它：发「按计划执行」、不带 plan、权限是对话的；计划模式关掉，旧卡片只剩「看计划」',
                 ro_card[0] is True and '只读' in ro_card[1] and run_sent.get('text') == '按计划执行' and not run_sent.get('plan')
                 and run_sent.get('perm') == 'workspace-write' and after == {'pressed': 'false', 'acts': ['看计划'], 'ph': '给天启发消息'}, (ro_card, run_sent, after))
        # 站长 11-20：设置里的「权限」「插件」两页多余（输入框旁边有权限按钮、左栏有插件），去掉；
        # 新对话沿用上次在新对话里选的权限（存在 lm.tq.perm，代替原来设置里的默认权限，和模型一样记着上次的）
        await pg.get_by_role('button', name='设置', exact=True).click()
        await pg.wait_for_selector('#tq-settings.on')
        tabs = await pg.evaluate("[...document.querySelectorAll('.tq-set-tab')].map(b => b.textContent.trim())")
        await pg.keyboard.press('Escape')
        await pg.wait_for_selector('#tq-settings', state='hidden')
        await pg.get_by_role('button', name='新建对话').click()
        await pg.get_by_text('从一个问题开始探索').wait_for()
        await perm.click()
        await pg.get_by_role('menuitemradio', name=re.compile('^只读')).click()
        saved = await pg.evaluate("localStorage.getItem('lm.tq.perm')")
        await pg.get_by_role('button', name='新建对话').click()
        await pg.get_by_text('从一个问题开始探索').wait_for()
        new_label = await perm.text_content()
        st['hist_perm'] = 'workspace-write'
        st['hist_plan'] = True
        await pg.locator('.tq-side .xc-si', has_text='天启旧对话').click()
        await pg.get_by_text('改好了，编译通过。', exact=True).wait_for()
        hist = await pg.evaluate("""(() => ({ label: document.querySelector('#tq-perm .tq-perm-n').textContent,
          cards: [...document.querySelectorAll('.tq-plan-card')].map(c => [...c.querySelectorAll('.tq-acts button')].map(b => b.textContent)),
          tab: !document.querySelector('#tq-tab-plan').hidden }))()""")
        ui.check('设置里只剩外观和电脑两页；新对话里选了只读，下一个新对话沿用（存在 lm.tq.perm）；打开记着工作区内修改的旧对话，按钮跟着换；旧计划刷新后还在、只能看',
                 tabs == ['外观', '电脑'] and saved == 'read-only' and new_label == '只读' and hist == {'label': '工作区', 'cards': [['看计划']], 'tab': True},
                 (tabs, saved, new_label, hist))
        await pg.context.close()
        # 手机：计划卡片和正文一样占满整行（回答是两栏网格，没指定的话会掉进头像那一栏，挤成一条竖线）；右栏不自动升起，「计划」亮个小点
        pg = await ui.page(browser, 390, 844)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        await pg.locator('#tq-plan').click()
        await pg.fill('.xc-row textarea', '把 LED 改快一点')
        await pg.press('.xc-row textarea', 'Enter')
        await pg.wait_for_selector('.tq-plan-card')
        await pg.wait_for_function(ui.CHAT_DONE)
        phone = await pg.evaluate("""(() => { const c = document.querySelector('.tq-plan-card').getBoundingClientRect(), m = document.querySelector('.tq-mid').getBoundingClientRect();
          return { w: Math.round(c.width), share: Math.round(c.width / m.width * 100), right: document.querySelector('.tq-frame').dataset.right,
            dot: document.querySelector('#tq-tab-plan').classList.contains('has'), chips: [...document.querySelectorAll('.tq-instruments > *')].every(e => e.getBoundingClientRect().right <= document.querySelector('.tq-box').getBoundingClientRect().right + 0.5),
            by: (() => { const b = document.querySelector('.xc-by'), l = document.querySelector('.xc-msgs'); return b ? Math.round(b.getBoundingClientRect().left - l.getBoundingClientRect().left - parseFloat(getComputedStyle(l).paddingLeft)) : null; })() }; })()""")
        # 截图自查：回答下面那行模型名在手机上还缩进 44px（chat.css 手机规则写在 .xc-by 的基本规则前面，被盖掉了），要和正文左边对齐
        ui.check('手机：计划卡片占满整行；右栏不自动升起、「计划」亮小点；输入框里的按钮都在框内；回答下面的模型名和正文左边对齐',
                 phone['share'] >= 80 and phone['right'] == 'closed' and phone['dot'] and phone['chips'] and phone['by'] is not None and abs(phone['by']) <= 1, phone)
        # 站长 11-20：模型面板切到「最高」时面板弹一下。说明那行字换字时宽度跟着内容动画，新字长一点就在旧宽度里折成两行，面板先变高再缩回去
        await pg.click('.xc-mdl')
        await pg.wait_for_selector('.xc-pick:not([hidden])')
        await pg.wait_for_timeout(450)
        hs = await pg.evaluate("""() => new Promise(done => {
          const p = document.querySelector('.xc-pick'), hs = [], t0 = performance.now();
          document.querySelector('.xc-eff-d[data-v=max]').click();
          (function f() { hs.push(p.getBoundingClientRect().height); if (performance.now() - t0 < 600) requestAnimationFrame(f); else done(hs); })();
        })""")
        ui.check('手机：模型面板从「高」切到「最高」，说明换字时面板高度一直不变（不弹一下）', len(hs) > 5 and max(hs) - min(hs) < 1, (round(min(hs), 1), round(max(hs), 1), len(hs)))
        # 截图自查：计划模式的提示语在手机上折成两行，输入框只按打的字长高，第二行被切掉一半。提示语要一行放得下（390 和更窄的 360 都量）
        fit_js = """(() => { const t = document.querySelector('.xc-row textarea'), cs = getComputedStyle(t), s = document.createElement('span');
          s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + cs.font + ';letter-spacing:' + cs.letterSpacing;
          s.textContent = t.placeholder; document.body.appendChild(s); const need = s.getBoundingClientRect().width; s.remove();
          return [t.placeholder, Math.round(need), Math.round(t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))]; })()"""
        fits = [await pg.evaluate(fit_js)]
        await pg.set_viewport_size({'width': 360, 'height': 780})
        await pg.wait_for_timeout(200)
        fits.append(await pg.evaluate(fit_js))
        ui.check('手机：计划模式的提示语一行放得下（390、360 宽都不折行、不被切掉）', all('计划' in f[0] and f[1] <= f[2] for f in fits), fits)
        await pg.context.close()

        # 2c. 工作区（第 3 个 PR）：新对话时输入框上面选工作区（列 /data/workspace 下的文件夹，不列 uploads 和文件，能新建），
        #     发出去带 work；标题旁显示工作区；左栏按工作区分组、组能收起；打开旧对话时不再让选，标题旁是它的工作区
        pg = await ui.page(browser, 1280, 860)
        await pg.add_init_script("try{localStorage.removeItem('lm.tq.work')}catch(e){}")
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        st['files_uploads'] = True
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        seen = """(() => { const p = document.querySelector('#tq-work-pick'), w = document.querySelector('#tq-work');
          return { pick: !!p && p.offsetParent !== null, label: p ? p.textContent.trim() : '', head: w ? w.textContent.trim() : '' }; })()"""
        first = await pg.evaluate(seen)
        st['files_gate'] = asyncio.Event()   # 列目录先停住：弹层这时还在「读取文件夹…」（CI 比本地慢，测试曾在这时读了列表）
        await pg.locator('#tq-work-pick').click()
        await pg.wait_for_selector('#tq-work-pop:not([hidden]) [role=menuitemradio]')
        loading = await pg.evaluate("[document.querySelector('#tq-work-pop').textContent.includes('读取文件夹…'), document.querySelectorAll('#tq-work-pop [data-work]').length]")
        st['files_gate'].set()
        # 等读完再读列表（照 Playwright 的 web-first assertions、Testing Library 的 findBy：等条件成立，不是等随便哪个元素出现）
        await pg.wait_for_function("!document.querySelector('#tq-work-pop').textContent.includes('读取文件夹…')")
        items = await pg.evaluate("[...document.querySelectorAll('#tq-work-pop [role^=menuitem]')].map(b => b.textContent.trim())")
        await pg.locator('#tq-work-pop [role=menuitemradio]', has_text='stm32-blink').click()
        chosen = await pg.evaluate(seen)
        popped = await pg.evaluate("document.querySelector('#tq-work-pop').hidden")
        ui.check('新对话：输入框上面选工作区，先写「读取文件夹…」，读完列出文件夹、「工作目录」和「新建文件夹…」，不列 uploads 和文件；选了标题旁跟着换',
                 first['pick'] and '工作目录' in first['label'] and '工作目录' in first['head'] and popped and loading == [True, 1]
                 and any('stm32-blink' in t for t in items) and any('工作目录' in t for t in items) and any('新建文件夹' in t for t in items)
                 and not any('uploads' in t or 'notes.md' in t for t in items) and 'stm32-blink' in chosen['label'] and 'stm32-blink' in chosen['head'], (first, loading, items, chosen))
        await pg.fill('.xc-row textarea', '看看工程')
        await pg.press('.xc-row textarea', 'Enter')
        await pg.wait_for_function(ui.CHAT_DONE)
        after = await pg.evaluate(seen)
        ui.check('发出去的这句带 work；对话开始后不再让选，标题旁还是这个工作区', st['sends'][-1].get('work') == 'stm32-blink' and not after['pick'] and 'stm32-blink' in after['head'], (st['sends'][-1].get('work'), after))
        # 左栏按工作区分组：最近有动静的组在前，组里照旧按时间；组标题能收起
        st['sessions'] = [
            {'sid': 'stqa00001', 'agent': 'harness', 'title': 'LED 快闪', 'turns': 2, 'updated': 1763600000000, 'work': 'stm32-blink'},
            {'sid': 'stqb00001', 'agent': 'harness', 'title': '天启旧对话', 'turns': 1, 'updated': 1763500000000, 'work': ''},
            {'sid': 'stqc00001', 'agent': 'harness', 'title': '串口调试', 'turns': 3, 'updated': 1763400000000, 'work': 'stm32-blink'},
        ]
        await pg.reload()
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-sgrp')
        rows_js = "[...document.querySelectorAll('.xc-sl-main > li')].filter(li => !li.hidden).map(li => li.classList.contains('xc-sgrp') ? 'G:' + li.textContent.trim() : 'S:' + li.querySelector('.xc-si-t').textContent)"
        rows = await pg.evaluate(rows_js)
        await pg.locator('.xc-sgrp-b', has_text='stm32-blink').click()
        folded = await pg.evaluate(rows_js)
        exp = await pg.evaluate("document.querySelector('.xc-sgrp-b').getAttribute('aria-expanded')")
        ui.check('左栏按工作区分组：最近的组在前、组里按时间；点组标题收起，读屏知道收起了',
                 len(rows) == 5 and rows[0].startswith('G:stm32-blink') and rows[1:3] == ['S:LED 快闪', 'S:串口调试'] and rows[3].startswith('G:工作目录') and rows[4] == 'S:天启旧对话'
                 and folded == [rows[0], rows[3], rows[4]] and exp == 'false', (rows, folded, exp))
        # 打开旧对话：不再让选，标题旁是它的工作区
        st['hist_work'] = 'stm32-blink'
        await pg.locator('.xc-si', has_text='天启旧对话').click()
        await pg.wait_for_function("document.querySelector('.xc-msgs').textContent.includes('老回答')")
        old = await pg.evaluate(seen)
        ui.check('打开旧对话：不出工作区选择，标题旁是它记下的工作区', not old['pick'] and 'stm32-blink' in old['head'], old)
        await pg.context.close()
        # 新建文件夹：名字不合规矩说清楚、不收；合规矩的记下来，发出去带上
        pg = await ui.page(browser, 1280, 860)
        await pg.add_init_script("try{localStorage.removeItem('lm.tq.work')}catch(e){}")
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        await pg.locator('#tq-work-pick').click()
        await pg.locator('#tq-work-pop [role=menuitem]', has_text='新建文件夹').click()
        box_in = pg.locator('#tq-work-pop input')
        await box_in.fill('a/b')
        await box_in.press('Enter')
        bad = await pg.evaluate("[!document.querySelector('#tq-work-pop').hidden, (document.querySelector('#tq-work-pop .tq-work-err') || {}).textContent || '']")
        await box_in.fill('led-fast')
        await box_in.press('Enter')
        good = await pg.evaluate(seen)
        saved = await pg.evaluate("localStorage.getItem('lm.tq.work')")
        await pg.fill('.xc-row textarea', '把 LED 改快一点')
        await pg.press('.xc-row textarea', 'Enter')
        await pg.wait_for_function(ui.CHAT_DONE)
        ui.check('新建文件夹：名字不合规矩时说清楚、不收；合规矩的选上、记住，发出去带 work',
                 bad[0] and '字母' in bad[1] and 'led-fast' in good['label'] and saved == 'led-fast' and st['sends'][-1].get('work') == 'led-fast', (bad, good, saved, st['sends'][-1].get('work')))
        await pg.context.close()
        # 手机：工作区选择和输入框都在屏幕里
        pg = await ui.page(browser, 390, 844)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        fit = await pg.evaluate("""(() => { const r = e => document.querySelector(e).getBoundingClientRect();
          return { pick: [Math.round(r('#tq-work-pick').left), Math.round(r('#tq-work-pick').right)], box: Math.round(r('.tq-box').right), iw: innerWidth, sw: document.documentElement.scrollWidth }; })()""")
        ui.check('手机：工作区选择和输入框都在屏幕里，没有横向滚动', fit['pick'][0] >= 0 and fit['pick'][1] <= fit['iw'] and fit['box'] <= fit['iw'] and fit['sw'] <= fit['iw'], fit)
        await pg.locator('.tq-menu').click()
        await pg.locator('.tq-plug-b').click()
        await pg.wait_for_selector('.xc-sheet .xc-plug-rea .xc-sw')
        await pg.wait_for_timeout(350)   # 等升起的动画走完再量
        plug = await pg.evaluate(PLUG_LOOK)
        ui.check('照 Linear：手机上插件页从底部升起——贴底、左右贴边、不透明、顶上一条拖动条，高度跟着内容走（底下没有空白）',
                 abs(plug['bottom'] - plug['ih']) <= 1 and plug['left'] == 0 and plug['right'] == plug['iw'] and plug['alpha'] == 1
                 and plug['grip'] and plug['h'] <= plug['need'] + 2 and plug['desc'] == ['提示词与规则管理', 'Ghidra 本地分析工具'], plug)
        await pg.context.close()

        # 2c-2. 照 Linear 的命令面板（Cmd K，开源的同类是 pacocoursey/cmdk）：天启的常用操作都在里面，每项右边写快捷键；
        #       单键快捷键 C 新对话、M 模型、P 权限、W 工作区，只在没在打字、没按 Ctrl / Alt / ⌘ 时生效
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        st['sessions'] = [{'sid': 'stqb00001', 'agent': 'harness', 'title': '天启旧对话', 'turns': 1, 'updated': 1763500000000}]
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        await pg.keyboard.press('Control+k')
        await pg.wait_for_selector('.xc-pal.in .xc-pal-i')
        pal = await pg.evaluate("""[...document.querySelectorAll('.xc-pal-i')].map(b => [b.querySelector('.xc-pal-t').textContent,
          [...b.querySelectorAll('.xc-pal-k kbd')].map(k => k.textContent).join(' ')])""")
        # 截图自查：天启全局的金色焦点框盖掉了命令面板输入框的「不画框」，搜索框外面多一个金色方框；面板还是旧的 20px 圆角
        pal_box = await pg.evaluate("""[document.activeElement.matches('.xc-pal-q input'), getComputedStyle(document.activeElement).outlineStyle,
          getComputedStyle(document.querySelector('.xc-pal-box')).borderTopLeftRadius]""")
        ui.check('照 Linear：命令面板 12px 圆角，打开就能打字，搜索框外面不画焦点框（光标就够了）', pal_box == [True, 'none', '12px'], pal_box)
        await pg.keyboard.press('Escape')
        await pg.wait_for_function("document.querySelector('.xc-pal').hidden")
        kb = dict(pal)
        ui.check('照 Linear：Ctrl K 命令面板里有天启的常用操作（换模型、换权限、计划模式、切换工作区、打开终端、左栏、右栏、插件、设置），右边写着快捷键',
                 all(t in kb for t in ['换模型', '换权限', '计划模式', '切换工作区', '打开终端', '插件', '设置'])
                 and kb.get('新建对话') == 'C' and kb.get('换模型') == 'M' and kb.get('换权限') == 'P' and kb.get('切换工作区') == 'W'
                 and any(t.endswith('右栏') and k == 'Ctrl J' for t, k in pal) and any(t.endswith('左栏') and k == 'Ctrl B' for t, k in pal), pal)
        opened = """(() => ({ perm: !document.querySelector('#tq-perm-pop').hidden, model: document.querySelector('.tq-instruments .xc-mdl').getAttribute('aria-expanded') === 'true',
          work: !document.querySelector('#tq-work-pop').hidden, sid: window.LimingXinChat.state.sid || '' }))()"""
        # 在输入框里打这几个字母只是打字
        await pg.locator('.xc-row textarea').click()
        await pg.keyboard.type('cmpw')
        typed = await pg.evaluate("document.querySelector('.xc-row textarea').value")
        in_box = await pg.evaluate(opened)
        await pg.fill('.xc-row textarea', '')
        # 没在打字时：P 弹出权限、M 弹出模型、W 弹出工作区（各自 Esc 关掉）；打开旧对话后按 C 回到新对话
        await pg.evaluate("document.activeElement && document.activeElement.blur()")
        keys = {}
        for key in ['p', 'm', 'w']:
            await pg.keyboard.press(key)
            await pg.wait_for_timeout(120)
            keys[key] = await pg.evaluate(opened)
            await pg.keyboard.press('Escape')
            await pg.wait_for_timeout(120)
            await pg.evaluate("document.activeElement && document.activeElement.blur()")
        await pg.keyboard.press('Control+p')   # 带 Ctrl 的不算（浏览器自己的打印也不能被抢）
        ctrl_p = await pg.evaluate(opened)
        sky = "parseFloat(getComputedStyle(document.querySelector('.tq-sky')).opacity)"
        sky_new = await pg.evaluate(sky)
        await pg.locator('.tq-side .xc-si', has_text='天启旧对话').click()
        await pg.wait_for_function("window.LimingXinChat.state.sid === 'stqb00001'")
        await pg.wait_for_timeout(900)   # 原来变暗的过渡是 0.6 秒：等过它再量
        sky_conv = await pg.evaluate(sky)
        await pg.evaluate("document.activeElement && document.activeElement.blur()")
        await pg.keyboard.press('c')
        await pg.wait_for_function("!window.LimingXinChat.state.sid", timeout=3000)
        after_c = await pg.evaluate("[window.LimingXinChat.state.sid || '', document.activeElement === document.querySelector('.xc-row textarea')]")
        sky_back = await pg.evaluate(sky)
        # 站长 11-20：背景有点淡了。进了对话也不再把夜空调暗（原来照 Linear「内容优先」暗到 0.55）
        ui.check('夜空在新对话、进了对话、回到新对话都一样亮（不再调暗）', sky_new == 1 and sky_conv == 1 and sky_back == 1, (sky_new, sky_conv, sky_back))
        ui.check('照 Linear：没在打字时单键 P 权限、M 模型、W 工作区、C 新对话（光标进输入框）；在输入框里打 cmpw 只是打字；带 Ctrl 的不算',
                 typed == 'cmpw' and not (in_box['perm'] or in_box['model'] or in_box['work'])
                 and keys['p']['perm'] and keys['m']['model'] and keys['w']['work']
                 and not (ctrl_p['perm'] or ctrl_p['model'] or ctrl_p['work']) and after_c == ['', True], (typed, in_box, keys, ctrl_p, after_c))
        await pg.context.close()

        # 2d. 终端里自己输命令（第 3 个 PR）：右栏「终端」底下一个输入框，在这个对话（或新对话选的）工作区里跑；
        #     命令后台跑、分几次取输出；跑的时候不能再发；结尾写退出码和用时，超时、输出太多各有一句话
        pg = await ui.page(browser, 1280, 860)
        await pg.add_init_script("try{localStorage.removeItem('lm.tq.work')}catch(e){}")
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        await pg.locator('#tq-tab-term').click()
        cli = pg.locator('#tq-term-form input')
        await cli.fill('ls')
        await cli.press('Enter')
        busy = await pg.evaluate("document.querySelector('#tq-term-form input').disabled")
        ended = lambda n: "document.querySelectorAll('.tq-cli-run').length === %d && document.querySelectorAll('.tq-cli-run')[%d].querySelector('.tq-cli-end').textContent" % (n, n - 1)
        await pg.wait_for_function(ended(1))
        r1 = await pg.evaluate("""(() => { const b = document.querySelector('.tq-cli-run');
          return { cmd: b.querySelector('.tq-cli-cmd').textContent, out: b.querySelector('.tq-cli-out').textContent, end: b.querySelector('.tq-cli-end').textContent,
            live: document.querySelector('.tq-cli-log').getAttribute('aria-live'), dis: document.querySelector('#tq-term-form input').disabled, focus: document.activeElement === document.querySelector('#tq-term-form input') }; })()""")
        ui.check('右栏「终端」底下能自己输命令：带上工作区跑，跑的时候不能再发；输出分两次拼起来，结尾写退出码和用时；跑完焦点回输入框',
                 st['term_runs'][-1] == {'work': '', 'cmd': 'ls'} and busy and r1['cmd'] == '$ ls' and r1['out'] == 'total 8\ndrwxr-xr-x stm32-blink\n'
                 and '退出码 0' in r1['end'] and '1.2 秒' in r1['end'] and r1['live'] == 'polite' and not r1['dis'] and r1['focus'], (st['term_runs'], busy, r1))
        await cli.fill('sleep 99')
        await cli.press('Enter')
        await pg.wait_for_function(ended(2))
        await cli.fill('yes')
        await cli.press('Enter')
        await pg.wait_for_function(ended(3))
        ends = await pg.evaluate("[...document.querySelectorAll('.tq-cli-run .tq-cli-end')].map(e => e.textContent)")
        ui.check('超时、输出太多各有一句话说清楚', '超过 60 秒' in ends[1] and '64 KB' in ends[2], ends)
        await pg.locator('#tq-work-pick').click()
        await pg.locator('#tq-work-pop [role=menuitemradio]', has_text='stm32-blink').click()
        await cli.fill('ls')
        await cli.press('Enter')
        await pg.wait_for_function(ended(4))
        ui.check('终端跟着工作区走：新对话选了 stm32-blink，命令就在那里跑', st['term_runs'][-1] == {'work': 'stm32-blink', 'cmd': 'ls'}, st['term_runs'][-1])
        await pg.context.close()
        # 手机：右栏从底下升起，终端的输入框在屏幕里
        pg = await ui.page(browser, 390, 844)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        await pg.locator('.tq-panel-b').click()
        await pg.locator('#tq-tab-term').click()
        await pg.wait_for_timeout(600)
        tfit = await pg.evaluate("""(() => { const r = document.querySelector('#tq-term-form').getBoundingClientRect();
          return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), iw: innerWidth, ih: innerHeight }; })()""")
        ui.check('手机：终端的输入框在屏幕里', tfit['l'] >= 0 and tfit['r'] <= tfit['iw'] and tfit['t'] >= 0 and tfit['b'] <= tfit['ih'], tfit)
        await pg.context.close()

        # 3. 没登录
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=False, ready=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc-login:not([hidden]) .xc-login-av .xc-tq')
        login_txt = await pg.evaluate('document.body.innerText')
        await pg.fill('.xc-login input', 'pw-ok-123456')
        await pg.click('.xc-login .xc-btn')
        await pg.wait_for_selector('.xc-hello.tq')
        ui.check(
            '没登录：登录框是天启的星且零「小芯」，登录提交 POST /api/tq/login 并进入天启工作台',
            '小芯' not in login_txt and 'POST /api/tq/login' in st['tq_calls'] and st['xin_reqs'] == [],
            st['tq_calls'],
        )
        await pg.context.close()

        # 4. 网关没配好
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=False)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc-gw-warn:not([hidden])')
        gw = await pg.evaluate("""(() => ({
          warn: document.querySelector('.xc-gw-warn')?.textContent,
          taDisabled: document.querySelector('.xc-row textarea')?.disabled,
          sendDisabled: document.querySelector('.xc-send')?.disabled,
          bodyText: document.body.innerText,
        }))()""")
        ui.check(
            '网关没配好：显示「天启的网关还没配好」，输入框和发送键禁用',
            '天启的网关还没配好' in (gw['warn'] or '') and gw['taDisabled'] and gw['sendDisabled'] and '小芯' not in gw['bodyText'],
            gw,
        )
        await pg.context.close()

        # 5. 唤醒中
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True, waking_send=True)
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc-hello.tq')
        await pg.fill('.xc-row textarea', '等它醒来回答')
        await pg.press('.xc-row textarea', 'Enter')
        await pg.wait_for_function("document.querySelector('.xc-typing-l')?.textContent.includes('已收到 · 唤醒中')", timeout=5000)
        saw_waking = await pg.text_content('.xc-typing-l')
        await pg.wait_for_function(ui.CHAT_DONE + " && [...document.querySelectorAll('.xc-ai .xc-bub')].some(e => e.textContent.includes('唤醒后回复完成'))", timeout=10000)
        ui.check(
            '唤醒中：状态行写「已收到 · 唤醒中」，待送达完成后回话显示',
            '已收到 · 唤醒中' in (saw_waking or '') and st['delivery_checks'] >= 2 and st['xin_reqs'] == [],
            (saw_waking, st['delivery_checks']),
        )
        await pg.context.close()

        # 6. 从首页正常打开时，小芯已经启动，天启使用自己的 iframe。
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, xin_enabled=True)
        await pg.goto(ui.BASE + '/')
        await pg.wait_for_selector('.card[data-id="tianqi"]')
        await pg.wait_for_function("window.LimingXinChat?.state.authed")
        for _ in range(60):
            if {'wake','greet'} <= set(xin_operations(st)): break
            await asyncio.sleep(.05)
        ui.check('普通首页照常唤醒小芯并打招呼', {'wake','greet'} <= set(xin_operations(st)), xin_operations(st))
        cat_name = await pg.evaluate("document.querySelector('.card[data-id=\"tianqi\"]')?.closest('.cat')?.querySelector('.cat-h')?.textContent")
        await pg.click('.card[data-id="tianqi"]')
        await pg.wait_for_selector('.panel[data-id="tianqi"].show iframe')
        iframe_src = await pg.get_attribute('.panel[data-id="tianqi"] iframe', 'src')
        fr = pg.frame(url=re.compile(r'/tools/tianqi/'))
        if not fr:
            for f in pg.frames:
                if '/tools/tianqi/' in f.url:
                    fr = f
                    break
        await fr.wait_for_selector('.xc.tq-mode.show .xc-hello.tq')
        embed_ui = await fr.evaluate("""(() => ({
          xHidden: getComputedStyle(document.querySelector('.xc-x')).display === 'none',
          embed: document.documentElement.classList.contains('embed'),
        }))()""")
        ui.check(
            '首页：「天启」分类有「天启」卡片，点击地址变 /tianqi，iframe 是 /tools/tianqi/?embed=1，嵌在首页时关闭键隐藏',
            cat_name == '天启' and pg.url.endswith('/tianqi') and iframe_src == '/tools/tianqi/?embed=1' and embed_ui['embed'] and embed_ui['xHidden'],
            (cat_name, pg.url, iframe_src, embed_ui),
        )
        await pg.context.close()

        # 6b. 站长 11-20：手机上从首页打开天启，打字时键盘把面板推上去，下面露出首页（STM32 卡片）。
        #     照 Vaul / React Aria 的 usePreventScroll：工具开着时首页钉在原处、页面没得滚（左滑返回时首页照样露出来）；
        #     面板跟着可见区域（visualViewport）走，键盘弹出时正好缩到键盘上面。Chromium 没有软键盘，用改 visualViewport 的值来模拟。
        pg = await ui.page(browser, 390, 560, mobile=True)
        st = await tianqi_mock(pg, xin_enabled=True)
        await pg.goto(ui.BASE + '/')
        await pg.wait_for_selector('.card[data-id="tianqi"]')
        await pg.evaluate("window.scrollTo(0, 80)")
        await pg.wait_for_function("scrollY > 30")
        # 首页的布局位置（offsetTop - scrollY，不受工具打开时首页缩小那一下的影响）
        before = await pg.evaluate("[scrollY, document.getElementById('home').offsetTop - scrollY]")
        await pg.click('.card[data-id="tianqi"]')
        await pg.wait_for_selector('.panel[data-id="tianqi"].show iframe')
        await pg.wait_for_timeout(700)
        locked = await pg.evaluate("""(() => { const h = document.getElementById('home');
          return { sy: scrollY, scrollable: document.scrollingElement.scrollHeight > innerHeight + 1,
            homeTop: h.offsetTop - scrollY, homeVisible: getComputedStyle(h).visibility === 'visible' && getComputedStyle(h).display !== 'none' }; })()""")
        await pg.evaluate("""(() => { const vv = window.visualViewport;
          Object.defineProperty(vv, 'height', { configurable: true, get: () => 300 });
          Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 40 });
          vv.dispatchEvent(new Event('resize')); })()""")
        kb = await pg.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })()")
        # 键盘和状态栏后面透出来的是整页的底：键盘弹出时它要是天启的颜色（#02040a），首页藏起来（站长 11-20 第二次截图：键盘后面还是白的首页）
        cover = """(() => ({ bg: getComputedStyle(document.documentElement).backgroundColor,
          home: getComputedStyle(document.getElementById('home')).visibility }))()"""
        kb_cover = await pg.evaluate(cover)
        await pg.evaluate("""(() => { const vv = window.visualViewport; delete vv.height; delete vv.offsetTop; vv.dispatchEvent(new Event('resize')); })()""")
        kb_off = await pg.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })()")
        # 收起后底色按首页原来的 0.3 秒过渡褪回去（面板这时已经铺满整屏，看不见）：等它复原
        await pg.wait_for_function("getComputedStyle(document.documentElement).backgroundColor !== 'rgb(2, 4, 10)'", timeout=3000)
        off_cover = await pg.evaluate(cover)
        await pg.click('.panel[data-id="tianqi"] .back')
        await pg.wait_for_function("!document.body.classList.contains('tool-open')")
        await pg.wait_for_timeout(600)
        after = await pg.evaluate("[scrollY, getComputedStyle(document.getElementById('home')).position]")
        ui.check('手机：从首页打开天启后首页钉在原处、页面不能滚（首页还看得见，左滑返回能露出来）；键盘弹出时面板缩到可见区域、收起后复原；关掉天启滚回原处',
                 before[0] > 30 and locked == {'sy': 0, 'scrollable': False, 'homeTop': before[1], 'homeVisible': True}
                 # 关掉后首页按「最近用过」重排卡片会变高，浏览器的滚动锚定可能再挪 1 像素
                 and kb == [40, 300] and kb_off == [0, 560] and abs(after[0] - before[0]) <= 2 and after[1] == 'relative',
                 (before, locked, kb, kb_off, after))
        ui.check('手机：键盘弹出时整页底色换成天启的颜色、首页藏起来（键盘和状态栏后面不再透出首页）；收起后首页回来，底色复原',
                 kb_cover == {'bg': 'rgb(2, 4, 10)', 'home': 'hidden'} and off_cover['home'] == 'visible' and off_cover['bg'] != 'rgb(2, 4, 10)',
                 (kb_cover, off_cover))
        await pg.context.close()

        # 6c. 站长 11-20 第三次截图（iOS 26）：点天启的输入框，键盘出来了，输入框却被键盘挡住；打一个字才跳到键盘上面。
        #     iOS 键盘弹出、收起时 visualViewport 不一定发事件（WebKit 198347、WICG visual-viewport #79、iOS 26 的 WebKit 297779），
        #     外壳只靠事件就跟不上。模拟：点进输入框以后把可见区域改小、不发任何事件，面板要自己跟上；失焦后改回、也不发事件，面板要自己铺回整屏。
        #     键盘弹起时天启底下给 iPhone 横条留的安全区（--sb）不再留白：键盘已经把那条盖住了（用 34px 模拟 iPhone 的值）。
        pg = await ui.page(browser, 390, 560, mobile=True)
        st = await tianqi_mock(pg, xin_enabled=True)
        await pg.goto(ui.BASE + '/')
        await pg.wait_for_selector('.card[data-id="tianqi"]')
        await pg.click('.card[data-id="tianqi"]')
        await pg.wait_for_selector('.panel[data-id="tianqi"].show iframe')
        frame = pg.frame_locator('.panel[data-id=tianqi] iframe')
        box_in = frame.locator('.xc-row textarea')
        await box_in.wait_for()
        await frame.locator('html').evaluate("h => { const s = h.ownerDocument.createElement('style'); s.textContent = ':root{--sb:34px}'; h.ownerDocument.head.appendChild(s); }")
        await pg.wait_for_timeout(500)
        rect = "(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })()"
        pad = "h => getComputedStyle(h.ownerDocument.querySelector('.tq-frame')).paddingBottom"
        pad_before = await frame.locator('html').evaluate(pad)
        await box_in.tap()
        await pg.evaluate("""(() => { const vv = window.visualViewport;
          Object.defineProperty(vv, 'height', { configurable: true, get: () => 300 });
          Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 }); })()""")
        up = down = False
        try:
            await pg.wait_for_function(rect + '[1] === 300', timeout=2500); up = True
        except Exception:
            pass
        up_rect, pad_up = await pg.evaluate(rect), await frame.locator('html').evaluate(pad)
        await box_in.evaluate('t => t.blur()')
        await pg.evaluate("(() => { const vv = window.visualViewport; delete vv.height; delete vv.offsetTop; })()")
        try:
            await pg.wait_for_function(rect + '[1] === 560', timeout=2500); down = True
        except Exception:
            pass
        pad_down = await frame.locator('html').evaluate(pad)
        ui.check('手机：点天启的输入框、键盘弹出时就算 iOS 不发 visualViewport 事件，面板也自己缩到键盘上面；收起后铺回整屏；键盘弹起时底下不再给横条留白',
                 up and up_rect == [0, 300] and down and pad_before == '34px' and pad_up == '0px' and pad_down == '34px',
                 (up, up_rect, down, pad_before, pad_up, pad_down))
        await pg.context.close()

        # 6d. 站长 11-20：手机上左栏要点两下才切换对话。iOS 手指一点先算悬停，悬停让「⋯」从看不见变看得见，
        #     WebKit 就把第一下只当悬停（content change observer）。触屏上「⋯」一直显示（照小芯 chat.css 的 hover:none），悬停不改它
        pg = await ui.page(browser, 390, 844, mobile=True)
        st = await tianqi_mock(pg, enabled=True, authed=True, ready=True)
        st['sessions'] = [{'sid': 'stqa00001', 'agent': 'harness', 'title': 'LED 快闪', 'turns': 2, 'updated': 1763600000000},
                          {'sid': 'stqb00001', 'agent': 'harness', 'title': '天启旧对话', 'turns': 1, 'updated': 1763500000000}]
        await pg.goto(ui.BASE + '/tools/tianqi/')
        await pg.wait_for_selector('.xc.wb.show.tq-mode .xc-hello.tq')
        await pg.locator('.tq-menu').tap()
        row = pg.locator('.tq-side .xc-sli', has_text='天启旧对话')
        await row.wait_for()
        await pg.wait_for_timeout(300)
        more = "e => getComputedStyle(e.querySelector('.xc-si-more')).opacity"
        touch = await pg.evaluate("matchMedia('(hover: none)').matches")
        o_before = await row.evaluate(more)
        await row.hover()
        await pg.wait_for_timeout(300)
        o_after = await row.evaluate(more)
        ui.check('手机：左栏每一行的「⋯」一直看得见，悬停不改它（不然 iOS 第一下点只算悬停，要点两下才切换对话）',
                 touch and o_before == o_after and float(o_before) > 0, (touch, o_before, o_after))
        # 6e. 站长 11-20：有时候对话里的字能左右滑。新回答出来时扫过的那道微光（.xc-ai.enter > .xc-bub::after）左右各宽出气泡 8px，
        #     手机上气泡占满整列、天启的对话区左右只留 4px，微光就把对话区撑宽了 4px；它在动画放完后还在（只是透明），所以每条新回答都留下这 4px
        await pg.locator('.tq-side .xc-si', has_text='LED 快闪').tap()
        await pg.get_by_text('老回答', exact=True).wait_for()
        await pg.locator('.xc-row textarea').fill('你好')
        await pg.locator('.xc-send').tap()
        await pg.wait_for_function(ui.CHAT_DONE)
        await pg.wait_for_timeout(1500)   # 等回答的动画放完
        sx = await pg.evaluate("""(() => { const b = document.querySelector('.xc-body');
          return { sw: b.scrollWidth, cw: b.clientWidth, ox: getComputedStyle(b).overflowX, enter: document.querySelectorAll('.xc-ai.enter').length }; })()""")
        ui.check('手机：新回答出来以后对话区不比屏幕宽、也不能左右滑（回答出现时的微光不再宽出气泡）',
                 sx['enter'] > 0 and sx['sw'] <= sx['cw'] and sx['ox'] == 'hidden', sx)
        await pg.context.close()

        # 手机双区上下排列，返回键与天启品牌、操作键分开。
        pg = await ui.page(browser, 390, 844, mobile=True)
        st = await tianqi_mock(pg)
        await pg.goto(ui.BASE + '/tianqi')
        frame = pg.frame_locator('.panel[data-id=tianqi] iframe')
        await frame.locator('.tq-empty').wait_for()
        back = await pg.locator('.panel[data-id=tianqi] .back').bounding_box()
        menu = await frame.locator('.tq-menu').bounding_box()
        box = await frame.locator('.tq-box').bounding_box()
        ui.check('手机天启工作台：左栏收进抽屉，返回键不挡菜单键，输入框在屏幕里，面板键能点', back['x'] + back['width'] <= menu['x']
                 and box['y'] + box['height'] <= 844 and await frame.locator('.tq-panel-b').is_visible(),
                 (back, menu, box))
        # 照 Linear 的手机版：顶栏是菜单、标题（下面小字写工作区）、搜索和命令、右栏，能点的都不小于 44px；点「搜索和命令」打开命令面板
        hdr = await frame.locator('.tq-mid-head').evaluate("""h => [...h.querySelectorAll('button')].filter(b => getComputedStyle(b).display !== 'none' && b.offsetWidth)
          .map(b => [b.getAttribute('aria-label'), Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)])""")
        try:   # 没有这个键时记一项失败，不让整组测试停在这里
            await frame.get_by_role('button', name='搜索和命令').tap(timeout=3000)
            await frame.locator('.xc-pal.in .xc-pal-i').first.wait_for(timeout=3000)
            pal_ok = True
        except Exception:
            pal_ok = False
        ui.check('手机天启顶栏：菜单、搜索和命令、右栏三个键都在，都不小于 44px；点「搜索和命令」打开命令面板',
                 [x[0] for x in hdr] == ['对话记录', '搜索和命令', '打开面板'] and all(w >= 44 and hh >= 44 for _, w, hh in hdr) and pal_ok, (hdr, pal_ok))
        await pg.context.close()

        # 7. 深链：只启动天启；返回首页后再启动小芯。
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, xin_enabled=True)
        await pg.goto(ui.BASE + '/tianqi')
        await pg.wait_for_function("window.LimingXinChat?.state.authed && document.body.classList.contains('tool-open')")
        await pg.frame_locator('.panel[data-id="tianqi"] iframe').locator('.xc-hello.tq').wait_for()
        for _ in range(60):
            if 'wake' in st['tq_ops']: break
            await asyncio.sleep(.05)
        await pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        await pg.wait_for_timeout(250)
        during = xin_operations(st)
        ui.check('直接打开天启并切回可见时，只叫醒 li2', 'wake' in st['tq_ops'] and not during, (st['tq_ops'], during))
        await pg.locator('.panel[data-id="tianqi"] .back').click()
        await pg.wait_for_url(ui.BASE + '/')
        for _ in range(60):
            if {'wake','greet'} <= set(xin_operations(st)[len(during):]): break
            await asyncio.sleep(.05)
        after = xin_operations(st)[len(during):]
        ui.check('从天启返回首页后唤醒小芯并打招呼，各一次', after.count('wake') == 1 and after.count('greet') == 1, after)
        await pg.context.close()

        # 8. 在内嵌天启登录后，首页无需重新输一次密码。
        pg = await ui.page(browser, 1280, 860)
        st = await tianqi_mock(pg, xin_enabled=True, authed=False)
        await pg.goto(ui.BASE + '/tianqi')
        frame = pg.frame_locator('.panel[data-id=tianqi] iframe')
        await frame.locator('.xc-login input[name=pw]').fill('pw-ok-123456')
        await frame.locator('.xc-login button').click()
        await frame.locator('.xc-hello.tq').wait_for()
        await pg.locator('.panel[data-id=tianqi] .back').click()
        for _ in range(60):
            if 'greet' in xin_operations(st): break
            await asyncio.sleep(.05)
        ops = xin_operations(st)
        shared = await pg.evaluate('LimingXinChat.state.authed')
        ui.check('在天启登录一次，返回首页即可使用小芯', shared and ops.count('wake') == 1 and ops.count('greet') == 1, (shared, ops))
        await pg.context.close()

        await browser.close()

    if ui.errors or ui.local_fail:
        ui.check('运行过程中无脚本或本地请求报错', False, (ui.errors, ui.local_fail))
    else:
        ui.check('运行过程中无脚本或本地请求报错', True)
    bad = [r for r in ui.results if not r[1]]
    print('\n共 %d 项，失败 %d 项' % (len(ui.results), len(bad)))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    asyncio.run(main())
