import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from xin_live_policy import HYDROGEN, DEEPSEEK, validate_front_model, front_reply_limit, is_leftover_smoke, reply_shape, spoken_marker, says, SPOKEN, first_person_receipt, explain_background_fallback, resident_owner, same_resident_owner, steer_request, list_verdict, after_steer, steer_count, canned_reply


class SpokenMarker(unittest.TestCase):
    def test_words_not_hex_and_two_markers_never_share_a_word(self):
        import random
        for seed in range(200):
            rng = random.Random(seed)
            a = spoken_marker(rng=rng); b = spoken_marker(a, rng=rng)
            self.assertEqual(len(a.split()), 3); self.assertTrue(all(w in SPOKEN for w in a.split()))
            self.assertFalse(set(a.split()) & set(b.split()))
            self.assertNotRegex(a, '[0-9a-f]{4}')

    def test_says_allows_punctuation_but_needs_every_word(self):
        self.assertTrue(says('青柠、风筝、海盐', '青柠 风筝 海盐'))
        self.assertTrue(says('青柠 风筝 海盐', '青柠 风筝 海盐'))
        self.assertFalse(says('青柠、风筝', '青柠 风筝 海盐'))
        self.assertFalse(says('', '青柠 风筝 海盐'))
        self.assertFalse(says('anything', ''))


class Steer(unittest.TestCase):
    ITEMS = [('alpha-main', True), ('beta-backup', False)]

    def test_fixture_is_a_cleanable_smoke_with_one_named_model_only_when_asked(self):
        r = steer_request('xin-steer-x', '/data/workspace/.xin-live-smoke/x', self.ITEMS)
        self.assertTrue(is_leftover_smoke({'title': r[:40]}))
        self.assertIn('alpha-main（启用）、beta-backup（备用）', r); self.assertNotIn('--model', r)
        k = steer_request('xin-steer-k', '/d', self.ITEMS, '用 Kimi 做')
        self.assertIn('这个后台任务用 Kimi 做。', k); self.assertIn('--model kimi-k3.1-pro', k)
        # 每一步先睡多久可调，默认 20 秒；都要小于控制器杀命令的 60 秒
        self.assertIn('sleep 20; echo', r); self.assertIn('sleep 40; echo', steer_request('xin-steer-b', '/d', self.ITEMS, '', 40))

    def test_final_list_keeps_enabled_and_drops_backups(self):
        self.assertEqual(list_verdict('alpha-main,gamma-main', ['alpha-main', 'gamma-main'], ['beta-backup']), {'keeps': True, 'drops': True})
        self.assertEqual(list_verdict('alpha-main,beta-backup', ['alpha-main'], ['beta-backup']), {'keeps': True, 'drops': False})
        self.assertEqual(list_verdict('', ['alpha-main'], []), {'keeps': False, 'drops': True})

    def test_after_steer_finds_later_commands_on_dropped_names(self):
        ev = [{'t': 'tool', 'detail': 'echo alpha-main'}, {'t': 'user', 'steer': True, 'text': 'x', 'clientId': 'ft-0123456789abcdef01234567'}, {'t': 'tool', 'detail': 'echo gamma-main'}]
        self.assertEqual(after_steer(ev, ['beta-backup']), {'steered': True, 'laterDrop': False, 'steers': 1})
        self.assertTrue(after_steer(ev + [{'t': 'tool_end', 'detail': 'echo beta-backup >> checked.txt'}], ['beta-backup'])['laterDrop'])
        self.assertEqual(after_steer(ev[:1], ['beta-backup'])['steered'], False)

    def test_only_the_chat_supplement_counts_as_steered_by_chat(self):
        # 网页任务详情那样直接补的（别的编号）在前面也不算聊天里那句；之后处理备用的命令照样算在聊天那句之后
        direct = {'t': 'user', 'steer': True, 'text': 'x', 'clientId': 'steer-resend-0123456789abcdef'}
        chat = {'t': 'user', 'steer': True, 'text': 'x', 'clientId': 'ft-0123456789abcdef01234567'}
        backup = {'t': 'tool', 'detail': 'sleep 30; echo beta-backup >> checked.txt'}
        self.assertEqual(after_steer([direct, backup], ['beta-backup']), {'steered': False, 'laterDrop': False, 'steers': 1})
        self.assertEqual(after_steer([direct, backup, chat], ['beta-backup']), {'steered': True, 'laterDrop': False, 'steers': 2})
        self.assertTrue(after_steer([chat, direct, backup], ['beta-backup'])['laterDrop'])
        # 按新要求把之前查到的备用的筛掉（命令里带着名字）不算再核对；只看命令，不看输出
        for cleanup in ("sed -i '/beta-backup/d' checked.txt", 'grep -v -e beta-backup -e delta-backup checked.txt > list.txt'):
            self.assertFalse(after_steer([chat, {'t': 'tool_end', 'detail': cleanup}], ['beta-backup', 'delta-backup'])['laterDrop'], cleanup)
        self.assertFalse(after_steer([chat, {'t': 'tool_end', 'detail': 'cat checked.txt', 'out': 'alpha-main\nbeta-backup'}], ['beta-backup'])['laterDrop'])
        self.assertTrue(after_steer([chat, {'t': 'tool', 'detail': "/bin/bash -lc 'sleep 30; echo \"delta-backup\" >> checked.txt'"}], ['delta-backup'])['laterDrop'])

    def test_steer_count_counts_one_client_id(self):
        e = lambda c: {'t': 'user', 'steer': True, 'text': 'x', 'clientId': c}
        self.assertEqual(steer_count([e('a-12345678'), e('b-12345678'), {'t': 'user', 'text': 'x', 'clientId': 'a-12345678'}], 'a-12345678'), 1)
        self.assertEqual(steer_count([e('a-12345678'), e('a-12345678')], 'a-12345678'), 2)
        self.assertEqual(steer_count([], 'a-12345678'), 0)

    def test_canned_controller_receipts_are_not_own_words(self):
        self.assertTrue(canned_reply('好，我这就去弄。')); self.assertTrue(canned_reply(' 好，我接着做。 '))
        self.assertFalse(canned_reply('行，最后只给你列正在用的'))


