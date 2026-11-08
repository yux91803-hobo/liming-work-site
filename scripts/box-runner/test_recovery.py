#!/usr/bin/env python3
"""Offline safety tests: no GitHub, sudo, tokens, services, or application calls."""
import copy
import sys
sys.dont_write_bytecode = True
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("box_runner_registration", Path(__file__).with_name("register.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

GOOD = {"id": 21, "name": r.NAME, "status": "offline", "busy": False,
        "labels": [{"name": "self-hosted"}, {"name": "box"}, {"name": "Linux"}]}
LOCAL = {"agentId": 21, "agentName": r.NAME, "gitHubUrl": "https://github.com/" + r.REPO}

class FakeApi:
    def __init__(self):
        self.metadata = {"id": r.REPO_ID, "full_name": r.REPO, "private": True, "permissions": {"admin": True}}
        self.inventory = [copy.deepcopy(GOOD)]
        self.fresh = copy.deepcopy(GOOD)
        self.policy = {"run_workflows_from_fork_pull_requests": False}
        self.events = []
    def repo(self): return self.metadata
    def fork_policy(self): return self.policy
    def runners(self): return self.inventory
    def runner(self, runner_id):
        self.events.append(("recheck", runner_id));return self.fresh
    def delete(self, runner_id): self.events.append(("delete", runner_id))
    def token(self): self.events.append(("temporary-token",));return "unit-test-placeholder-not-a-credential"

class RecoveryTests(unittest.TestCase):
    def setUp(self): self.api = FakeApi();self.configured = []
    def recover(self, **kw):
        return r.recover(self.api, kw.pop("local", None), configure=self.configured.append, **kw)
    def assert_refuses(self, **kw):
        with self.assertRaises(r.RecoveryError): self.recover(**kw)
        self.assertFalse(any(e[0] in ("delete", "temporary-token") for e in self.api.events))
        self.assertEqual(self.configured, [])
    def test_explicit_offline_exact_id_recovery(self):
        result = self.recover(replace_id=21, apply=True)
        self.assertEqual(result["action"], "replace-offline")
        self.assertEqual(self.api.events, [("recheck",21),("delete",21),("temporary-token",)])
        self.assertEqual(len(self.configured), 1)
        self.assertNotIn(self.configured[0], str(result))
    def test_dry_run_never_deletes_or_gets_token(self):
        self.assertEqual(self.recover(replace_id=21)["action"], "replace-offline")
        self.assertEqual(self.api.events, [])
    def test_no_flag_existing_remote_refuses(self): self.assert_refuses(apply=True)
    def test_online_refuses(self):
        self.api.inventory[0]["status"] = "online";self.assert_refuses(replace_id=21, apply=True)
    def test_busy_refuses(self):
        self.api.inventory[0]["busy"] = True;self.assert_refuses(replace_id=21, apply=True)
    def test_unknown_state_refuses(self):
        del self.api.inventory[0]["busy"];self.assert_refuses(replace_id=21, apply=True)
    def test_wrong_id_refuses(self): self.assert_refuses(replace_id=22, apply=True)
    def test_wrong_name_refuses(self):
        self.api.inventory[0]["name"] = "other";self.assert_refuses(replace_id=21, apply=True)
    def test_missing_box_label_refuses(self):
        self.api.inventory[0]["labels"] = [{"name":"self-hosted"}];self.assert_refuses(replace_id=21, apply=True)
    def test_wrong_repo_identity_refuses(self):
        for field,value in [("id", 42),("full_name","other/repo"),("private",False)]:
            with self.subTest(field=field):
                self.api=FakeApi();self.api.metadata[field]=value;self.assert_refuses(replace_id=21,apply=True)
    def test_missing_admin_refuses(self):
        self.api.metadata["permissions"]={};self.assert_refuses(replace_id=21,apply=True)
    def test_fork_execution_enabled_refuses(self):
        self.api.policy["run_workflows_from_fork_pull_requests"]=True;self.assert_refuses(replace_id=21,apply=True)
    def test_existing_local_auth_refuses_replacement(self): self.assert_refuses(local=LOCAL,replace_id=21,apply=True)
    def test_existing_matching_local_auth_is_idempotent(self):
        self.assertEqual(self.recover(local=LOCAL,apply=True)["action"],"keep-existing")
        self.assertEqual(self.api.events,[])
    def test_busy_local_auth_refuses(self):
        self.api.inventory[0]["busy"]=True;self.assert_refuses(local=LOCAL,apply=True)
    def test_wrong_local_identity_refuses(self):
        local={**LOCAL,"agentName":"other"};self.assert_refuses(local=local,apply=True)
    def test_missing_remote_for_local_refuses(self):
        self.api.inventory=[];self.assert_refuses(local=LOCAL,apply=True)
    def test_duplicate_same_names_refuse(self):
        self.api.inventory.append({**copy.deepcopy(GOOD),"id":22});self.assert_refuses(replace_id=21,apply=True)
    def test_race_to_online_before_delete_refuses(self):
        self.api.fresh["status"]="online";self.assert_refuses(replace_id=21,apply=True)
        self.assertEqual(self.api.events,[("recheck",21)])
    def test_race_to_busy_before_delete_refuses(self):
        self.api.fresh["busy"]=True;self.assert_refuses(replace_id=21,apply=True)
    def test_fresh_identity_changed_refuses(self):
        self.api.fresh["name"]="other";self.assert_refuses(replace_id=21,apply=True)
    def test_new_registration_no_delete(self):
        self.api.inventory=[];self.assertEqual(self.recover(apply=True)["action"],"register-new")
        self.assertEqual(self.api.events,[("temporary-token",)])
    def test_missing_configurer_refuses_before_mutation(self):
        with self.assertRaises(r.RecoveryError):r.recover(self.api,None,21,True,None)
        self.assertEqual(self.api.events,[])

if __name__ == "__main__": unittest.main(verbosity=2)
