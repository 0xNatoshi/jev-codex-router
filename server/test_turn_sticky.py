"""Turn-scoped sticky routing: one Jev decision per turn, reused by its continuations.

The contract this file pins, in the order the tests read:

1. a decision is taken when a turn opens (a user message);
2. every later call of that turn — tool steps, retries, the call that follows a
   mid-turn compaction — keeps the route, and the turn's own long history never
   triggers a re-decision;
3. a new user ask opens the next turn;
4. the compact projection sent to Jev (task, signals, digest) never becomes the
   execution context: the edge receives the caller's canonical request.

Pure tests cover the turn bookkeeping; the end-to-end class runs the real
handler against a mocked edge and counts decisions, so a routing bug shows up as
a wrong number of Jev calls, not as a diff to read.

    python3 -m unittest discover -s server -p "test_*.py"
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

COMPLETED = (
    b'data: {"type":"response.created","response":{"id":"resp_turn"}}\n\n'
    b'data: {"type":"response.completed","response":{"id":"resp_turn","status":"completed",'
    b'"output":[]}}\n\n'
    b'data: [DONE]\n\n'
)


def answer(tier, depth):
    """What a stubbed Jev returns for a joint (model, effort) decision."""
    return {
        "model": "jev-test",
        "answers": {"route": {"choice": f"{tier}:{depth}", "confidence": 0.3}},
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
        "input": items,
        "tools": [{"type": "function", "name": "exec_command"}],
    }
    body.update(overrides)
    return body


class Edge(BaseHTTPRequestHandler):
    """Stands in for the router's local caller edge: records what it was sent."""

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


class TurnBookkeeping(unittest.TestCase):
    """The rules that decide whether a call opens a turn or continues it."""

    def setUp(self):
        jev.reset_turn_routes()

    tearDown = setUp

    def test_a_user_message_opens_the_turn_and_tool_steps_reuse_it(self):
        scope = "thread-1"
        user = {"step_type": "user_turn"}
        step = {"step_type": "tool_step"}
        self.assertIsNone(jev.turn_route_lookup(scope, "run the tests", user, 6, now=100.0))
        jev.turn_route_remember(scope, "run the tests", {"model": "luna"}, 6, now=100.0)
        held = jev.turn_route_lookup(scope, "run the tests", step, 8, now=110.0)
        self.assertEqual(held["model"], "luna")

    def test_a_tool_step_on_a_long_history_keeps_the_turn_route(self):
        jev.turn_route_remember("thread-1", "ship the fix", {"model": "sol"}, 4, now=0.0)
        held = jev.turn_route_lookup("thread-1", "ship the fix", {"step_type": "tool_step"},
                                     4000, now=30.0)
        self.assertEqual(held["model"], "sol")

    def test_a_new_ask_in_a_grown_thread_opens_a_new_turn(self):
        jev.turn_route_remember("thread-1", "ship the fix", {"model": "sol"}, 4, now=0.0)
        # The answer and the tool traffic made the thread grow: this is the next ask.
        self.assertIsNone(jev.turn_route_lookup(
            "thread-1", "now write the regression test", {"step_type": "user_turn"}, 9, now=30.0))

    def test_a_compaction_mid_turn_keeps_the_route(self):
        jev.turn_route_remember("thread-1", "ship the fix", {"model": "sol"}, 900, now=0.0)
        # Compaction replaces the history with a checkpoint and can rewrite the
        # ask: the input shrank, so the turn is still the same one.
        held = jev.turn_route_lookup("thread-1", "You are creating a continuation checkpoint",
                                     {"step_type": "user_turn"}, 12, now=120.0)
        self.assertEqual(held["model"], "sol")

    def test_the_same_ask_re_delivered_stays_in_the_turn(self):
        jev.turn_route_remember("thread-1", "go", {"model": "astra"}, 5, now=0.0)
        held = jev.turn_route_lookup("thread-1", "go", {"step_type": "user_turn"}, 5, now=20.0)
        self.assertEqual(held["model"], "astra")

    def test_an_expired_turn_is_decided_again(self):
        jev.turn_route_remember("thread-1", "go", {"model": "astra"}, 5, now=0.0)
        self.assertIsNone(jev.turn_route_lookup(
            "thread-1", "go", {"step_type": "tool_step"}, 7, now=jev.TURN_TTL + 1.0))

    def test_threads_do_not_share_a_turn(self):
        jev.turn_route_remember("thread-1", "go", {"model": "astra"}, 5, now=0.0)
        self.assertIsNone(jev.turn_route_lookup("thread-2", "go", {"step_type": "tool_step"}, 5, now=1.0))

    def test_memory_stays_bounded(self):
        for index in range(jev.TURN_MAX + 20):
            jev.turn_route_remember(f"thread-{index}", "go", {"model": "luna"}, 1, now=float(index))
        self.assertLessEqual(len(jev._TURNS), jev.TURN_MAX)

    def test_scope_prefers_the_clients_cache_key(self):
        self.assertEqual(jev.turn_scope({"prompt_cache_key": "pck-9"}, "go"), "pck-9")
        self.assertEqual(
            jev.turn_scope({}, "go"), jev.turn_scope({}, "go"))
        self.assertNotEqual(jev.turn_scope({}, "go"), jev.turn_scope({}, "stop"))


