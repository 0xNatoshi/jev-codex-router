# Fan-out protocol

Use subagents to obtain independent judgment or parallelize genuinely separable work. Decomposition is valuable only when the parent can integrate and verify the results.

## Decide first

Fan-out is usually warranted when at least one is true:

- the change crosses three or more independently reviewable surfaces;
- security, credentials, protocol/wire shape, data migration, concurrency, installer, dependency lock, or release behavior needs an independent adversarial pass;
- platform or client variants can be inspected independently;
- the incoming patch is large enough that separate intent, correctness, and verification reviews reduce omission risk;
- independent implementation leaves have stable interfaces and disjoint files.

Do not fan out merely because many lines changed. Skip it when the work is isolated, generated, tightly coupled, or cheaper to understand in one context.

## Prefer review fan-out before write fan-out

For consequential work, start with bounded read-only roles such as:

1. **Intent and adoption:** reconstruct the problem, compare the proposed change with current behavior, and recommend adopt/adapt/defer/reject.
2. **Correctness and security:** review every relevant hunk, failure path, state transition, concurrency edge, cleanup path, and trust boundary.
3. **Integration and verification:** trace callers and mirrors, platform/client parity, tests, docs, installers, configuration, and release consequences.

Give each role the same comparison boundary but a distinct question. Ask for file-and-line evidence, concrete findings, and explicit uncertainty. Do not tell an independent reviewer the conclusion it is expected to reach.

## Delegate writes carefully

Write delegation requires all of the following:

- the user authorized implementation;
- each leaf owns a complete, repository-relative, disjoint path set;
- shared interfaces and assumptions are fixed before dispatch;
- generated files, caches, services, and package-manager state cannot collide, or isolated worktrees/environments are used;
- the parent retains integration ownership.

If any condition is false, delegate analysis and keep writes in the parent. Never use voluntary ownership declarations as a filesystem or security boundary.

Prefer explicit path prefixes over rich glob expressions. Before declaring two write scopes disjoint, account for case-insensitive filesystems, symlink aliases, generated outputs, and shared caches; `src/API` and `src/api` may be the same place on a supported machine. Treat ambiguous metacharacters or unresolved aliases as overlapping.

Dispatch ready work as dependencies clear; do not wait for unrelated reviews before starting a newly unblocked task. Keep the active set bounded by available capacity and by the number of meaningful independent streams.

## Accept returned work

A subagent return is a candidate result, not completion evidence. The parent must:

1. inspect the actual diff or cited source;
2. check ownership and unintended edits;
3. reconcile contradictions between reviewers;
4. verify interfaces and integration behavior;
5. rerun relevant checks after integration;
6. record anything unverified or abandoned explicitly.

When reviewers disagree, resolve the underlying evidence. Do not decide by majority vote.
