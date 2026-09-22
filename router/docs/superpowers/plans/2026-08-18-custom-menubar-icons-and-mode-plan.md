# Implementation Plan: Support Custom Menu Bar Icons and Icon-Only Mode

- **Issue**: [#307](https://github.com/duolahypercho/codex-router/issues/307)
- **Goal**: Implement customizable menu bar display settings in `ModelRouterTray` (macOS), including icon-only mode, custom/preset icons, and model name visibility toggle.

## Proposed Changes

### Phase 1: Define Enums & Store State in `ModelRouterTrayApp.swift`
1. Define `TrayMenuBarDisplayMode` enum:
   - `standard` ("Standard")
   - `iconOnly` ("Icon only")
2. Define `TrayMenuBarIconStyle` enum:
   - `provider` ("Provider icon")
   - `indicator` ("Activity dot")
   - `preset` ("Preset icon")
   - `custom` ("Custom image")
3. Add `UserDefaults` keys and published state properties to `RouterStore`:
   - `menuBarDisplayModeKey = "ModelRouterTray.menuBarDisplayMode"`
   - `menuBarShowModelNameKey = "ModelRouterTray.menuBarShowModelName"`
   - `menuBarIconStyleKey = "ModelRouterTray.menuBarIconStyle"`
   - `menuBarPresetIconKey = "ModelRouterTray.menuBarPresetIcon"`
   - `menuBarCustomIconPathKey = "ModelRouterTray.menuBarCustomIconPath"`
4. Implement getter/setter methods with persistence in `RouterStore`:
   - `setMenuBarDisplayMode(_ mode: TrayMenuBarDisplayMode)`
   - `setMenuBarShowModelName(_ show: Bool)`
   - `setMenuBarIconStyle(_ style: TrayMenuBarIconStyle)`
   - `setMenuBarPresetIcon(_ icon: String)`
   - `setMenuBarCustomIconPath(_ path: String?)`

### Phase 2: Render Custom Icon & Update `StatusItemLabel`
1. Implement `MenuBarIconView`:
   - Handles rendering of `.provider` (using provider icon asset), `.indicator` (colored circle), `.preset` (SF symbol), and `.custom` (loaded `NSImage` from disk path).
   - Renders cleanly at menu bar height (14-16pt), with activity dot badge / overlay or side-by-side indicator when needed.
2. Refactor `StatusItemLabel`:
   - When `menuBarDisplayMode == .iconOnly`: Renders `MenuBarIconView` with a compact frame (e.g. 24pt width) and tooltip with provider / model name / activity info.
   - When `menuBarDisplayMode == .standard`:
     - Renders `MenuBarIconView` followed by (if `menuBarShowModelName`: provider / model label) + (usage / concurrent activity text).
     - Width scales appropriately (e.g. reserved width or flexible).

### Phase 3: Settings UI in `TrayView`
1. Add a dedicated "Menu bar" settings group in `settingsTab`:
   - Display mode picker (Standard vs Icon only).
   - Model name toggle (visible when in Standard mode).
   - Icon style selector (Provider icon, Activity dot, Preset icon, Custom image).
   - Preset icon selector (CPU, Brain, Sparkles, Terminal, Bolt, Network).
   - Custom image selector with `NSOpenPanel` file picker (PNG, JPG, SVG, ICNS) and clear button.

### Phase 4: Documentation & Verification
1. Update `docs/MACOS-TRAY.md` with documentation on the new menu bar display mode and custom icon settings.
2. Run test suites (`npm test`) and syntax/type verification to ensure everything passes with zero regression.

## Success Criteria
- Users can switch between standard mode (icon + text) and icon-only mode in menu bar.
- Users can toggle model name visibility in standard mode.
- Users can customize the menu bar icon (provider icon, activity dot, preset SF symbol, or custom image file).
- Settings persist across app restarts in `UserDefaults`.
- All tests pass cleanly.
