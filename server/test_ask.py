"""Tests for the POST /ask pass-through (no network, no TypeSafe credits spent).

    python3 -m unittest discover -s server -p "test_*.py"
"""
import json
import socket
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import jev_server  # noqa: E402


def choice_question(criteria):
    return {
        "type": "choice",
        "instructions": "Which element advances the goal?",
        "criteria": criteria,
    }


class ValidateAskTests(unittest.TestCase):
    def test_accepts_a_choice_and_a_noul_question(self):
        body = {
            "state": {"goal": "log in", "candidates": [{"id": "e1"}]},
            "questions": {
                "next": choice_question({"e1": "button Sign in"}),
                "on_page": {"type": "noul", "instructions": "Is the target offered?"},
            },
        }
        state, questions, error = jev_server.validate_ask(body)
        self.assertIsNone(error)
        self.assertEqual(state, body["state"])
        self.assertEqual(set(questions), {"next", "on_page"})

    def test_accepts_a_plain_string_state(self):
        _, _, error = jev_server.validate_ask(
            {"state": "some text", "questions": {"q": {"type": "noul", "instructions": "yes?"}}}
        )
        self.assertIsNone(error)

    def test_rejects_malformed_bodies(self):
        cases = {
            "not an object": ["nope"],
            "missing state": {"questions": {"q": {"type": "noul", "instructions": "x"}}},
            "bad state type": {"state": 42, "questions": {"q": {"type": "noul", "instructions": "x"}}},
            "no questions": {"state": "s", "questions": {}},
            "questions not a map": {"state": "s", "questions": ["q"]},
            "unsupported type": {
                "state": "s",
                "questions": {"q": {"type": "likert", "instructions": "x"}},
            },
            "missing instructions": {"state": "s", "questions": {"q": {"type": "noul"}}},
            "choice without criteria": {
                "state": "s",
                "questions": {"q": {"type": "choice", "instructions": "x"}},
            },
            "choice with empty criteria": {"state": "s", "questions": {"q": choice_question({})}},
            "score with map criteria": {
                "state": "s",
                "questions": {"q": {"type": "score", "instructions": "x", "criteria": {"a": 1}}},
            },
            "empty question name": {
                "state": "s",
                "questions": {"": {"type": "noul", "instructions": "x"}},
            },
        }
        for label, body in cases.items():
            with self.subTest(label):
                _, _, error = jev_server.validate_ask(body)
                self.assertIsNotNone(error, f"{label} should be rejected")

    def test_rejects_a_state_over_the_cap(self):
        _, _, error = jev_server.validate_ask({
            "state": "x" * (jev_server.ASK_MAX_STATE_CHARS + 1),
            "questions": {"q": {"type": "noul", "instructions": "x"}},
        })
        self.assertIn("too large", error)

    def test_rejects_too_many_questions(self):
        questions = {
            f"q{i}": {"type": "noul", "instructions": "x"}
            for i in range(jev_server.ASK_MAX_QUESTIONS + 1)
        }
        _, _, error = jev_server.validate_ask({"state": "s", "questions": questions})
        self.assertIn("too many questions", error)

    def test_rejects_a_state_that_is_not_json_serialisable(self):
        _, _, error = jev_server.validate_ask({
            "state": {"tags": {"a", "b"}},
            "questions": {"q": {"type": "noul", "instructions": "x"}},
        })
        self.assertIn("not JSON-serialisable", error)


