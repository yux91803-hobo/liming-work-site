#!/usr/bin/python3
"""Disposable sandbox signal tests. Root required; never stops production runner."""
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
import unittest

RELAY = str(Path(__file__).with_name("service-relay.py"))

class RelayTests(unittest.TestCase):
    def probe(self, ignore=False):
        probe = ("import signal,time,sys; "
                 + ("signal.signal(signal.SIGINT,signal.SIG_IGN); " if ignore else
                    "signal.signal(signal.SIGINT,lambda s,f:(print('INT_HANDLED',flush=True),sys.exit(0))); ")
                 + "print('RELAY_PROBE_READY',flush=True); time.sleep(30)")
        driver = ("import importlib.util,os,pathlib; "
                  "s=importlib.util.spec_from_file_location('relay'," + repr(RELAY) + "); "
                  "m=importlib.util.module_from_spec(s);s.loader.exec_module(m); "
                  "match=lambda pid: pathlib.Path(f'/proc/{pid}/comm').read_text().strip()=='python3' "
                  "and b'RELAY_PROBE_READY' in pathlib.Path(f'/proc/{pid}/cmdline').read_bytes(); "
                  "raise SystemExit(m.run(command=[m.SANDBOX,'/usr/bin/python3','-c'," + repr(probe) + "],matcher=match,grace_seconds=1))")
        proc = subprocess.Popen([sys.executable, '-c', driver], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            sel = selectors.DefaultSelector();sel.register(proc.stdout, selectors.EVENT_READ)
            self.assertTrue(sel.select(timeout=4), 'probe startup timeout')
            self.assertEqual(proc.stdout.readline().strip(), 'RELAY_PROBE_READY')
            start = time.monotonic();os.killpg(proc.pid, signal.SIGTERM)
            out, err = proc.communicate(timeout=6)
            self.assertEqual(proc.returncode, 0, err)
            self.assertLess(time.monotonic()-start, 5)
            if ignore:
                self.assertIn('deadline reached', out)
                self.assertNotIn('INT_HANDLED', out)
            else:
                self.assertIn('INT_HANDLED', out)
                self.assertIn('graceful INT forwarded', out)
                self.assertNotIn('deadline reached', out)
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL);proc.communicate(timeout=4)

    def test_term_reaches_child_without_killing_sandbox_parent(self):
        self.probe()

    def test_unresponsive_child_has_bounded_shutdown(self):
        self.probe(ignore=True)

    def test_cli_refuses_arbitrary_command(self):
        p=subprocess.run([sys.executable,RELAY,'--arbitrary-command'],capture_output=True,text=True)
        self.assertNotEqual(p.returncode,0)

if __name__ == '__main__':
    if os.geteuid()!=0:raise SystemExit('Run with sudo: disposable sandbox tests only')
    unittest.main()
