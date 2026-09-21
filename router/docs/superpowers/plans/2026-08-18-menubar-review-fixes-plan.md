# Menu Bar Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven review findings on PR #308 so existing installs keep the activity dot, provider marks stay complete, and the status item width stays stable.

**Architecture:** Extract a pure `resolveMenuBarSettings` plus small layout/persist helpers on `RouterStore`, same pattern as `resolveIslandMode`. Views consume those helpers. Swift tests cover the resolver; Node source tests cover wiring that this Windows host cannot compile.

**Tech Stack:** Swift 5.10 / AppKit / SwiftUI tray, Swift Testing, Node `node:test` source guards.

---

## Chunk 1: Resolver + layout tests, then implementation

### Task 1: Failing tests for settings resolution and layout

**Files:**
- Create: `apps/macos/ModelRouterTray/Tests/MenuBarSettingsTests.swift`
- Modify: `test/tray-rebuild.test.mjs`

- [ ] **Step 1: Write Swift tests for `resolveMenuBarSettings` and layout metrics**

Cover: missing keys → `.indicator` / `.standard` / `true` / `cpu`; unknown raw values fall through; explicit values win; standard width is 180 even when the name is hidden; icon-only width is 24; activity badge is off for `.indicator`.

- [ ] **Step 2: Write Node wiring tests that fail on current source**

Assert `resolveMenuBarSettings` exists and is `nonisolated`; default missing style is `.indicator`; `MenuBarIconView` uses `ProviderIcon`; standard `.frame(width:)` is not gated on `menuBarShowModelName`; icon-only uses a fixed 24pt width.

- [ ] **Step 3: Run Node tests and confirm RED**

Run: `node --test test/tray-rebuild.test.mjs`
Expected: new assertions fail because the helpers and wiring are not present.

- [ ] **Step 4: Implement resolver, layout metrics, and view wiring**

- [ ] **Step 5: Re-run Node tests and confirm GREEN**

### Task 2: Custom-icon persist + tooltip localization

**Files:**
- Modify: `apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift`
- Modify: `apps/macos/ModelRouterTray/Sources/Localization.swift`
- Modify: `apps/macos/ModelRouterTray/Sources/RouterArabicText.swift`
- Modify: `apps/macos/ModelRouterTray/Sources/RouterHindiText.swift`
- Modify: `apps/macos/ModelRouterTray/Sources/RouterJapaneseText.swift`
- Modify: `apps/macos/ModelRouterTray/Sources/RouterKoreanText.swift`
- Modify: `apps/macos/ModelRouterTray/Tests/MenuBarSettingsTests.swift`
- Modify: `docs/MACOS-TRAY.md`
- Modify: `docs/superpowers/specs/2026-08-18-custom-menubar-icons-and-mode-design.md`

- [ ] **Step 1: Extend tests for persist/copy, missing-file flag, and localized tooltip keys**
- [ ] **Step 2: Confirm Node/Swift-source assertions fail**
- [ ] **Step 3: Implement copy-to-Application Support, cached `NSImage`, missing-file Settings label, `routerFormat` tooltip**
- [ ] **Step 4: Update docs default from provider icon to activity dot**
- [ ] **Step 5: Re-run `node --test test/tray-install.test.mjs test/tray-rebuild.test.mjs test/tray-service-windows.test.mjs` and `node scripts-check.mjs`**

## Verification

- Node tray tests pass on this host.
- Swift tests are present for CI (`swift test` on macOS). This Windows host cannot compile the AppKit target; do not claim they passed locally.
- Push to `Zzy-min/codex-router` branch `feat/menubar-custom-icon-mode` to update PR #308.
