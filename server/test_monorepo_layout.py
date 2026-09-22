import json
import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class EmbeddedRouterLayout(unittest.TestCase):
    def test_router_fork_is_complete_and_contains_jev_contract_fixes(self):
        package = json.loads((ROOT / "router" / "package.json").read_text())
        self.assertEqual(package["name"], "codex-model-router")
        self.assertTrue((ROOT / "router" / "bin" / "codex-router").exists())

        router_source = (ROOT / "router" / "src" / "router.mjs").read_text()
        self.assertIn('route?.slug === "jev/auto"', router_source)
        self.assertIn("CODEX_ROUTER_STREAM_STALL_MS", router_source)
        self.assertIn("router_reasoning_effort", router_source)

    def test_root_installer_uses_only_the_embedded_router_source(self):
        installer = (ROOT / "install.sh").read_text()
        self.assertIn("router_dir=$repo_dir/router", installer)
        self.assertNotIn(".local/share/codex-router", installer)
        self.assertNotIn("git clone", installer)
        self.assertNotIn("CODEX_ROUTER_REPOSITORY_URL", installer)
        self.assertIn('CODEX_HOME=$prepare_home', installer)
        self.assertIn('"$router_dir/bin/install" --prepare-only', installer)
        self.assertNotIn('"$router_dir/install.sh" --prepare-only', installer)
        self.assertIn('"$router_dir/bin/install" --take-over-managed-router', installer)
        self.assertIn("CODEX_ROUTER_STATE_DIR=$state_dir", installer)

        service = (ROOT / "server" / "install-service.sh").read_text()
        self.assertIn("<key>CODEX_HOME</key>", service)
        self.assertIn("<key>CODEX_ROUTER_STATE_DIR</key>", service)
        self.assertIn("<key>JEV_ENV_FILE</key>", service)

    def test_model_configuration_is_idempotent_and_preserves_other_routes(self):
        with tempfile.TemporaryDirectory() as temp:
            state_dir = pathlib.Path(temp) / "state"
            state_dir.mkdir()
            user_models = state_dir / "user-models.json"
            user_models.write_text(json.dumps({
                "version": 1,
                "models": [{"slug": "example/model", "provider": "example"}],
            }))
            env = {
                **os.environ,
                "CODEX_ROUTER_STATE_DIR": str(state_dir),
            }
            command = ["node", str(ROOT / "server" / "configure-model.mjs")]
            subprocess.run(command, check=True, env=env, capture_output=True, text=True)
            subprocess.run(command, check=True, env=env, capture_output=True, text=True)
            payload = json.loads(user_models.read_text())
            slugs = [model["slug"] for model in payload["models"]]
            self.assertEqual(slugs.count("jev/auto"), 1)
            self.assertIn("example/model", slugs)
            self.assertEqual(user_models.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
