# Risk-proportional verification

Verification should be cheap for truly non-semantic work and difficult to evade for consequential work.

## Decide the tier semantically

The analyzer provides a conservative starting tier. Override it when the content says otherwise.

### Review-only

Use only when every changed hunk is non-executable prose, comments, spelling, or formatting and does not affect generated output, examples consumed as tests, configuration, schemas, packaging, release notes, or agent behavior.

Minimum evidence:

- inspect every hunk;
- `git diff --check` or repository equivalent, including an explicit check of untracked files;
- render or link-check when layout or links are the outcome.

### Targeted

Use when behavior is isolated and a focused check directly exercises the changed outcome and a negative or regression case. Run adjacent tests if shared helpers are involved.

### Expanded

Use for shared runtime, multiple modules, platform/client variants, persistence, concurrency, installers, build configuration, or dependency resolution. Combine focused regression tests with repository syntax, lint, type, build, and broader suites relevant to every affected surface.

### Full or release

Use for credentials, authorization, privacy, protocols, schemas, migrations, lockfiles, release artifacts, or changes whose blast radius cannot be bounded. Include platform or packaged-run evidence when unit tests cannot exercise the contract.

## Tests must be capable of failing

A passing check is evidence only when its oracle measures the stated outcome.

- Prefer assertions over successful process exit alone.
- Add a regression fixture that fails without the fix when practical.
- Test failure and cleanup paths, not just success.
- For absence checks, prove the detector against a known positive control.
- Do not copy an expected number from the implementation and call equality independent verification.
- Treat skipped tests, environment mismatch, and stale pre-edit output as unverified.

## Evidence ledger

Before implementation, record observable outcomes as `pending`. At completion, mark each:

- `verified`: fresh command or reviewed artifact directly supports it;
- `blocked`: required evidence could not be obtained, with the reason and consequence;
- `not-applicable`: the surface is demonstrably outside the final diff, with a reason.

Never silently delete an inconvenient outcome. Re-run checks after the last relevant edit; earlier output is stale.

Use a compact table in the working plan or final report:

| ID | Observable outcome | Status | Evidence or reason |
| --- | --- | --- | --- |
| A1 | The original failure is reproduced, then fixed | pending | Reproduction command and expected assertion |
| A2 | Supported callers preserve their contract | pending | Named focused tests or inspected interfaces |
| A3 | Failure and cleanup paths remain safe | pending | Negative-control or fault-injection result |

Outcomes must describe behavior an independent reviewer could observe. “Tests pass” is evidence, not an outcome.

## External and expensive checks

Do not infer authority for quota-consuming probes, production requests, credential access, destructive migrations, publishing, merges, or external writes from a general request to verify code. Use deterministic local substitutes when they prove the same contract. Otherwise report the missing check and request the specific authority only when it is necessary.
