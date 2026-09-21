import CoreGraphics
import Testing

@testable import ModelRouterTray

@Suite("Tray panel placement")
struct TrayPanelPlacementTests {
  private let panel = TrayPanelPlacement.panelSize

  @Test("a top-right extra keeps the panel right-aligned and below the item")
  func topRightExtraAlignsBelow() {
    let visible = CGRect(x: 0, y: 0, width: 1680, height: 1020)
    let button = CGRect(x: 1500, y: 1028, width: 180, height: 22)
    let frame = TrayPanelPlacement.frame(
      buttonScreenRect: button,
      visibleFrame: visible
    )
    #expect(frame.size == panel)
    #expect(frame.maxX == button.maxX)
    #expect(frame.maxY == visible.maxY)
    #expect(visible.contains(frame))
  }

  @Test("a left-edge extra does not place the panel at a negative origin")
  func leftEdgeClampsToVisibleMinX() {
    let visible = CGRect(x: 0, y: 0, width: 1680, height: 1020)
    let button = CGRect(x: 0, y: 1028, width: 22, height: 22)
    let frame = TrayPanelPlacement.frame(
      buttonScreenRect: button,
      visibleFrame: visible
    )
    #expect(frame.minX == visible.minX)
    #expect(frame.minY >= visible.minY)
    #expect(frame.maxX <= visible.maxX)
    #expect(frame.maxY <= visible.maxY)
  }

  @Test("a panel that would sit below the dock is lifted into the visible frame")
  func bottomClampUsesVisibleMinY() {
    let visible = CGRect(x: 0, y: 80, width: 1680, height: 940)
    let button = CGRect(x: 200, y: 120, width: 180, height: 22)
    let frame = TrayPanelPlacement.frame(
      buttonScreenRect: button,
      visibleFrame: visible
    )
    #expect(frame.minY == visible.minY)
    #expect(frame.maxY <= visible.maxY)
  }

  @Test("a menu-bar item on a secondary display stays on that display")
  func secondaryDisplayMenuBarItemStaysOnSecondaryDisplay() {
    // The menu-bar strip starts at visible.maxY. A hit test against visibleFrame
    // cannot select this display, but AppKit's buttonWindow.screen can.
    let secondaryVisible = CGRect(x: -1920, y: 0, width: 1920, height: 1057)
    let button = CGRect(x: -180, y: 1057, width: 180, height: 23)
    let frame = TrayPanelPlacement.frame(
      buttonScreenRect: button,
      visibleFrame: secondaryVisible
    )
    #expect(frame.maxX == button.maxX)
    #expect(frame.maxY == secondaryVisible.maxY)
    #expect(secondaryVisible.contains(frame))
    #expect(frame.maxX <= 0)
  }

  @Test("the panel size matches the SwiftUI tray frame")
  func panelSizeMatchesTrayView() {
    #expect(TrayPanelPlacement.panelSize.width == 352)
    #expect(TrayPanelPlacement.panelSize.height == 560)
  }
}
