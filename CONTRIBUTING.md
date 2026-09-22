# Contributing

Start with a focused issue or pull request describing the observed behavior,
expected behavior, and a synthetic regression fixture. Never attach credentials,
private conversation logs, or generated configuration from your installation.
For vulnerabilities, use [SECURITY.md](SECURITY.md), not a public issue.

## Local development without provider credentials

Use Node.js 22.19+ and Python 3.11+. From the repository root:

```sh
cd router
npm ci --include=dev
npm run check
npm test
cd ..
PYTHONPATH=server python3 -m unittest discover -s server -p 'test_*.py'
git diff --check
```

These tests use synthetic fixtures and temporary state; no TypeSafe key or
ChatGPT account is required. Browser and real Codex binary requirements are
listed in [docs/SUPPORT.md](docs/SUPPORT.md). Report skipped tests explicitly.
Do not run the installer just to contribute: it modifies the user's live
configuration and services. Live smoke tests and paid evaluations are separate,
opt-in checks, not prerequisites for an ordinary contribution.

## Ownership and invariants

- `server/` owns the compact Jev decision dossier, policy, lease, cache evidence,
  native-first fallback orchestration, and routing telemetry.
- `router/src/` owns the embedded transport fork, protocol adapters, local
  authentication, model discovery, and generated configuration.
- Root installation scripts own the integration and shared state paths.
- `poc/` contains evaluations, not the production source of truth.

Fix behavior in source, never generated catalogs, managed config blocks, or
runtime state. Preserve complete canonical executor input across model swaps;
the compact decision dossier must never become executor history. Cache evidence
is an optimization signal, not conversation storage. Retry tests must distinguish
failure before output from interruption after output and must not duplicate tool
execution. Never relax authentication when classification fails.

The embedded fork is maintained here. Upstream changes are reviewed and adopted
as scoped commits with attribution and regression tests; no separate upstream
checkout is required at runtime. Keep inherited license notices. An upstream
version or changelog does not constitute a release of this monorepo.

## Pull requests

One logical change per PR. Include the linked issue, changed contract, tests
actually run, remaining skips/limitations, and migration or rollback impact.
Use conventional commit messages. Avoid unrelated formatting and generated
files. Changes to policy, authentication, context replay, retries, or installation
need explicit review of their affected boundary. AI-assisted contributions follow
the same requirements; the submitter owns the result and verifies the evidence.
