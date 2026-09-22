from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "repo_maintainer.py"
SPEC = importlib.util.spec_from_file_location("repo_maintainer", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def evidence_for(manifest: dict) -> dict:
    return {
        "reviewed": [
            {"id": item["id"], "verdict": "accepted", "note": "Reviewed in context."}
            for item in manifest["reviewItems"]
        ]
    }


def git(repo: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return completed.stdout.strip()


class RepositoryFixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="repo-maintainer-test-")
        self.root = Path(self.temporary.name) / "repo"
        self.root.mkdir()
        git(self.root, "init", "--quiet")
        git(self.root, "config", "user.email", "tests@example.invalid")
        git(self.root, "config", "user.name", "Repo Maintainer Tests")

    def close(self) -> None:
        self.temporary.cleanup()

    def write(self, relative: str, content: str | bytes) -> Path:
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")
        return target

    def commit_all(self, message: str = "fixture") -> str:
        git(self.root, "add", "--all")
        git(self.root, "commit", "--quiet", "-m", message)
        return git(self.root, "rev-parse", "HEAD")


class ParserTests(unittest.TestCase):
    def test_git_invocation_disables_lazy_fetch_and_pathspec_magic(self) -> None:
        completed = subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"")
        with mock.patch.dict(MODULE.os.environ, {"git_dir": "/wrong"}):
            with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as runner:
                MODULE.run_git(Path("."), ["version"])
        environment = runner.call_args.kwargs["env"]
        self.assertEqual(environment["GIT_NO_LAZY_FETCH"], "1")
        self.assertEqual(environment["GIT_NO_REPLACE_OBJECTS"], "1")
        self.assertEqual(environment["GIT_LITERAL_PATHSPECS"], "1")
        self.assertEqual(environment["GIT_OPTIONAL_LOCKS"], "0")
        self.assertNotIn("git_dir", environment)

    def test_name_status_preserves_rename_and_unsafe_path_as_data(self) -> None:
        raw = b"M\0src/$(touch nope).mjs\0R100\0old name.txt\0new name.txt\0"
        changes = MODULE.parse_name_status(raw)
        self.assertEqual(changes[0].path, "src/$(touch nope).mjs")
        self.assertEqual(changes[1].status, "R100")
        self.assertEqual(changes[1].old_path, "old name.txt")
        self.assertEqual(changes[1].path, "new name.txt")

    def test_numstat_parses_rename_and_binary(self) -> None:
        raw = (
            b"3\t2\tplain.txt\0"
            b"-\t-\tbinary.png\0"
            b"1\t0\t\0old name.txt\0new name.txt\0"
        )
        stats = MODULE.parse_numstat(raw)
        self.assertEqual(stats["plain.txt"], (3, 2, False))
        self.assertEqual(stats["binary.png"], (None, None, True))
        self.assertEqual(stats["new name.txt"], (1, 0, False))

    def test_classification_escalates_sensitive_paths(self) -> None:
        self.assertEqual(MODULE.classify_path("README.md"), ["docs"])
        self.assertEqual(MODULE.classify_path("AGENTS.md"), ["docs", "skills"])
        self.assertIn("security", MODULE.classify_path("src/oauth-token.mjs"))
        self.assertIn("installers", MODULE.classify_path("install.ps1"))
        self.assertIn("dependencies", MODULE.classify_path("requirements/python.txt"))
        self.assertIn("ci", MODULE.classify_path(".github/workflows/ci.yml"))
        self.assertIn("dependencies", MODULE.classify_path("requirements-dev.txt"))
        self.assertIn("installers", MODULE.classify_path("Dockerfile.windows"))
        self.assertIn("installers", MODULE.classify_path("Containerfile"))

    def test_classification_does_not_use_dangerous_substrings(self) -> None:
        for path in ("src/hockey.mjs", "src/monkey.mjs", "src/author.mjs"):
            self.assertNotIn("security", MODULE.classify_path(path))
        self.assertNotIn("protocol", MODULE.classify_path("src/apiary.mjs"))
        self.assertNotIn("concurrency", MODULE.classify_path("src/block.mjs"))

    def test_markdown_escapes_terminal_and_bidi_controls(self) -> None:
        self.assertEqual(MODULE.markdown_escape("a\x1bb\u202ec"), r"a\u001bb\u202ec")

    def test_markdown_code_uses_a_fence_longer_than_filename_backticks(self) -> None:
        rendered = MODULE.markdown_code("a` **FAKE** `b")
        self.assertTrue(rendered.startswith("``"))
        self.assertTrue(rendered.endswith("``"))
        self.assertIn("a` **FAKE** `b", rendered)

    def test_unicode_normalization_aliases_are_detected(self) -> None:
        self.assertEqual(
            MODULE.case_alias_groups(["Résumé.md", "Re\u0301sume\u0301.md"]),
            [["Re\u0301sume\u0301.md", "Résumé.md"]],
        )

    def test_posix_backslash_is_filename_data_not_a_separator(self) -> None:
        self.assertEqual(MODULE.normalized_parts(r"docs\\token.mjs"), (r"docs\\token.mjs",))
        self.assertEqual(MODULE.top_level(r"docs\\token.mjs"), ".")

    def test_json_loader_rejects_duplicate_top_level_key(self) -> None:
        with tempfile.TemporaryDirectory(prefix="repo-maintainer-json-") as temporary:
            path = Path(temporary) / "manifest.json"
            path.write_text('{"revision": {}, "revision": {}}', encoding="utf-8")
            with self.assertRaisesRegex(MODULE.AnalyzerError, "duplicate JSON key 'revision'"):
                MODULE.load_json_object(path, "manifest")

    def test_json_loader_rejects_duplicate_nested_key(self) -> None:
        with tempfile.TemporaryDirectory(prefix="repo-maintainer-json-") as temporary:
            path = Path(temporary) / "evidence.json"
            path.write_text(
                '{"reviewed": [{"id": "first", "id": "second"}]}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(MODULE.AnalyzerError, "duplicate JSON key 'id'"):
                MODULE.load_json_object(path, "evidence")


class IntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = RepositoryFixture()
        self.fixture.write("README.md", "hello\n")
        self.fixture.write("src/value.mjs", "export const value = 1;\n")
        self.fixture.write("test/value.test.mjs", "// fixture\n")
        self.base = self.fixture.commit_all("base")

    def tearDown(self) -> None:
        self.fixture.close()

    def analyze_worktree(self) -> dict:
        return MODULE.analyze_report(
            self.fixture.root,
            mode="worktree",
            base=None,
            head=None,
            include_untracked=True,
        )

    def test_docs_only_is_review_only_without_fanout(self) -> None:
        self.fixture.write("README.md", "hello, world\n")
        report = self.analyze_worktree()
        self.assertEqual(report["risk"]["level"], "minor")
        self.assertEqual(report["verification"]["tier"], "review-only")
        self.assertEqual(report["fanout"]["decision"], "none")
        self.assertEqual(report["summary"]["hunks"], 1)

    def test_source_and_test_change_is_targeted(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        self.fixture.write("test/value.test.mjs", "// regression fixture\n")
        report = self.analyze_worktree()
        self.assertEqual(report["risk"]["level"], "local")
        self.assertEqual(report["verification"]["tier"], "targeted")
        self.assertNotIn("Source changed without a changed test file; confirm meaningful existing coverage", report["warnings"])

    def test_source_test_and_docs_do_not_trigger_fanout_by_surface_count_alone(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        self.fixture.write("test/value.test.mjs", "// regression fixture\n")
        self.fixture.write("README.md", "updated docs\n")
        report = self.analyze_worktree()
        self.assertEqual(report["fanout"]["decision"], "none")

    def test_small_security_change_is_critical_and_considers_review(self) -> None:
        self.fixture.write("src/oauth-token.mjs", "export const token = null;\n")
        report = self.analyze_worktree()
        self.assertEqual(report["risk"]["level"], "critical")
        self.assertEqual(report["verification"]["tier"], "full")
        self.assertEqual(report["fanout"]["decision"], "consider")

    def test_install_script_warns_about_platform_parity(self) -> None:
        self.fixture.write("install.sh", "#!/bin/sh\nexit 0\n")
        report = self.analyze_worktree()
        self.assertIn(
            "install.sh changed without install.ps1; review Windows parity explicitly",
            report["warnings"],
        )

    def test_generated_python_lock_requires_inputs(self) -> None:
        self.fixture.write("requirements/python.txt", "example==1 --hash=sha256:00\n")
        report = self.analyze_worktree()
        self.assertIn(
            "The generated Python lock changed without its declared inputs",
            report["warnings"],
        )

    def test_dependency_manifest_is_critical_and_full(self) -> None:
        self.fixture.write("requirements-dev.txt", "example==1\n")
        report = self.analyze_worktree()
        self.assertEqual(report["risk"]["level"], "critical")
        self.assertEqual(report["verification"]["tier"], "full")

    def test_range_reports_dirty_overlap(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        candidate = self.fixture.commit_all("candidate")
        self.fixture.write("src/value.mjs", "export const value = 3;\n")
        report = MODULE.analyze_report(
            self.fixture.root,
            mode="range",
            base=self.base,
            head=candidate,
            include_untracked=False,
        )
        self.assertEqual(report["adoption"]["dirtyOverlap"], ["src/value.mjs"])

    def test_rename_binary_and_spaces_are_preserved(self) -> None:
        git(self.fixture.root, "mv", "README.md", "docs name.md")
        self.fixture.write("assets/image.png", b"\x89PNG\x00fixture")
        report = self.analyze_worktree()
        changes = {change["path"]: change for change in report["changes"]}
        self.assertEqual(changes["docs name.md"]["oldPath"], "README.md")
        self.assertTrue(changes["assets/image.png"]["binary"])
        rename_items = [item for item in report["reviewItems"] if item["path"] == "docs name.md"]
        self.assertEqual(len(rename_items), 1)
        self.assertEqual(rename_items[0]["newRange"], [1, 1])

    def test_malicious_filename_is_never_executed(self) -> None:
        marker = self.fixture.root / "PWNED"
        self.fixture.write("src/$(touch PWNED).mjs", "export default 1;\n")
        report = self.analyze_worktree()
        self.assertFalse(marker.exists())
        self.assertIn("src/$(touch PWNED).mjs", {item["path"] for item in report["changes"]})

    def test_control_characters_in_filename_are_preserved_and_escaped(self) -> None:
        unusual = "src/odd\tname\nfile.mjs"
        self.fixture.write(unusual, "export default 1;\n")
        report = self.analyze_worktree()
        self.assertIn(unusual, {item["path"] for item in report["changes"]})
        rendered = MODULE.render_markdown(report)
        self.assertIn("odd\\tname\\nfile.mjs", rendered)
        self.assertNotIn("odd\tname\nfile.mjs", rendered)

    def test_warning_paths_cannot_create_markdown_links(self) -> None:
        report = self.analyze_worktree()
        report["warnings"] = ["Alias: [x](https://example.invalid)"]
        rendered = MODULE.render_markdown(report)
        self.assertIn(r"\[x\]\(https://example\.invalid\)", rendered)

    def test_case_colliding_paths_warn_for_portable_repositories(self) -> None:
        self.assertEqual(
            MODULE.case_alias_groups(["src/API/value.mjs", "src/api/value.mjs"]),
            [["src/API/value.mjs", "src/api/value.mjs"]],
        )

    @unittest.skipIf(__import__("os").name == "nt", "symlink fixture requires POSIX privileges")
    def test_untracked_symlink_is_not_followed(self) -> None:
        outside = Path(self.fixture.temporary.name) / "outside-secret"
        outside.write_text("do not read through the link\n", encoding="utf-8")
        link = self.fixture.root / "src" / "linked.mjs"
        link.symlink_to(outside)
        report = self.analyze_worktree()
        change = next(item for item in report["changes"] if item["path"] == "src/linked.mjs")
        review = next(item for item in report["reviewItems"] if item["path"] == "src/linked.mjs")
        self.assertTrue(change["symlink"])
        self.assertTrue(review["symlink"])
        self.assertIn(
            "Symlinks are reviewed as link metadata; targets are not followed",
            report["warnings"],
        )

    def test_manifest_output_is_stable(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        first = self.analyze_worktree()
        second = self.analyze_worktree()
        self.assertEqual(
            json.dumps(first, sort_keys=True),
            json.dumps(second, sort_keys=True),
        )

    @unittest.skipIf(__import__("os").name == "nt", "symlink fixture requires POSIX privileges")
    def test_manifest_writer_refuses_symlink_destination(self) -> None:
        victim = Path(self.fixture.temporary.name) / "victim.json"
        victim.write_text("do not overwrite\n", encoding="utf-8")
        destination = self.fixture.root / "manifest.json"
        destination.symlink_to(victim)
        with self.assertRaises(MODULE.AnalyzerError):
            MODULE.atomic_write_json(destination, {"safe": True})
        self.assertEqual(victim.read_text(encoding="utf-8"), "do not overwrite\n")

    @unittest.skipUnless(Path("/tmp").is_symlink(), "system /tmp alias is macOS-specific")
    def test_manifest_writer_allows_trusted_system_tmp_alias(self) -> None:
        destination = Path(self.fixture.temporary.name) / "system-alias-manifest.json"
        MODULE.atomic_write_json(destination, {"safe": True})
        self.assertEqual(json.loads(destination.read_text(encoding="utf-8")), {"safe": True})

    def test_detailed_review_cap_blocks_large_blob_without_patch_capture(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 222;\n")
        with mock.patch.object(MODULE, "MAX_DETAILED_BLOB_BYTES", 1):
            report = self.analyze_worktree()
        item = next(item for item in report["reviewItems"] if item["path"] == "src/value.mjs")
        self.assertTrue(item["summaryOnly"])
        self.assertFalse(item["verifiable"])

    @unittest.skipIf(__import__("os").name == "nt", "executable-bit fixture is POSIX-only")
    def test_mode_only_change_has_review_evidence(self) -> None:
        executable = self.fixture.write("bin/tool", "#!/bin/sh\nexit 0\n")
        self.fixture.commit_all("mode base")
        executable.chmod(0o755)
        report = self.analyze_worktree()
        items = [item for item in report["reviewItems"] if item["path"] == "bin/tool"]
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0].get("metadataOnly"))

    def test_staged_mode_excludes_unstaged_hunk(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        git(self.fixture.root, "add", "src/value.mjs")
        self.fixture.write("src/value.mjs", "export const value = 3;\n")
        staged = MODULE.analyze_report(
            self.fixture.root,
            mode="staged",
            base=None,
            head=None,
            include_untracked=False,
        )
        worktree = self.analyze_worktree()
        self.assertEqual(staged["summary"]["additions"], 1)
        self.assertEqual(worktree["summary"]["additions"], 2)
        worktree_by_layer = {item["layer"]: item["id"] for item in worktree["reviewItems"]}
        self.assertEqual(staged["reviewItems"][0]["id"], worktree_by_layer["staged"])
        self.assertNotEqual(worktree_by_layer["staged"], worktree_by_layer["unstaged"])

    def test_worktree_keeps_staged_and_unstaged_layers_when_they_cancel(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        git(self.fixture.root, "add", "src/value.mjs")
        self.fixture.write("src/value.mjs", "export const value = 1;\n")
        report = self.analyze_worktree()
        changes = [item for item in report["changes"] if item["path"] == "src/value.mjs"]
        self.assertEqual({item["layer"] for item in changes}, {"staged", "unstaged"})
        self.assertEqual(report["summary"]["files"], 1)
        self.assertEqual(report["summary"]["deltas"], 2)
        self.assertEqual(len({item["id"] for item in report["reviewItems"]}), 2)

    def test_staged_delete_and_untracked_replacement_both_survive(self) -> None:
        git(self.fixture.root, "rm", "src/value.mjs")
        self.fixture.write("src/value.mjs", "replacement\n")
        report = self.analyze_worktree()
        changes = [item for item in report["changes"] if item["path"] == "src/value.mjs"]
        self.assertEqual({item["layer"] for item in changes}, {"staged", "untracked"})

    def test_rename_retains_old_sensitive_surface(self) -> None:
        self.fixture.write("src/oauth-token.mjs", "export default 1;\n")
        self.fixture.commit_all("sensitive source")
        (self.fixture.root / "docs").mkdir()
        git(self.fixture.root, "mv", "src/oauth-token.mjs", "docs/notes.md")
        report = self.analyze_worktree()
        change = next(item for item in report["changes"] if item["path"] == "docs/notes.md")
        self.assertIn("security", change["surfaces"])
        self.assertEqual(report["risk"]["level"], "critical")

    def test_range_rename_overlap_includes_old_path(self) -> None:
        self.fixture.write("src/old.mjs", "export default 1;\n")
        old_base = self.fixture.commit_all("rename base")
        git(self.fixture.root, "mv", "src/old.mjs", "src/new.mjs")
        candidate = self.fixture.commit_all("rename")
        self.fixture.write("src/old.mjs", "local work\n")
        report = MODULE.analyze_report(
            self.fixture.root,
            mode="range",
            base=old_base,
            head=candidate,
            include_untracked=False,
        )
        self.assertIn("src/old.mjs", report["adoption"]["dirtyOverlap"])

    def test_three_root_docs_remain_one_top_level_path(self) -> None:
        self.fixture.write("README.md", "changed\n")
        self.fixture.write("GUIDE.md", "guide\n")
        self.fixture.write("NOTES.md", "notes\n")
        report = self.analyze_worktree()
        self.assertEqual(report["summary"]["topLevelPaths"], ["."])
        self.assertEqual(report["risk"]["level"], "minor")

    def test_many_docs_do_not_trigger_fanout_by_file_count(self) -> None:
        for index in range(9):
            self.fixture.write(f"NOTE-{index}.md", f"note {index}\n")
        report = self.analyze_worktree()
        self.assertEqual(report["risk"]["level"], "minor")
        self.assertEqual(report["fanout"]["decision"], "none")

    def test_ci_change_requires_expanded_verification(self) -> None:
        self.fixture.write(".github/workflows/ci.yml", "name: ci\n")
        report = self.analyze_worktree()
        self.assertEqual(report["verification"]["tier"], "expanded")

    @unittest.skipIf(__import__("os").name == "nt", "symlink fixture requires POSIX privileges")
    def test_tracked_symlink_is_classified_without_following_target(self) -> None:
        first = Path(self.fixture.temporary.name) / "first"
        second = Path(self.fixture.temporary.name) / "second"
        first.write_text("first secret\n", encoding="utf-8")
        second.write_text("second secret\n", encoding="utf-8")
        link = self.fixture.root / "src" / "tracked-link"
        link.symlink_to(first)
        self.fixture.commit_all("symlink base")
        link.unlink()
        link.symlink_to(second)
        report = self.analyze_worktree()
        change = next(item for item in report["changes"] if item["path"] == "src/tracked-link")
        self.assertTrue(change["symlink"])
        self.assertIn("links", change["surfaces"])

    def test_unborn_repository_can_be_analyzed(self) -> None:
        fixture = RepositoryFixture()
        try:
            fixture.write("src/new.mjs", "export default 1;\n")
            git(fixture.root, "add", "src/new.mjs")
            report = MODULE.analyze_report(
                fixture.root, mode="worktree", base=None, head=None, include_untracked=True
            )
            self.assertIsNone(report["revision"]["repositoryHead"])
            self.assertEqual(report["summary"]["files"], 1)
        finally:
            fixture.close()

    def test_configured_textconv_is_not_executed(self) -> None:
        marker = Path(self.fixture.temporary.name) / "textconv-ran"
        converter = Path(self.fixture.temporary.name) / "converter.sh"
        converter.write_text(f"#!/bin/sh\ntouch '{marker}'\ncat \"$1\"\n", encoding="utf-8")
        converter.chmod(0o755)
        self.fixture.write(".gitattributes", "*.foo diff=owned\n")
        self.fixture.write("sample.foo", "one\n")
        self.fixture.commit_all("textconv base")
        git(self.fixture.root, "config", "diff.owned.textconv", str(converter))
        self.fixture.write("sample.foo", "two\n")
        self.analyze_worktree()
        self.assertFalse(marker.exists())

    def test_configured_clean_filter_is_not_executed(self) -> None:
        marker = Path(self.fixture.temporary.name) / "clean-filter-ran"
        converter = Path(self.fixture.temporary.name) / "clean-filter.sh"
        converter.write_text(f"#!/bin/sh\ntouch '{marker}'\ncat\n", encoding="utf-8")
        converter.chmod(0o755)
        self.fixture.write(".gitattributes", "*.foo filter=owned\n")
        self.fixture.write("sample.foo", "one\n")
        self.fixture.commit_all("filter base")
        git(self.fixture.root, "config", "filter.owned.clean", str(converter))
        marker.unlink(missing_ok=True)
        self.fixture.write("sample.foo", "two\n")
        report = self.analyze_worktree()
        self.assertFalse(marker.exists())
        self.assertIn("sample.foo", {item["path"] for item in report["changes"]})

    def test_pathspec_magic_filename_is_hashed_as_literal_data(self) -> None:
        unusual = ":(exclude)*.py"
        self.fixture.write(unusual, "one\n")
        git(self.fixture.root, "add", "--", f":(literal){unusual}")
        git(self.fixture.root, "commit", "--quiet", "-m", "literal path")
        self.fixture.write(unusual, "two\n")
        first = self.analyze_worktree()
        first_id = next(item["id"] for item in first["reviewItems"] if item["path"] == unusual)
        self.fixture.write(unusual, "three\n")
        second = self.analyze_worktree()
        second_id = next(item["id"] for item in second["reviewItems"] if item["path"] == unusual)
        self.assertNotEqual(first_id, second_id)

    def test_copy_review_does_not_mislabel_source_hunk(self) -> None:
        original = "".join(f"{index}\n" for index in range(100))
        self.fixture.write("src/a.txt", original)
        self.fixture.commit_all("copy base")
        self.fixture.write("src/a.txt", original + "source edit\n")
        self.fixture.write("src/b.txt", original)
        git(self.fixture.root, "add", "src/a.txt", "src/b.txt")
        report = self.analyze_worktree()
        copied = next(item for item in report["changes"] if item["path"] == "src/b.txt")
        self.assertTrue(copied["status"].startswith("C"))
        source_items = [item for item in report["reviewItems"] if item["path"] == "src/a.txt"]
        copy_items = [item for item in report["reviewItems"] if item["path"] == "src/b.txt"]
        self.assertEqual(source_items[0]["newRange"][1], 1)
        self.assertEqual(copy_items[0]["newRange"][1], 100)

    def test_copy_from_unchanged_sensitive_source_keeps_provenance_risk(self) -> None:
        content = "".join(f"secret-shaped line {index}\n" for index in range(100))
        self.fixture.write("src/oauth-token.py", content)
        self.fixture.commit_all("sensitive copy base")
        self.fixture.write("docs/example.md", content)
        git(self.fixture.root, "add", "docs/example.md")
        report = self.analyze_worktree()
        copied = next(item for item in report["changes"] if item["path"] == "docs/example.md")
        self.assertTrue(copied["status"].startswith("C"))
        self.assertEqual(copied["oldPath"], "src/oauth-token.py")
        self.assertIn("security", copied["surfaces"])
        self.assertEqual(report["risk"]["level"], "critical")

    def test_rename_crossing_exclusion_boundary_is_not_hidden(self) -> None:
        content = "".join(f"line {index}\n" for index in range(100))
        self.fixture.write("generated/old.txt", content)
        self.fixture.commit_all("rename base")
        git(self.fixture.root, "mv", "generated/old.txt", "src/renamed.txt")
        report = MODULE.analyze_report(
            self.fixture.root,
            mode="staged",
            base=None,
            head=None,
            include_untracked=False,
            excluded_paths={"generated/old.txt"},
        )
        renamed = next(item for item in report["changes"] if item["path"] == "src/renamed.txt")
        self.assertTrue(renamed["status"].startswith("R"))
        self.assertEqual(renamed["oldPath"], "generated/old.txt")

    def test_copy_crossing_exclusion_boundary_is_not_hidden(self) -> None:
        content = "".join(f"line {index}\n" for index in range(100))
        self.fixture.write("src/original.txt", content)
        self.fixture.commit_all("copy exclusion base")
        self.fixture.write("generated/copied.txt", content)
        git(self.fixture.root, "add", "generated/copied.txt")
        report = MODULE.analyze_report(
            self.fixture.root,
            mode="staged",
            base=None,
            head=None,
            include_untracked=False,
            excluded_paths={"generated/copied.txt"},
        )
        copied = next(item for item in report["changes"] if item["path"] == "generated/copied.txt")
        self.assertTrue(copied["status"].startswith("C"))
        self.assertEqual(copied["oldPath"], "src/original.txt")

    def test_opaque_nested_repository_blocks_coverage_verification(self) -> None:
        nested = self.fixture.root / "nested"
        nested.mkdir()
        git(nested, "init", "--quiet")
        git(nested, "config", "user.email", "nested@example.invalid")
        git(nested, "config", "user.name", "Nested")
        (nested / "value.py").write_text("one\n", encoding="utf-8")
        git(nested, "add", "value.py")
        git(nested, "commit", "--quiet", "-m", "nested")
        manifest = self.analyze_worktree()
        opaque = next(item for item in manifest["reviewItems"] if item.get("opaque"))
        self.assertFalse(opaque["verifiable"])
        artifact_root = Path(self.fixture.temporary.name) / "opaque-evidence"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text(json.dumps(evidence_for(manifest)), encoding="utf-8")
        result = MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["unverifiable"], [opaque["id"]])

    def test_unresolved_merge_conflict_is_critical_and_unverifiable(self) -> None:
        main_branch = git(self.fixture.root, "branch", "--show-current")
        git(self.fixture.root, "checkout", "-q", "-b", "side")
        self.fixture.write("src/value.mjs", "side\n")
        self.fixture.commit_all("side")
        git(self.fixture.root, "checkout", "-q", main_branch)
        self.fixture.write("src/value.mjs", "main\n")
        self.fixture.commit_all("main")
        completed = subprocess.run(
            ["git", "-C", str(self.fixture.root), "merge", "side"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        report = self.analyze_worktree()
        conflict = [item for item in report["changes"] if item["path"] == "src/value.mjs"]
        self.assertEqual(len(conflict), 1)
        self.assertEqual(conflict[0]["layer"], "unmerged")
        self.assertFalse(conflict[0]["verifiable"])
        self.assertEqual(report["risk"]["level"], "critical")

    def test_ignore_submodules_config_cannot_hide_staged_gitlink_change(self) -> None:
        source = Path(self.fixture.temporary.name) / "submodule-source"
        source.mkdir()
        git(source, "init", "--quiet")
        git(source, "config", "user.email", "submodule@example.invalid")
        git(source, "config", "user.name", "Submodule")
        (source / "value.txt").write_text("one\n", encoding="utf-8")
        git(source, "add", "value.txt")
        git(source, "commit", "--quiet", "-m", "one")
        git(
            self.fixture.root,
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--quiet",
            str(source),
            "dep",
        )
        self.fixture.commit_all("submodule base")
        dep = self.fixture.root / "dep"
        git(dep, "config", "user.email", "submodule@example.invalid")
        git(dep, "config", "user.name", "Submodule")
        (dep / "value.txt").write_text("two\n", encoding="utf-8")
        git(dep, "add", "value.txt")
        git(dep, "commit", "--quiet", "-m", "two")
        git(self.fixture.root, "add", "dep")
        git(self.fixture.root, "config", "diff.ignoreSubmodules", "all")
        report = MODULE.analyze_report(
            self.fixture.root, mode="staged", base=None, head=None, include_untracked=False
        )
        change = next(item for item in report["changes"] if item["path"] == "dep")
        self.assertTrue(change["gitlink"])
        self.assertFalse(change["verifiable"])
        self.assertEqual(report["risk"]["level"], "critical")

    def test_in_repo_manifest_is_excluded_on_repeated_cli_runs(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        manifest_path = self.fixture.root / ".repo-maintainer" / "manifest.json"
        command = [
            sys.executable,
            str(SCRIPT),
            "analyze",
            "--repo",
            str(self.fixture.root),
            "--format",
            "json",
            "--manifest",
            str(manifest_path),
        ]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        first = json.loads(manifest_path.read_text(encoding="utf-8"))
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        second = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(
            [item["id"] for item in first["reviewItems"]],
            [item["id"] for item in second["reviewItems"]],
        )

    def test_preexisting_in_repo_evidence_can_be_explicitly_excluded(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        artifact_root = self.fixture.root / ".repo-maintainer"
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        artifact_root.mkdir()
        evidence_path.write_text('{"reviewed": []}\n', encoding="utf-8")
        command = [
            sys.executable,
            str(SCRIPT),
            "analyze",
            "--repo",
            str(self.fixture.root),
            "--format",
            "json",
            "--manifest",
            str(manifest_path),
            "--exclude-artifact",
            str(evidence_path),
        ]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        evidence_path.write_text(json.dumps(evidence_for(manifest)), encoding="utf-8")
        result = MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)
        self.assertTrue(result["coverageComplete"])

    @unittest.skipIf(__import__("os").name == "nt", "mode fixture is POSIX-only")
    def test_content_hunk_evidence_changes_when_mode_metadata_changes(self) -> None:
        tool = self.fixture.write("bin/tool", "one\n")
        self.fixture.commit_all("tool base")
        self.fixture.write("bin/tool", "two\n")
        tool.chmod(0o755)
        manifest = self.analyze_worktree()
        artifact_root = Path(self.fixture.temporary.name) / "mode-evidence"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text(json.dumps(evidence_for(manifest)), encoding="utf-8")
        self.assertTrue(MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)["coverageComplete"])
        tool.chmod(0o644)
        self.assertFalse(MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)["coverageComplete"])

    def test_manifest_revision_cannot_inject_git_options(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        candidate = self.fixture.commit_all("candidate")
        manifest = MODULE.analyze_report(
            self.fixture.root,
            mode="range",
            base=self.base,
            head=candidate,
            include_untracked=False,
        )
        marker = Path(self.fixture.temporary.name) / "injected"
        manifest["revision"]["base"] = f"--output={marker}"
        artifact_root = Path(self.fixture.temporary.name) / "inject"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text(json.dumps(evidence_for(manifest)), encoding="utf-8")
        with self.assertRaises(MODULE.AnalyzerError):
            MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)
        self.assertFalse(marker.exists())

    def test_manifest_cannot_self_authorize_excluding_changed_code(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        manifest = self.analyze_worktree()
        manifest["revision"]["excludedArtifacts"] = ["src/value.mjs"]
        manifest["reviewItems"] = []
        artifact_root = Path(self.fixture.temporary.name) / "exclusion-bypass"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text('{"reviewed": []}', encoding="utf-8")
        with self.assertRaises(MODULE.AnalyzerError):
            MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)

    def test_verifier_only_exclusion_cannot_hide_changed_code(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        manifest = self.analyze_worktree()
        manifest["reviewItems"] = []
        artifact_root = Path(self.fixture.temporary.name) / "verifier-exclusion"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text('{"reviewed": []}', encoding="utf-8")
        result = MODULE.verify_review(
            self.fixture.root,
            manifest_path,
            evidence_path,
            [self.fixture.root / "src/value.mjs"],
        )
        self.assertFalse(result["coverageComplete"])
        self.assertTrue(result["missing"])

    def test_replace_refs_cannot_hide_range_changes(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        candidate = self.fixture.commit_all("candidate")
        git(self.fixture.root, "replace", candidate, self.base)
        report = MODULE.analyze_report(
            self.fixture.root,
            mode="range",
            base=self.base,
            head=candidate,
            include_untracked=False,
        )
        self.assertEqual(report["summary"]["files"], 1)
        self.assertEqual(report["changes"][0]["path"], "src/value.mjs")

    def test_repository_shaping_environment_is_ignored(self) -> None:
        other = Path(self.fixture.temporary.name) / "other"
        other.mkdir()
        git(other, "init", "--quiet")
        git(other, "config", "user.email", "other@example.invalid")
        git(other, "config", "user.name", "Other")
        (other / "only-other.py").write_text("other\n", encoding="utf-8")
        git(other, "add", "only-other.py")
        git(other, "commit", "--quiet", "-m", "other")
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        with mock.patch.dict(
            MODULE.os.environ,
            {"GIT_DIR": str(other / ".git"), "GIT_WORK_TREE": str(other)},
        ):
            report = self.analyze_worktree()
        self.assertIn("src/value.mjs", {item["path"] for item in report["changes"]})
        self.assertNotIn("only-other.py", {item["path"] for item in report["changes"]})

    @unittest.skipIf(__import__("os").name == "nt", "file mode is not portable on Windows")
    def test_filemode_config_cannot_hide_executable_bit_change(self) -> None:
        tool = self.fixture.write("bin/tool", "#!/bin/sh\nexit 0\n")
        self.fixture.commit_all("mode base")
        git(self.fixture.root, "config", "core.filemode", "false")
        tool.chmod(0o755)
        report = self.analyze_worktree()
        change = next(item for item in report["changes"] if item["path"] == "bin/tool")
        self.assertEqual(change["layer"], "unstaged")
        review = next(item for item in report["reviewItems"] if item["path"] == "bin/tool")
        self.assertTrue(review["metadataOnly"])

    def test_invalid_utf8_evidence_fails_closed(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        manifest = self.analyze_worktree()
        artifact_root = Path(self.fixture.temporary.name) / "bad-utf8"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_bytes(b"\xff")
        with self.assertRaises(MODULE.AnalyzerError):
            MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)

    def test_manifest_and_evidence_inside_repo_are_excluded_from_review(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        manifest = self.analyze_worktree()
        manifest_path = self.fixture.root / ".repo-maintainer" / "manifest.json"
        evidence_path = self.fixture.root / ".repo-maintainer" / "evidence.json"
        MODULE.atomic_write_json(manifest_path, manifest)
        MODULE.atomic_write_json(
            evidence_path,
            evidence_for(manifest),
        )
        result = MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)
        self.assertTrue(result["coverageComplete"])

    def test_review_evidence_becomes_stale_after_hunk_change(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        manifest = self.analyze_worktree()
        artifact_root = Path(self.fixture.temporary.name) / "evidence"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text(
            json.dumps(evidence_for(manifest)),
            encoding="utf-8",
        )
        verified = MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)
        self.assertTrue(verified["coverageComplete"])

        self.fixture.write("src/value.mjs", "export const value = 200;\n")
        stale = MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)
        self.assertFalse(stale["coverageComplete"])
        self.assertTrue(stale["missing"])

    def test_finding_verdict_completes_coverage_without_approving_patch(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        manifest = self.analyze_worktree()
        evidence = evidence_for(manifest)
        evidence["reviewed"][0]["verdict"] = "finding"
        artifact_root = Path(self.fixture.temporary.name) / "finding"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
        result = MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)
        self.assertTrue(result["coverageComplete"])
        self.assertTrue(result["hasFindings"])

    @unittest.skipIf(__import__("os").name == "nt", "file mode is not portable on Windows")
    def test_untracked_file_mode_change_stales_evidence(self) -> None:
        tool = self.fixture.write("tool", "same bytes\n")
        manifest = self.analyze_worktree()
        artifact_root = Path(self.fixture.temporary.name) / "untracked-mode"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text(json.dumps(evidence_for(manifest)), encoding="utf-8")
        self.assertTrue(
            MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)["coverageComplete"]
        )
        tool.chmod(0o755)
        self.assertFalse(
            MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)["coverageComplete"]
        )

    def test_review_boundary_change_is_stale(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        manifest = self.analyze_worktree()
        artifact_root = Path(self.fixture.temporary.name) / "boundary"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text(
            json.dumps(evidence_for(manifest)),
            encoding="utf-8",
        )
        self.fixture.commit_all("move head")
        result = MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)
        self.assertFalse(result["coverageComplete"])
        self.assertTrue(result["boundaryChanged"])

    def test_binary_review_evidence_becomes_stale(self) -> None:
        self.fixture.write("assets/image.png", b"\x89PNG\x00base")
        self.fixture.commit_all("binary base")
        self.fixture.write("assets/image.png", b"\x89PNG\x00first")
        manifest = self.analyze_worktree()
        binary_items = [item for item in manifest["reviewItems"] if item.get("binary")]
        self.assertEqual(len(binary_items), 1)

        artifact_root = Path(self.fixture.temporary.name) / "binary-evidence"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        evidence_path.write_text(
            json.dumps(evidence_for(manifest)),
            encoding="utf-8",
        )
        self.assertTrue(MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)["coverageComplete"])
        self.fixture.write("assets/image.png", b"\x89PNG\x00second")
        self.assertFalse(MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)["coverageComplete"])

    def test_malformed_or_duplicate_evidence_fails_closed(self) -> None:
        self.fixture.write("src/value.mjs", "export const value = 2;\n")
        manifest = self.analyze_worktree()
        artifact_root = Path(self.fixture.temporary.name) / "malformed-evidence"
        artifact_root.mkdir()
        manifest_path = artifact_root / "manifest.json"
        evidence_path = artifact_root / "evidence.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        duplicate = manifest["reviewItems"][0]["id"]
        record = {"id": duplicate, "verdict": "accepted", "note": "reviewed"}
        evidence_path.write_text(json.dumps({"reviewed": [record, record]}), encoding="utf-8")
        with self.assertRaises(MODULE.AnalyzerError):
            MODULE.verify_review(self.fixture.root, manifest_path, evidence_path)


if __name__ == "__main__":
    unittest.main()
