#!/usr/bin/env python3
"""Git change analyzer for the repo-maintainer skill.

The analyzer reports deterministic facts and conservative recommendations. It
does not fetch, pull, merge, or execute test commands. It does not edit
repository content unless the explicitly named ``--manifest`` destination is
inside the repository; manifest mode atomically creates or replaces that JSON
artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence


SCHEMA_VERSION = 2
MAX_UNTRACKED_LINE_COUNT_BYTES = 8 * 1024 * 1024
MAX_WORKTREE_HASH_BYTES = 64 * 1024 * 1024
MAX_DETAILED_BLOB_BYTES = 16 * 1024 * 1024
MAX_DETAILED_FILES = 100
MAX_DETAILED_CHANGED_LINES = 100_000
HUNK_RE = re.compile(
    r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$"
)

DOC_EXTENSIONS = {".md", ".mdx", ".rst", ".adoc", ".txt"}
SOURCE_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".jsx",
    ".kt", ".kts", ".m", ".mjs", ".mm", ".php", ".py", ".rb",
    ".rs", ".sh", ".swift", ".ts", ".tsx", ".vue", ".zsh",
}
CONFIG_EXTENSIONS = {".cfg", ".conf", ".ini", ".json", ".jsonc", ".toml", ".yaml", ".yml"}
BINARY_EXTENSIONS = {
    ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".dmg", ".dll",
    ".doc", ".docx", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg",
    ".jpg", ".mov", ".mp3", ".mp4", ".o", ".pdf", ".png", ".so",
    ".tar", ".webm", ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".zip",
}

CRITICAL_SURFACES = {
    "concurrency", "dependencies", "installers", "protocol", "release",
    "security", "state", "links", "embedded-repository",
    "unmerged",
}
OID_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")


class AnalyzerError(RuntimeError):
    """Expected input or Git failure."""


@dataclass
class Change:
    status: str
    path: str
    layer: str
    old_path: str | None = None
    additions: int | None = 0
    deletions: int | None = 0
    binary: bool = False
    symlink: bool = False
    gitlink: bool = False
    opaque: bool = False
    old_mode: str | None = None
    new_mode: str | None = None
    old_oid: str | None = None
    new_oid: str | None = None
    verifiable: bool = True
    surfaces: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "status": self.status,
            "path": self.path,
            "layer": self.layer,
            "additions": self.additions,
            "deletions": self.deletions,
            "binary": self.binary,
            "symlink": self.symlink,
            "gitlink": self.gitlink,
            "opaque": self.opaque,
            "verifiable": self.verifiable,
            "surfaces": self.surfaces,
        }
        if self.old_path is not None:
            result["oldPath"] = self.old_path
        return result


def decode_path(value: bytes) -> str:
    return value.decode("utf-8", errors="surrogateescape")


def disabled_filter_config(repo: Path, environment: dict[str, str]) -> list[str]:
    completed = subprocess.run(
        [
            "git", "-c", "core.fsmonitor=false", "-C", str(repo), "config",
            "--null", "--get-regexp", r"^filter\..*\.(clean|process|required)$",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=environment,
    )
    if completed.returncode not in {0, 1}:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise AnalyzerError(f"could not inspect Git filter configuration: {detail or 'unknown error'}")
    drivers: set[str] = set()
    for record in completed.stdout.split(b"\0"):
        if not record:
            continue
        key = decode_path(record.split(b"\n", 1)[0])
        prefix, separator, _setting = key.rpartition(".")
        if separator and prefix.lower().startswith("filter."):
            drivers.add(prefix)
    result: list[str] = []
    for prefix in sorted(drivers, key=str.casefold):
        result.extend(
            [
                "-c", f"{prefix}.clean=",
                "-c", f"{prefix}.process=",
                "-c", f"{prefix}.required=false",
            ]
        )
    return result


def run_git(repo: Path, args: Sequence[str], *, allow_failure: bool = False) -> bytes:
    environment = {
        key: value for key, value in os.environ.items()
        if not key.upper().startswith("GIT_")
    }
    environment.update(
        {
            "GIT_LITERAL_PATHSPECS": "1",
            "GIT_NO_LAZY_FETCH": "1",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
        }
    )
    filter_config = disabled_filter_config(repo, environment)
    safety_config = ["-c", "core.fsmonitor=false"]
    if os.name != "nt":
        safety_config.extend(["-c", "core.filemode=true"])
    completed = subprocess.run(
        [
            "git", *safety_config, *filter_config,
            "-C", str(repo), *args,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
        check=False,
    )
    if completed.returncode != 0 and not allow_failure:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise AnalyzerError(f"git {' '.join(args)} failed: {detail or 'unknown error'}")
    return completed.stdout


def repository_root(repo: Path) -> Path:
    raw = run_git(repo, ["rev-parse", "--show-toplevel"])
    return Path(decode_path(raw).rstrip("\r\n")).resolve()


def resolve_commit(repo: Path, revision: str) -> str:
    raw = run_git(
        repo,
        ["rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"],
    )
    return raw.decode("ascii").strip()


def try_resolve_commit(repo: Path, revision: str) -> str | None:
    raw = run_git(
        repo,
        ["rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"],
        allow_failure=True,
    )
    value = raw.decode("ascii", errors="ignore").strip()
    return value or None


def diff_arguments(mode: str, base: str | None, head: str | None) -> list[str]:
    if mode == "staged":
        return ["--cached"]
    if mode == "range":
        if base is None or head is None:
            raise AnalyzerError("range mode requires both base and head revisions")
        return [base, head]
    return []


def diff_command(diff_args: Sequence[str], *tail: str) -> list[str]:
    return [
        "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--find-renames",
        "--find-copies-harder", *diff_args, *tail,
    ]


def parse_name_status(raw: bytes, *, layer: str = "range") -> list[Change]:
    fields = raw.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    changes: list[Change] = []
    index = 0
    while index < len(fields):
        status = decode_path(fields[index])
        index += 1
        if not status:
            raise AnalyzerError("git returned an empty change status")
        code = status[0]
        if code in {"R", "C"}:
            if index + 1 >= len(fields):
                raise AnalyzerError("git returned a truncated rename/copy record")
            old_path = decode_path(fields[index])
            new_path = decode_path(fields[index + 1])
            index += 2
            changes.append(Change(status=status, path=new_path, layer=layer, old_path=old_path))
        else:
            if index >= len(fields):
                raise AnalyzerError("git returned a truncated change record")
            changes.append(Change(status=status, path=decode_path(fields[index]), layer=layer))
            index += 1
    return changes


def parse_numstat(raw: bytes) -> dict[str, tuple[int | None, int | None, bool]]:
    fields = raw.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    result: dict[str, tuple[int | None, int | None, bool]] = {}
    index = 0
    while index < len(fields):
        header = decode_path(fields[index])
        index += 1
        parts = header.split("\t", 2)
        if len(parts) != 3:
            raise AnalyzerError("git returned a malformed numstat record")
        added_raw, deleted_raw, path = parts
        if path == "":
            if index + 1 >= len(fields):
                raise AnalyzerError("git returned a truncated rename numstat record")
            index += 1  # old path
            path = decode_path(fields[index])
            index += 1
        binary = added_raw == "-" or deleted_raw == "-"
        additions = None if binary else int(added_raw)
        deletions = None if binary else int(deleted_raw)
        result[path] = (additions, deletions, binary)
    return result


def parse_raw_modes(raw: bytes) -> dict[str, tuple[str, str, str, str]]:
    fields = raw.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    result: dict[str, tuple[str, str, str, str]] = {}
    index = 0
    while index < len(fields):
        header = decode_path(fields[index])
        index += 1
        if not header.startswith(":"):
            raise AnalyzerError("git returned a malformed raw diff record")
        pieces = header[1:].split()
        if len(pieces) != 5:
            raise AnalyzerError("git returned an unexpected raw diff header")
        old_mode, new_mode, old_oid, new_oid, status = pieces
        if status[0] in {"R", "C"}:
            if index + 1 >= len(fields):
                raise AnalyzerError("git returned a truncated raw rename/copy record")
            index += 1
            path = decode_path(fields[index])
            index += 1
        else:
            if index >= len(fields):
                raise AnalyzerError("git returned a truncated raw diff record")
            path = decode_path(fields[index])
            index += 1
        result[path] = (old_mode, new_mode, old_oid, new_oid)
    return result


def is_probably_binary(path: Path) -> bool:
    if path.suffix.lower() in BINARY_EXTENSIONS:
        return True
    try:
        with path.open("rb") as handle:
            return b"\0" in handle.read(8192)
    except OSError as error:
        raise AnalyzerError(f"could not inspect untracked file {path}: {error}") from error


def untracked_changes(repo: Path) -> list[Change]:
    raw = run_git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
    paths = sorted(decode_path(item) for item in raw.split(b"\0") if item)
    result: list[Change] = []
    for relative in paths:
        absolute = repo / relative
        try:
            metadata = absolute.lstat()
        except OSError as error:
            raise AnalyzerError(f"could not inspect untracked path {relative}: {error}") from error
        if stat.S_ISLNK(metadata.st_mode):
            result.append(
                Change(
                    status="?",
                    path=relative,
                    layer="untracked",
                    additions=1,
                    deletions=0,
                    binary=False,
                    symlink=True,
                )
            )
            continue
        if stat.S_ISDIR(metadata.st_mode):
            result.append(
                Change(
                    status="?",
                    path=relative,
                    layer="untracked",
                    additions=None,
                    deletions=None,
                    gitlink=(absolute / ".git").exists(),
                    opaque=True,
                    verifiable=False,
                )
            )
            continue
        if not stat.S_ISREG(metadata.st_mode):
            continue
        binary = is_probably_binary(absolute)
        verifiable = metadata.st_size <= MAX_WORKTREE_HASH_BYTES
        additions: int | None = None
        if not binary:
            try:
                size = absolute.stat().st_size
                if size <= MAX_UNTRACKED_LINE_COUNT_BYTES:
                    content = absolute.read_bytes()
                    additions = content.count(b"\n") + (1 if content and not content.endswith(b"\n") else 0)
            except OSError as error:
                raise AnalyzerError(f"could not read untracked file {relative}: {error}") from error
        result.append(
            Change(
                status="?",
                path=relative,
                layer="untracked",
                additions=additions,
                deletions=0,
                binary=binary,
                verifiable=verifiable,
            )
        )
    return result


def unmerged_paths(repo: Path) -> set[str]:
    raw = run_git(repo, ["ls-files", "--unmerged", "-z"])
    result: set[str] = set()
    for record in raw.split(b"\0"):
        if not record:
            continue
        try:
            _metadata, path = record.split(b"\t", 1)
        except ValueError as error:
            raise AnalyzerError("git returned a malformed unmerged-index record") from error
        result.add(decode_path(path))
    return result


def collect_diff_layer(
    repo: Path,
    diff_args: Sequence[str],
    *,
    layer: str,
) -> tuple[list[Change], list[str]]:
    name_raw = run_git(repo, diff_command(diff_args, "--name-status", "-z"))
    numstat_raw = run_git(repo, diff_command(diff_args, "--numstat", "-z"))
    modes_raw = run_git(
        repo,
        diff_command(diff_args, "--raw", "--full-index", "--no-abbrev", "-z"),
    )
    changes = parse_name_status(name_raw, layer=layer)
    stats = parse_numstat(numstat_raw)
    modes = parse_raw_modes(modes_raw)
    warnings: list[str] = []
    for change in changes:
        line_stat = stats.get(change.path)
        if line_stat is None:
            warnings.append(f"No line statistics were available for {change.path}")
            change.additions = None
            change.deletions = None
        else:
            change.additions, change.deletions, change.binary = line_stat
        mode_pair = modes.get(change.path)
        if mode_pair is not None:
            change.old_mode, change.new_mode, change.old_oid, change.new_oid = mode_pair
            change.symlink = "120000" in mode_pair[:2]
            change.gitlink = "160000" in mode_pair[:2]
            if change.gitlink:
                change.verifiable = False
    return changes, warnings


def collect_changes(
    repo: Path,
    *,
    mode: str,
    base: str | None,
    head: str | None,
    include_untracked: bool,
    excluded_paths: set[str] | None = None,
) -> tuple[list[Change], list[str]]:
    changes: list[Change] = []
    warnings: list[str] = []
    if mode == "worktree":
        layers = [("staged", ["--cached"]), ("unstaged", [])]
    elif mode == "staged":
        layers = [("staged", ["--cached"])]
    else:
        layers = [("range", diff_arguments(mode, base, head))]
    for layer, diff_args in layers:
        layer_changes, layer_warnings = collect_diff_layer(repo, diff_args, layer=layer)
        changes.extend(layer_changes)
        warnings.extend(layer_warnings)
    if mode == "worktree" and include_untracked:
        changes.extend(untracked_changes(repo))
    if mode in {"worktree", "staged"}:
        conflicted = unmerged_paths(repo)
        if conflicted:
            changes = [change for change in changes if change.path not in conflicted]
            changes.extend(
                Change(
                    status="U",
                    path=path,
                    layer="unmerged",
                    additions=None,
                    deletions=None,
                    verifiable=False,
                )
                for path in conflicted
            )
    if excluded_paths:
        changes = [
            change for change in changes
            if not (
                change.path in excluded_paths
                and (change.old_path is None or change.old_path in excluded_paths)
            )
        ]
    changes.sort(key=lambda item: (item.path, item.layer, item.status, item.old_path or ""))
    return changes, warnings


def normalized_parts(path: str) -> tuple[str, ...]:
    normalized = path
    while normalized.startswith("./"):
        normalized = normalized[2:]
    normalized = normalized.lstrip("/")
    return tuple(part.lower() for part in PurePosixPath(normalized).parts)


def path_tokens(parts: Sequence[str]) -> set[str]:
    tokens: set[str] = set()
    for part in parts:
        expanded = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", part)
        tokens.update(token.lower() for token in re.findall(r"[A-Za-z0-9]+", expanded))
    return tokens


def classify_path(path: str, *, binary: bool = False) -> list[str]:
    parts = normalized_parts(path)
    tokens = path_tokens(PurePosixPath(path).parts)
    joined = "/".join(parts)
    name = parts[-1] if parts else ""
    suffix = PurePosixPath(name).suffix.lower()
    surfaces: set[str] = set()

    if binary or suffix in BINARY_EXTENSIONS:
        surfaces.add("binary")
    if suffix in DOC_EXTENSIONS or name.startswith("readme") or "docs" in parts:
        surfaces.add("docs")
    if (
        "test" in parts
        or "tests" in parts
        or re.search(r"(?:^|[._-])(test|spec)(?:[._-]|$)", name)
    ):
        surfaces.add("tests")
    if ".agents" in parts or "skills" in parts or name in {"agents.md", "skill.md"}:
        surfaces.add("skills")
    if suffix in SOURCE_EXTENSIONS or any(part in {"src", "lib", "app", "apps", "packages"} for part in parts):
        surfaces.add("source")
    if suffix in CONFIG_EXTENSIONS or "config" in tokens or name.startswith(".env"):
        surfaces.add("config")
    if joined.startswith(".github/workflows/") or ".gitlab-ci" in joined or name == "azure-pipelines.yml":
        surfaces.add("ci")
    dependency_names = {
        "cargo.lock", "cargo.toml", "go.mod", "go.sum", "package-lock.json",
        "package.json", "pnpm-lock.yaml", "pyproject.toml", "requirements.txt",
        "uv.lock", "yarn.lock", "pipfile", "pipfile.lock", "poetry.lock",
        "gemfile", "gemfile.lock", "pom.xml", "build.gradle", "build.gradle.kts",
        "gradle.lockfile", "composer.json", "composer.lock",
    }
    if (
        name in dependency_names
        or (name.startswith("requirements") and name.endswith(".txt"))
        or "requirements" in parts
        or "lock-python" in joined
    ):
        surfaces.add("dependencies")
    if (
        name.startswith("install")
        or "installer" in joined
        or "packaging" in parts
        or "formula" in parts
        or name.startswith(("dockerfile", "containerfile", "makefile"))
    ):
        surfaces.add("installers")
    if (
        "release" in tokens
        or name.startswith("changelog")
        or name in {"version", "version.txt"}
        or joined.startswith(".changeset/")
    ):
        surfaces.add("release")
    security_terms = {
        "auth", "credential", "crypto", "key", "oauth", "permission", "privacy",
        "secret", "security", "token",
    }
    if security_terms.intersection(tokens):
        surfaces.add("security")
    protocol_terms = {"api", "protobuf", "protocol", "schema", "stream", "transport", "wire"}
    if protocol_terms.intersection(tokens):
        surfaces.add("protocol")
    state_terms = {"migration", "ownership", "persistence", "settings", "state"}
    if name.startswith(".env") or state_terms.intersection(tokens) or any(
        term in joined for term in {"config-manager", "state-owner"}
    ):
        surfaces.add("state")
    concurrency_terms = {"concurrency", "lock", "queue", "race", "semaphore", "supervisor"}
    if concurrency_terms.intersection(tokens):
        surfaces.add("concurrency")
    if any(part in {"dist", "generated", "vendor"} for part in parts):
        surfaces.add("generated")
    if suffix in {".css", ".html", ".scss", ".sass", ".svg"} or any(
        part in {"desktop", "frontend", "tray", "ui", "web"} for part in parts
    ):
        surfaces.add("ui")
    if suffix in {".ps1", ".sh"} or any(part in {"linux", "macos", "windows"} for part in parts):
        surfaces.add("platform")
    if not surfaces:
        surfaces.add("unknown")
    return sorted(surfaces)


def diff_for_path(repo: Path, diff_args: Sequence[str], path: str, old_path: str | None) -> str:
    candidates = [path]
    raw = run_git(
        repo,
        diff_command(diff_args, "--unified=0", "--no-color", "--", *candidates),
    )
    return raw.decode("utf-8", errors="surrogateescape")


def parse_hunks(
    path: str,
    patch: str,
    surfaces: Sequence[str],
    *,
    layer: str = "range",
    verifiable: bool = True,
    status: str = "M",
    old_path: str | None = None,
) -> list[dict[str, Any]]:
    lines = patch.splitlines(keepends=True)
    items: list[dict[str, Any]] = []
    first_hunk = next(
        (offset for offset, line in enumerate(lines) if HUNK_RE.match(line.rstrip("\r\n"))),
        len(lines),
    )
    envelope = "".join(lines[:first_hunk])
    index = 0
    while index < len(lines):
        match = HUNK_RE.match(lines[index].rstrip("\r\n"))
        if match is None:
            index += 1
            continue
        header = lines[index].rstrip("\r\n")
        body: list[str] = []
        index += 1
        while index < len(lines):
            candidate = lines[index].rstrip("\r\n")
            if HUNK_RE.match(candidate) or candidate.startswith("diff --git "):
                break
            body.append(lines[index])
            index += 1
        old_start = int(match.group(1))
        old_lines = int(match.group(2) or "1")
        new_start = int(match.group(3))
        new_lines = int(match.group(4) or "1")
        identity = json.dumps(
            {
                "layer": layer,
                "oldPath": old_path,
                "path": path,
                "status": status,
                "surfaces": list(surfaces),
            },
            ensure_ascii=True,
            sort_keys=True,
        )
        digest_input = (identity + "\0" + envelope + "\0" + header + "\0" + "".join(body)).encode(
            "utf-8", errors="surrogateescape"
        )
        items.append(
            {
                "id": hashlib.sha256(digest_input).hexdigest()[:20],
                "path": path,
                "layer": layer,
                "oldRange": [old_start, old_lines],
                "newRange": [new_start, new_lines],
                "surfaces": list(surfaces),
                "verifiable": verifiable,
            }
        )
    return items


def untracked_review_item(repo: Path, change: Change) -> dict[str, Any]:
    absolute = repo / change.path
    try:
        filesystem_mode = absolute.lstat().st_mode
    except OSError as error:
        raise AnalyzerError(f"could not inspect untracked path {change.path}: {error}") from error
    digest = hashlib.sha256()
    digest.update(
        json.dumps(
            {
                "gitlink": change.gitlink,
                "filesystemMode": filesystem_mode,
                "layer": change.layer,
                "opaque": change.opaque,
                "path": change.path,
                "status": change.status,
                "surfaces": change.surfaces,
                "symlink": change.symlink,
                "verifiable": change.verifiable,
            },
            ensure_ascii=True,
            sort_keys=True,
        ).encode("utf-8")
    )
    digest.update(b"\0untracked\0")
    try:
        if change.symlink:
            digest.update(os.readlink(absolute).encode("utf-8", errors="surrogateescape"))
        elif not change.verifiable:
            metadata = absolute.lstat()
            digest.update(f"{metadata.st_mode}:{metadata.st_size}:{metadata.st_mtime_ns}".encode("ascii"))
        else:
            with absolute.open("rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
    except OSError as error:
        change.verifiable = False
        digest.update(str(error).encode("utf-8", errors="replace"))
    return {
        "id": digest.hexdigest()[:20],
        "path": change.path,
        "layer": change.layer,
        "oldRange": [0, 0],
        "newRange": [1, change.additions or 0],
        "surfaces": change.surfaces,
        "untracked": True,
        "symlink": change.symlink,
        "opaque": change.opaque,
        "gitlink": change.gitlink,
        "verifiable": change.verifiable,
    }


def binary_review_item(
    repo: Path,
    change: Change,
    diff_args: Sequence[str],
    mode: str,
) -> dict[str, Any]:
    candidates = [change.path]
    raw = run_git(
        repo,
        diff_command(diff_args, "--raw", "--full-index", "-z", "--", *candidates),
    )
    digest = hashlib.sha256()
    digest.update(
        json.dumps(
            {
                "layer": change.layer,
                "oldPath": change.old_path,
                "path": change.path,
                "status": change.status,
                "surfaces": change.surfaces,
            },
            ensure_ascii=True,
            sort_keys=True,
        ).encode("utf-8")
    )
    digest.update(b"\0binary\0")
    digest.update(raw)
    if change.layer == "unstaged":
        absolute = repo / change.path
        if absolute.is_file():
            try:
                if absolute.stat().st_size > MAX_WORKTREE_HASH_BYTES:
                    change.verifiable = False
                else:
                    with absolute.open("rb") as handle:
                        while True:
                            chunk = handle.read(1024 * 1024)
                            if not chunk:
                                break
                            digest.update(chunk)
            except OSError as error:
                change.verifiable = False
                digest.update(str(error).encode("utf-8", errors="replace"))
    return {
        "id": digest.hexdigest()[:20],
        "path": change.path,
        "layer": change.layer,
        "oldRange": [0, 0],
        "newRange": [0, 0],
        "surfaces": change.surfaces,
        "binary": True,
        "verifiable": change.verifiable,
    }


def metadata_review_item(change: Change, patch: str) -> dict[str, Any]:
    digest = hashlib.sha256()
    digest.update(change.path.encode("utf-8", errors="surrogateescape"))
    digest.update(b"\0" + change.layer.encode("ascii") + b"\0metadata\0")
    digest.update(change.status.encode("ascii", errors="replace"))
    digest.update(b"\0")
    if change.old_path:
        digest.update(change.old_path.encode("utf-8", errors="surrogateescape"))
    digest.update(b"\0")
    digest.update(json.dumps(change.surfaces, ensure_ascii=True).encode("utf-8"))
    digest.update(b"\0")
    digest.update(patch.encode("utf-8", errors="surrogateescape"))
    return {
        "id": digest.hexdigest()[:20],
        "path": change.path,
        "layer": change.layer,
        "oldRange": [0, 0],
        "newRange": [0, 0],
        "surfaces": change.surfaces,
        "metadataOnly": True,
        "verifiable": change.verifiable,
    }


def summary_review_item(change: Change, reason: str) -> dict[str, Any]:
    identity = {
        "binary": change.binary,
        "gitlink": change.gitlink,
        "layer": change.layer,
        "newMode": change.new_mode,
        "newOid": change.new_oid,
        "oldMode": change.old_mode,
        "oldOid": change.old_oid,
        "oldPath": change.old_path,
        "path": change.path,
        "status": change.status,
        "surfaces": change.surfaces,
        "summaryReason": reason,
        "symlink": change.symlink,
    }
    digest = hashlib.sha256(
        json.dumps(identity, ensure_ascii=True, sort_keys=True).encode("utf-8")
    ).hexdigest()[:20]
    return {
        "id": digest,
        "path": change.path,
        "layer": change.layer,
        "oldRange": [0, 0],
        "newRange": [0, 0],
        "surfaces": change.surfaces,
        "summaryOnly": True,
        "summaryReason": reason,
        "opaque": change.opaque,
        "gitlink": change.gitlink,
        "symlink": change.symlink,
        "verifiable": False,
    }


def object_size(repo: Path, oid: str | None, cache: dict[str, int]) -> int:
    if oid is None or set(oid) == {"0"}:
        return 0
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", oid):
        raise AnalyzerError("git returned an invalid object id")
    if oid not in cache:
        raw = run_git(repo, ["cat-file", "-s", oid])
        try:
            cache[oid] = int(raw.decode("ascii").strip())
        except ValueError as error:
            raise AnalyzerError("git returned an invalid object size") from error
    return cache[oid]


def detailed_review_blocker(
    repo: Path,
    change: Change,
    object_sizes: dict[str, int],
) -> str | None:
    if not change.verifiable:
        return "opaque, conflicted, gitlink, or oversized item"
    if change.status == "?":
        absolute = repo / change.path
        try:
            if absolute.is_file() and absolute.lstat().st_size > MAX_DETAILED_BLOB_BYTES:
                return f"untracked file exceeds {MAX_DETAILED_BLOB_BYTES} bytes"
        except OSError as error:
            raise AnalyzerError(f"could not inspect untracked path {change.path}: {error}") from error
        return None
    for oid in (change.old_oid, change.new_oid):
        if object_size(repo, oid, object_sizes) > MAX_DETAILED_BLOB_BYTES:
            return f"blob exceeds {MAX_DETAILED_BLOB_BYTES} bytes"
    if change.layer == "unstaged":
        absolute = repo / change.path
        try:
            if absolute.is_file() and absolute.lstat().st_size > MAX_DETAILED_BLOB_BYTES:
                return f"worktree file exceeds {MAX_DETAILED_BLOB_BYTES} bytes"
        except OSError as error:
            raise AnalyzerError(f"could not inspect changed path {change.path}: {error}") from error
    return None


def collect_review_items(
    repo: Path,
    changes: Sequence[Change],
    *,
    mode: str,
    base: str | None,
    head: str | None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    changed_lines = sum((change.additions or 0) + (change.deletions or 0) for change in changes)
    global_blocker: str | None = None
    if len(changes) > MAX_DETAILED_FILES:
        global_blocker = f"change count exceeds {MAX_DETAILED_FILES} detailed items"
    elif changed_lines > MAX_DETAILED_CHANGED_LINES:
        global_blocker = f"changed line count exceeds {MAX_DETAILED_CHANGED_LINES}"
    object_sizes: dict[str, int] = {}
    for change in changes:
        blocker = global_blocker or detailed_review_blocker(repo, change, object_sizes)
        if blocker is not None:
            change.verifiable = False
            items.append(summary_review_item(change, blocker))
            continue
        if change.layer == "range":
            args = diff_arguments("range", base, head)
        elif change.layer == "staged":
            args = ["--cached"]
        else:
            args = []
        if change.status == "?":
            items.append(untracked_review_item(repo, change))
        elif change.binary:
            items.append(binary_review_item(repo, change, args, mode))
        else:
            patch = diff_for_path(repo, args, change.path, change.old_path)
            parsed = parse_hunks(
                change.path,
                patch,
                change.surfaces,
                layer=change.layer,
                verifiable=change.verifiable,
                status=change.status,
                old_path=change.old_path,
            )
            items.extend(parsed or [metadata_review_item(change, patch)])
    return sorted(items, key=lambda item: (item["path"], item["newRange"], item["id"]))


def working_tree_paths(repo: Path) -> set[str]:
    changes, _ = collect_changes(
        repo,
        mode="worktree",
        base=None,
        head=None,
        include_untracked=True,
        excluded_paths=None,
    )
    return {
        path
        for change in changes
        for path in (change.path, change.old_path)
        if path is not None
    }


def top_level(path: str) -> str:
    parts = normalized_parts(path)
    return parts[0] if len(parts) > 1 else "."


def case_alias_groups(paths: Iterable[str]) -> list[list[str]]:
    casefolded: dict[str, list[str]] = {}
    for path in sorted(set(paths)):
        key = unicodedata.normalize("NFC", path).casefold()
        casefolded.setdefault(key, []).append(path)
    return sorted(
        (aliases for aliases in casefolded.values() if len(aliases) > 1),
        key=lambda aliases: tuple(aliases),
    )


def analyze_report(
    repo: Path,
    *,
    mode: str,
    base: str | None,
    head: str | None,
    include_untracked: bool,
    excluded_paths: set[str] | None = None,
) -> dict[str, Any]:
    repo = repository_root(repo)
    if mode == "range":
        if not isinstance(base, str) or not isinstance(head, str):
            raise AnalyzerError("range mode requires resolved commit ids")
        if not OID_RE.fullmatch(base) or not OID_RE.fullmatch(head):
            raise AnalyzerError("range revisions must be full lowercase commit ids")
        if resolve_commit(repo, base) != base or resolve_commit(repo, head) != head:
            raise AnalyzerError("range revision no longer resolves to the recorded commit")
    changes, warnings = collect_changes(
        repo,
        mode=mode,
        base=base,
        head=head,
        include_untracked=include_untracked,
        excluded_paths=excluded_paths,
    )
    for change in changes:
        change.surfaces = sorted(
            set(classify_path(change.path, binary=change.binary)).union(
                classify_path(change.old_path, binary=change.binary)
                if change.old_path else set()
            )
        )
        if change.symlink:
            change.surfaces = sorted(set(change.surfaces).union({"links"}))
        if change.gitlink or change.opaque:
            change.surfaces = sorted(
                set(change.surfaces).union({"embedded-repository"})
            )
        if change.layer == "unmerged":
            change.surfaces = sorted(set(change.surfaces).union({"unmerged"}))

    review_items = collect_review_items(repo, changes, mode=mode, base=base, head=head)
    surfaces = sorted({surface for change in changes for surface in change.surfaces})
    independent_surfaces = sorted(
        set(surfaces).difference({"binary", "docs", "tests", "unknown"})
    )
    all_changed_paths = {
        path
        for change in changes
        for path in (change.path, change.old_path)
        if path is not None
    }
    unique_paths = {change.path for change in changes}
    directories = sorted({top_level(path) for path in all_changed_paths})
    known_additions = sum(change.additions or 0 for change in changes)
    known_deletions = sum(change.deletions or 0 for change in changes)
    changed_lines = known_additions + known_deletions
    unknown_line_stats = sum(
        1 for change in changes if change.additions is None or change.deletions is None
    )

    critical_hits = sorted(CRITICAL_SURFACES.intersection(surfaces))
    risk_reasons: list[str] = []
    docs_only = bool(changes) and set(surfaces).issubset({"docs"})
    if critical_hits:
        risk = "critical"
        risk_reasons.append("Critical surfaces changed: " + ", ".join(critical_hits))
    elif not changes or docs_only:
        risk = "minor"
        risk_reasons.append("Only documentation-like paths changed" if changes else "No changes detected")
    elif len(independent_surfaces) >= 3 or len(directories) >= 3 or len(unique_paths) >= 8 or changed_lines >= 250:
        risk = "cross-cutting"
        if len(independent_surfaces) >= 3:
            risk_reasons.append(f"The diff crosses {len(independent_surfaces)} semantic surfaces")
        if len(directories) >= 3:
            risk_reasons.append(f"The diff crosses {len(directories)} top-level paths")
        if len(unique_paths) >= 8:
            risk_reasons.append(f"The diff changes {len(unique_paths)} files")
        if changed_lines >= 250:
            risk_reasons.append(f"The diff changes at least {changed_lines} text lines")
    else:
        risk = "local"
        risk_reasons.append("The diff appears bounded but contains semantic or repository-control surfaces")

    if unknown_line_stats:
        risk_reasons.append(f"{unknown_line_stats} file(s) have unknown or binary line statistics")

    if risk == "critical":
        verification_tier = "full"
    elif risk == "cross-cutting" or "ci" in surfaces:
        verification_tier = "expanded"
    elif risk == "local":
        verification_tier = "targeted"
    else:
        verification_tier = "review-only"

    fanout_reasons: list[str] = []
    if len(independent_surfaces) >= 3:
        fanout_reasons.append("multiple independently reviewable surfaces")
    if len(unique_paths) >= 8 and not docs_only:
        fanout_reasons.append("eight or more changed files")
    if len(review_items) >= 12:
        fanout_reasons.append("twelve or more review hunks")
    if changed_lines >= 250:
        fanout_reasons.append("at least 250 changed text lines")
    if critical_hits:
        fanout_reasons.append("independent review is useful for critical surfaces")
    scale_signal = (
        len(independent_surfaces) >= 3
        or (len(unique_paths) >= 8 and not docs_only)
        or (len(review_items) >= 12 and not docs_only)
        or (changed_lines >= 250 and not docs_only)
    )
    if scale_signal and len(unique_paths) > 1:
        fanout_decision = "recommended"
    elif critical_hits:
        fanout_decision = "consider"
    else:
        fanout_decision = "none"

    suggested_roles: list[str] = []
    if fanout_decision != "none":
        suggested_roles.extend(["correctness-security", "integration-verification"])
        if mode == "range":
            suggested_roles.insert(0, "intent-adoption")
        if "platform" in surfaces or "installers" in surfaces:
            suggested_roles.append("platform-parity")

    changed_paths = all_changed_paths
    for aliases in case_alias_groups(changed_paths):
        warnings.append(
            "Changed paths may alias on a case-insensitive filesystem: "
            + ", ".join(aliases)
        )
    if "install.sh" in changed_paths and "install.ps1" not in changed_paths:
        warnings.append("install.sh changed without install.ps1; review Windows parity explicitly")
    if "install.ps1" in changed_paths and "install.sh" not in changed_paths:
        warnings.append("install.ps1 changed without install.sh; review POSIX parity explicitly")
    if "requirements/python.txt" in changed_paths and not {
        "requirements/python.in", "src/install-plan.mjs"
    }.intersection(changed_paths):
        warnings.append("The generated Python lock changed without its declared inputs")
    if "source" in surfaces and "tests" not in surfaces:
        warnings.append("Source changed without a changed test file; confirm meaningful existing coverage")
    if "binary" in surfaces or "generated" in surfaces:
        warnings.append("Opaque or generated artifacts require provenance and regeneration evidence")
    if any(change.symlink for change in changes):
        warnings.append("Symlinks are reviewed as link metadata; targets are not followed")
    if any(change.opaque for change in changes):
        warnings.append("Opaque untracked directories or nested repositories are not traversed; inspect them separately")
    if any(not change.verifiable for change in changes):
        warnings.append("One or more opaque or oversized items cannot receive a successful coverage verification")
    if any(change.layer == "unmerged" for change in changes):
        warnings.append("Unresolved merge conflicts must be resolved before maintenance review can pass")
    if "ui" in surfaces:
        warnings.append("Visible UI changes require rendered or interactive visual verification")

    dirty_overlap: list[str] = []
    if mode == "range":
        dirty_paths = working_tree_paths(repo)
        dirty_by_key: dict[str, set[str]] = {}
        for path in dirty_paths:
            dirty_by_key.setdefault(path.casefold(), set()).add(path)
        dirty_overlap = sorted(
            path for path in changed_paths if path.casefold() in dirty_by_key
        )
        if dirty_overlap:
            warnings.append("Candidate paths overlap the dirty worktree; preserve and reconcile local work before adoption")

    resolved_head = try_resolve_commit(repo, "HEAD")
    revision: dict[str, Any] = {
        "mode": mode,
        "repositoryIdentity": hashlib.sha256(str(repo).encode("utf-8")).hexdigest()[:20],
        "repositoryHead": resolved_head,
        "includesUntracked": mode == "worktree" and include_untracked,
        "excludedArtifacts": sorted(excluded_paths or set()),
    }
    if mode == "range":
        revision["base"] = base
        revision["head"] = head
    elif mode == "staged":
        revision["base"] = resolved_head
        revision["head"] = "INDEX"
    else:
        revision["base"] = resolved_head
        revision["head"] = "WORKTREE"

    return {
        "schemaVersion": SCHEMA_VERSION,
        "revision": revision,
        "summary": {
            "files": len(unique_paths),
            "deltas": len(changes),
            "hunks": len(review_items),
            "additions": known_additions,
            "deletions": known_deletions,
            "unknownLineStats": unknown_line_stats,
            "topLevelPaths": directories,
        },
        "risk": {"level": risk, "reasons": risk_reasons},
        "surfaces": surfaces,
        "fanout": {
            "decision": fanout_decision,
            "reasons": fanout_reasons,
            "suggestedReadOnlyRoles": suggested_roles,
        },
        "verification": {
            "tier": verification_tier,
            "minimum": [
                "inspect every changed hunk",
                "git diff --check plus an equivalent check for untracked files",
            ],
            "note": "The agent must select repository checks that directly exercise the changed behavior.",
        },
        "adoption": {
            "decision": (
                "blocked-unresolved-conflict"
                if "unmerged" in surfaces
                else "needs-human-judgment" if changes else "no-change"
            ),
            "dirtyOverlap": dirty_overlap,
        },
        "changes": [change.as_dict() for change in changes],
        "reviewItems": review_items,
        "warnings": sorted(set(warnings)),
        "limitations": [
            "Path classification cannot determine semantic correctness or test sufficiency.",
            "Fan-out requires independent workstreams; this analyzer cannot prove that they exist.",
            "Configured Git clean/process filters are neutralized; inspect generated or filtered-file semantics separately.",
            "The analyzer never fetches, pulls, merges, or runs tests; it edits only the explicitly named manifest destination when --manifest is used.",
        ],
    }


def markdown_escape(value: str) -> str:
    escaped: list[str] = []
    for character in value:
        code = ord(character)
        if character == "\r":
            escaped.append("\\r")
        elif character == "\n":
            escaped.append("\\n")
        elif character == "\t":
            escaped.append("\\t")
        elif code < 0x20 or code == 0x7F or 0x202A <= code <= 0x202E or 0x2066 <= code <= 0x2069:
            escaped.append(f"\\u{code:04x}")
        else:
            escaped.append(character)
    return "".join(escaped)


def markdown_code(value: str) -> str:
    safe = markdown_escape(value)
    longest = max((len(run) for run in re.findall(r"`+", safe)), default=0)
    fence = "`" * (longest + 1)
    padding = " " if safe.startswith(("`", " ")) or safe.endswith(("`", " ")) else ""
    return f"{fence}{padding}{safe}{padding}{fence}"


def markdown_text(value: str) -> str:
    return re.sub(r"([\\`*{}\[\]()#+\-.!_|<>])", r"\\\1", markdown_escape(value))


def render_markdown(report: dict[str, Any]) -> str:
    revision = report["revision"]
    summary = report["summary"]
    lines = [
        "# Repository change impact",
        "",
        f"- Boundary: {markdown_code(str(revision['base']))} -> {markdown_code(str(revision['head']))} ({revision['mode']})",
        f"- Files/hunks: {summary['files']} / {summary['hunks']}",
        f"- Known line changes: +{summary['additions']} / -{summary['deletions']}",
        f"- Risk: **{report['risk']['level']}**",
        f"- Fan-out: **{report['fanout']['decision']}**",
        f"- Verification: **{report['verification']['tier']}**",
        "",
        "## Risk reasons",
        "",
    ]
    lines.extend(f"- {reason}" for reason in report["risk"]["reasons"])
    lines.extend(["", "## Surfaces", "", ", ".join(report["surfaces"]) or "none"])
    lines.extend(["", "## Changed files", ""])
    for change in report["changes"]:
        stats = "binary/unknown" if change["additions"] is None or change["deletions"] is None else f"+{change['additions']}/-{change['deletions']}"
        old = f" (from {markdown_code(change['oldPath'])})" if "oldPath" in change else ""
        lines.append(
            f"- {markdown_code(change['path'])}{old}: {change['status']}, {stats}; "
            + ", ".join(change["surfaces"])
        )
    if report["warnings"]:
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {markdown_text(warning)}" for warning in report["warnings"])
    if report["fanout"]["reasons"]:
        lines.extend(["", "## Fan-out signals", ""])
        lines.extend(f"- {reason}" for reason in report["fanout"]["reasons"])
    lines.extend(["", "The recommendations are conservative signals; inspect the diff semantically before acting."])
    return "\n".join(lines) + "\n"


def ensure_plain_directory(path: Path) -> None:
    path = Path(os.path.abspath(path))
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current = current / component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            current.mkdir()
            metadata = current.lstat()
        except OSError as error:
            raise AnalyzerError(f"could not inspect artifact directory {current}: {error}") from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise AnalyzerError(f"artifact directory component is not a plain directory: {current}")


def trusted_artifact_path(path: Path) -> Path:
    lexical = Path(os.path.abspath(path))
    current = Path(lexical.anchor)
    for component in lexical.parent.parts[1:]:
        current = current / component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise AnalyzerError(f"could not inspect artifact path {current}: {error}") from error
        if not stat.S_ISLNK(metadata.st_mode):
            continue
        parent_metadata = current.parent.stat()
        trusted_system_link = (
            os.name != "nt"
            and metadata.st_uid == 0
            and parent_metadata.st_uid == 0
            and not parent_metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
        )
        if not trusted_system_link:
            raise AnalyzerError(f"refusing symlinked artifact directory component: {current}")
    return Path(os.path.realpath(lexical.parent)) / lexical.name


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path = trusted_artifact_path(path)
    ensure_plain_directory(path.parent)
    try:
        existing = path.lstat()
    except FileNotFoundError:
        existing = None
    except OSError as error:
        raise AnalyzerError(f"could not inspect artifact destination {path}: {error}") from error
    if existing is not None and stat.S_ISLNK(existing.st_mode):
        raise AnalyzerError(f"refusing to replace symlink artifact destination: {path}")

    descriptor: int
    temporary: str
    directory_fd: int | None = None
    if os.name != "nt" and hasattr(os, "O_NOFOLLOW"):
        directory_fd = os.open(
            path.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW,
        )
        for _attempt in range(100):
            temporary = f".{path.name}.{secrets.token_hex(8)}"
            try:
                descriptor = os.open(
                    temporary,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                    dir_fd=directory_fd,
                )
                break
            except FileExistsError:
                continue
        else:
            os.close(directory_fd)
            raise AnalyzerError("could not allocate a temporary artifact file")
    else:
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, indent=2, sort_keys=True, ensure_ascii=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if directory_fd is not None:
            os.replace(
                temporary,
                path.name,
                src_dir_fd=directory_fd,
                dst_dir_fd=directory_fd,
            )
            os.fsync(directory_fd)
        else:
            os.replace(temporary, path)
    except BaseException:
        try:
            if directory_fd is not None:
                os.unlink(temporary, dir_fd=directory_fd)
            else:
                os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise AnalyzerError(f"{label} contains duplicate JSON key {key!r}")
            result[key] = value
        return result

    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=unique_object,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise AnalyzerError(f"could not read {label} {path}: {error}") from error
    if not isinstance(value, dict):
        raise AnalyzerError(f"{label} must contain a JSON object")
    return value


def verify_review(
    repo: Path,
    manifest_path: Path,
    evidence_path: Path,
    authorized_artifacts: Sequence[Path] = (),
) -> dict[str, Any]:
    repo = repository_root(repo)
    manifest = load_json_object(manifest_path, "manifest")
    evidence = load_json_object(evidence_path, "evidence")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise AnalyzerError("manifest schema version is unsupported")
    revision = manifest.get("revision")
    if not isinstance(revision, dict):
        raise AnalyzerError("manifest revision is missing")
    if not isinstance(revision.get("repositoryIdentity"), str):
        raise AnalyzerError("manifest repository identity is missing")
    mode = revision.get("mode")
    if mode not in {"worktree", "staged", "range"}:
        raise AnalyzerError("manifest revision mode is invalid")
    base = revision.get("base") if mode == "range" else None
    head = revision.get("head") if mode == "range" else None
    if mode == "range":
        if (
            not isinstance(base, str)
            or not isinstance(head, str)
            or not OID_RE.fullmatch(base)
            or not OID_RE.fullmatch(head)
        ):
            raise AnalyzerError("range manifest revisions must be full lowercase commit ids")
        if resolve_commit(repo, base) != base or resolve_commit(repo, head) != head:
            raise AnalyzerError("range manifest revisions do not resolve to their recorded commits")
    recorded_exclusions = revision.get("excludedArtifacts", [])
    if not isinstance(recorded_exclusions, list) or not all(
        isinstance(path, str)
        and bool(path)
        and not PurePosixPath(path).is_absolute()
        and ".." not in PurePosixPath(path).parts
        for path in recorded_exclusions
    ):
        raise AnalyzerError("manifest excludedArtifacts are invalid")
    automatic_exclusions: set[str] = set()
    for artifact in (manifest_path, evidence_path):
        try:
            automatic_exclusions.add(artifact.resolve().relative_to(repo).as_posix())
        except ValueError:
            pass
    authorized_exclusions = set(automatic_exclusions)
    for artifact in authorized_artifacts:
        try:
            authorized_exclusions.add(artifact.resolve().relative_to(repo).as_posix())
        except ValueError:
            pass
    if not set(recorded_exclusions).issubset(authorized_exclusions):
        unauthorized = sorted(set(recorded_exclusions).difference(authorized_exclusions))
        raise AnalyzerError(
            "manifest contains unauthorized artifact exclusions: " + ", ".join(unauthorized)
        )
    excluded_paths = set(recorded_exclusions).union(automatic_exclusions)
    current = analyze_report(
        repo,
        mode=mode,
        base=base,
        head=head,
        include_untracked=bool(revision.get("includesUntracked", False)),
        excluded_paths=excluded_paths,
    )
    manifest_items = manifest.get("reviewItems")
    if not isinstance(manifest_items, list) or not all(
        isinstance(item, dict) and isinstance(item.get("id"), str)
        for item in manifest_items
    ):
        raise AnalyzerError("manifest reviewItems must be an array of hunk objects")
    manifest_id_list = [item["id"] for item in manifest_items]
    if len(manifest_id_list) != len(set(manifest_id_list)):
        raise AnalyzerError("manifest contains duplicate hunk ids")
    manifest_ids = set(manifest_id_list)
    current_ids = {item["id"] for item in current["reviewItems"]}
    unverifiable = sorted(
        item["id"] for item in current["reviewItems"] if not item.get("verifiable", True)
    )
    reviewed_raw = evidence.get("reviewed", [])
    allowed_verdicts = {"accepted", "finding", "not-applicable"}
    if not isinstance(reviewed_raw, list) or not all(
        isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item.get("verdict") in allowed_verdicts
        and isinstance(item.get("note"), str)
        and bool(item["note"].strip())
        for item in reviewed_raw
    ):
        raise AnalyzerError(
            "evidence.reviewed must contain objects with id, verdict, and a non-empty note"
        )
    reviewed_ids = [item["id"] for item in reviewed_raw]
    if len(reviewed_ids) != len(set(reviewed_ids)):
        raise AnalyzerError("evidence.reviewed contains duplicate hunk ids")
    reviewed = set(reviewed_ids)
    verdict_counts = {
        verdict: sum(1 for item in reviewed_raw if item["verdict"] == verdict)
        for verdict in sorted(allowed_verdicts)
    }
    missing = sorted(current_ids - reviewed)
    stale = sorted(manifest_ids - current_ids)
    unknown = sorted(reviewed - current_ids)
    boundary_changed = (
        manifest.get("revision", {}).get("repositoryIdentity")
        != current.get("revision", {}).get("repositoryIdentity")
        or (
            mode in {"worktree", "staged"}
            and manifest.get("revision", {}).get("base")
            != current.get("revision", {}).get("base")
        )
        or (
            mode == "range"
            and manifest.get("adoption", {}).get("dirtyOverlap")
            != current.get("adoption", {}).get("dirtyOverlap")
        )
    )
    coverage_complete = (
        not missing and not stale and not unknown and not boundary_changed and not unverifiable
    )
    return {
        "coverageComplete": coverage_complete,
        "hasFindings": verdict_counts["finding"] > 0,
        "boundaryChanged": boundary_changed,
        "currentHunks": len(current_ids),
        "reviewedHunks": len(reviewed.intersection(current_ids)),
        "verdictCounts": verdict_counts,
        "missing": missing,
        "stale": stale,
        "unknown": unknown,
        "unverifiable": unverifiable,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    analyze = subparsers.add_parser("analyze", help="analyze a worktree, index, or local revision range")
    analyze.add_argument("--repo", default=".", help="Git repository path")
    analyze.add_argument("--base", help="base commit for a local revision range")
    analyze.add_argument("--head", default="HEAD", help="head commit for a local revision range")
    analyze.add_argument("--staged", action="store_true", help="analyze only staged changes")
    analyze.add_argument("--no-untracked", action="store_true", help="exclude untracked files in worktree mode")
    analyze.add_argument("--format", choices=("json", "markdown"), default="markdown")
    analyze.add_argument("--manifest", help="optionally write the JSON report atomically")
    analyze.add_argument(
        "--exclude-artifact",
        action="append",
        default=[],
        help="exclude a generated review artifact path (repeatable)",
    )

    verify = subparsers.add_parser("verify-review", help="ensure evidence covers the current hunk ids")
    verify.add_argument("--repo", default=".", help="Git repository path")
    verify.add_argument("--manifest", required=True, help="analyzer JSON manifest")
    verify.add_argument("--evidence", required=True, help='JSON object with reviewed verdict records')
    verify.add_argument(
        "--exclude-artifact",
        action="append",
        default=[],
        help="authorize a recorded generated-artifact exclusion (repeatable)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        repo = repository_root(Path(args.repo).resolve())
        if args.command == "analyze":
            if args.staged and args.base is not None:
                raise AnalyzerError("--staged and --base are mutually exclusive")
            if args.base is None and args.head != "HEAD":
                raise AnalyzerError("--head requires --base")
            if args.staged:
                mode = "staged"
                base = None
                head = None
            elif args.base is not None:
                mode = "range"
                base = resolve_commit(repo, args.base)
                head = resolve_commit(repo, args.head)
            else:
                mode = "worktree"
                base = None
                head = None
            excluded_paths: set[str] = set()
            for artifact_path in ([args.manifest] if args.manifest else []) + args.exclude_artifact:
                try:
                    excluded_paths.add(
                        Path(artifact_path).resolve().relative_to(repo).as_posix()
                    )
                except ValueError:
                    pass
            report = analyze_report(
                repo,
                mode=mode,
                base=base,
                head=head,
                include_untracked=not args.no_untracked,
                excluded_paths=excluded_paths,
            )
            if args.manifest:
                atomic_write_json(Path(args.manifest), report)
            if args.format == "json":
                print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True))
            else:
                print(render_markdown(report), end="")
            return 0

        result = verify_review(
            repo,
            Path(args.manifest),
            Path(args.evidence),
            [Path(path) for path in args.exclude_artifact],
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["coverageComplete"] else 1
    except AnalyzerError as error:
        print(f"repo-maintainer: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
