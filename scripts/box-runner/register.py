#!/usr/bin/env python3
"""Fail-closed registration/recovery for this repository's one box runner.
No token is printed or written to a recovery asset. Tests inject a fake API.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys

REPO = "yux91803-hobo/liming-work-site"
REPO_ID = 1434453690
NAME = "box-liming-work-site"
USER = "actions-box"
HOME = "/var/lib/liming-actions"
RUNNER = HOME + "/runner"

class RecoveryError(RuntimeError):
    pass

class GhApi:
    def request(self, method, endpoint):
        env = os.environ.copy()
        env.pop("GH_DEBUG", None)
        proc = subprocess.run(["gh", "api", "--hostname", "github.com", "--method", method, endpoint],
                              capture_output=True, text=True, env=env)
        if proc.returncode:
            status = re.search(r"HTTP (\d{3})", proc.stderr)
            detail = "HTTP " + status.group(1) if status else "exit " + str(proc.returncode)
            # Never echo response/debug bodies, particularly registration tokens.
            raise RecoveryError(f"GitHub {method} {endpoint} failed ({detail}); no fallback attempted")
        if not proc.stdout.strip():
            return None
        try:
            return json.loads(proc.stdout)
        except ValueError:
            raise RecoveryError("GitHub returned invalid JSON; response body withheld") from None

    def repo(self):
        return self.request("GET", "repos/" + REPO)

    def fork_policy(self):
        return self.request("GET", "repos/" + REPO + "/actions/permissions/fork-pr-workflows-private-repos")

    def runners(self):
        result = []
        for page in range(1, 101):
            data = self.request("GET", f"repos/{REPO}/actions/runners?per_page=100&page={page}")
            batch = data["runners"]
            result.extend(batch)
            if len(result) >= data["total_count"] or not batch:
                return result
        raise RecoveryError("Runner inventory unexpectedly large; inspect manually")

    def runner(self, runner_id):
        return self.request("GET", f"repos/{REPO}/actions/runners/{runner_id}")

    def delete(self, runner_id):
        self.request("DELETE", f"repos/{REPO}/actions/runners/{runner_id}")

    def token(self):
        data = self.request("POST", f"repos/{REPO}/actions/runners/registration-token")
        token = data.get("token")
        if not isinstance(token, str) or not token:
            raise RecoveryError("No temporary registration token returned")
        return token


def validate_repo(api):
    repo = api.repo()
    if repo.get("id") != REPO_ID or repo.get("full_name") != REPO or repo.get("private") is not True:
        raise RecoveryError("Repository ID/name/privacy mismatch; refusing recovery")
    if repo.get("permissions", {}).get("admin") is not True:
        raise RecoveryError("Repository administration permission is required")
    if api.fork_policy().get("run_workflows_from_fork_pull_requests") is not False:
        raise RecoveryError("Private-fork workflow execution is not disabled; refusing unattended start")


def validate_runner(runner, expected_id, require_offline=False):
    labels = {label.get("name") for label in runner.get("labels", [])}
    if runner.get("id") != expected_id or runner.get("name") != NAME or "box" not in labels or "self-hosted" not in labels:
        raise RecoveryError("Runner ID/name/box/self-hosted identity mismatch; refusing replacement")
    if require_offline and (runner.get("status") != "offline" or runner.get("busy") is not False):
        raise RecoveryError("Runner is online, busy, or has unknown state; NEVER replace it")


def recover(api, local, replace_id=None, apply=False, configure=None):
    validate_repo(api)
    runners = api.runners()
    same_name = [r for r in runners if r.get("name") == NAME]
    if len(same_name) > 1:
        raise RecoveryError("Duplicate runner names already exist; inspect manually")
    target = None
    if replace_id is not None:
        target = next((r for r in runners if r.get("id") == replace_id), None)
        if target is None:
            raise RecoveryError("Explicit old runner ID not found in this repository; refusing")
        validate_runner(target, replace_id, require_offline=True)
        if local is not None:
            raise RecoveryError("Local runner registration still exists; preserve it, do not replace")
        if not same_name or same_name[0]["id"] != replace_id:
            raise RecoveryError("The explicitly selected ID is not the unique same-name runner")
    elif local is not None:
        if local.get("agentName") != NAME or local.get("gitHubUrl", "").rstrip("/") != "https://github.com/" + REPO:
            raise RecoveryError("Existing local runner belongs to another name/repository")
        found = next((r for r in same_name if r.get("id") == local.get("agentId")), None)
        if found is None:
            raise RecoveryError("Local and remote registrations disagree; inspect manually")
        validate_runner(found, local["agentId"])
        if found.get("busy") is not False:
            raise RecoveryError("Existing runner is busy or its state is unknown; refuse installation/recovery")
        return {"action": "keep-existing", "runner_id": found["id"], "name": NAME}
    elif same_name:
        raise RecoveryError(f"Existing remote runner ID {same_name[0]['id']}; explicitly choose --replace-offline-runner-id {same_name[0]['id']} only after wiping local auth and confirming it is offline")
    plan = {"action": "replace-offline" if target else "register-new", "repository": REPO,
            "old_runner_id": replace_id, "name": NAME, "apply": apply}
    if not apply:
        return plan
    if configure is None:
        raise RecoveryError("Missing registration implementation")
    if target:
        # Fresh read immediately before the irreversible DELETE. Fail closed on any change.
        validate_repo(api)
        fresh = api.runner(replace_id)
        validate_runner(fresh, replace_id, require_offline=True)
        api.delete(replace_id)
    token = api.token()
    configure(token)
    return plan


def read_local_registration():
    try:
        pwd.getpwnam(USER)
    except KeyError:
        return None
    code = """import json,os,sys
