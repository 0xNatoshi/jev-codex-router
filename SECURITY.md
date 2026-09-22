# Security policy

## Private reporting

Report suspected vulnerabilities in this monorepo, including its embedded
`router/` fork, through
[GitHub Private Vulnerability Reporting](https://github.com/0xNatoshi/jev-codex-router/security/advisories/new).
This channel was enabled and read back on 2026-09-22.
Do not post vulnerability details in public issues. If the private form is
unavailable, request a private contact without disclosing technical details.

Provide the affected commit, platform, affected component, expected boundary,
and a minimal synthetic description. Do not send actual tokens, caller secrets,
private prompts, full configuration, or unredacted logs. There is no guaranteed
response-time SLA or bug bounty.

## Scope and supported fixes

Security fixes target the current main branch. Older snapshots are not promised
backports; update to the published fixing commit. Platform coverage is defined
in [docs/SUPPORT.md](docs/SUPPORT.md), not inherited upstream release claims.

Services are local-only and must remain bound to loopback. Local capabilities
do not isolate hostile code running as the same OS user. TypeSafe receives a
bounded routing dossier; the selected execution provider receives conversation
context. A compact dossier may still contain sensitive user content.

See [the embedded security model](router/SECURITY.md) for its detailed credential
and transport boundaries. The root policy controls reporting and releases for
this project. Never upload diagnostic bundles automatically. Review and redact
even sanitized output before sharing it.
