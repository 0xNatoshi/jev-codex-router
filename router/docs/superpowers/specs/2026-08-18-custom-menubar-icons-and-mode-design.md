# Design Specification: Support Custom Menu Bar Icons and Icon-Only Mode

- **Issue**: [#307](https://github.com/duolahypercho/codex-router/issues/307)
- **Status**: Accepted
- **Author**: Antigravity Assistant

## Background & Motivation

The macOS companion app `ModelRouterTray` currently renders `StatusItemLabel` with a fixed width of 180 points in the macOS menu bar (`MenuBarExtra`), displaying the active model/provider name, activity state, and token usage text.

On displays with limited menu bar space (such as MacBook screens with a camera notch or users with many menu bar items), this takes up significant space and causes menu bar clutter. Users have requested:
1. **Icon-Only Mode**: Hide text and display only a compact icon in the menu bar.
2. **Custom Menu Bar Icons**: Allow selecting preset icons, provider marks, or uploading/choosing a custom image file.
3. **Show/Hide Model Name**: Control whether the model/provider name is visible when text is enabled.
4. **Preserve Default Mode**: Retain the standard "Icon/Dot + Model Name + Usage" layout as a selectable option.

## Architecture & Design

### 1. Configuration & Persistence
Settings are stored in `UserDefaults.standard` under consistent `ModelRouterTray.*` keys:
- `ModelRouterTray.menuBarDisplayMode`: String enum (`standard` | `iconOnly`). Default: `standard`.
- `ModelRouterTray.menuBarShowModelName`: Boolean. Default: `true`.
- `ModelRouterTray.menuBarIconStyle`: String enum (`provider` | `indicator` | `preset` | `custom`). Default: `indicator` (preserves the shipped activity-dot look; `.provider` is an explicit Settings choice).
- `ModelRouterTray.menuBarPresetIcon`: String. Default: `cpu`. Supported presets: `cpu`, `brain`, `sparkles`, `terminal`, `bolt.horizontal.circle`, `network`.
- `ModelRouterTray.menuBarCustomIconPath`: String (absolute file path to user-selected image). Default: `nil`.

### 2. RouterStore State Management
`RouterStore` exposes published properties and setter methods:
- `@Published private(set) var menuBarDisplayMode: TrayMenuBarDisplayMode`
- `@Published private(set) var menuBarShowModelName: Bool`
- `@Published private(set) var menuBarIconStyle: TrayMenuBarIconStyle`
- `@Published private(set) var menuBarPresetIcon: String`
- `@Published private(set) var menuBarCustomIconPath: String?`
- Methods:
  - `setMenuBarDisplayMode(_ mode: TrayMenuBarDisplayMode)`
  - `setMenuBarShowModelName(_ show: Bool)`
  - `setMenuBarIconStyle(_ style: TrayMenuBarIconStyle)`
  - `setMenuBarPresetIcon(_ icon: String)`
  - `setMenuBarCustomIconPath(_ path: String?)`

### 3. Menu Bar Item Rendering (`StatusItemLabel`)
- **Icon-Only Mode (`.iconOnly`)**:
  - Renders a compact icon view (size ~16-18pt) with an optional subtle activity status indicator dot (tinted by `RouterActivityState.tint`).
  - Uses a fixed 24pt reserved width. Pulse and badge stay inside that frame.
- **Standard Mode (`.standard`)**:
  - Displays the selected icon/dot style.
  - If `menuBarShowModelName` is `true`, renders the active model or provider short name.
  - If usage/concurrent activity text is available, displays it concisely.
  - Always uses the existing 180pt reserved width, including when the model name is hidden.

### 4. Settings UI (`TrayView` Settings Tab)
In `ModelRouterTrayApp.swift`'s Settings tab:
- **Menu Bar Section**:
  - **Display Mode**: Segmented control (`Standard` | `Icon Only`).
  - **Show Model Name**: Toggle (visible when in `Standard` mode).
  - **Icon Style**: Picker for `Provider Icon`, `Activity Dot`, `Preset Icon`, `Custom Image…`.
  - **Preset Icon Grid/Picker**: When `Preset Icon` is active, provides selectable SF Symbols (`cpu`, `brain`, `sparkles`, `terminal`, `bolt.horizontal.circle`, `network`).
  - **Custom Image Picker**: When `Custom Image…` is active, presents a "Choose Image…" button (launching `NSOpenPanel` for PNG, JPG, SVG, ICNS), displays the current file name, and allows clearing back to default.

### 5. Documentation
Update `docs/MACOS-TRAY.md` with the new menu bar display options and CLI defaults commands.
