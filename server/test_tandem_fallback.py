"""End-to-end check of the Codex-dry handoff, with the caller edge mocked.

test_jev_server holds the rules; this holds the wiring. A tandem call that comes
back retryable must be tried once on the sibling model, and when both refuse the
caller must still receive the refusal instead of a request that is never
answered -- the shape a live session hung on after the handoff on 18 September
2026. The edge is mocked, so the test needs neither opencode Go nor an exhausted
chat quota.
"""
import json
import os
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import jev_server as jev
from routing_policy import route_choice

COMPLETED = (
    b'event: response.completed\n'
    b'data: {"type":"response.completed","response":{"id":"resp_mock","output":[],"status":"completed"}}\n\n'
)

# What the caller edge answers a relayed turn with: the stream opened on one id,
# and the terminal event repeats it under a fresh encoding. The Responses
# transform in front of the router refuses that pair, so the relay has to hand it
# one id or the whole turn arrives as an error.
MISMATCHED = (
    b'data: {"type":"response.created","response":{"id":"resp_created"}}\n\n'
    b'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
    b'data: {"type":"response.completed","response":{"id":"resp_re-encoded","output":[]}}\n\n'
    b'data: [DONE]\n\n'
)


def jev_answer(tier, depth, confidence, lease="one_call"):
    pair = route_choice(tier, depth, lease=lease)
    return {"answers": {
        "astra_policy": {"choice": pair["astra_policy"], "confidence": confidence},
        "model": {"choice": pair["model"], "confidence": confidence},
        "effort": {"choice": pair["effort"], "confidence": confidence},
        "lease": {"choice": pair["lease"], "confidence": confidence},
    }}


