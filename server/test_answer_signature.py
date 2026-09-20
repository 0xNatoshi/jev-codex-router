"""The served model/effort heads every assistant message and never re-enters input."""
import json
import unittest
from unittest import mock

import jev_server as jev


class AnswerHeader(unittest.TestCase):
    HEADER = "**🧠 sol · thinking: low**\n\n"
    TAG = " · 🧠 sol:low · "
    LEGACY = "\n\n— 🧠 sol · low"

    @staticmethod
    def frame(event):
        return ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode()

    @staticmethod
    def events(stream):
        return [json.loads(line[6:]) for line in stream.splitlines()
                if line.startswith("data: ") and line[6:].strip() != "[DONE]"]

    def relay(self, frames, header=HEADER):
        marker = jev.SummaryMarker(self.TAG, header)
        return "".join(marker.feed(frame) for frame in frames) + marker.flush()

    def message(self, item_id, text, phase=None):
        item = {"id": item_id, "type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": text}]}
        if phase:
            item["phase"] = phase
        return item

    def turn(self, phase="final_answer", text="Bonjour à toi."):
        item = self.message("msg", text, phase)
        return [self.frame(event) for event in [
            {"type": "response.created", "response": {"id": "response"}},
            {"type": "response.output_item.added", "item": dict(item, content=[])},
            {"type": "response.content_part.added", "item_id": "msg", "content_index": 0,
             "part": {"type": "output_text", "text": ""}},
            {"type": "response.output_text.delta", "item_id": "msg", "content_index": 0,
             "delta": text[:3]},
            {"type": "response.output_text.delta", "item_id": "msg", "content_index": 0,
             "delta": text[3:]},
            {"type": "response.output_text.done", "item_id": "msg", "content_index": 0,
             "text": text},
            {"type": "response.content_part.done", "item_id": "msg", "content_index": 0,
             "part": {"type": "output_text", "text": text}},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": {"id": "response", "output": [item]}},
        ]]

    def assert_representations(self, stream, expected):
        events = self.events(stream)
        deltas = "".join(e["delta"] for e in events if e["type"] == "response.output_text.delta")
        self.assertEqual(deltas, expected)
        for event in events:
            kind = event["type"]
            if kind == "response.output_text.done":
                self.assertEqual(event["text"], expected)
            elif kind == "response.content_part.done":
                self.assertEqual(event["part"]["text"], expected)
            elif kind == "response.output_item.done":
                self.assertEqual(event["item"]["content"][0]["text"], expected)
            elif kind == "response.completed":
                self.assertEqual(event["response"]["output"][0]["content"][0]["text"], expected)

    def test_header_is_consistent_for_final_commentary_and_unphased_messages(self):
        for phase in ("final_answer", "commentary", None):
            with self.subTest(phase=phase):
                self.assert_representations(self.relay(self.turn(phase)), self.HEADER + "Bonjour à toi.")

    def test_first_delta_contains_the_header_without_waiting_for_done(self):
        marker = jev.SummaryMarker(self.TAG, self.HEADER)
        for frame in self.turn()[:3]:
            marker.feed(frame)
        emitted = self.events(marker.feed(self.turn()[3]))
        self.assertEqual(emitted[0]["delta"], self.HEADER + "Bon")

    def test_native_empty_terminal_output_reconstructs_the_same_headed_message(self):
        frames = self.turn()
        frames[-1] = self.frame({
            "type": "response.completed", "response": {"id": "response", "output": []},
        })
        stream = self.relay(frames)
        events = self.events(stream)
        text = "".join(e["delta"] for e in events if e["type"] == "response.output_text.delta")
        self.assertEqual(text, self.HEADER + "Bonjour à toi.")
        response = jev.assemble_sse(stream.encode())
        self.assertEqual(response["output"][0]["content"][0]["text"], text)

    def test_fragmented_utf8_stream_keeps_the_same_header_and_content(self):
        raw = b"".join(self.turn())
        chunks = [raw[i:i + 7] for i in range(0, len(raw), 7)]
        self.assert_representations(self.relay(chunks), self.HEADER + "Bonjour à toi.")

    def test_empty_output_and_disabled_display_are_unchanged(self):
        self.assert_representations(self.relay(self.turn(text="")), "")
        self.assert_representations(self.relay(self.turn(), header=None), "Bonjour à toi.")

    def test_header_is_only_on_the_first_text_part(self):
        parts = [{"type": "output_text", "text": ""},
                 {"type": "output_text", "text": "first"},
                 {"type": "output_text", "text": "second"}]
        item = self.message("msg", "")
        item["content"] = parts
        frames = [self.frame({"type": "response.output_text.delta", "item_id": "msg",
                             "content_index": i, "delta": p["text"]}) for i, p in enumerate(parts)]
        frames.append(self.frame({"type": "response.completed", "response": {"output": [item]}}))
        events = self.events(self.relay(frames))
        self.assertEqual([e["delta"] for e in events[:-1]], ["", self.HEADER + "first", "second"])
        self.assertEqual([p["text"] for p in events[-1]["response"]["output"][0]["content"]],
                         ["", self.HEADER + "first", "second"])

    def test_interleaved_messages_each_get_one_header(self):
        frames = [self.frame({"type": "response.output_text.delta", "item_id": item,
                             "content_index": 0, "delta": text})
                  for item, text in (("a", "one"), ("b", "two"), ("a", " more"))]
        events = self.events(self.relay(frames))
        self.assertEqual([e["delta"] for e in events],
                         [self.HEADER + "one", self.HEADER + "two", " more"])

    def test_complete_item_is_not_prefixed_twice(self):
        item = self.message("msg", self.HEADER + "hello", "commentary")
        stream = self.relay([self.frame({"type": "response.output_item.done", "item": item})])
        self.assertEqual(self.events(stream)[0]["item"]["content"][0]["text"], self.HEADER + "hello")

    def test_tool_arguments_are_untouched_and_reasoning_retains_its_own_tag(self):
        tool = {"id": "tool", "type": "function_call", "name": "run", "arguments": '{"x":1}'}
        frames = [self.frame({"type": "response.output_item.done", "item": tool}),
                  self.frame({"type": "response.reasoning_summary_text.done",
                              "item_id": "reasoning", "summary_index": 0, "text": "Checking"})]
        events = self.events(self.relay(frames))
        self.assertEqual(events[0]["item"], tool)
        self.assertEqual(events[1]["text"], "Checking" + self.TAG)
        self.assertNotIn(self.HEADER, json.dumps(events))

    def test_replayed_headers_and_legacy_footers_are_removed_even_when_display_is_off(self):
        payload = {"input": [
            {"role": "assistant", "content": [{"type": "output_text", "text": self.HEADER + "answer"}]},
            {"role": "assistant", "content": "old answer" + self.LEGACY},
            {"role": "assistant", "content": "An example:\n" + self.HEADER + "quoted"},
            {"role": "user", "content": [{"type": "input_text", "text": self.HEADER + "user text"}]},
        ]}
        with mock.patch.object(jev.os.path, "exists", return_value=False):
            self.assertEqual(jev.strip_signatures(payload), 2)
        self.assertEqual(payload["input"][0]["content"][0]["text"], "answer")
        self.assertEqual(payload["input"][1]["content"], "old answer")
        self.assertEqual(payload["input"][2]["content"], "An example:\n" + self.HEADER + "quoted")
        self.assertEqual(payload["input"][3]["content"][0]["text"], self.HEADER + "user text")

    def test_header_generation_uses_the_actual_route_and_handles_unknown_effort(self):
        with mock.patch.object(jev.os.path, "exists", return_value=True):
            self.assertEqual(jev.answer_signature({"model": jev.SOL, "effort": "low"}), self.HEADER)
            self.assertIn("thinking: non spécifié", jev.answer_signature({"model": jev.ASTRA}))
        with mock.patch.object(jev.os.path, "exists", return_value=False):
            self.assertIsNone(jev.answer_signature({"model": jev.LUNA, "effort": "low"}))


if __name__ == "__main__":
    unittest.main()
