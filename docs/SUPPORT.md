# Support and test matrix

Last reviewed: 2026-09-22.

## Product support

The complete Jev Codex Router stack is supported on macOS with the current
Codex desktop application, Node.js 22.19 or newer, and Python 3.11 or newer.
The installer and background-service contract are macOS-specific because they
install launchd services and publish the model into the local Codex desktop
configuration.

The embedded router under `router/` remains a cross-platform fork. Its portable
runtime and state-management suite is required on Ubuntu, macOS, and Windows
with Node.js 24 in CI. Passing that matrix does not make the root launchd
installer supported on Linux or Windows.

## Required CI lanes

| Lane | Runtime | What it proves |
| --- | --- | --- |
| Jev server | Ubuntu / Python 3.11 | Minimum supported Python and portable policy/relay behavior |
| Jev server | macOS / Python 3.12 | Primary product OS and a current Python runtime |
| Embedded router | Ubuntu, macOS, Windows / Node.js 24 | Portable fork behavior, state safety, and platform-specific branches |
| Browser panel | Ubuntu / Playwright Chromium | Browser UI tests execute instead of silently skipping for a missing browser |
| Codex app-server contract | Ubuntu / `codex-cli 0.155.0-alpha.9.2` | A real, known Codex binary completes both login-free provider configurations |

The Codex contract lane sets `CODEX_ROUTER_REQUIRE_REAL_CODEX=1`; absence of the
binary is a failure, never a skip. It also checks the exact CLI version before
running the fixture. Updating that pin is a deliberate compatibility change:
run the integration locally, review request and WebSocket behavior, then update
the workflow and this document together.

Codex 0.155 may establish two authenticated WebSocket connections after a
provider-preserving configuration rewrite. The fixture accepts that bounded
reconnect only when exactly one connection relays `response.create` and the
mock upstream receives exactly one model request.

## Optional and live coverage

Routine pull-request CI never uses TypeSafe credits, ChatGPT credentials, or
real model-provider keys. Provider compatibility and the installed launchd
stack remain explicit local/release checks:

```bash
PYTHONPATH=server python3 -m unittest discover -s server -p 'test_*.py'
(cd router && npm run check && npm test)
python3 server/smoke.py
```

For a local browser-panel run, install the locked Playwright browser once:

```bash
cd router
npx playwright install chromium
```

On Linux CI, use `npx playwright install --with-deps chromium`.
