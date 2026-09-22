---
name: repo-maintainer
description: Maintain or assess a large, mature repository when a proposed or existing change may cross modules, platforms, clients, installers, configuration, security boundaries, tests, or documentation. Use for incoming-change adoption decisions, consequential bug fixes, refactors, dependency upgrades, compatibility work, maintenance audits, and release preparation. Do not use for factual questions or obviously isolated trivial edits.
---

# Repo Maintainer

Make cross-repository consequences visible before accepting, implementing, or declaring a change complete. Scale review and verification to semantic risk, not diff size alone.

## Select the operation

- **Assess an incoming change:** inspect it read-only and recommend `adopt`, `adapt`, `defer`, or `reject`. Do not pull, merge, cherry-pick, or edit merely because assessment was requested.
- **Implement maintenance:** map impact, make the smallest complete change, and verify the resulting diff.
- **Audit existing work:** review every changed hunk, find omissions and regressions, and report findings before editing unless the user also asked for fixes.
- **Prepare a release:** inspect the complete release delta and read [references/verification.md](references/verification.md) plus any repository release instructions.

Read repository instructions before acting. In this repository, also read [references/codex-router-surfaces.md](references/codex-router-surfaces.md) when a change touches routing, providers, clients, installers, credentials, the gateway, model publication, desktop surfaces, or releases.

## Establish the evidence baseline

1. Preserve unrelated work. Inspect status, current branch or detached state, relevant instructions, and the requested comparison boundary.
2. Run the analyzer from the repository root. The command below is read-only;
   adding `--manifest PATH` atomically creates or replaces that named JSON
   artifact:

   ```text
   python3 <skill-dir>/scripts/repo_maintainer.py analyze --repo . --format markdown
   ```

   For an existing commit range, pass `--base REF --head REF`. For only staged changes, pass `--staged`. Treat its classifications as conservative signals, not proof of semantic impact.
3. State observable acceptance outcomes before implementation. Keep them in the working plan unless the task genuinely needs a durable artifact. Each outcome is `pending`, `verified`, `blocked`, or `not-applicable` with a reason.
4. Identify affected and explicitly unaffected surfaces. Search callers, consumers, mirrored implementations, platform variants, configuration writers/readers, tests, documentation, generated artifacts, and release metadata.

Read [references/change-review.md](references/change-review.md) for incoming changes, compatibility decisions, or line-by-line audits.

## Decide whether to fan out

Fan out only when independent review or implementation streams improve confidence or wall-clock time. Read [references/fanout.md](references/fanout.md) before delegating.

- Skip fan-out for a genuinely isolated, low-risk change that one context can inspect completely.
- Prefer parallel **read-only** review for security, protocol, installer, dependency, release, cross-platform, or multi-subsystem changes.
- Delegate writes only with complete, disjoint path ownership and stable interfaces. Otherwise keep implementation in the parent and delegate analysis.
- Never accept a subagent's completion claim as verification. Re-read its diff, reconcile it with other findings, and rerun the relevant checks in the parent context.

The analyzer's fan-out recommendation is a prompt to judge independence, not a command to spawn agents. A tiny authentication change can deserve independent review; a large generated snapshot can remain one mechanical stream.

## Review and implement

For every non-generated text hunk:

1. Determine intended behavior and whether the change actually implements it.
2. Trace changed inputs, outputs, failure paths, state transitions, cleanup, concurrency, and compatibility boundaries.
3. Look for callers or mirrors that the diff did not update.
4. Check tests for meaningful assertions, negative controls, and the failure mode being fixed. Passing tests that never exercise the changed behavior are not evidence.
5. Check comments and docs against the resulting code, not the original request.

Run `git diff --check` and apply an equivalent whitespace check to untracked files, which ordinary `git diff` omits. Do not confuse whitespace validation with review. For generated or binary artifacts, verify their source, regeneration command, expected diff, and platform provenance instead of pretending to review opaque bytes line by line.

When implementation is authorized, prefer the smallest coherent patch. Do not silently broaden a maintenance request into cleanup. Preserve compatibility unless the user chose a breaking change.

## Choose verification proportionally

Read [references/verification.md](references/verification.md) before deciding that tests are unnecessary or that a focused test is enough.

- **Review-only:** comments, prose, or formatting with no executable, generated, configuration, schema, release, or behavioral effect. Still inspect every hunk and run cheap structural checks.
- **Targeted:** isolated behavior with a direct, meaningful test and no credible cross-surface impact.
- **Expanded:** shared runtime, multiple modules, platform/client variants, build or installer behavior, dependencies, persistence, concurrency, or compatibility.
- **Full/release:** security boundaries, credentials, protocols, schemas, generated locks, release artifacts, or changes whose impact cannot be bounded confidently.

Start with the narrowest test that can fail for the intended reason, then widen according to risk. Do not run quota-consuming, production, destructive, credential-dependent, or external mutation checks without the authority they independently require.

## Reconcile before reporting

After all edits and returned work:

1. Rerun the analyzer on the actual final diff and compare it with the original impact map.
2. Inspect every final hunk, including test and documentation changes.
3. Re-run required checks after the last relevant edit. Old output is stale evidence.
4. Mark each acceptance outcome with fresh evidence. Surface every blocked or intentionally unrun check and explain the consequence.
5. Report the decision or completed change, verified behavior, checks run, remaining uncertainty, and any follow-up that is truly outside scope.

Do not claim the repository is correct merely because available checks pass. Claim only the outcomes the review and evidence support.

When changing this skill itself, run its unit suite with `python3 -m unittest discover -s .agents/skills/repo-maintainer/tests -v` and validate the package with the available skill-creator validator.