class ReplyShape(unittest.TestCase):
    def test_shape_tells_failure_kinds_apart_without_any_text(self):
        m, o = '青柠 风筝 海盐', '灯塔 松果 白鹭'
        self.assertTrue(reply_shape(['好，我这就去弄。', '青柠、风筝、海盐'], m)['anyReplySays'])
        s = reply_shape(['青柠 风筝'], m)
        self.assertEqual((s['words'], s['of'], s['anyReplySays']), (2, 3, False))
        s = reply_shape(['灯塔 松果 白鹭'], m, o)
        self.assertEqual((s['words'], s['otherWords']), (0, 3))
        s = reply_shape(['generation-current'], 'generation-current-0123456789ab')
        self.assertEqual((s['chars'], s['ascii'], s['words']), (18, True, 0))
        s = reply_shape([], m)
        self.assertEqual((s['replies'], s['chars'], s['words']), (0, 0, 0))
        dumped = str(reply_shape(['任务还在跑，' + o], m, o))
        for w in m.split() + o.split() + ['任务']:
            self.assertNotIn(w, dumped)


class LeftoverSmoke(unittest.TestCase):
    def test_only_this_scripts_own_non_main_conversations(self):
        for title in ('这是发布后的真实联调，使用默认后台安排，只派一个后台任务并立即回复，不要等待它完', '只读取这张图片中唯一一行字符并照写出来。不要派任务、执行命令或记忆。',
                      '只回复 generation-original-0123456789ab，不要执行命令、派任务或记忆。', '只回复 generation-current-0123456789ab，不要执行命令、派任务或记忆。'):
            with self.subTest(title=title):
                self.assertTrue(is_leftover_smoke({'sid': 'sx', 'title': title}))
                self.assertFalse(is_leftover_smoke({'sid': 'sx', 'title': title, 'main': True}))
        for title in ('你好', '只回复我一句话', '这是发布后的真实效果吗', '只读取这张图片', '', None):
            with self.subTest(title=title):
                self.assertFalse(is_leftover_smoke({'sid': 'sx', 'title': title}))
        self.assertFalse(is_leftover_smoke(None))


