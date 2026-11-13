import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from xin_live_policy import HYDROGEN, DEEPSEEK, validate_front_model, front_reply_limit, is_leftover_smoke, reply_shape, spoken_marker, says, SPOKEN, first_person_receipt, explain_background_fallback


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


class LiveScriptUsesOnePolicy(unittest.TestCase):
    # #132 正式站：只改了默认后台任务那一处，「点名 Gemini 做网页」那处还只认额度，Gemini 一卡又判失败回滚
    def test_every_gemini_fallback_check_goes_through_the_policy(self):
        src = (Path(__file__).resolve().parents[1] / 'scripts' / 'test-xin-live.py').read_text(encoding='utf-8')
        self.assertNotIn("get('antigravity') or {}", src)
        self.assertNotIn('without a real quota cooldown', src)
        # 默认后台任务、点名 Gemini 做网页：两处换模型的验收都走同一个规则
        self.assertEqual(src.count('explain_background_fallback(center'), 2)


if __name__ == '__main__':
    unittest.main()
