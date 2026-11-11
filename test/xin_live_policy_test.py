import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from xin_live_policy import OPUS, DEEPSEEK, validate_front_model, front_reply_limit, is_leftover_smoke, reply_shape, spoken_marker, says, SPOKEN


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
    def test_opus_is_the_foreground_during_named_background_work(self):
        self.assertEqual(validate_front_model({'ok': True, 'model': OPUS}), OPUS)
        for model in ('kimi-k3.1-pro', 'gemini-3.8-flash-high', None):
            with self.subTest(model=model), self.assertRaises(RuntimeError):
                validate_front_model({'ok': True, 'model': model})

    def test_deepseek_requires_real_current_claude_exhaustion(self):
        good = {'model': OPUS, 'blocked': True, 'retryAt': 2000}
        done = {'ok': True, 'model': DEEPSEEK}
        self.assertEqual(validate_front_model(done, good, 1000), DEEPSEEK)
        for bad in (None, {}, {**good, 'blocked': False}, {**good, 'retryAt': 1000},
                    {**good, 'model': 'gemini-3.8-flash-high'}, {**good, 'retryAt': '2000'}):
            with self.subTest(quota=bad), self.assertRaises(RuntimeError):
                validate_front_model(done, bad, 1000)

    def test_failure_cannot_pass_as_a_receipt(self):
        for model in (OPUS, DEEPSEEK):
            with self.subTest(model=model), self.assertRaises(RuntimeError):
                validate_front_model({'ok': False, 'model': model})

    def test_deadlines_include_existing_inference_budget_and_remain_bounded(self):
        self.assertGreaterEqual(front_reply_limit(OPUS), 65)
        self.assertLessEqual(front_reply_limit(OPUS), 75)
        self.assertGreaterEqual(front_reply_limit(DEEPSEEK), 25)
        self.assertLessEqual(front_reply_limit(DEEPSEEK), 30)
        with self.assertRaises(RuntimeError):
            front_reply_limit('kimi-k3.1-pro')


if __name__ == '__main__':
    unittest.main()
