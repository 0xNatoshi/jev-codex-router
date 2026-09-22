import AppKit
import SwiftUI
import Testing

@testable import ModelRouterTray

@Suite("Provider icon sizing")
struct ProviderIconTests {
  @Test("provider marks render at their requested size")
  @MainActor
  func providerMarksUseRequestedSize() throws {
    let requestedSize: CGFloat = 18
    let renderer = ImageRenderer(
      content: ProviderIcon(providerID: "openai", size: requestedSize, showsHelp: false)
    )
    renderer.scale = 1

    guard let image = renderer.nsImage else {
      Issue.record("ProviderIcon did not produce an image")
      return
    }

    #expect(image.size.width == requestedSize)
    #expect(image.size.height == requestedSize)
  }
}