class AskEndpointTests(unittest.TestCase):
    """Drives the real handler over loopback with a stubbed Jev call."""

    def setUp(self):
        self.enterContext(mock.patch.object(jev_server, "local_secret", return_value="fixture-local"))

    @classmethod
    def setUpClass(cls):
        cls.server = jev_server.ThreadingHTTPServer(("127.0.0.1", 0), jev_server.Handler)
        cls.server.daemon_threads = True
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body, path="/ask"):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer fixture-local"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode())

    def failed_post(self, body):
        """POST expecting an error; returns (status, payload) with the body closed."""
        try:
            self.post(body)
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read())
            finally:
                error.close()
        self.fail("expected an HTTP error")

    def test_forwards_the_callers_questions_and_returns_the_answers(self):
        body = {
            "state": {"goal": "reach the docs"},
            "questions": {"next": choice_question({"e7": "link Documentation"})},
        }
        seen = {}

        def fake_call_jev(key, state, questions, timeout=None):
            seen.update(key=key, state=state, questions=questions)
            return {
                "model": "jev-1.13.0",
                "answers": {"next": {"type": "choice", "choice": "e7", "confidence": 0.9}},
                "usage": {"input_tokens": 120, "output_tokens": 3},
            }

        with mock.patch.object(jev_server, "load_key", return_value="test-key"), \
             mock.patch.object(jev_server, "call_jev_routed", side_effect=fake_call_jev):
            status, payload = self.post(body)

        self.assertEqual(status, 200)
        self.assertEqual(payload["answers"]["next"]["choice"], "e7")
        self.assertEqual(payload["usage"]["input_tokens"], 120)
        self.assertIn("ms", payload)
        self.assertEqual(seen["key"], "test-key")
        self.assertEqual(seen["state"], body["state"])
        self.assertEqual(seen["questions"], body["questions"])

    def test_serves_both_the_plain_and_versioned_path(self):
        with mock.patch.object(jev_server, "load_key", return_value="k"), \
             mock.patch.object(jev_server, "call_jev_routed", return_value={"answers": {}}):
            for path in ("/ask", "/v1/ask"):
                with self.subTest(path):
                    status, _ = self.post(
                        {"state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}},
                        path=path,
                    )
                    self.assertEqual(status, 200)

    def test_missing_local_auth_never_reaches_the_provider(self):
        with mock.patch.object(jev_server, "call_jev_routed") as provider:
            request = urllib.request.Request(
                f"http://127.0.0.1:{self.port}/ask", data=b'{}',
                headers={"Content-Type": "application/json"})
            try:
                urllib.request.urlopen(request, timeout=5)
            except urllib.error.HTTPError as error:
                self.assertEqual(error.code, 401)
                error.close()
            else:
                self.fail("authentication required")
            provider.assert_not_called()

    def test_rejects_a_malformed_body_with_400(self):
        status, payload = self.failed_post({"state": "s", "questions": {}})
        self.assertEqual(status, 400)
        self.assertIn("questions", payload["error"]["message"])

    def test_answers_503_when_no_key_is_configured(self):
        with mock.patch.object(jev_server, "load_key", return_value=""):
            status, _ = self.failed_post(
                {"state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}}
            )
        self.assertEqual(status, 503)

    def test_answers_502_when_jev_fails(self):
        with mock.patch.object(jev_server, "load_key", return_value="k"), \
             mock.patch.object(jev_server, "call_jev_routed", side_effect=RuntimeError("boom")):
            status, payload = self.failed_post(
                {"state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}}
            )
        self.assertEqual(status, 502)
        self.assertIn("unavailable", payload["error"]["message"])

    def test_refuses_an_oversized_body_without_reading_it(self):
        connection = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        try:
            connection.sendall(
                b"POST /ask HTTP/1.1\r\nHost: localhost\r\n"
                b"Authorization: Bearer fixture-local\r\n"
                b"Content-Length: 999999999\r\n\r\n"
            )
            # The refusal can arrive split across segments, and the server closes
            # the connection right after it: read the header block, then the body
            # its Content-Length announces, instead of trusting one recv.
            answer = b""
            while b"\r\n\r\n" not in answer:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                answer += chunk
            head, _, body = answer.partition(b"\r\n\r\n")
            declared = [
                line.split(b": ", 1)[1]
                for line in head.split(b"\r\n")
                if line.lower().startswith(b"content-length: ")
            ]
            wanted = int(declared[0]) if declared else 0
            while len(body) < wanted:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                body += chunk
        finally:
            connection.close()
        self.assertIn(b" 413 ", head)
        self.assertIn(b"too large", body)


if __name__ == "__main__":
    unittest.main()
