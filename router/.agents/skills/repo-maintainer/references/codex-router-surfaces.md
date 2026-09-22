# Codex Router maintenance surfaces

Use this map to begin impact analysis; the repository's `AGENTS.md` remains authoritative for exact invariants.

## Shared plane and clients

- One shared router plane serves Codex, DeepSeek Harness, and Gemini CLI. Client target selection must not fork service state, credentials, ports, or provider selection.
- A routable-set change can require republishing every installed client through the shared refresh path.
- Client integrations own different document shapes and privacy constraints. Verify publish, idempotence, drift detection, doctor output, repair, and uninstall/restoration independently.

## Provider and model changes

Trace registry/catalog entries, request profiles, credential storage and discovery, provider selection, setup/tray UI, CLI status, doctor, support-bundle redaction, gateway routing, model curation, every installer, and user documentation. Check aliases or variants that share a credential and must not be toggled independently.

Useful focused areas include provider selection, catalog, configuration, provider credentials, onboarding, installer scripts, target integration, desktop/tray setup, doctor, support bundle, and Windows parity tests.

## Gateway and routing

Separate failures in the router, forwarders, gateway supervisor, and upstream provider. Preserve the rule that retries or failover are legal only before the first relayed byte. Review startup cleanup, health degradation naming, process supervision bounds, stream translation, usage accounting, and Windows spawn behavior.

## Python dependency lock

Change direct pins in the install plan and regenerate both requirement files with the repository lock command; do not hand-edit the lock. Verify universal markers and hashes, installation through supported resolver/platform combinations, imports, and a live gateway health boot. A successful resolve alone is insufficient.

## Installers and operating systems

Maintain macOS/Linux shell and Windows PowerShell parity. Inspect stable-checkout behavior, file privacy, service definitions, dependency fingerprints, migrations, rollback, repair, package artifacts, and generated Homebrew or release metadata. POSIX success does not prove Windows command spawning or quoting.

## Credentials and privacy

Never expose API keys, OAuth tokens, caller capabilities, managed URLs containing secrets, or another CLI's credential store. Review status, doctor, logs, support bundles, environment files, configuration writers, permissions, and redaction together.

## Verification baseline

Use focused tests named by the relevant `AGENTS.md` section first. Consequential source changes normally also require `npm run check` and the appropriate portion of `npm test`; installer, lock, desktop, packaging, or live-provider behavior can require their dedicated workflows. Quota-consuming live probes require explicit consent.
