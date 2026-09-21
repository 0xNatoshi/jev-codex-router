"""Per-call routing keeps Jev's view compact and the executor's replay complete.

The contract pinned here is:

1. every model call, including tool continuations and post-compaction calls,
   gets a fresh Jev decision;
2. different sub-actions may therefore use different models;
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
    b'"output":[]}}\n\n'
    b'data: [DONE]\n\n'
)


def answer(tier, depth, astra_required=False):
    pair = route_choice(tier, depth, astra_required)
    return {
        "model": "jev-test",
        "answers": {
            "astra_policy": {"choice": pair["astra_policy"], "confidence": 0.3},
            "model": {"choice": pair["model"], "confidence": 0.3},
            "effort": {"choice": pair["effort"], "confidence": 0.3},
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


class PerCallEndToEnd(unittest.TestCase):
    def setUp(self):
        Edge.payloads = []
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        for name in ("OFF_PATH", "SHADOW_PATH", "DEBUG_PATH", "SIGNATURE_PATH",
                     "LOG_PATH", "DRY_STATE_PATH", "DRY_MANUAL_PATH"):
            self.enterContext(mock.patch.object(jev, name, os.path.join(tmp, name)))
        self.enterContext(mock.patch.object(jev, "STATE", tmp))
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
            headers={"Content-Type": "application/json"},
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
            answer(jev.LUNA, "medium"),
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
            [jev.LUNA, jev.SOL, jev.LUNA, jev.ASTRA],
        )
        self.assertEqual([r["routing_scope"] for r in self.records], ["call"] * 4)
        self.assertEqual(len({r["cache_scope"] for r in self.records}), 1)

    def test_mandatory_review_policy_forces_astra_without_changing_replay(self):
        history = [message("user", "Review this code for security and performance.")]
        sent = payload_for(history)
        with mock.patch.object(
            jev,
            "call_jev_routed",
            return_value=answer(jev.LUNA, "high", astra_required=True),
        ):
            self.call(sent)
        self.assertEqual(Edge.payloads[-1]["model"], jev.ASTRA)
        self.assertEqual(Edge.payloads[-1]["input"], history)
        self.assertEqual(self.records[-1]["gate"], "astra_policy")
        self.assertEqual(self.records[-1]["base_tier"], jev.LUNA)

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
