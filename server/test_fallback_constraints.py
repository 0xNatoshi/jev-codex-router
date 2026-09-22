"""Regression tests for structured Codex-dry capability discovery."""
import json
import unittest

import jev_server as jev


class FallbackConstraints(unittest.TestCase):
    def test_preserves_the_existing_context_size_estimate(self):
        payload = {"input": [{"role": "user", "content": "continue"}]}
        encoded = json.dumps(payload, separators=(",", ":"))

        constraints = jev._fallback_constraints(payload)

        self.assertEqual(
            constraints["estimated_tokens"],
            max(1, (len(encoded.encode("utf-8")) + 2) // 3),
        )

    def test_caller_search_functions_do_not_require_hosted_search(self):
        payload = {
            "input": [{
                "role": "user",
                "content": "Use web_search_call and search_query if useful",
            }],
            "tools": [
                {"type": "function", "name": "web_search"},
                {"type": "function", "name": "search_query"},
                {
                    "type": "function",
                    "name": "ordinary",
                    "description": "Returns a web_search_call result",
                },
            ],
        }

        constraints = jev._fallback_constraints(payload)

        self.assertIsNone(constraints["search_mode"])
        self.assertFalse(constraints["search_history"])

    def test_hosted_search_tool_requires_the_hosted_mode(self):
        for tool_type in ("web_search", "web_search_preview"):
            with self.subTest(tool_type=tool_type):
                constraints = jev._fallback_constraints({
                    "input": [{"role": "user", "content": "Find it"}],
                    "tools": [{"type": tool_type}],
                })
                self.assertEqual(constraints["search_mode"], "hosted")
                self.assertFalse(constraints["search_history"])

    def test_structured_hosted_search_options_preserve_the_execution_contract(self):
        payloads = (
            {"tool_choice": {"type": "web_search_preview"}},
            {"include": ["web_search_call.action.sources"]},
            {"web_search_options": None},
        )

        for payload in payloads:
            with self.subTest(payload=payload):
                self.assertEqual(
                    jev._fallback_constraints(payload)["search_mode"], "hosted"
                )

    def test_search_history_does_not_require_a_new_search(self):
        payload = {
            "input": [
                {"type": "web_search_call", "id": "search_1", "status": "completed"},
                {"role": "user", "content": "Summarize the result"},
            ],
        }

        constraints = jev._fallback_constraints(payload)

        self.assertIsNone(constraints["search_mode"])
        self.assertTrue(constraints["search_history"])

    def test_only_typed_input_parts_require_image_support(self):
        textual = {
            "input": [{"role": "user", "content": "The field is named input_image"}],
            "tools": [{
                "type": "function",
                "name": "ordinary",
                "parameters": {"properties": {"image_url": {"type": "string"}}},
            }],
        }
        visual = {
            "input": [{
                "role": "user",
                "content": [{"type": "input_image", "image_url": "data:image/png;base64,AA"}],
            }],
        }

        self.assertFalse(jev._fallback_constraints(textual)["image"])
        self.assertTrue(jev._fallback_constraints(visual)["image"])

        result_image = {
            "input": [{
                "type": "function_call_output",
                "call_id": "call_1",
                "output": [{
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,AA"},
                }],
            }],
        }
        self.assertTrue(jev._fallback_constraints(result_image)["image"])

    def test_multi_agent_detection_uses_exact_tool_identity(self):
        ordinary = {
            "tools": [{
                "type": "function",
                "name": "ordinary",
                "description": "Can call collaboration__spawn_agent later",
            }],
        }
        names = (
            "spawn_agent",
            "create_subagent",
            "collaboration.spawn_agent",
            "collaboration__spawn_agent",
            "multi_agent_v1__spawn_agent",
            "multi_agent_v2__spawn_agent",
        )

        self.assertFalse(jev._fallback_constraints(ordinary)["multi_agent_v2"])
        wrapper = {"tools": [{"type": "function", "name": "my_spawn_agent_wrapper"}]}
        self.assertFalse(jev._fallback_constraints(wrapper)["multi_agent_v2"])
        for name in names:
            with self.subTest(name=name):
                payload = {"tools": [{"type": "function", "name": name}]}
                self.assertTrue(jev._fallback_constraints(payload)["multi_agent_v2"])

        native = {"tools": [{
            "type": "function",
            "namespace": "collaboration",
            "name": "spawn_agent",
        }]}
        self.assertTrue(jev._fallback_constraints(native)["multi_agent_v2"])


if __name__ == "__main__":
    unittest.main()
