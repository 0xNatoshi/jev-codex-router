"""The routing policy `route(tier, depth, conf, step)` — frozen case by case.

`route()` is the one place the triptych is decided; its tuple
`(model, effort, speed, gate)` is what the live log, the answer signature and the
backtest all read. The property the backtest bought is asymmetric and easy to
lose in a refactor: *below* the confidence gate the middle tier (sol) is the safe
default — never astra — and the only way luna survives its own low-confidence
verdict is a clean, shallow mechanical continuation (a tool step with no error,
depth low or medium). Above the gate the verdict is applied as given, with luna
always on max thinking and the priority fast lane.

These tests pin each branch with a literal tuple, including the boundaries
(confidence exactly at the gate, an absent confidence, an unknown depth), so a
policy change shows up as a diff here and the anti-downgrade property cannot
regress silently.

Run with the rest of the suite:
    python -m unittest discover -s server -p "test_*.py"
"""
import unittest

import jev_server as jev


class RoutePolicy(unittest.TestCase):
    """(model, effort, speed, gate) for every shape the policy can see."""

    def assertRoute(self, expected, *args):
        self.assertEqual(jev.route(*args), expected)

    # --- below the confidence gate: hold to the middle tier --------------------

    def test_a_low_confidence_user_turn_is_held_to_the_middle_tier(self):
        self.assertRoute((jev.SOL, "low", "default", "hold(sol)"), jev.LUNA, "low", 0.1)

    def test_a_conversational_turn_without_a_step_is_held_to_sol(self):
        self.assertRoute((jev.SOL, "medium", "default", "hold(sol)"),
                         jev.LUNA, "medium", 0.4, None)

    def test_a_low_confidence_verdict_on_sol_is_held_to_sol(self):
        self.assertRoute((jev.SOL, "high", "default", "hold(sol)"),
                         jev.SOL, "high", 0.0, {"step_type": "tool_step"})

    def test_a_low_confidence_verdict_on_astra_is_held_to_sol(self):
        self.assertRoute((jev.SOL, "low", "default", "hold(sol)"),
                         jev.ASTRA, "low", 0.49, {"step_type": "user_turn"})

    def test_an_errored_tool_step_is_held_to_sol(self):
        self.assertRoute((jev.SOL, "low", "default", "hold(sol)"),
                         jev.LUNA, "low", 0.3,
                         {"step_type": "tool_step", "errored": True})

    def test_a_step_that_is_not_a_tool_step_is_held_to_sol(self):
        self.assertRoute((jev.SOL, "low", "default", "hold(sol)"),
                         jev.LUNA, "low", 0.3, {"step_type": "user_turn"})

    # --- the one measured exception: a clean shallow luna tool step ------------

    def test_a_clean_shallow_luna_tool_step_keeps_luna_on_the_fast_lane(self):
        self.assertRoute((jev.LUNA, "max", "priority", "hold(luna_step)"),
                         jev.LUNA, "low", 0.3, {"step_type": "tool_step"})

    def test_a_medium_depth_luna_tool_step_still_counts_as_shallow(self):
        self.assertRoute((jev.LUNA, "max", "priority", "hold(luna_step)"),
                         jev.LUNA, "medium", 0.35,
                         {"step_type": "tool_step", "errored": False})

    def test_an_absent_depth_defaults_to_shallow_for_that_exception(self):
        self.assertRoute((jev.LUNA, "max", "priority", "hold(luna_step)"),
                         jev.LUNA, None, 0.2, {"step_type": "tool_step"})

    def test_a_deep_luna_tool_step_is_held_to_sol(self):
        for depth in ("high", "xhigh", "max"):
            with self.subTest(depth=depth):
                self.assertRoute((jev.SOL, depth, "default", "hold(sol)"),
                                 jev.LUNA, depth, 0.3, {"step_type": "tool_step"})

    # --- at or above the gate: the verdict is applied as given -----------------

    def test_a_confident_luna_verdict_is_applied_on_max_and_priority(self):
        self.assertRoute((jev.LUNA, "max", "priority", "apply"),
                         jev.LUNA, "low", 0.97, {"step_type": "user_turn"})

    def test_a_confident_sol_verdict_is_applied_with_its_depth(self):
        self.assertRoute((jev.SOL, "medium", "default", "apply"),
                         jev.SOL, "medium", 0.5, {"step_type": "tool_step"})

    def test_a_confident_astra_verdict_is_applied_with_its_depth(self):
        self.assertRoute((jev.ASTRA, "high", "default", "apply"),
                         jev.ASTRA, "high", 0.9, {"step_type": "user_turn"})

    # --- boundaries -----------------------------------------------------------

    def test_confidence_exactly_at_the_gate_is_applied_not_held(self):
        self.assertRoute((jev.LUNA, "max", "priority", "apply"),
                         jev.LUNA, "low", jev.CONF_GATE, {"step_type": "user_turn"})

    def test_an_absent_confidence_leaves_the_verdict_untouched(self):
        self.assertRoute((jev.ASTRA, "low", "default", "apply"),
                         jev.ASTRA, "low", None, {"step_type": "user_turn"})

    def test_an_unknown_depth_is_clamped_to_medium_and_keeps_its_gate(self):
        self.assertRoute((jev.SOL, "medium", "default", "apply"),
                         jev.SOL, "nonsense", 0.8, {"step_type": "tool_step"})
        self.assertRoute((jev.SOL, "medium", "default", "hold(sol)"),
                         jev.SOL, "nonsense", 0.2, {"step_type": "tool_step"})

    def test_the_model_a_gate_holds_to_is_never_the_frontier(self):
        for tier in (jev.LUNA, jev.SOL, jev.ASTRA):
            for step in (None, {"step_type": "tool_step"}, {"step_type": "user_turn"},
                         {"step_type": "tool_step", "errored": True}):
                for depth in ("low", "medium", "high", "max", None):
                    with self.subTest(tier=tier, step=step, depth=depth):
                        model, _effort, _speed, _gate = jev.route(tier, depth, 0.0, step)
                        self.assertIn(model, (jev.LUNA, jev.SOL))


if __name__ == "__main__":
    unittest.main()
