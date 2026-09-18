"""Unit tests for the decisions jev_server makes on every call.

The server itself is a long-lived process on loopback, so these tests hold the
parts that do not need it: which model serves a Codex-dry call, which rung of
that model's ladder the decided depth lands on, whether a failed tandem call is
worth one attempt on the sibling model, and the confidence gate that keeps the
triptych from over-spending.
"""
import json
import unittest

import jev_server as jev


class ResponseIdContinuity(unittest.TestCase):
    """One response id per relayed stream, however many gateways touched it.

    A Codex-dry turn is relayed through the local edge, which encodes response
    ids, so the terminal event of the stream we receive repeats the id under a
    fresh encoding. The Responses transform in front of the router read that as a
    completion that renamed itself and replaced the turn with an
    `invalid_responses_stream` error -- the shape that ended a live tandem turn
    on 18 September 2026.
    """

    CREATED = b'data: {"type":"response.created","response":{"id":"resp_created"}}\n\n'
    DONE = b"data: [DONE]\n\n"

    def relay(self, *frames):
        markerer = jev.SummaryMarker(" \u00b7 \U0001f9e0sol:low \u00b7 ")
        return "".join(markerer.feed(frame) for frame in frames) + markerer.flush()

    def response_ids(self, stream):
        ids = []
        for line in stream.splitlines():
            if not line.startswith("data: ") or line[6:].strip() == "[DONE]":
                continue
            event = json.loads(line[6:])
            response = event.get("response")
            if isinstance(response, dict) and "id" in response:
                ids.append(response["id"])
        return ids

    def test_a_re_encoded_completion_keeps_the_announced_id(self):
        completed = (
            b'data: {"type":"response.completed","response":{"id":"resp_re-encoded","output":[]}}\n\n'
        )
        stream = self.relay(self.CREATED, completed, self.DONE)
        self.assertEqual(self.response_ids(stream), ["resp_created", "resp_created"])
        self.assertIn("data: [DONE]", stream)

    def test_every_terminal_event_is_rewritten_onto_the_announced_id(self):
        for terminal in ("response.completed", "response.incomplete", "response.failed"):
            frame = (
                'data: {"type":"%s","response":{"id":"resp_other","output":[]}}\n\n' % terminal
            ).encode()
            stream = self.relay(self.CREATED, frame)
            self.assertEqual(self.response_ids(stream), ["resp_created", "resp_created"], terminal)

    def test_a_stream_without_a_created_event_is_left_to_its_own_id(self):
        completed = (
            b'data: {"type":"response.completed","response":{"id":"resp_alone","output":[]}}\n\n'
        )
        stream = self.relay(completed)
        self.assertEqual(self.response_ids(stream), ["resp_alone"])


class DryTandem(unittest.TestCase):
    def test_frontier_steps_go_to_glm_and_the_rest_to_deepseek(self):
        self.assertEqual(jev.dry_target(jev.ASTRA, "high")[0], jev.GO_FRONTIER)
        for tier in (jev.LUNA, jev.SOL):
            self.assertEqual(jev.dry_target(tier, "high")[0], jev.GO_STANDARD)

    def test_the_tandem_never_receives_a_rung_its_model_cannot_serve(self):
        # DeepSeek V4.1 Flash and GLM-5.3-Flash both declare low/high/max, and an
        # off-ladder value is an upstream 400 rather than an ignored field.
        for effort in ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", None, ""):
            self.assertIn(jev.tandem_effort(effort, jev.SOL), ("low", "high", "max"), repr(effort))

    def test_a_middle_depth_keeps_its_meaning(self):
        # DeepSeek documents its `low` as "no deep reasoning needed", and Jev says
        # "medium" about work it wants done carefully, so the middle of the native
        # ladder lands on the middle of the Go ladder instead of its floor.
        self.assertEqual(jev.tandem_effort("medium", jev.SOL), "high")
        self.assertEqual(jev.tandem_effort("high", jev.SOL), "high")
        self.assertEqual(jev.tandem_effort("low", jev.SOL), "low")
        self.assertEqual(jev.tandem_effort("xhigh", jev.SOL), "max")

    def test_an_absent_depth_keeps_the_tier_habit(self):
        self.assertEqual(jev.tandem_effort(None, jev.ASTRA), "max")
        self.assertEqual(jev.tandem_effort(None, jev.SOL), "high")

    def test_mapping_is_idempotent_so_a_fallback_cannot_drift(self):
        # The fallback remaps the rung it already carries; a second pass must not
        # walk it up or down.
        for effort in ("low", "medium", "high", "xhigh", "max"):
            once = jev.tandem_effort(effort, jev.SOL)
            self.assertEqual(jev.tandem_effort(once, jev.SOL), once)

    def test_the_fallback_is_the_sibling_model(self):
        self.assertEqual(jev.other_tandem(jev.GO_STANDARD), jev.GO_FRONTIER)
        self.assertEqual(jev.other_tandem(jev.GO_FRONTIER), jev.GO_STANDARD)


class TandemRetry(unittest.TestCase):
    def test_transient_and_allowance_statuses_are_retried(self):
        # opencode Go reports a spent allowance with the same shape a transient
        # outage arrives in, so both are worth the sibling attempt.
        for status in (408, 425, 429, 500, 502, 503, 504):
            self.assertIn(status, jev.RETRYABLE_TANDEM_STATUS)

    def test_a_rejected_request_is_not_retried(self):
        # A 400/401/403/404/413/422 is the caller's shape or credentials, so the
        # sibling model would answer the same way and only double the failure.
        for status in (400, 401, 403, 404, 413, 422):
            self.assertNotIn(status, jev.RETRYABLE_TANDEM_STATUS)


class Policy(unittest.TestCase):
    def test_a_low_confidence_user_turn_is_held_to_the_middle_tier(self):
        model, effort, speed, gate = jev.route(jev.LUNA, "low", 0.1, {"step_type": "user_turn"})
        self.assertEqual((model, effort, speed, gate), (jev.SOL, "low", "default", "hold(sol)"))

    def test_a_clean_mechanical_step_keeps_luna_on_the_fast_lane(self):
        model, effort, speed, gate = jev.route(jev.LUNA, "low", 0.1, {"step_type": "tool_step"})
        self.assertEqual((model, effort, speed, gate), (jev.LUNA, "max", "priority", "hold(luna_step)"))

    def test_a_confident_verdict_is_applied_as_given(self):
        model, effort, speed, gate = jev.route(jev.ASTRA, "max", 0.9, {"step_type": "user_turn"})
        self.assertEqual((model, effort, speed, gate), (jev.ASTRA, "max", "default", "apply"))

    def test_an_unknown_depth_is_clamped_to_the_documented_default(self):
        _model, effort, _speed, _gate = jev.route(jev.SOL, "nonsense", 0.9, {"step_type": "user_turn"})
        self.assertEqual(effort, "medium")


if __name__ == "__main__":
    unittest.main()