class FrontPolicy(unittest.TestCase):
    # 站长 2026-11-13：前台换 Gemini 4 Hydrogen（思考强度中），Gemini 额度用完再切 DeepSeek；Claude 不再用
    def test_hydrogen_is_the_foreground_during_named_background_work(self):
        self.assertEqual(validate_front_model({'ok': True, 'model': HYDROGEN}), HYDROGEN)
        for model in ('kimi-k3.1-pro', 'claude-opus-4.6', None):
            with self.subTest(model=model), self.assertRaises(RuntimeError):
                validate_front_model({'ok': True, 'model': model})

    def test_deepseek_requires_real_current_gemini_exhaustion(self):
        good = {'model': HYDROGEN, 'blocked': True, 'retryAt': 2000}
        done = {'ok': True, 'model': DEEPSEEK}
        self.assertEqual(validate_front_model(done, good, 1000), DEEPSEEK)
        for bad in (None, {}, {**good, 'blocked': False}, {**good, 'retryAt': 1000},
                    {**good, 'model': 'claude-opus-4.6'}, {**good, 'retryAt': '2000'}):
            with self.subTest(quota=bad), self.assertRaises(RuntimeError):
                validate_front_model(done, bad, 1000)

    def test_failure_cannot_pass_as_a_receipt(self):
        for model in (HYDROGEN, DEEPSEEK):
            with self.subTest(model=model), self.assertRaises(RuntimeError):
                validate_front_model({'ok': False, 'model': model})

    def test_deadlines_include_existing_inference_budget_and_remain_bounded(self):
        self.assertGreaterEqual(front_reply_limit(HYDROGEN), 65)
        self.assertLessEqual(front_reply_limit(HYDROGEN), 75)
        self.assertGreaterEqual(front_reply_limit(DEEPSEEK), 25)
        self.assertLessEqual(front_reply_limit(DEEPSEEK), 30)
        with self.assertRaises(RuntimeError):
            front_reply_limit('kimi-k3.1-pro')

    def test_first_person_receipt_allows_dropped_subject_but_not_third_person(self):
        # 2026-11-12 #125 上线联调：DeepSeek 回执省略了主语「我」，是自然的第一人称，被只查「我」字的检查判失败
        for ok in ('好，我来。', '好嘞，这就去画这只黄乎乎的小奶龙，跳个舞、挥个手，手机上点开就能玩。', '收到，马上开始画。'):
            with self.subTest(reply=ok):
                self.assertTrue(first_person_receipt(ok))
        for bad in ('', '   ', '小芯会帮你画一只奶龙。', '已经交给后台去画了。', '我让分身去画了。', '交给同事处理。', '助手正在制作。'):
            with self.subTest(reply=bad):
                self.assertFalse(first_person_receipt(bad))


class BackgroundFallback(unittest.TestCase):
    # 2026-11-13 #131 正式站：Gemini 回了不是 SUCCESS 的状态，控制器换 Kimi 做完了，联调只认额度、判失败回滚
    NOW = 1_800_000_000_000
    SENT = NOW - 4 * 60_000

    def test_real_quota_cooldown_explains_it(self):
        self.assertEqual(explain_background_fallback({'blocked': True, 'retryAt': self.NOW + 60_000}, None, self.SENT, self.NOW), 'quota')

    def test_recorded_gemini_outage_in_this_run_or_the_15_minutes_before_explains_it(self):
        for issue in ({'kind': 'stall', 'at': self.SENT + 120_000}, {'kind': 'status', 'status': 'ERROR', 'at': self.SENT + 125_000},
                      {'kind': 'stall', 'at': self.SENT - 14 * 60_000}, {'kind': 'stall', 'at': self.NOW + 30_000}):
            with self.subTest(issue=issue):
                self.assertTrue(explain_background_fallback({}, issue, self.SENT, self.NOW).startswith('gemini '))
        self.assertEqual(explain_background_fallback(None, {'kind': 'status', 'status': 'ERROR', 'at': self.SENT}, self.SENT, self.NOW), 'gemini status ERROR')

    def test_unexplained_fallback_still_fails(self):
        for quota, issue in (({}, None), ({'blocked': True, 'retryAt': self.NOW - 1}, None),
                             ({}, {'kind': 'stall', 'at': self.SENT - 16 * 60_000}),
                             ({}, {'kind': 'crash', 'at': self.SENT + 1000}), ({}, {'kind': 'status', 'at': self.NOW + 5 * 60_000})):
            with self.subTest(quota=quota, issue=issue), self.assertRaises(RuntimeError):
                explain_background_fallback(quota, issue, self.SENT, self.NOW)


