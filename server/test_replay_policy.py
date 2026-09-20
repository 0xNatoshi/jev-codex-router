"""Replay uses the live contract and compares exactly the same supported turns."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import routing_policy

spec = importlib.util.spec_from_file_location(
    "backtest_under_test", Path(__file__).resolve().parents[1] / "poc/backtest_savings.py")
backtest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backtest)


class ReplayPolicy(unittest.TestCase):
    def write_session(self, root, name, model, volume):
        folder = root / "2026/09/20"
        folder.mkdir(parents=True, exist_ok=True)
        records = [
            {"type": "session_meta", "payload": {"cwd": "/fixture"}},
            {"type": "event_msg", "payload": {"type": "thread_settings_applied",
                                            "thread_settings": {"model": model}}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": name}},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
              "content": [{"type": "input_text", "text": "Explain the fixture function " + name}]}},
            {"type": "token_usage_record", "payload": {"turn_id": name, "turn_token_usage": {
                "input_tokens": volume, "cached_input_tokens": 0, "output_tokens": 0}}},
        ]
        (folder / f"{name}.jsonl").write_text("\n".join(json.dumps(r) for r in records))

    def test_joint_decision_and_equal_baseline_population(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_session(root, "supported", routing_policy.SOL, 1_000_000)
            self.write_session(root, "unsupported", "unknown-model", 1_000_000_000)
            result = root / "result.json"
            with mock.patch.object(backtest, "SESS_ROOT", str(root)), \
                 mock.patch.object(backtest, "RESULT_PATH", str(result)), \
                 mock.patch.object(backtest.poc, "load_key", return_value="fixture"), \
                 mock.patch.object(backtest.poc, "post_json", return_value={"answers": {
                     "route": {"choice": f"{routing_policy.LUNA}:low", "confidence": 0.1},
                 }}) as judge, \
                 mock.patch("sys.argv", ["backtest"]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(backtest.main(), 0)
            self.assertEqual(judge.call_args.args[2]["questions"], routing_policy.QUESTIONS)
            data = json.loads(result.read_text())
            self.assertEqual(data["turns"], 1)
            self.assertEqual(data["skipped_turns"], 1)
            self.assertEqual(data["jev_usd"], 0.2)
            self.assertEqual(data["scenarios_usd"][routing_policy.SOL], 4.0)
            self.assertEqual(data["policy_version"], routing_policy.POLICY_VERSION)

    def test_identical_short_replies_do_not_share_different_contexts(self):
        self.assertNotEqual(backtest.turn_key({"text": "continue", "prev": "first task"}),
                            backtest.turn_key({"text": "continue", "prev": "other task"}))


if __name__ == "__main__":
    unittest.main()
