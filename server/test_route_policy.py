"""Regression checks for joint routing and provider answer validation."""
import copy
import unittest

import jev_server as jev
from routing_policy import ROUTE_PAIRS, decision_from_answers


class JointPolicy(unittest.TestCase):
    def test_every_valid_pair_survives_confidence_and_step_metadata(self):
        for model, effort in ROUTE_PAIRS.values():
            for confidence in (None, 0.0, 0.2, 0.5, 1.0):
                for step in (None, {"step_type": "user_turn"},
                             {"step_type": "tool_step", "errored": True},
                             {"step_type": "tool_step", "errored": False}):
                    with self.subTest(model=model, effort=effort, confidence=confidence, step=step):
                        self.assertEqual(jev.route(model, effort, confidence, step),
                                         (model, effort, "default", "apply"))

    def answer(self, choice=None):
        choice = choice or f"{jev.LUNA}:low"
        probabilities = {key: 0.8 / (len(ROUTE_PAIRS) - 1) for key in ROUTE_PAIRS}
        probabilities[choice] = 0.2
        return {"route": {"choice": choice, "confidence": 0.01,
                          "probabilities": probabilities}}

    def test_a_diffuse_valid_distribution_does_not_force_sol(self):
        for model in jev.TIERS:
            result = decision_from_answers(self.answer(f"{model}:low"))
            self.assertEqual(result["model"], model)
            self.assertEqual(result["effort"], "low")
            self.assertEqual(result["confidence"], 0.01)
            self.assertEqual(result["chosen_probability"], 0.2)
            self.assertEqual(result["gate"], "apply")

    def test_confidence_is_not_invented_from_winning_probability(self):
        answer = self.answer()
        del answer["route"]["confidence"]
        answer["route"]["type"] = "choice"
        result = decision_from_answers(jev._typesafe_answers(answer))
        self.assertIsNone(result["confidence"])
        self.assertEqual(result["chosen_probability"], 0.2)

    def test_invalid_choices_cannot_become_an_unrequested_pair(self):
        for answer in ({}, None, {"route": None}, {"route": {"choice": []}},
                       {"route": {"choice": f"{jev.LUNA}:ultra"}},
                       {"route": {"choice": "unknown:low"}}):
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                decision_from_answers(answer)

    def test_invalid_distributions_are_rejected(self):
        base = self.answer()
        for value in (-0.5, float("nan"), float("inf"), True, "0.2"):
            answer = copy.deepcopy(base)
            answer["route"]["probabilities"][f"{jev.LUNA}:low"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                decision_from_answers(answer)
        for probabilities in ({}, {f"{jev.LUNA}:low": 1.0},
                              dict.fromkeys(ROUTE_PAIRS, 0.0)):
            answer = copy.deepcopy(base)
            answer["route"]["probabilities"] = probabilities
            with self.subTest(probabilities=probabilities), self.assertRaises(ValueError):
                decision_from_answers(answer)

    def test_choice_must_agree_with_the_distribution(self):
        answer = self.answer()
        answer["route"]["choice"] = f"{jev.ASTRA}:high"
        with self.assertRaises(ValueError):
            decision_from_answers(answer)

    def test_missing_or_invalid_confidence_is_diagnostic_only(self):
        for confidence in (None, True, float("nan"), -1, 2, "high"):
            answer = self.answer()
            answer["route"]["confidence"] = confidence
            result = decision_from_answers(answer)
            self.assertIsNone(result["confidence"])
            self.assertEqual(result["model"], jev.LUNA)


if __name__ == "__main__":
    unittest.main()
