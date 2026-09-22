import CoreGraphics
import Foundation

/// Screen-space placement for the tray panel.
///
/// `MenuBarExtra(.window)` and `NSPopover.show(relativeTo:button.bounds)` both
/// re-anchor from a SwiftUI-driven rect. When that rect oscillates between a
/// menu-bar extra and a screen-sized fitting size, AppKit clamps the panel to
/// opposite corners. This helper only ever uses a fixed panel size and a
/// status-item window frame already expressed in screen coordinates.
enum TrayPanelPlacement {
  static let panelSize = CGSize(width: 352, height: 560)

  static func frame(
    buttonScreenRect: CGRect,
    panelSize: CGSize = panelSize,
    visibleFrame: CGRect
  ) -> CGRect {
    var x = buttonScreenRect.maxX - panelSize.width
    var y = buttonScreenRect.minY - panelSize.height

    let minX = visibleFrame.minX
    let maxX = visibleFrame.maxX - panelSize.width
    if maxX < minX {
      x = minX
    } else {
      x = min(max(x, minX), maxX)
    }

    let minY = visibleFrame.minY
    let maxY = visibleFrame.maxY - panelSize.height
    if maxY < minY {
      y = minY
    } else {
      y = min(max(y, minY), maxY)
    }

    return CGRect(origin: CGPoint(x: x, y: y), size: panelSize)
  }
}
