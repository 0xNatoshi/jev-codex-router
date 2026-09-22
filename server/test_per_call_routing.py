"""Measured routing keeps Jev's view compact and the executor replay complete.

The contract pinned here is:

1. user turns and changed/error tool phases get a fresh Jev decision;
2. explicit leases may reuse a route across safe clean continuations;
3. the canonical Responses request and prompt_cache_key are preserved for the
   selected model; the compact Jev dossier never becomes execution context;
4. cache telemetry identifies a session only by a non-reversible local hash.
"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import jev_server as jev  # noqa: E402
from routing_policy import route_choice  # noqa: E402

COMPLETED = (
    b'data: {"type":"response.created","response":{"id":"resp_call"}}\n\n'
    b'data: {"type":"response.completed","response":{"id":"resp_call","status":"completed",'
    b'"output":[],"usage":{"input_tokens":1000,"output_tokens":10,'
    b'"input_tokens_details":{"cached_tokens":800,"cache_write_tokens":50}}}}\n\n'
    b'data: [DONE]\n\n'
)


def answer(tier, depth, astra_required=False, lease="one_call"):
    pair = route_choice(tier, depth, astra_required, lease)
    return {
        "model": "jev-test",
        "answers": {
            "astra_policy": {"choice": pair["astra_policy"], "confidence": 0.3},
            "model": {"choice": pair["model"], "confidence": 0.3},
            "effort": {"choice": pair["effort"], "confidence": 0.3},
            "lease": {"choice": pair["lease"], "confidence": 0.3},
        },
        "usage": {"input_tokens": 100, "output_tokens": 5},
    }


def message(role, text):
    return {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]}


def tool_step(call_id, output):
    return {"type": "function_call_output", "call_id": call_id, "output": output}


def tool_call(call_id, name="exec_command"):
    return {"type": "function_call", "call_id": call_id, "name": name, "arguments": "{}"}


def payload_for(items, cache_key="pck-thread-1", **overrides):
    body = {
        "model": "auto",
        "stream": True,
        "instructions": "You are Codex.",
        "prompt_cache_key": cache_key,
        "prompt_cache_options": {"mode": "implicit", "ttl": "30m"},
        "input": items,
        "tools": [{"type": "function", "name": "exec_command"}],
    }
    body.update(overrides)
    return body


class Edge(BaseHTTPRequestHandler):
    """Local caller edge fixture: records the exact request sent to the model."""

    payloads = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).payloads.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(COMPLETED)))
        self.end_headers()
        self.wfile.write(COMPLETED)


class CacheScope(unittest.TestCase):
    def setUp(self):
        with jev._cache_affinity_lock:
            jev._cache_affinity.clear()
        with jev._route_lease_lock:
            jev._route_leases.clear()

    def test_same_prompt_cache_key_has_same_private_scope(self):
        first = jev.cache_scope({"prompt_cache_key": "pck-9"}, "one")
        second = jev.cache_scope({"prompt_cache_key": "pck-9"}, "another")
        self.assertEqual(first, second)
        self.assertNotIn("pck-9", first)
        self.assertEqual(len(first), 16)

    def test_different_sessions_do_not_share_scope(self):
        self.assertNotEqual(
            jev.cache_scope({"prompt_cache_key": "pck-a"}, "go"),
            jev.cache_scope({"prompt_cache_key": "pck-b"}, "go"),
        )

    def test_without_a_cache_key_the_bounded_task_is_the_fallback(self):
        self.assertEqual(jev.cache_scope({}, "go"), jev.cache_scope({}, "go"))
        self.assertNotEqual(jev.cache_scope({}, "go"), jev.cache_scope({}, "stop"))

    def test_successful_native_calls_create_bounded_cache_affinity(self):
        payload = payload_for([message("user", "inspect")])
        scope = jev.cache_scope(payload, "inspect")
        jev.remember_cache_model(
            scope, payload, jev.SOL, 200,
            usage={"input_tokens": 1000, "cached_input_tokens": 800},
            effort="high", now=100,
        )
        affinity = jev.cache_affinity(scope, payload, now=101)
        self.assertEqual(affinity, {
            "last_model": "sol",
            "context_k": 1,
            "models": {
                "sol": {"state": "hot", "read_pct": 80.0, "age_s": 1, "effort": "high"},
            },
        })

    def test_affinity_expires_with_the_callers_cache_ttl(self):
        payload = payload_for([message("user", "inspect")])
        payload["prompt_cache_options"]["ttl"] = "10s"
        scope = jev.cache_scope(payload, "inspect")
        jev.remember_cache_model(scope, payload, jev.LUNA, 200, usage={}, now=100)
        self.assertIsNone(jev.cache_affinity(scope, payload, now=111))

    def test_failed_external_or_unscoped_calls_warm_nothing(self):
        payload = payload_for([message("user", "inspect")])
        scope = jev.cache_scope(payload, "inspect")
        jev.remember_cache_model(scope, payload, jev.SOL, 500, now=100)
        jev.remember_cache_model(scope, payload, "deepseek/test", 200, now=100)
        self.assertIsNone(jev.cache_affinity(scope, payload, now=101))
        no_key = payload_for([message("user", "inspect")])
        no_key.pop("prompt_cache_key")
        no_scope = jev.cache_scope(no_key, "inspect")
        jev.remember_cache_model(no_scope, no_key, jev.SOL, 200)
        self.assertIsNone(jev.cache_affinity(no_scope, no_key))

    def test_success_without_usage_is_unknown_and_zero_read_is_only_warming(self):
        payload = payload_for([message("user", "inspect")])
        scope = jev.cache_scope(payload, "inspect")
        jev.remember_cache_model(scope, payload, jev.SOL, 200, usage={}, now=100)
        self.assertEqual(
            jev.cache_affinity(scope, payload, now=101)["models"]["sol"]["state"],
            "unknown",
        )
        jev.remember_cache_model(
            scope, payload, jev.SOL, 200,
            usage={"input_tokens": 2000, "cached_input_tokens": 0}, now=102,
        )
        evidence = jev.cache_affinity(scope, payload, now=103)["models"]["sol"]
        self.assertEqual(evidence["state"], "warming")
        self.assertEqual(evidence["read_pct"], 0.0)

    def test_nested_cache_write_usage_is_allowlisted(self):
        self.assertEqual(
            jev.usage_counts({
                "input_tokens": 100,
                "input_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 20},
            }),
            {
                "input_tokens": 100,
                "cached_input_tokens": 60,
                "cache_write_input_tokens": 20,
            },
        )


class PerCallEndToEnd(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(jev, "local_secret", return_value="fixture-local"))
        Edge.payloads = []
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        for name in ("OFF_PATH", "SHADOW_PATH", "DEBUG_PATH", "SIGNATURE_PATH",
                     "LOG_PATH", "DRY_STATE_PATH", "DRY_MANUAL_PATH"):
            self.enterContext(mock.patch.object(jev, name, os.path.join(tmp, name)))
        self.enterContext(mock.patch.object(jev, "STATE", tmp))
        with jev._cache_affinity_lock:
            jev._cache_affinity.clear()
        with jev._route_lease_lock:
            jev._route_leases.clear()
        self.records = []
        self.logged = threading.Event()

        def record(entry):
            self.records.append(entry)
            self.logged.set()

        self.enterContext(mock.patch.object(jev, "log_line", side_effect=record))
        self.edge = ThreadingHTTPServer(("127.0.0.1", 0), Edge)
        threading.Thread(target=self.edge.serve_forever, daemon=True).start()
        self.saved = (jev.ROUTER, jev.caller_secret, jev.load_key, jev.native_dry)
        jev.ROUTER = ("127.0.0.1", self.edge.server_address[1])
        jev.caller_secret = lambda: "test-caller-secret"
        jev.load_key = lambda: "fixture-key"
        jev.native_dry = lambda: None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), jev.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        (jev.ROUTER, jev.caller_secret, jev.load_key, jev.native_dry) = self.saved
        for server in (self.server, self.edge):
            server.shutdown()
            server.server_close()

    def call(self, payload):
        self.logged.clear()
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_address[1]}/v1/responses",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer fixture-local"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            result = response.status, response.read()
        self.assertTrue(self.logged.wait(3), "wait for the call's log record")
        return result

    def test_each_sub_action_is_decided_and_can_swap_model(self):
        opening = [message("user", "run the tests and fix what breaks")]
        choices = [
            answer(jev.LUNA, "low"),
            answer(jev.SOL, "high"),
            answer(jev.TERRA, "medium"),
            answer(jev.ASTRA, "xhigh"),
        ]
        with mock.patch.object(jev, "call_jev_routed", side_effect=choices) as judge:
            self.call(payload_for(opening))
            for index in range(3):
                history = opening + [tool_call(f"c{index}"), tool_step(f"c{index}", "exit 1")]
                self.call(payload_for(history))
        self.assertEqual(judge.call_count, 4)
        self.assertEqual(
            [p["model"] for p in Edge.payloads],
            [jev.LUNA, jev.SOL, jev.TERRA, jev.ASTRA],
        )
        self.assertEqual([r["routing_scope"] for r in self.records], ["one_call"] * 4)
        self.assertEqual(len({r["cache_scope"] for r in self.records}), 1)

    def test_user_turn_lease_skips_repeat_jev_input_across_clean_tools(self):
        opening = [message("user", "inspect these files and report")]
        with mock.patch.object(
            jev, "call_jev_routed",
            return_value=answer(jev.SOL, "medium", lease="user_turn"),
        ) as judge:
            self.call(payload_for(opening))
            self.call(payload_for(opening + [tool_call("c0"), tool_step("c0", "ok")]))
            self.call(payload_for(
                opening + [tool_call("c1", "read_file"), tool_step("c1", "ok")]
            ))
        self.assertEqual(judge.call_count, 1)
        self.assertEqual(
            [record["decision_source"] for record in self.records],
            ["jev", "lease", "lease"],
        )
        self.assertEqual([payload["model"] for payload in Edge.payloads], [jev.SOL] * 3)

    def test_tool_chain_lease_ends_on_tool_change_and_error(self):
        opening = [message("user", "run the bounded checks")]
        with mock.patch.object(
            jev, "call_jev_routed",
            side_effect=[
                answer(jev.LUNA, "low", lease="tool_chain"),
                answer(jev.SOL, "high"),
                answer(jev.ASTRA, "high"),
            ],
        ) as judge:
            self.call(payload_for(opening))
            self.call(payload_for(opening + [tool_call("c0"), tool_step("c0", "ok")]))
            self.call(payload_for(
                opening + [tool_call("c1", "read_file"), tool_step("c1", "ok")]
            ))
            self.call(payload_for(
                opening + [tool_call("c2", "read_file"), tool_step("c2", "error: failed")]
            ))
        self.assertEqual(judge.call_count, 3)
        self.assertEqual(
            [record["decision_source"] for record in self.records],
            ["jev", "lease", "jev", "jev"],
        )

    def test_leases_end_on_compaction_or_changed_execution_contract(self):
        opening = [message("user", "run the bounded checks")]
        compacted = opening + [
            {"type": "compaction", "encrypted_content": "checkpoint"},
            tool_call("c0"),
            tool_step("c0", "ok"),
        ]
        changed_tools = opening + [tool_call("c1"), tool_step("c1", "ok")]
        with mock.patch.object(
            jev, "call_jev_routed",
            side_effect=[
                answer(jev.SOL, "medium", lease="user_turn"),
                answer(jev.TERRA, "medium", lease="user_turn"),
                answer(jev.LUNA, "low"),
            ],
        ) as judge:
            self.call(payload_for(opening))
            self.call(payload_for(compacted))
            self.call(payload_for(changed_tools, tools=[
                {"type": "function", "name": "exec_command"},
                {"type": "function", "name": "read_file"},
            ]))
        self.assertEqual(judge.call_count, 3)
        self.assertEqual(
            [record["decision_source"] for record in self.records],
            ["jev", "jev", "jev"],
        )

    def test_tool_chain_lease_rejects_a_mixed_result_batch(self):
        opening = [message("user", "run the bounded checks")]
        mixed = opening + [
            tool_call("c0", "exec_command"),
            tool_call("c1", "read_file"),
            tool_step("c0", "ok"),
            tool_step("c1", "ok"),
        ]
        with mock.patch.object(
            jev, "call_jev_routed",
            side_effect=[
                answer(jev.LUNA, "low", lease="tool_chain"),
                answer(jev.SOL, "medium"),
            ],
        ) as judge:
            self.call(payload_for(opening))
            self.call(payload_for(mixed))
        self.assertEqual(judge.call_count, 2)
        self.assertEqual(
            [record["decision_source"] for record in self.records], ["jev", "jev"]
        )

    def test_astra_effort_uses_configuration_update_without_rewriting_base_effort(self):
        history = [message("user", "perform the final security review")]
        sent = payload_for(history, reasoning={"effort": "low"})
        with mock.patch.object(
            jev, "call_jev_routed",
            return_value=answer(jev.ASTRA, "high", astra_required=True),
        ):
            self.call(sent)
        forwarded = Edge.payloads[-1]
        self.assertEqual(forwarded["reasoning"]["effort"], "low")
        self.assertEqual(forwarded["input"][0], {
            "type": "configuration_update", "reasoning": {"effort": "high"},
        })
        self.assertEqual(forwarded["input"][1:], history)
        self.assertEqual(self.records[-1]["effort_transport"], "configuration_update")

    def test_next_decision_sees_successful_models_as_cache_affinity(self):
        opening = [message("user", "implement the bounded change")]
        continuation = opening + [tool_call("c0"), tool_step("c0", "ok")]
        choices = [answer(jev.SOL, "medium"), answer(jev.LUNA, "low")]
        with mock.patch.object(jev, "call_jev_routed", side_effect=choices) as judge:
            self.call(payload_for(opening))
            self.call(payload_for(continuation))
        first_state = judge.call_args_list[0].args[1]
        second_state = judge.call_args_list[1].args[1]
        self.assertNotIn("cache_state", first_state)
        self.assertEqual(second_state["cache_state"]["last_model"], "sol")
        self.assertEqual(second_state["cache_state"]["models"]["sol"]["state"], "hot")
        self.assertEqual(second_state["cache_state"]["models"]["sol"]["read_pct"], 80.0)
        self.assertEqual(self.records[1]["cache_state"]["last_model"], "sol")

    def test_mandatory_review_policy_forces_astra_without_changing_replay(self):
        history = [message("user", "Review this code for security and performance.")]
        sent = payload_for(history)
        with mock.patch.object(
            jev,
            "call_jev_routed",
            return_value=answer(jev.TERRA, "high", astra_required=True),
        ):
            self.call(sent)
        self.assertEqual(Edge.payloads[-1]["model"], jev.ASTRA)
        self.assertEqual(Edge.payloads[-1]["input"], history)
        self.assertEqual(self.records[-1]["gate"], "astra_policy")
        self.assertEqual(self.records[-1]["base_tier"], jev.TERRA)

    def test_checkpoint_then_final_review_then_fix_routes_each_phase(self):
        # Stubbed semantic decisions test wiring, not Jev classification accuracy.
        history = [message("user", "Implement the change, then get an independent final review.")]
        phases = [
            ("Run an in-progress quality checkpoint.", answer(jev.TERRA, "medium")),
            ("Scores look good; independent final review is still required.",
             answer(jev.TERRA, "high", astra_required=True)),
            ("Final review complete. Fix its established finding.",
             answer(jev.SOL, "high")),
        ]
        with mock.patch.object(
            jev, "call_jev_routed", side_effect=[choice for _, choice in phases]
        ) as judge:
            for intent, _ in phases:
                history = history + [message("user", intent)]
                self.call(payload_for(history))
                self.assertEqual(Edge.payloads[-1]["input"], history)
        self.assertEqual(judge.call_count, 3)
        self.assertEqual(
            [p["model"] for p in Edge.payloads], [jev.TERRA, jev.ASTRA, jev.SOL]
        )
        self.assertEqual(
            [r["gate"] for r in self.records], ["apply", "astra_policy", "apply"]
        )

    def test_compaction_gets_a_new_decision_and_full_handoff(self):
        opening = [message("user", "refactor the router tests"),
                   tool_call("c0"), tool_step("c0", "ok")]
        compacted = [message("user", "You are creating a lossy continuation checkpoint"),
                     message("assistant", "checkpoint with all active facts"),
                     message("user", "refactor the router tests")]
        with mock.patch.object(
            jev, "call_jev_routed",
            side_effect=[answer(jev.SOL, "high"), answer(jev.LUNA, "medium")],
        ) as judge:
            self.call(payload_for(opening))
            self.call(payload_for(compacted))
        self.assertEqual(judge.call_count, 2)
        self.assertEqual([p["model"] for p in Edge.payloads], [jev.SOL, jev.LUNA])
        self.assertEqual(Edge.payloads[-1]["input"], compacted)

    def test_compact_projection_never_becomes_execution_context(self):
        history = [
            message("user", "Inspect the original tweet about launch timing."),
            message("assistant", "I will inspect the evidence."),
            tool_call("xmesh-0", "xmesh_inspect"),
            tool_step("xmesh-0", "XMESH historical action result: post 1842 was opened."),
            message("user", "[Earlier history was compacted: keep the tweet and XMESH evidence.]"),
            message("user", "Continue from the existing evidence."),
        ]
        sent = payload_for(history)
        with mock.patch.object(
            jev, "call_jev_routed", return_value=answer(jev.LUNA, "low")
        ) as judge:
            self.call(sent)
        decision_state = judge.call_args.args[1]
        forwarded = Edge.payloads[-1]
        self.assertEqual(forwarded["input"], sent["input"])
        self.assertEqual(forwarded["instructions"], sent["instructions"])
        self.assertEqual(forwarded["tools"], sent["tools"])
        self.assertEqual(decision_state["task"], "Continue from the existing evidence.")
        self.assertEqual(
            decision_state["active_task"],
            "[Earlier history was compacted: keep the tweet and XMESH evidence.]",
        )
        self.assertNotIn("XMESH historical action", json.dumps(decision_state))
        for key in ("task", "active_task", "step", "intent_tail", "tool", "tool_result_tail"):
            self.assertNotIn(key, forwarded)

    def test_cache_controls_and_canonical_replay_survive_model_swaps_unchanged(self):
        cache_key = "stable-private-session-key"
        first = [message("user", "first")]
        second = [message("user", "first"), tool_call("c"), tool_step("c", "done")]
        with mock.patch.object(
            jev, "call_jev_routed",
            side_effect=[answer(jev.LUNA, "low"), answer(jev.SOL, "high")],
        ):
            self.call(payload_for(first, cache_key=cache_key))
            self.call(payload_for(second, cache_key=cache_key))
        self.assertEqual([p["prompt_cache_key"] for p in Edge.payloads], [cache_key, cache_key])
        self.assertEqual(
            [p["prompt_cache_options"] for p in Edge.payloads],
            [{"mode": "implicit", "ttl": "30m"}] * 2,
        )
        self.assertEqual([p["input"] for p in Edge.payloads], [first, second])
        self.assertNotIn(cache_key, json.dumps(self.records))

    def test_completed_web_search_history_survives_a_model_swap(self):
        history = [
            {
                "type": "web_search_call",
                "id": "ws_completed",
                "status": "completed",
                "action": {"type": "search", "query": "router execution contract"},
            },
            message("user", "Summarize the verified result."),
        ]
        sent = payload_for(history)
        sent["tools"] = [{"type": "web_search"}]
        with mock.patch.object(
            jev, "call_jev_routed", return_value=answer(jev.SOL, "medium")
        ):
            self.call(sent)
        self.assertEqual(Edge.payloads[-1]["model"], jev.SOL)
        self.assertEqual(Edge.payloads[-1]["input"], history)
        self.assertEqual(Edge.payloads[-1]["tools"], [{"type": "web_search"}])

    def test_two_threads_route_independently(self):
        with mock.patch.object(jev, "call_jev_routed", return_value=answer(jev.LUNA, "low")):
            self.call(payload_for([message("user", "first thread task")], cache_key="pck-a"))
        with mock.patch.object(jev, "call_jev_routed", return_value=answer(jev.SOL, "high")) as judge:
            self.call(payload_for([message("user", "second thread task")], cache_key="pck-b"))
        judge.assert_called_once()
        self.assertEqual([p["model"] for p in Edge.payloads], [jev.LUNA, jev.SOL])
        self.assertNotEqual(self.records[0]["cache_scope"], self.records[1]["cache_scope"])


if __name__ == "__main__":
    unittest.main()
