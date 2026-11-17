#!/usr/bin/python3
"""Read-only CI observations; wrappers preserve the real tool argv and exec it."""
import json, os, pathlib, re, stat, subprocess, sys, time

UNIT = re.compile(r'^xin-[A-Za-z0-9_.@:-]{1,180}\.(?:scope|service|timer)$')
TOOLS = {'systemctl': '/usr/bin/systemctl', 'systemd-run': '/usr/bin/systemd-run'}

def write(root, name, value):
    try:
        root.mkdir(parents=True, exist_ok=True)
        with (root / name).open('a') as out:
            out.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
    except OSError:
        pass  # Observations must not change the command's outcome.

def command(args):
    try:
        r = subprocess.run(args, text=True, capture_output=True, timeout=4)
        return r.returncode, r.stdout
    except (OSError, subprocess.TimeoutExpired):
        return None, ''

def file_summary(home):
    directory = home / '.config/systemd/user'
    result = {name: (directory / name).is_file() for name in ['xin-reaper.service', 'xin-reaper.timer']}
    try:
        text = (directory / 'xin-reaper.service').read_text()[:16000]
        start = re.search(r'^ExecStart=(\S+)', text, re.M)
        result['startUnderTmpFixture'] = bool(start and start[1].startswith('/tmp/xin-'))
        result['explicitXinHome'] = bool(re.search(r'^Environment=.*XIN_HOME', text, re.M))
    except OSError:
        pass
    return result

def reaper_log(root, base, phase, origin):
    # This known file contains only reaper decisions. Never copy config, environment or model argv.
    file = base / 'logs/reaper.jsonl'
    try:
        lines = file.read_text()[-65536:].splitlines()
    except OSError:
        return
    for line in lines[-80:]:
        try:
            value = json.loads(line)
        except ValueError:
            continue
        unit = value.get('unit', '')
        if unit and not UNIT.fullmatch(str(unit)):
            continue
        write(root, 'reaper-decisions.jsonl', {'phase': phase, 'origin': origin, 'at': value.get('at'),
            'act': str(value.get('act', ''))[:30], 'ok': value.get('ok'), 'unit': unit,
            'pids': [p for p in value.get('pids', []) if isinstance(p, int)][:64],
            'runEndedReason': '这一轮已经结束' in str(value.get('reason', ''))})

def snapshot(root, phase):
    uid = os.getuid(); home = pathlib.Path.home(); bus = pathlib.Path('/run/user') / str(uid) / 'bus'
    try:
        mode = bus.stat().st_mode
        exists, socket = True, stat.S_ISSOCK(mode)
    except OSError:
        exists, socket = False, False
    rc, version = command(['/usr/bin/systemd', '--version'])
    _, node_version = command(['node', '--version'])
    lr, linger = command(['/usr/bin/loginctl', 'show-user', str(uid), '--property=Linger', '--value'])
    value = {'phase': phase, 'at': time.time(), 'monotonic': time.monotonic(), 'uid': uid,
        'defaultBusExists': exists, 'defaultBusSocket': socket,
        'customBusConfigured': bool(os.environ.get('XIN_SYSTEMD_BUS')),
        'systemd': version.splitlines()[0][:150] if version else None,
        'node': node_version.strip()[:80],
        'linger': linger.strip() if lr == 0 and linger.strip() in ('yes', 'no') else None,
        'globalUnitFiles': file_summary(home)}
    write(root, 'environment.jsonl', value); print(json.dumps(value, ensure_ascii=False))
    if socket:
        for unit in ['xin-reaper.service', 'xin-reaper.timer']:
            rc, raw = command(['/usr/bin/systemctl', '--user', 'show', unit, '-p', 'LoadState', '-p', 'ActiveState',
                '-p', 'SubState', '-p', 'MainPID', '-p', 'Result', '-p', 'FragmentPath', '-p', 'ExecStart',
                '-p', 'LastTriggerUSec', '-p', 'NextElapseUSecMonotonic'])
            properties = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
            start = re.search(r'\bpath=([^ ;]+)', properties.pop('ExecStart', ''))
            fragment = properties.pop('FragmentPath', '')
            properties['fragmentUnderHome'] = bool(fragment and fragment.startswith(str(home) + '/'))
            properties['startUnderTmpFixture'] = bool(start and start[1].startswith('/tmp/xin-'))
            if start and start[1].startswith('/tmp/xin-') and pathlib.Path(start[1]).name == 'xin-reap':
                base = pathlib.Path(start[1]).parent.parent
                reaper_log(root, base, phase, 'service-fixture')
            write(root, 'known-units.jsonl', {'phase': phase, 'at': time.time(), 'unit': unit, 'returnCode': rc, 'properties': properties})
    reaper_log(root, home / '.xin', phase, 'default-home')

def install(root):
    folder = root / 'bin'; folder.mkdir(parents=True, exist_ok=True)
    helper = str(pathlib.Path(__file__).resolve())
    installed = []
    for name, real in TOOLS.items():
        if not pathlib.Path(real).is_file():
            continue  # Do not make an absent system tool appear available.
        wrapper = folder / name
        wrapper.write_text('#!/usr/bin/python3\nimport runpy,sys\nsys.argv=[' + repr(helper) + ", 'wrap', " + repr(str(root)) + ', ' + repr(name) + "]+sys.argv[1:]\nrunpy.run_path(" + repr(helper) + ",run_name='__main__')\n")
        wrapper.chmod(0o755); installed.append(name)
    with open(os.environ['GITHUB_PATH'], 'a') as out:
        out.write(str(folder) + '\n')
    print(json.dumps({'passiveWrappersInstalled': installed}))

def wrap(root, tool, args):
    safe_args = args[:args.index('--')] if '--' in args else args
    units = []
    for i, arg in enumerate(safe_args):
        token = arg.split('=', 1)[1] if arg.startswith('--unit=') else safe_args[i+1] if arg == '--unit' and i+1 < len(safe_args) else arg
        if tool == 'systemd-run' and '--scope' in safe_args and token.startswith('xin-') and not token.endswith('.scope'):
            token += '.scope'
        if UNIT.fullmatch(token): units.append(token)
    allowed = {'daemon-reload','enable','start','stop','kill','restart','status','show','list-units','list-unit-files','is-active','is-enabled','reset-failed'}
    verb = 'scope' if tool == 'systemd-run' and '--scope' in safe_args else next((a for a in safe_args if a in allowed), 'other')
    write(root, 'systemd-tools.jsonl', {'at': time.time(), 'monotonic': time.monotonic(), 'tool': tool,
        'verb': verb, 'units': units[:8], 'pid': os.getpid(), 'ppid': os.getppid()})
    os.execv(TOOLS[tool], [TOOLS[tool], *args])  # No argv mutation or additional systemctl operation.

if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'wrap':
        wrap(pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4:])
    else:
        root = pathlib.Path(os.environ['GITHUB_WORKSPACE']) / '.ci-note-probe'
        if action == 'install': install(root)
        elif action == 'snapshot': snapshot(root, sys.argv[2])
        else: raise SystemExit('unknown observation command')
