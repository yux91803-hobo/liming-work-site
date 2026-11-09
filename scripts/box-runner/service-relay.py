#!/usr/bin/python3
"""Root-owned, runner-only signal relay; never reads auth or network payloads."""
import os
from pathlib import Path
import signal
import subprocess
import threading
import time

SANDBOX = "/opt/liming-runner-tools/bin/sandbox.sh"
RUNNER = "/var/lib/liming-actions/runner"

def descendants(root):
    result, todo = [], [root]
    while todo and len(result) < 256:
        pid = todo.pop()
        if pid in result:
            continue
        result.append(pid)
        try:
            children = Path(f"/proc/{pid}/task/{pid}/children").read_text()
            todo.extend(int(x) for x in children.split())
        except (OSError, ValueError):
            pass
    return result

def official_manager(pid):
    # Only the official service manager beneath OUR sandbox, never a worker.
    import pwd
    try:
        proc = Path(f"/proc/{pid}")
        args = [x for x in (proc / "cmdline").read_bytes().split(b"\0") if x]
        return (proc.stat().st_uid == pwd.getpwnam("actions-box").pw_uid
                and len(args) == 2
                and Path(os.fsdecode(args[0])).name == "node"
                and args[1] == b"./bin/RunnerService.js"
                and str((proc / "cwd").readlink()) == RUNNER)
    except (OSError, KeyError):
        return False

def forward_stop(root, matcher):
    matches = [pid for pid in descendants(root) if matcher(pid)]
    if len(matches) != 1:
        return False
    pid = matches[0]
    try:
        fd = os.pidfd_open(pid)
        try:
            # Recheck after acquiring a PID-stable handle.
            if not matcher(pid) or pid not in descendants(root):
                return False
            signal.pidfd_send_signal(fd, signal.SIGINT)
            print("liming-relay: graceful INT forwarded to official service manager", flush=True)
            return True
        finally:
            os.close(fd)
    except ProcessLookupError:
        return False

def run(command=None, matcher=official_manager, grace_seconds=75):
    stop = threading.Event()
    old = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        old[sig] = signal.signal(sig, lambda *_: stop.set())
    child = subprocess.Popen(command or [SANDBOX], start_new_session=True)
    try:
        while child.poll() is None and not stop.is_set():
            try:
                child.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
        if child.poll() is not None:
            return child.returncode if child.returncode >= 0 else 128 - child.returncode
        deadline = time.monotonic() + grace_seconds
        delivered = False
        while child.poll() is None and time.monotonic() < deadline:
            if not delivered:
                delivered = forward_stop(child.pid, matcher)
            try:
                child.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
        if child.poll() is None:
            # This process group was created by this relay; never target any other service.
            print("liming-relay: graceful shutdown deadline reached; stopping own sandbox", flush=True)
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        return 0
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        for sig, handler in old.items():
            signal.signal(sig, handler)

if __name__ == "__main__":
    import sys
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise SystemExit("Only root may run this fixed runner-only relay; no command arguments accepted.")
    raise SystemExit(run())