class StickyTurnEndToEnd(unittest.TestCase):
    """The real handler, a mocked edge, and the number of decisions per turn."""

    def setUp(self):
        Edge.payloads = []
        jev.reset_turn_routes()
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
        jev.reset_turn_routes()

    def call(self, payload):
        # The router logs after it answered: wait for that record, or a test
        # would read the turn's telemetry before it exists.
        self.logged.clear()
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_address[1]}/v1/responses",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            result = response.status, response.read()
        self.assertTrue(self.logged.wait(3), "wait for the turn's log record")
        return result

    def decide(self, tier=jev.LUNA, depth="low"):
        """Stub the judge and count how many times the router asks it."""
        return mock.patch.object(jev, "call_jev_routed", return_value=answer(tier, depth))

    def test_a_whole_tool_turn_costs_one_decision_and_one_route(self):
        opening = [message("user", "run the tests and fix what breaks")]
        with self.decide() as judge:
            self.call(payload_for(opening))
            seen = [("user", opening)]
            for index in range(3):
                history = opening + [tool_call(f"c{index}"), tool_step(f"c{index}", "exit 1")]
                payload = payload_for(history)
                self.call(payload)
                seen.append((f"step{index}", history))
        judge.assert_called_once()
        # Every continuation left on the turn's route, and the route is the one
        # the opening decision chose.
        self.assertEqual([p["model"] for p in Edge.payloads], [jev.LUNA] * 4)
        self.assertEqual([r["sticky"] for r in self.records], [False, True, True, True])
        self.assertEqual(len(Edge.payloads), 4)

    def test_the_next_user_ask_opens_exactly_one_new_decision(self):
        opening = [message("user", "run the tests and fix what breaks")]
        with self.decide(jev.SOL, "high") as judge:
            self.call(payload_for(opening))
            continuation = opening + [tool_call("c0"), tool_step("c0", "ok"),
                                      message("assistant", "done"), message("user", "now ship it")]
            self.call(payload_for(continuation))
        self.assertEqual(judge.call_count, 2)
        self.assertEqual([r["sticky"] for r in self.records], [False, False])

    def test_a_compaction_mid_turn_does_not_re_decide(self):
        opening = [message("user", "refactor the router tests")]
        with self.decide(jev.ASTRA, "xhigh") as judge:
            self.call(payload_for(opening + [tool_call("c0"), tool_step("c0", "ok")]))
            compacted = [message("user", "You are creating a lossy continuation checkpoint"),
                         message("assistant", "checkpoint"),
                         message("user", "refactor the router tests")]
            self.call(payload_for(compacted))
        judge.assert_called_once()
        self.assertEqual([p["model"] for p in Edge.payloads], [jev.ASTRA, jev.ASTRA])
        self.assertEqual([r["sticky"] for r in self.records], [False, True])

    def test_the_jev_projection_never_becomes_the_execution_context(self):
        history = [
            message("user", "Inspect the original tweet about launch timing."),
            message("assistant", "I will inspect the evidence."),
            tool_call("xmesh-0", "xmesh_inspect"),
            tool_step("xmesh-0", "XMESH historical action result: post 1842 was opened."),
            message("user", "[Earlier conversation history was compacted: keep the tweet and XMESH evidence.]"),
            message("user", "Continue from the existing evidence."),
        ]
        sent = payload_for(history)
        with self.decide() as judge:
            self.call(sent)
        decision_state = judge.call_args.args[1]
        forwarded = Edge.payloads[-1]
        self.assertEqual(forwarded["input"], sent["input"])
        self.assertEqual(forwarded["instructions"], sent["instructions"])
        self.assertEqual(forwarded["tools"], sent["tools"])
        self.assertEqual(decision_state["task"], "Continue from the existing evidence.")
        self.assertNotIn("original tweet", json.dumps(decision_state))
        self.assertNotIn("XMESH historical action", json.dumps(decision_state))
        # The compact judgement payload (task, signals, step, previous_assistant)
        # is never injected into what the executing model reads.
        for key in ("task", "signals", "step", "previous_assistant"):
            self.assertNotIn(key, forwarded)

    def test_two_threads_route_independently(self):
        with self.decide(jev.LUNA, "low"):
            self.call(payload_for([message("user", "first thread task")], cache_key="pck-a"))
        with self.decide(jev.SOL, "high") as judge:
            self.call(payload_for([message("user", "second thread task")], cache_key="pck-b"))
        judge.assert_called_once()
        self.assertEqual([p["model"] for p in Edge.payloads], [jev.LUNA, jev.SOL])


if __name__ == "__main__":
    unittest.main()
