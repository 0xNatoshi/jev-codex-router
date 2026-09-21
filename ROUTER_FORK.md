# Embedded Codex Router fork

`router/` is the source of the Codex Router runtime used by this project. It is
a regular, versioned directory in this repository — not a submodule, generated
artifact, package-manager indirection, or clone under `~/.local/share`.

## Imported snapshot

- Upstream project: `duolahypercho/codex-router`
- Upstream base: `9c0db45679f64640402bb5bba19705b0cb15c898`
- Integrated fork snapshot: `576dba20f02d97822a8170eccf09bb484a6db273`
- Imported: 2026-09-21
- License: MIT, retained at `router/LICENSE`

The snapshot includes the local fork changes that preserve complete canonical
replay for `jev/auto`, keep its prompt-cache identity, carry the routed reasoning
effort, preserve tool traffic across conversation windows, and separate
post-prologue stream stalls from the initial prelude timeout.

## Ownership

Runtime behavior shared with Codex is changed and tested under `router/`.
Jev's typed decision policy and relay are changed and tested under `server/`.
Generated files under `~/.codex/codex-router` remain runtime state and must not
be copied back into the repository.

Future upstream updates are deliberate source merges into `router/`, followed by
the embedded router suite and the Jev end-to-end contract tests. The installed
service never pulls or updates another repository by itself.