root='/var/lib/liming-actions/runner'
try:
 try: names=set(os.listdir(root))
 except FileNotFoundError: names=set()
 if '.runner' not in names:
  if {'.credentials','.credentials_rsaparams'} & names: raise RuntimeError('Partial local authentication exists')
  result={'state':'absent'}
 else:
  if not {'.credentials','.credentials_rsaparams'} <= names: raise RuntimeError('Incomplete local authentication exists')
  result={'state':'present','metadata':json.load(open(root+'/.runner',encoding='utf-8-sig'))}
 print(json.dumps(result))
except Exception:
 sys.exit(2)
"""
    proc = subprocess.run(["sudo", "-n", "-u", USER, "env", "-i", "PATH=/usr/bin:/bin", "python3", "-c", code], capture_output=True, text=True)
    if proc.returncode:
        raise RecoveryError("Cannot safely inspect local metadata/credential presence; inspect manually (credential contents are never read)")
    state = json.loads(proc.stdout)
    return state["metadata"] if state["state"] == "present" else None


def configure(token):
    code = """import json,sys,os,subprocess
j=json.load(sys.stdin);os.umask(0o077)
e={'HOME':'/var/lib/liming-actions','USER':'actions-box','PATH':'/usr/bin:/bin','ACTIONS_RUNNER_INPUT_TOKEN':j['token']}
p=subprocess.run(['./config.sh','--unattended','--url','https://github.com/yux91803-hobo/liming-work-site','--name','box-liming-work-site','--labels','box','--work','_work'],cwd='/var/lib/liming-actions/runner',env=e,capture_output=True,text=True)
sys.exit(p.returncode)
"""
    proc = subprocess.run(["sudo", "-n", "-u", USER, "env", "-i", "PATH=/usr/bin:/bin", "python3", "-c", code],
                          input=json.dumps({"token": token}), text=True, capture_output=True)
    if proc.returncode:
        raise RecoveryError("Official non-root runner configuration failed; token/output withheld. Inspect private runner diagnostics; do not repeat deletion blindly")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    parser.add_argument("--replace-offline-runner-id", type=int)
    args = parser.parse_args()
    if args.replace_offline_runner_id is not None and args.replace_offline_runner_id <= 0:
        parser.error("old runner ID must be a positive integer")
    try:
        result = recover(GhApi(), read_local_registration(), args.replace_offline_runner_id,
                         apply=args.apply, configure=configure)
        print(json.dumps(result, ensure_ascii=False))
    except (RecoveryError, OSError, ValueError, KeyError) as exc:
        print("Recovery refused: " + str(exc), file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
