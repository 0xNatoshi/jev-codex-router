"""Tests for the answer signature: the route the app actually renders.

The app collapses a turn's activity (thinking, commentary, tool calls) behind
its worked-for divider, so the tag written into the reasoning summaries stays
invisible until that divider is expanded. These tests hold the second pass --
the one that signs the visible answer: only the item Codex marks
`final_answer` is signed, it is added once per representation, and the history
replayed upstream never carries it.
"""
import json
import unittest
from unittest import mock

import jev_server as jev


class AnswerSignature(unittest.TestCase):
    """The route written where the app renders it without a click: the answer.

    The app collapses a turn's activity (thinking, commentary, tool calls)
    behind its worked-for divider, so a tag inside the thinking block stays
    invisible. These tests hold the answering pass: only the item Codex marks
    `final_answer` gains the tag, it is added once per representation, and the
    history replayed upstream never carries it.
    """

    SIG = "\n\n— 🧠 sol · low"
    LINE = "— 🧠 sol · low"  # the signature as it reads inside a JSON frame
    TAG = " · 🧠 sol:low · "
    ANSWER_ID = "msg_answer"
    NOTE_ID = "msg_note"

    def frame(self, event):
        return ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode("utf-8")

    def relay(self, *frames, signature=None):
        markerer = jev.SummaryMarker(self.TAG, self.SIG if signature is None else signature)
        return "".join(markerer.feed(f) for f in frames) + markerer.flush()

    def events(self, stream):
        for line in stream.splitlines():
            if line.startswith("data: ") and line[6:].strip() != "[DONE]":
                yield json.loads(line[6:])

    def turn(self, answer="Le mot contient 2 r.", note="Je vérifie.",
             parts=("Le mot ", "contient ", "2 r.")):
        """One streamed turn: thinking, a commentary note, then the answer."""
        answer_item = {"id": self.ANSWER_ID, "type": "message", "phase": "final_answer",
                       "content": [{"type": "output_text", "text": answer}]}
        frames = [
            {"type": "response.created", "response": {"id": "resp_a"}},
            {"type": "response.reasoning_summary_text.delta",
             "item_id": "rs_1", "summary_index": 0, "delta": "Comptage"},
            {"type": "response.reasoning_summary_text.done",
             "item_id": "rs_1", "summary_index": 0, "text": "Comptage"},
            {"type": "response.output_item.added",
             "item": {"id": self.NOTE_ID, "type": "message", "phase": "commentary"}},
            {"type": "response.output_text.delta",
             "item_id": self.NOTE_ID, "content_index": 0, "delta": note},
            {"type": "response.output_text.done",
             "item_id": self.NOTE_ID, "content_index": 0, "text": note},
            {"type": "response.output_item.done",
             "item": {"id": self.NOTE_ID, "type": "message", "phase": "commentary",
                      "content": [{"type": "output_text", "text": note}]}},
            {"type": "response.output_item.added",
             "item": {"id": self.ANSWER_ID, "type": "message", "phase": "final_answer"}},
        ]
        for part in parts:
            frames.append({"type": "response.output_text.delta",
                           "item_id": self.ANSWER_ID, "content_index": 0, "delta": part})
        frames += [
            {"type": "response.output_text.done",
             "item_id": self.ANSWER_ID, "content_index": 0, "text": answer},
            {"type": "response.output_item.done", "item": answer_item},
            {"type": "response.completed",
             "response": {"id": "resp_a", "output": [
                 {"id": "rs_1", "type": "reasoning",
                  "summary": [{"type": "summary_text", "text": "Comptage"}]},
                 answer_item]}},
        ]
        return [self.frame(f) for f in frames]

    def answer_deltas(self, stream):
        text = ""
        for event in self.events(stream):
            if event.get("type") == "response.output_text.delta" and event.get("item_id") == self.ANSWER_ID:
                text += event["delta"]
        return text

    def test_the_streamed_answer_ends_with_the_route(self):
        stream = self.relay(*self.turn())
        self.assertEqual(self.answer_deltas(stream), "Le mot contient 2 r." + self.SIG)

    def test_every_representation_of_the_answer_carries_it_once(self):
        stream = self.relay(*self.turn())
        self.assertEqual(stream.count(self.LINE), 4, stream)
        for event in self.events(stream):
            if event.get("type") == "response.output_text.done" and event.get("item_id") == self.ANSWER_ID:
                self.assertTrue(event["text"].endswith(self.SIG))
            if event.get("type") == "response.output_item.done" and event["item"].get("id") == self.ANSWER_ID:
                self.assertTrue(event["item"]["content"][0]["text"].endswith(self.SIG))
            if event.get("type") == "response.completed":
                texts = [part["text"] for item in event["response"]["output"]
                         if item.get("phase") == "final_answer" for part in item["content"]]
                self.assertTrue(texts and all(t.endswith(self.SIG) for t in texts))

    def test_a_commentary_note_is_never_signed(self):
        """The note lives behind the divider: signing it would only reach the history."""
        stream = self.relay(*self.turn(note="Je vérifie la doc."))
        self.assertNotIn("Je vérifie la doc." + self.SIG, stream)
        note = [e for e in self.events(stream)
                if e.get("type") == "response.output_text.done" and e.get("item_id") == self.NOTE_ID]
        self.assertEqual(note[0]["text"], "Je vérifie la doc.")

    def test_the_reasoning_tag_survives_the_second_pass(self):
        stream = self.relay(*self.turn())
        self.assertIn("Comptage" + self.TAG, stream)

    def test_no_signature_switched_off_changes_nothing(self):
        stream = self.relay(*self.turn(), signature="")
        self.assertNotIn(self.LINE, stream)
        self.assertEqual(self.answer_deltas(stream), "Le mot contient 2 r.")
        self.assertEqual(stream.count(self.TAG), 3)

    def test_a_turn_without_a_flagged_answer_keeps_its_text(self):
        """Codex alone marks the answer; without the mark nothing is signed."""
        frames = self.turn()
        stream = self.relay(*frames)
        self.assertIn(self.LINE, stream)  # the mark is present in this fixture
        unflagged = []
        for frame in frames:
            event = json.loads(frame.decode()[6:].strip())
            if event.get("item", {}).get("type") == "message":
                event["item"].pop("phase", None)
            if event.get("type") == "response.completed":
                for item in event["response"]["output"]:
                    item.pop("phase", None)
            unflagged.append(self.frame(event))
        self.assertNotIn(self.LINE, self.relay(*unflagged))

    def test_an_empty_answer_is_not_signed(self):
        stream = self.relay(*self.turn(answer="", parts=()))
        self.assertNotIn(self.LINE, stream)

    def test_stripping_removes_only_our_trailing_line(self):
        payload = {"input": [
            {"type": "message", "role": "assistant",
             "content": [{"type": "output_text", "text": "Le mot contient 2 r." + self.SIG}]},
            {"type": "message", "role": "assistant",
             "content": [{"type": "output_text", "text": "sol · low, sans tiret cadratin"}]},
            {"type": "message", "role": "user",
             "content": [{"type": "input_text", "text": "et le modèle ?" + self.SIG}]},
        ]}
        with mock.patch.object(jev.os.path, "exists", return_value=True):
            self.assertEqual(jev.strip_signatures(payload), 1)
        self.assertEqual(payload["input"][0]["content"][0]["text"], "Le mot contient 2 r.")
        self.assertEqual(payload["input"][1]["content"][0]["text"], "sol · low, sans tiret cadratin")
        self.assertEqual(payload["input"][2]["content"][0]["text"], "et le modèle ?" + self.SIG)

    def test_stripping_is_off_without_the_flag(self):
        payload = {"input": [{"type": "message", "role": "assistant",
                              "content": [{"type": "output_text", "text": "a" + self.SIG}]}]}
        with mock.patch.object(jev.os.path, "exists", return_value=False):
            self.assertEqual(jev.strip_signatures(payload), 0)
        self.assertTrue(payload["input"][0]["content"][0]["text"].endswith(self.SIG))


if __name__ == "__main__":
    unittest.main()
