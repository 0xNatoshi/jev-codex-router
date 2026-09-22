# Design Specification: Menu Bar Review Fixes (PR #308)

- **Issue**: [#307](https://github.com/duolahypercho/codex-router/issues/307)
- **PR**: [#308](https://github.com/duolahypercho/codex-router/pull/308)
- **Status**: Accepted
- **Amends**: `docs/superpowers/specs/2026-08-18-custom-menubar-icons-and-mode-design.md`

## Background

PR #308 added menu-bar display modes and icon styles, but review found
correctness gaps that change the shipped look for existing installs and
break provider marks for unmapped IDs.

## Decisions

### 1. Default icon style is the current activity dot

Absent `ModelRouterTray.menuBarIconStyle` resolves to `.indicator`, not
`.provider`. Existing installs keep the pulsing activity dot. `.provider`
is an explicit Settings choice. Fresh installs get the same default.

Unknown stored raw values fall through to the same defaults as missing keys
(`standard`, `true`, `indicator`, `cpu`, no custom path).

### 2. Provider marks reuse `ProviderIcon`

`MenuBarIconView` must not keep a second, shorter asset map. `.provider`
renders `ProviderIcon(providerID:size:)`. Fallback is the existing `cpu`
symbol, never a 6pt circle. The activity badge is shown only when the
style is not already `.indicator` and activity is not idle.

### 3. Status-item width is reserved, not content-sized

- Standard mode always uses the existing 180pt reserved width, including
  when the model-name toggle is off. Usage and concurrent-provider text
  still change, so the item must not jump.
- Icon-only mode uses a fixed 24pt slot. Pulse and the 5pt badge stay
  inside that frame.

### 4. Custom images are copied and cached

Choosing a file copies it into Application Support
(`ModelRouterTray/menu-bar-icon.<ext>`). `RouterStore` caches the
`NSImage` and a missing flag. Settings shows a missing-file label instead
of a stale filename. The SwiftUI view must not re-read the file on every
body. A gone file does not silently keep looking selected.

### 5. Tooltip is localized

The hover string is built with `routerFormat` and added to every language
table. English remains the source key.

### 6. Resolver is testable

Load/defaulting lives in a pure `RouterStore.resolveMenuBarSettings(...)`
(same shape as `resolveIslandMode`). Swift tests cover missing keys,
unknown values, and explicit choices. Node source tests cover wiring that
Swift tests cannot see on a non-macOS host.

## Follow-up: macOS CI flake in `dsh-web`

PR CI on `a9b69f0` failed `test (macos-latest)` in
`test/dsh-web.test.mjs` at `assert.equal(stopped.stopped, true)` after
18ms. Ubuntu/Windows were green. This file is not part of the menu-bar
change. The fake `dsh` is `exec sleep 5`, so `processStartIdentity`
(`ps ... comm=`) can record `sh`/`dsh` at start and `sleep` at stop,
and `stateOwnsProcess` then refuses to stop. The test must inject a
stable identity that still observes liveness (`process.kill(pid, 0)`),
and must not `exec`, so start/stop do not race `ps comm` or treat a dead
PID as still owned.

## Out of scope

- Changing the Settings control layout
- Sandbox / security-scoped bookmarks (the tray is not sandboxed)
- New icon styles
