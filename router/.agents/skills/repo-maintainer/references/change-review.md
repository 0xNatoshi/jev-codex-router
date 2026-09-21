# Change and adoption review

Use this procedure for an incoming commit, branch, patch, dependency update, or existing local diff.

## Fix the comparison boundary

Record the repository, base revision, head revision or working-tree state, and whether untracked files are included. Do not compare against a moving remote name without recording the resolved commit ids. Fetching, pulling, merging, or cherry-picking changes repository state; do it only when the user's request authorizes that operation.

## Reconstruct intent

Read the issue, commit message, release note, or upstream rationale when available, then verify it against code. Identify:

- the concrete failure or maintenance cost;
- affected users and supported environments;
- current behavior and desired behavior;
- compatibility and rollout constraints;
- whether the repository already solves the problem differently.

An attractive patch without a relevant problem is not a reason to adopt it.

## Inspect every hunk

For a substantial or high-risk review, capture stable hunk identifiers outside the repository:

```text
python3 <skill-dir>/scripts/repo_maintainer.py analyze --repo . --base BASE --head HEAD --format json --manifest <temporary-manifest.json>
```

`--manifest` is a write: it atomically creates or replaces the named JSON
artifact. It does not alter tracked worktree content unless that path itself is
tracked, but choose the destination deliberately.

Keep manifest and evidence files outside the repository when practical. If an artifact must live inside it, pass `--exclude-artifact PATH` for every pre-existing generated artifact so the manifest records and reproduces that exclusion; the manifest itself is excluded automatically. For an additional recorded artifact beyond the manifest and evidence files, repeat the same flag on `verify-review` to authorize that exclusion independently.

After actually reviewing a hunk and its surrounding code, add a verdict record to the evidence file. A valid file is:

```json
{
  "reviewed": [
    {
      "id": "HUNK_ID",
      "verdict": "accepted",
      "note": "Why this hunk is correct, or the concrete finding it produced."
    }
  ]
}
```

`verdict` is `accepted`, `finding`, or `not-applicable`; `note` must be non-empty. Then run:

```text
python3 <skill-dir>/scripts/repo_maintainer.py verify-review --repo . --manifest <temporary-manifest.json> --evidence <temporary-evidence.json>
```

Verification fails when a current hunk is missing, an id is unknown, the repository boundary moved, reviewed content or file metadata became stale, or a verdict record is malformed. Hunk ids are bookkeeping, not proof of judgment; never create a verdict without reading the hunk and its context.

`coverageComplete: true` means only that every current review item has a fresh verdict record. It does not approve the patch. Inspect `hasFindings` and the evidence notes before deciding adoption.

For each changed hunk, ask:

- Is it necessary for the stated outcome?
- Is the behavior correct for success, failure, cancellation, retry, cleanup, and partial state?
- Does it preserve public and persisted contracts?
- Are validation and trust boundaries on the correct side of the interface?
- Are errors diagnostic without leaking secrets?
- Can ordering, concurrency, caching, or retries make the result stale or duplicated?
- Are callers, mirrors, platform variants, and generated counterparts updated?
- Would removing this hunk make an existing or new test fail for the intended reason?

Check deletions and unchanged surrounding code as carefully as additions. Small diffs can change a high-risk invariant.

## Decide adoption

- **Adopt:** the problem is relevant, the approach fits repository contracts, the patch is complete, and risk-proportional verification supports it.
- **Adapt:** the idea is useful but the exact patch conflicts with local architecture, compatibility, security, style, or maintenance constraints. Describe the local implementation boundary.
- **Defer:** the change may be useful, but evidence, prerequisites, timing, or supported environments are insufficient. Name what would unblock it.
- **Reject:** the problem is irrelevant or already solved, the approach is unsound, or expected cost/risk exceeds supported benefit. Give technical evidence.

Do not equate a small patch with low risk or a large patch with high value.

## Required report

State:

1. the resolved comparison boundary;
2. the reconstructed intent;
3. the adoption decision and rationale;
4. findings ordered by severity with file-and-line evidence;
5. affected and verified-unaffected surfaces;
6. checks run and what each proves;
7. remaining uncertainty or prerequisites.