class ResidentStateOwner(unittest.TestCase):
    # 第 2 批：正式站的状态由外壳拉起的常驻进程管，操作经本机套接字交给它，不再起控制器进程（usage 里的 owner 是外壳的 summary）
    RUNNING = {'want': 'kernel', 'mode': 'kernel', 'phase': 'running', 'epoch': 4, 'spawns': 2, 'pid': 900, 'lastError': None, 'kernelCurrent': True}

    def test_running_kernel_owner_is_resident(self):
        self.assertEqual(resident_owner({'owner': self.RUNNING}), {'epoch': 4, 'spawns': 2})

    def test_anything_else_is_not_resident_yet(self):
        for owner in (None, {}, dict(self.RUNNING, phase='starting'), dict(self.RUNNING, phase='fallback', mode='legacy'),
                      dict(self.RUNNING, mode='legacy'), dict(self.RUNNING, epoch=None), dict(self.RUNNING, spawns='2'),
                      # 电脑上的外壳还不是这次部署的版本（Worker 正在后台换）：先不记，换好了再记，免得中途换外壳把切换次数加一判成重启
                      dict(self.RUNNING, kernelCurrent=False), {k: v for k, v in self.RUNNING.items() if k != 'kernelCurrent'}):
            with self.subTest(owner=owner):
                self.assertIsNone(resident_owner({'owner': owner} if owner is not None else {}))
        self.assertIsNone(resident_owner(None))

    def test_same_owner_passes_and_any_change_fails_with_counts_only(self):
        first = resident_owner({'owner': self.RUNNING})
        same_resident_owner(first, {'owner': dict(self.RUNNING, up=99)})
        for owner, says_ in ((dict(self.RUNNING, epoch=5), 'restarted'), (dict(self.RUNNING, spawns=3), 'controller'),
                             (dict(self.RUNNING, phase='fallback', mode='legacy', lastError='state_compat'), 'no longer'), (None, 'no longer')):
            with self.subTest(owner=owner), self.assertRaises(RuntimeError) as e:
                same_resident_owner(first, {'owner': owner} if owner else {})
            self.assertIn(says_, str(e.exception))


class LiveScriptUsesOnePolicy(unittest.TestCase):
    # #132 正式站：只改了默认后台任务那一处，「点名 Gemini 做网页」那处还只认额度，Gemini 一卡又判失败回滚
    def test_every_gemini_fallback_check_goes_through_the_policy(self):
        src = (Path(__file__).resolve().parents[1] / 'scripts' / 'test-xin-live.py').read_text(encoding='utf-8')
        self.assertNotIn("get('antigravity') or {}", src)
        self.assertNotIn('without a real quota cooldown', src)
        # 默认后台任务、点名 Gemini 做网页：两处换模型的验收都走同一个规则
        self.assertEqual(src.count('explain_background_fallback(center'), 2)

    def test_resident_owner_is_waited_for_then_checked_at_the_end(self):
        src = (Path(__file__).resolve().parents[1] / 'scripts' / 'test-xin-live.py').read_text(encoding='utf-8')
        wait, check = src.index('owner = resident_owner(usage)'), src.index("same_resident_owner(owner, await call('usage', {}))")
        self.assertIn("usage = await call('usage', {})", src)
        self.assertIn('PASS state owner is the resident process (kernel mode, no controller process per request)', src)
        self.assertLess(wait, src.index('PASS off-machine encrypted backup'), '第一个检查之前先等到常驻进程')
        self.assertGreater(check, src.index('PASS real Gemini animated web preview'), '所有检查做完以后再核对一次')


if __name__ == '__main__':
    unittest.main()
