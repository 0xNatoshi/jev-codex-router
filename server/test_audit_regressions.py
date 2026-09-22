"""Defensive and functional regression checks from the September 2026 audit."""
import io
import datetime
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import healthcheck
import jev_server as j
import local_runtime
import report_routing


def message(role, text):
    return {"role": role, "content": text}


class DossierRegression(unittest.TestCase):
    def test_short_assent_keeps_the_proposal_and_active_task(self):
        def state(proposal):
            return j.decision_dossier({"input": [
                message("user", "Improve the export."),
                message("assistant", proposal), message("user", "oui")]})
        a, b = state("Rename the button."), state("Investigate transactional consistency.")
        self.assertNotEqual(a, b)
        self.assertEqual(a["task"], "oui")
        self.assertEqual(a["active_task"], "Improve the export.")
        self.assertEqual(a["previous_proposal"], "Rename the button.")

    def test_separate_metadata_messages_do_not_hide_the_last_request(self):
        state = j.decision_dossier({"input": [
            message("user", "Review the design."),
            message("user", '# AGENTS.md instructions for /fixture\n<INSTRUCTIONS>rules</INSTRUCTIONS>'),
            message("user", "<environment_context>metadata</environment_context>"),
        ]})
        self.assertEqual(state["task"], "Review the design.")
        self.assertNotIn("rules", json.dumps(state))

    def test_parallel_outputs_preserve_an_earlier_error(self):
        inp = [message("user", "Run both checks."),
               {"type": "function_call", "call_id": "a", "name": "tests", "arguments": "private"},
               {"type": "function_call", "call_id": "b", "name": "lint", "arguments": "private"},
               {"type": "function_call_output", "call_id": "a", "output": "Tests failed: race"},
               {"type": "function_call_output", "call_id": "b", "output": "lint passed"}]
        state = j.decision_dossier({"input": inp})
        self.assertTrue(state["tool_error"])
        self.assertEqual(state["tool_batch"]["errors"], 1)
        self.assertEqual(state["tool_batch"]["count"], 2)
        self.assertEqual(state["tool_batch"]["results"][0]["tool"], "tests")
        self.assertNotIn("private", json.dumps(state))

    def test_large_tool_batch_has_a_fixed_excerpt_budget(self):
        inp = [message("user", "Check results.")] + [
            {"type": "custom_tool_call_output", "call_id": str(i), "output": "error " + "x" * 2000}
            for i in range(100)]
        state = j.decision_dossier({"input": inp})
        self.assertEqual(state["tool_batch"]["errors"], 100)
        self.assertEqual(len(state["tool_batch"]["results"]), 3)
        self.assertLess(len(json.dumps(state)), 1000)

    def test_projection_leaves_canonical_input_unchanged(self):
        inp = [message("user", "old " * 10000), message("user", "oui")]
        before = json.dumps(inp)
        j.decision_dossier({"input": inp})
        self.assertEqual(json.dumps(inp), before)


class LocalControls(unittest.TestCase):
    def test_authorization_fails_closed(self):
        self.assertFalse(local_runtime.authorized(None, "fixture"))
        self.assertFalse(local_runtime.authorized("Bearer wrong", "fixture"))
        self.assertFalse(local_runtime.authorized("Bearer ", ""))
        self.assertTrue(local_runtime.authorized("Bearer fixture", "fixture"))

    def test_local_credential_requires_private_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "key"
            path.write_text("fixture-key")
            with mock.patch.object(local_runtime, "AUTH_PATH", str(path)):
                path.chmod(0o644)
                self.assertEqual(local_runtime.local_secret(), "")
                path.chmod(0o600)
                self.assertEqual(local_runtime.local_secret(), "fixture-key")

    def test_diagnostic_files_are_private_and_rotation_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "diagnostic.log"
            for _ in range(5):
                local_runtime.append_private(str(path), "entry\n", max_bytes=10)
            self.assertEqual(len(list(Path(tmp).iterdir())), 2)
            for file in Path(tmp).iterdir():
                self.assertLessEqual(file.stat().st_size, 10)
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_healthcheck_requires_correct_service_and_json(self):
        for payload, status, expected in [
            (b'{"ok":true,"service":"jev-router"}', 200, True),
            (b'{"ok":true,"service":"different"}', 200, False),
            (b'{"ok":false,"service":"jev-router"}', 200, False),
            (b'not json', 200, False),
            (b'{"ok":true,"service":"jev-router"}', 503, False),
        ]:
            response = io.BytesIO(payload)
            response.status = status
            with mock.patch.object(healthcheck.urllib.request, "urlopen", return_value=response):
                self.assertEqual(healthcheck.healthy(), expected)


class CacheRegression(unittest.TestCase):
    def test_rotated_log_is_included_in_the_report_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "routes.jsonl"
            line = json.dumps({"at": "2026-09-21T10:00:00", "model": j.TERRA}) + "\n"
            path.write_text(line)
            Path(str(path) + ".1").write_text(line)
            rows, stats = report_routing.load_entries(
                path, 7, now=datetime.datetime(2026, 9, 21, 12))
            self.assertEqual(len(rows), 2)
            self.assertEqual(stats["lines"], 2)

    def test_terra_swaps_and_cache_counters_do_not_depend_on_credit_prices(self):
        rows = [{"cache_scope": "fixture", "native": model, "attempts": [{
            "model": model, "usage": {"input_tokens": 1000, "cached_input_tokens": 500}
        }]} for model in (j.SOL, j.TERRA, j.SOL)]
        result = report_routing.prompt_cache_usage(rows)
        self.assertEqual(result["route_switches"], 2)
        self.assertEqual(result["model_revisits"], 1)
        self.assertEqual(result["observed_attempts"], 3)
        self.assertEqual(result["cached_input_tokens"], 1500)
        self.assertIn(j.TERRA, result["by_model"])


if __name__ == "__main__":
    unittest.main()