class Edge(BaseHTTPRequestHandler):
    """Stands in for the router's local caller edge."""

    attempts = []
    payloads = []
    refuse = ()
    body = COMPLETED
    reset_at = 0
    refuse_status = 429

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).payloads.append(body)
        model = body.get("model")
        type(self).attempts.append((model, (body.get("reasoning") or {}).get("effort")))
        if model in type(self).refuse:
            # The shape the edge answers an exhausted allowance with: a JSON error
            # whose text matches the quota detector, and no content type that
            # would make the relay treat it as a stream.
            message = ("rate limit reached for this model" if self.refuse_status == 429
                       else "temporarily unavailable")
            data = json.dumps({"error": {"message": message}}).encode()
            self.send_response(self.refuse_status)
            self.send_header("Content-Type", "application/json")
            if type(self).reset_at:
                self.send_header("x-codex-primary-reset-at", str(int(type(self).reset_at)))
        else:
            data = type(self).body
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class TandemHandoff(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(jev, "local_secret", return_value="fixture-local"))
        Edge.attempts = []
        Edge.payloads = []
        Edge.refuse = ()
        Edge.body = COMPLETED
        Edge.reset_at = 0
        Edge.refuse_status = 429
        # Tests must not read the installed sentinels, write the live decision
        # log, or depend on the user's current fallback model configuration.
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        for name in ("OFF_PATH", "SHADOW_PATH", "DEBUG_PATH", "SIGNATURE_PATH",
                     "LOG_PATH", "DRY_STATE_PATH", "DRY_MANUAL_PATH"):
            self.enterContext(mock.patch.object(jev, name, os.path.join(tmp, name)))
        self.enterContext(mock.patch.object(jev, "STATE", tmp))
        self.enterContext(mock.patch.object(jev, "GO_STANDARD", "fixture/standard"))
        self.enterContext(mock.patch.object(jev, "GO_FRONTIER", "fixture/frontier"))
        self.enterContext(mock.patch.object(jev, "GO_TANDEM",
                                          ("fixture/standard", "fixture/frontier")))
        self.logged = threading.Event()
        original_log = jev.log_line

        def record(entry):
            original_log(entry)
            self.logged.set()

        self.enterContext(mock.patch.object(jev, "log_line", side_effect=record))
        self.edge = ThreadingHTTPServer(("127.0.0.1", 0), Edge)
        threading.Thread(target=self.edge.serve_forever, daemon=True).start()
        # Keep the decision local: no Jev call (so no API key), dry mode on.
        self.saved = (jev.ROUTER, jev.caller_secret, jev.load_key, jev.native_dry)
        jev.ROUTER = ("127.0.0.1", self.edge.server_address[1])
        jev.caller_secret = lambda: "test-caller-secret"
        jev.load_key = lambda: ""
        jev.native_dry = lambda: "manual"
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), jev.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        (jev.ROUTER, jev.caller_secret, jev.load_key, jev.native_dry) = self.saved
        for server in (self.server, self.edge):
            server.shutdown()
            server.server_close()

    def call(self, stream=False, **overrides):
        self.logged.clear()
        payload = {
            "model": "auto",
            "stream": stream,
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "say OK"}],
            }],
        }
        payload.update(overrides)
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_address[1]}/v1/responses",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer fixture-local"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = response.status, response.read()
        except urllib.error.HTTPError as error:
            body = error.read()
            error.close()
            result = error.code, body
        self.assertTrue(self.logged.wait(2), "wait for post-response state and telemetry")
        return result

    def raw_post(self, content_length=None, transfer_encoding=None, body=b"{}"):
        """Send framing that urllib.request intentionally normalises for us."""
        connection = socket.create_connection(
            ("127.0.0.1", self.server.server_address[1]), timeout=10
        )
        try:
            headers = [
                b"POST /v1/responses HTTP/1.1",
                b"Host: localhost",
                b"Authorization: Bearer fixture-local",
                b"Content-Type: application/json",
            ]
            if content_length is not None:
                headers.append(f"Content-Length: {content_length}".encode())
            if transfer_encoding is not None:
                headers.append(f"Transfer-Encoding: {transfer_encoding}".encode())
            connection.sendall(b"\r\n".join(headers) + b"\r\n\r\n" + body)
            answer = b""
            while True:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                answer += chunk
        finally:
            connection.close()
        head, _, response_body = answer.partition(b"\r\n\r\n")
        status = int(head.splitlines()[0].split()[1])
        return status, response_body

    def test_rejects_an_oversized_response_body_before_forwarding(self):
        status, body = self.raw_post(content_length=jev.RESPONSE_MAX_BYTES + 1)
        self.assertEqual(status, 413)
        self.assertIn(b"too large", body)
        self.assertEqual(Edge.attempts, [])

    def test_rejects_an_invalid_response_content_length(self):
        status, body = self.raw_post(content_length="not-a-number")
        self.assertEqual(status, 400)
        self.assertIn(b"invalid Content-Length", body)
        self.assertEqual(Edge.attempts, [])

    def test_rejects_a_response_without_content_length(self):
        status, body = self.raw_post()
        self.assertEqual(status, 400)
        self.assertIn(b"one Content-Length required", body)
        self.assertEqual(Edge.attempts, [])

    def test_rejects_chunked_response_bodies(self):
        status, body = self.raw_post(transfer_encoding="chunked", body=b"0\r\n\r\n")
        self.assertEqual(status, 400)
        self.assertIn(b"one Content-Length required", body)
        self.assertEqual(Edge.attempts, [])

    def test_a_refused_tandem_call_is_retried_on_the_sibling(self):
        Edge.refuse = (jev.GO_FRONTIER,)
        canonical = [
            {"type": "message", "role": "user", "content": "Original evidence."},
            {"type": "function_call", "call_id": "xmesh", "name": "xmesh_inspect",
             "arguments": "{}"},
            {"type": "function_call_output", "call_id": "xmesh", "output": "full result"},
            {"type": "message", "role": "user", "content": "Continue"},
        ]
        status, body = self.call(service_tier="priority", input=canonical)
        self.assertEqual(status, 200, body)
        self.assertEqual(
            [model for model, _effort in Edge.attempts],
            [jev.GO_FRONTIER, jev.GO_STANDARD],
        )
        self.assertEqual([payload["input"] for payload in Edge.payloads],
                         [canonical, canonical])
        # The depth survives the switch, and both attempts carry a rung the Go
        # models declare.
        self.assertEqual({effort for _model, effort in Edge.attempts}, {"high"})
        self.assertEqual([p["service_tier"] for p in Edge.payloads],
                         ["default", "default"])

    def test_nonquota_service_failure_is_held_before_retry(self):
        Edge.refuse = (jev.GO_FRONTIER,)
        Edge.refuse_status = 503
        for stream in (False, True):
            with self.subTest(stream=stream):
                status, body = self.call(stream=stream)
                self.assertEqual(status, 200, body)
                self.assertNotIn(b"temporarily unavailable", body)
                self.assertIn(b"completed", body)

    def test_single_fallback_does_not_retry_itself(self):
        Edge.refuse = (jev.GO_FRONTIER,)
        Edge.refuse_status = 503
        with mock.patch.object(jev, "GO_TANDEM", (jev.GO_FRONTIER,)):
            status, _ = self.call()
        self.assertEqual(status, 503)
        self.assertEqual(len(Edge.attempts), 1)

    def test_incomplete_and_failed_nonstream_responses_keep_their_contract(self):
        for terminal in ("incomplete", "failed"):
            with self.subTest(terminal=terminal):
                response = {"id": "r", "status": terminal, "output": [],
                            "incomplete_details": {"reason": "max_output_tokens"}}
                Edge.body = ("data: " + json.dumps(
                    {"type": "response." + terminal, "response": response}) + "\n\n").encode()
                status, body = self.call()
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), response)

    def test_nonstream_truncated_stream_becomes_explicit_error(self):
        Edge.body = b'data: {"type":"response.created","response":{"id":"r"}}\n\n'
        status, body = self.call()
        self.assertEqual(status, 502)
        self.assertIn("error", json.loads(body))

    def test_structured_outputs_never_receive_a_display_header(self):
        with open(jev.SIGNATURE_PATH, "w"):
            pass
        item = {"type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": '{"ok":true}'}]}
        Edge.body = ("data: " + json.dumps({"type": "response.completed",
                     "response": {"id": "r", "status": "completed", "output": [item]}})
                     + "\n\n").encode()
        status, body = self.call(text={"format": {"type": "json_schema", "name": "fixture"}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(json.loads(body)["output"][0]["content"][0]["text"]),
                         {"ok": True})

    def test_native_calls_replace_client_fast_and_max_with_the_jev_decision(self):
        jev.native_dry = lambda: None
        jev.load_key = lambda: "fixture-key"
        for tier, depth, client_speed in ((jev.LUNA, "low", "priority"),
                                         (jev.TERRA, "high", "priority"),
                                         (jev.LUNA, "medium", "fast"),
                                         (jev.SOL, "high", "priority"),
                                         (jev.ASTRA, "xhigh", "fast")):
            with self.subTest(tier=tier, depth=depth), mock.patch.object(
                jev, "call_jev_routed", return_value=jev_answer(tier, depth, 0.1)
            ):
                status, body = self.call(service_tier=client_speed,
                                         reasoning={"effort": "max", "summary": "auto"},
                                         input=[{
                                             "type": "message",
                                             "role": "user",
                                             "content": [{"type": "input_text",
                                                          "text": f"say OK ({tier}:{depth})"}],
                                         }])
                self.assertEqual(status, 200, body)
                sent = Edge.payloads[-1]
                self.assertEqual(sent["model"], tier)
                if tier == jev.ASTRA:
                    self.assertEqual(sent["reasoning"], {
                        "effort": "max", "summary": "auto"
                    })
                    self.assertEqual(sent["input"][0], {
                        "type": "configuration_update",
                        "reasoning": {"effort": depth},
                    })
                else:
                    self.assertEqual(sent["reasoning"], {
                        "effort": depth, "summary": "auto"
                    })
                self.assertEqual(sent["service_tier"], "default")
                self.assertTrue(sent["stream"])

    def test_kill_switch_and_shadow_do_not_inherit_fast(self):
        jev.native_dry = lambda: None
        for flag in (jev.OFF_PATH, jev.SHADOW_PATH):
            with self.subTest(flag=os.path.basename(flag)):
                with open(flag, "w"):
                    pass
                try:
                    status, body = self.call(service_tier="priority")
                    self.assertEqual(status, 200, body)
                    self.assertEqual(Edge.payloads[-1]["service_tier"], "default")
                finally:
                    os.unlink(flag)

    def test_compaction_is_judged_instead_of_pinned_to_sol_high(self):
        jev.native_dry = lambda: None
        jev.load_key = lambda: "fixture-key"
        with mock.patch.object(
            jev,
            "call_jev_routed",
            return_value=jev_answer(jev.ASTRA, "low", 0.2),
        ) as judge:
            status, body = self.call(input="You are creating a lossy continuation checkpoint")
        self.assertEqual(status, 200, body)
        judge.assert_called_once()
        self.assertEqual(Edge.attempts[-1], (jev.ASTRA, "low"))

    def test_usage_is_logged_for_streaming_and_nonstreaming_calls(self):
        Edge.body = (
            b'data: {"type":"response.completed","response":{"id":"r","status":"completed",'
            b'"output":[],"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},'
            b'"output_tokens":20,"output_tokens_details":{"reasoning_tokens":15}}}}\n\n'
        )
        logged = threading.Event()
        original_log = jev.log_line

        def capture(record):
            original_log(record)
            logged.set()

        with mock.patch.object(jev, "log_line", side_effect=capture):
            for stream in (True, False):
                with self.subTest(stream=stream):
                    logged.clear()
                    status, body = self.call(stream=stream)
                    self.assertEqual(status, 200, body)
                    self.assertTrue(logged.wait(2), "logging follows the terminal response")
                    with open(jev.LOG_PATH) as handle:
                        record = json.loads(handle.readlines()[-1])
                    self.assertEqual(len(record["attempts"]), 1)
                    attempt = record["attempts"][0]
                    self.assertEqual(attempt["terminal_type"], "response.completed")
                    self.assertEqual(attempt["usage"]["cached_input_tokens"], 80)
                    self.assertEqual(attempt["usage"]["reasoning_tokens"], 15)

    def test_both_models_refusing_still_answers_the_caller(self):
        Edge.refuse = (jev.GO_FRONTIER, jev.GO_STANDARD)
        status, body = self.call()
        self.assertEqual(status, 429)
        self.assertIn(b"rate limit", body)
        self.assertEqual(len(Edge.attempts), 2, "one try per tandem model, no loop")

    def test_header_covers_streaming_nonstreaming_and_strips_replayed_metadata(self):
        with open(jev.SIGNATURE_PATH, "w"):
            pass
        item = {"id": "msg", "type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "OK"}]}
        Edge.body = b"".join(("data: " + json.dumps(event) + "\n\n").encode() for event in [
            {"type": "response.output_item.added", "item": dict(item, content=[])},
            {"type": "response.output_text.delta", "item_id": "msg", "content_index": 0, "delta": "OK"},
            {"type": "response.completed",
             "response": {"id": "r", "status": "completed", "output": [item]}},
        ])
        header = jev.answer_signature({"model": jev.GO_FRONTIER, "effort": "high"})
        for stream in (True, False):
            status, body = self.call(stream=stream, input=[
                {"role": "assistant", "content": header + "Previous reply"},
                {"role": "user", "content": "Continue"},
            ])
            self.assertEqual(status, 200)
            self.assertEqual(Edge.payloads[-1]["input"][0]["content"], "Previous reply")
            if stream:
                events = [json.loads(line[6:]) for line in body.decode().splitlines()
                          if line.startswith("data: ")]
                text = "".join(e["delta"] for e in events if e["type"] == "response.output_text.delta")
                self.assertEqual(text, header + "OK")
                response = events[-1]["response"]
            else:
                response = json.loads(body)
            self.assertEqual(response["output"][0]["content"][0]["text"], header + "OK")
        # Shadow mode serves Astra while Jev proposes Luna; the header must
        # describe the actual response, not the hypothetical choice.
        with open(jev.SHADOW_PATH, "w"):
            pass
        jev.native_dry = lambda: None
        jev.load_key = lambda: "fixture-key"
        with mock.patch.object(
            jev,
            "call_jev_routed",
            return_value=jev_answer(jev.LUNA, "low", 0.9),
        ):
            status, body = self.call(reasoning={"effort": "high"})
        self.assertEqual(status, 200)
        actual = jev.answer_signature({"model": jev.ASTRA, "effort": "high"})
        self.assertEqual(json.loads(body)["output"][0]["content"][0]["text"], actual + "OK")

    def test_a_relayed_stream_repeats_the_id_it_opened_on(self):
        # The edge re-encodes the id of the terminal event. Handing the caller
        # that pair is what the Responses transform in front of the router turns
        # into an `invalid_responses_stream` error, so the relay keeps the id the
        # stream opened on.
        Edge.body = MISMATCHED
        status, body = self.call(stream=True)
        self.assertEqual(status, 200, body)
        ids = []
        for line in body.decode().splitlines():
            if not line.startswith("data: ") or line[6:].strip() == "[DONE]":
                continue
            response = json.loads(line[6:]).get("response")
            if isinstance(response, dict) and "id" in response:
                ids.append(response["id"])
        self.assertEqual(ids, ["resp_created", "resp_created"])
        self.assertIn(b"data: [DONE]", body)

    def test_an_expired_flip_is_served_natively_and_the_state_is_dropped(self):
        # The window reopened: the first call after it probes the triptych again
        # (not the tandem), is served there, and the stale auto state goes away.
        with tempfile.TemporaryDirectory() as tmp:
            state = os.path.join(tmp, "dry.json")
            saved = (jev.native_dry, jev.DRY_STATE_PATH, jev.DRY_MANUAL_PATH)
            jev.native_dry = self.saved[3]  # the real reader, over the temp paths
            jev.DRY_STATE_PATH = state
            jev.DRY_MANUAL_PATH = os.path.join(tmp, "flag")
            with open(state, "w", encoding="utf-8") as fh:
                json.dump({"reason": "quota", "at": "earlier", "until": time.time() - 1}, fh)
            try:
                status, body = self.call()
                self.assertEqual(status, 200, body)
                self.assertEqual([model for model, _ in Edge.attempts], [jev.ASTRA])
                self.assertFalse(os.path.exists(state), "the stale flip must be dropped")
            finally:
                jev.native_dry, jev.DRY_STATE_PATH, jev.DRY_MANUAL_PATH = saved

    def test_a_quota_flip_lasts_until_the_edge_says_the_window_reopens(self):
        # The first attempt is a native tier (no Jev key in this harness), the
        # edge refuses it with the reset instant, and the flip must record that
        # instant: the next call after the quota returns goes back to the
        # triptych instead of serving the tandem on a window that already
        # reopened.
        with tempfile.TemporaryDirectory() as tmp:
            state = os.path.join(tmp, "dry.json")
            saved = (jev.native_dry, jev.DRY_STATE_PATH, jev.DRY_MANUAL_PATH)
            jev.native_dry = lambda: None
            jev.DRY_STATE_PATH = state
            jev.DRY_MANUAL_PATH = os.path.join(tmp, "flag")
            try:
                Edge.refuse = (jev.ASTRA,)
                Edge.reset_at = time.time() + 1800
                status, body = self.call(reasoning={"effort": "max"})
                self.assertEqual(status, 200, body)
                self.assertEqual([model for model, _ in Edge.attempts], [jev.ASTRA, jev.GO_FRONTIER])
                self.assertEqual(
                    Edge.payloads[0]["input"][0].get("type"), "configuration_update"
                )
                self.assertFalse(any(
                    item.get("type") == "configuration_update"
                    for item in Edge.payloads[1]["input"]
                    if isinstance(item, dict)
                ))
                with open(state, encoding="utf-8") as fh:
                    flipped = json.load(fh)
                self.assertAlmostEqual(
                    flipped["until"], Edge.reset_at + jev.DRY_RESET_SKEW_S, delta=2
                )
            finally:
                jev.native_dry, jev.DRY_STATE_PATH, jev.DRY_MANUAL_PATH = saved


if __name__ == "__main__":
    unittest.main()
