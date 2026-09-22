"""Runtime path resolution must match the embedded router configuration."""
import pathlib
import unittest

from local_runtime import resolve_runtime_paths


class RuntimePaths(unittest.TestCase):
    def test_defaults_under_the_owner_codex_home(self):
        home, codex_home, state = resolve_runtime_paths({}, "/Users/example")
        self.assertEqual(home, "/Users/example")
        self.assertEqual(codex_home, "/Users/example/.codex")
        self.assertEqual(state, "/Users/example/.codex/codex-router")

    def test_codex_home_moves_the_default_state(self):
        _, codex_home, state = resolve_runtime_paths(
            {"CODEX_HOME": "/tmp/custom-codex"}, "/Users/example"
        )
        self.assertEqual(codex_home, "/tmp/custom-codex")
        self.assertEqual(state, "/tmp/custom-codex/codex-router")

    def test_explicit_router_state_wins_over_every_other_location(self):
        _, _, state = resolve_runtime_paths({
            "CODEX_HOME": "/tmp/custom-codex",
            "MODEL_ROUTER_STATE_DIR": "/tmp/model-router-state",
            "CODEX_ROUTER_STATE_DIR": "/tmp/codex-router-state",
        }, "/Users/example")
        self.assertEqual(state, "/tmp/model-router-state")

    def test_model_router_state_is_the_compatible_secondary_override(self):
        _, _, state = resolve_runtime_paths({
            "CODEX_HOME": "/tmp/custom-codex",
            "MODEL_ROUTER_STATE_DIR": "/tmp/model-router-state",
        }, "/Users/example")
        self.assertEqual(state, "/tmp/model-router-state")


if __name__ == "__main__":
    unittest.main()
