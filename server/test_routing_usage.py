"""Usage reporting must preserve missing data and price each attempt only once."""
import json
import unittest

import jev_server as j
import report_routing as report


class Usage(unittest.TestCase):
    def test_fragmented_terminal_event_captures_only_token_counters(self):
        raw_usage = {"input_tokens": 1000, "output_tokens": 120, "total_tokens": 1120,
                     "input_tokens_details": {"cached_tokens": 900},
                     "output_tokens_details": {"reasoning_tokens": 100},
                     "private_field": "must not enter telemetry"}
        raw = ("data: " + json.dumps({"type": "response.completed",
               "response": {"id": "r", "usage": raw_usage}}) + "\n\n").encode()
        marker = j.SummaryMarker("")
        for at in range(0, len(raw), 13):
            marker.feed(raw[at:at + 13])
        marker.flush()
        self.assertEqual(marker.terminal_type, "response.completed")
        self.assertEqual(marker.usage, {
            "input_tokens": 1000, "output_tokens": 120, "total_tokens": 1120,
            "cached_input_tokens": 900, "reasoning_tokens": 100,
        })

    def test_missing_usage_is_not_a_free_call(self):
        self.assertIsNone(j.usage_counts(None))
        self.assertIsNone(j.usage_counts({"input_tokens": True, "output_tokens": -1}))
        self.assertIsNone(report.token_credits(j.LUNA, {"input_tokens": 1000, "output_tokens": 1}))

    def test_reasoning_is_not_billed_twice(self):
        usage = {"input_tokens": 1_000_000, "cached_input_tokens": 800_000,
                 "output_tokens": 100_000, "reasoning_tokens": 90_000}
        self.assertEqual(report.token_credits(j.SOL, usage), 78.0)
        self.assertEqual(report.token_credits(j.LUNA, usage), 4.4)

    def test_retries_count_and_external_fallback_does_not_inflate_native_savings(self):
        usage = {"input_tokens": 1_000_000, "cached_input_tokens": 0, "output_tokens": 0}
        entries = [{"attempts": [
            {"model": j.LUNA, "speed": "default", "status": 500, "usage": usage},
            {"model": j.SOL, "speed": "default", "status": 200, "usage": usage},
            {"model": j.ASTRA, "speed": "default", "status": 429, "usage": None},
            {"model": "external", "speed": "default", "status": 200, "usage": usage},
        ]}, {"model": j.LUNA}]
        result = report.measured_usage(entries)
        self.assertEqual(result["native_attempts"], 3)
        self.assertEqual(result["priced_attempts"], 2)
        self.assertEqual(result["unknown_attempts"], 1)
        self.assertEqual(result["legacy_calls_without_attempts"], 1)
        self.assertEqual(result["routed_credits"], 105.0)
        self.assertEqual(result["all_sol_credits"], 200.0)
        self.assertEqual(result["all_astra_credits"], 500.0)

    def test_historical_fast_calls_keep_their_api_surcharge(self):
        for model in j.TIERS:
            self.assertAlmostEqual(report.turn_cost(model, speed="priority"),
                                   2 * report.turn_cost(model, speed="default"))
            self.assertAlmostEqual(report.turn_cost(model, speed="fast"),
                                   2 * report.turn_cost(model, speed="default"))

    def test_prompt_cache_is_measured_per_session_and_model(self):
        entries = [
            {"cache_scope": "session-a", "native": j.LUNA, "attempts": [{
                "model": j.LUNA,
                "usage": {"input_tokens": 1000, "cached_input_tokens": 800},
            }]},
            {"cache_scope": "session-a", "native": j.SOL, "attempts": [{
                "model": j.SOL,
                "usage": {"input_tokens": 2000, "cached_input_tokens": 0},
            }]},
            {"cache_scope": "session-a", "native": j.LUNA, "attempts": [{
                "model": j.LUNA,
                "usage": {"input_tokens": 3000, "cached_input_tokens": 2400},
            }]},
            {"cache_scope": "session-b", "native": j.ASTRA, "attempts": [{
                "model": j.ASTRA, "usage": None,
            }]},
        ]
        cache = report.prompt_cache_usage(entries)
        self.assertEqual(cache["tracked_sessions"], 2)
        self.assertEqual(cache["route_switches"], 2)
        self.assertEqual(cache["model_revisits"], 1)
        self.assertEqual(cache["observed_attempts"], 3)
        self.assertEqual(cache["unknown_attempts"], 1)
        self.assertEqual(cache["hit_attempts"], 2)
        self.assertEqual(cache["cached_share_pct"], 53.3)
        self.assertEqual(cache["by_model"][j.LUNA]["sessions"], 1)
        self.assertEqual(cache["by_model"][j.LUNA]["hit_rate_pct"], 100.0)
        self.assertEqual(cache["by_model"][j.SOL]["cached_share_pct"], 0.0)


if __name__ == "__main__":
    unittest.main()
