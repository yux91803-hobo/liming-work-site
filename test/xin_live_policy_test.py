import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from xin_live_policy import OPUS, DEEPSEEK, validate_front_model, front_reply_limit


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
