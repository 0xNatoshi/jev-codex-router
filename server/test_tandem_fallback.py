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
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jev_server as jev

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


class Edge(BaseHTTPRequestHandler):
    """Stands in for the router's local caller edge."""

    attempts = []
    refuse = ()
    body = COMPLETED
    reset_at = 0

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        model = body.get("model")
        type(self).attempts.append((model, (body.get("reasoning") or {}).get("effort")))
        if model in type(self).refuse:
            # The shape the edge answers an exhausted allowance with: a JSON error
            # whose text matches the quota detector, and no content type that
            # would make the relay treat it as a stream.
            data = json.dumps({"error": {"message": "rate limit reached for this model"}}).encode()
            self.send_response(429)
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
        Edge.attempts = []
        Edge.refuse = ()
        Edge.body = COMPLETED
        Edge.reset_at = 0
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

    def call(self, stream=False):
        payload = {
            "model": "auto",
            "stream": stream,
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "say OK"}],
            }],
        }
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_address[1]}/v1/responses",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            body = error.read()
            error.close()
            return error.code, body

    def test_a_refused_tandem_call_is_retried_on_the_sibling(self):
        Edge.refuse = (jev.GO_FRONTIER,)
        status, body = self.call()
        self.assertEqual(status, 200, body)
        self.assertEqual(
            [model for model, _effort in Edge.attempts],
            [jev.GO_FRONTIER, jev.GO_STANDARD],
        )
        # The depth survives the switch, and both attempts carry a rung the Go
        # models declare.
        self.assertEqual({effort for _model, effort in Edge.attempts}, {"high"})

    def test_both_models_refusing_still_answers_the_caller(self):
        Edge.refuse = (jev.GO_FRONTIER, jev.GO_STANDARD)
        status, body = self.call()
        self.assertEqual(status, 429)
        self.assertIn(b"rate limit", body)
        self.assertEqual(len(Edge.attempts), 2, "one try per tandem model, no loop")

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
                status, body = self.call()
                self.assertEqual(status, 200, body)
                self.assertEqual([model for model, _ in Edge.attempts], [jev.ASTRA, jev.GO_FRONTIER])
                with open(state, encoding="utf-8") as fh:
                    flipped = json.load(fh)
                self.assertAlmostEqual(
                    flipped["until"], Edge.reset_at + jev.DRY_RESET_SKEW_S, delta=2
                )
            finally:
                jev.native_dry, jev.DRY_STATE_PATH, jev.DRY_MANUAL_PATH = saved


if __name__ == "__main__":
    unittest.main()
