"""Regression checks for split routing and provider answer validation."""
import copy
import json
import unittest

import jev_server as jev
from routing_policy import (
    ASTRA_POLICY,
    DEPTH_PROFILES,
    LEASE_PROFILES,
    MODEL_IDS,
    QUESTIONS,
    decision_from_answers,
    route_choice,
)


class SplitPolicy(unittest.TestCase):
    def test_the_repeated_contract_stays_compact_and_explicit(self):
        encoded = json.dumps(QUESTIONS, separators=(",", ":"))
        self.assertLessEqual(len(encoded), 3200)
        self.assertNotIn('"luna":"luna"', encoded)
        self.assertIn("Intermittent or concurrency failures", encoded)
        self.assertIn("independent final code review", encoded)
        self.assertIn("routine in-progress quality checkpoints", encoded)
        self.assertIn("never waives a required final/risk review", encoded)
        self.assertEqual(set(QUESTIONS), {"astra_policy", "model", "effort", "lease"})
        self.assertIn("corrections and clarification turns", encoded)
        self.assertIn("reprocessing-cost evidence", encoded)
        self.assertIn("never a capability ceiling", encoded)
        self.assertIn("Do not inherit a completed phase", encoded)

    def test_every_valid_pair_survives_confidence_and_step_metadata(self):
        for model in jev.TIERS:
            for effort in jev.EFFORTS:
                for confidence in (None, 0.0, 0.2, 0.5, 1.0):
                    for step in (
                        None,
                        {"step_type": "user_turn"},
                        {"step_type": "tool_step", "errored": True},
                        {"step_type": "tool_step", "errored": False},
                    ):
                        with self.subTest(
                            model=model,
                            effort=effort,
                            confidence=confidence,
                            step=step,
                        ):
                            self.assertEqual(
                                jev.route(model, effort, confidence, step),
                                (model, effort, "default", "apply"),
                            )

    @staticmethod
    def distribution(choices, selected):
        if len(choices) == 2:
            return {choice: 0.7 if choice == selected else 0.3 for choice in choices}
        remainder = 0.6 / (len(choices) - 1)
        result = {choice: remainder for choice in choices}
        result[selected] = 0.4
        return result

    def answer(self, model=jev.LUNA, effort="low", astra_required=False, lease="one_call"):
        pair = route_choice(model, effort, astra_required, lease)
        return {
            "astra_policy": {
                "choice": pair["astra_policy"],
                "confidence": 0.21,
                "probabilities": self.distribution(
                    ASTRA_POLICY, pair["astra_policy"]
                ),
            },
            "model": {
                "choice": pair["model"],
                "confidence": 0.21,
                "probabilities": self.distribution(MODEL_IDS, pair["model"]),
            },
            "effort": {
                "choice": pair["effort"],
                "confidence": 0.12,
                "probabilities": self.distribution(DEPTH_PROFILES, pair["effort"]),
            },
            "lease": {
                "choice": pair["lease"],
                "confidence": 0.18,
                "probabilities": self.distribution(LEASE_PROFILES, pair["lease"]),
            },
        }

    def test_valid_independent_choices_are_combined_without_an_override(self):
        for model in jev.TIERS:
            for effort in jev.EFFORTS:
                result = decision_from_answers(self.answer(model, effort))
                self.assertEqual(result["model"], model)
                self.assertEqual(result["base_model"], model)
                self.assertEqual(result["astra_policy"], "normal")
                self.assertEqual(result["effort"], effort)
                self.assertEqual(result["lease"], "one_call")
                self.assertEqual(result["confidence"], 0.12)
                self.assertEqual(result["chosen_probability"], 0.4)
                self.assertEqual(result["gate"], "apply")

    def test_mandatory_categories_override_the_base_model_with_astra(self):
        result = decision_from_answers(
            self.answer(jev.LUNA, "high", astra_required=True)
        )
        self.assertEqual(result["model"], jev.ASTRA)
        self.assertEqual(result["base_model"], jev.LUNA)
        self.assertEqual(result["astra_policy"], "astra")
        self.assertEqual(result["effort"], "high")
        self.assertEqual(result["gate"], "astra_policy")

    def test_invalid_choices_cannot_become_an_unrequested_pair(self):
        invalid = (
            {},
            None,
            {"model": None, "effort": None},
            {"model": {"choice": []}, "effort": {"choice": "low"}},
            {"model": {"choice": "luna"}, "effort": {"choice": "ultra"}},
            {"model": {"choice": "unknown"}, "effort": {"choice": "low"}},
        )
        for answer in invalid:
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                decision_from_answers(answer)

    def test_invalid_distributions_are_rejected_for_each_question(self):
        for question, choices in (
            ("astra_policy", ASTRA_POLICY),
            ("model", MODEL_IDS),
            ("effort", DEPTH_PROFILES),
            ("lease", LEASE_PROFILES),
        ):
            selected = self.answer()[question]["choice"]
            for value in (-0.5, float("nan"), float("inf"), True, "0.2"):
                answer = copy.deepcopy(self.answer())
                answer[question]["probabilities"][selected] = value
                with self.subTest(question=question, value=value), self.assertRaises(ValueError):
                    decision_from_answers(answer)
            for probabilities in ({}, {selected: 1.0}, dict.fromkeys(choices, 0.0)):
                answer = copy.deepcopy(self.answer())
                answer[question]["probabilities"] = probabilities
                with (
                    self.subTest(question=question, probabilities=probabilities),
                    self.assertRaises(ValueError),
                ):
                    decision_from_answers(answer)

    def test_choice_must_agree_with_its_distribution(self):
        answer = self.answer()
        answer["model"]["choice"] = "astra"
        with self.assertRaises(ValueError):
            decision_from_answers(answer)

    def test_missing_or_invalid_confidence_is_diagnostic_only(self):
        for confidence in (None, True, float("nan"), -1, 2, "high"):
            answer = self.answer()
            answer["astra_policy"]["confidence"] = confidence
            answer["model"]["confidence"] = confidence
            answer["effort"]["confidence"] = confidence
            answer["lease"]["confidence"] = confidence
            result = decision_from_answers(answer)
            self.assertIsNone(result["confidence"])
            self.assertEqual(result["model"], jev.LUNA)


if __name__ == "__main__":
    unittest.main()
