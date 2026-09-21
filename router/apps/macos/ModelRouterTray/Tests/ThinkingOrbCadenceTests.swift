import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Thinking orb redraw cadence")
struct ThinkingOrbCadenceTests {
  @Test("common display refresh rates preserve a 20 fps phase", arguments: [60.0, 120.0, 144.0])
  func commonRefreshRates(refreshRate: Double) {
    var cadence = ThinkingOrbRedrawCadence(framesPerSecond: 20)
    let frameInterval = 1.0 / refreshRate
    var scheduled: [TimeInterval] = []

    for frame in 0...Int(refreshRate * 2) {
      let now = Double(frame) * frameInterval
      if cadence.shouldSchedule(at: now) { scheduled.append(now) }
    }

    #expect(scheduled.count == 41)
    let elapsed = scheduled.last! - scheduled.first!
    let observedRate = Double(scheduled.count - 1) / elapsed
    #expect(abs(observedRate - 20) < 0.2)

    for (index, actual) in scheduled.enumerated() {
      let ideal = Double(index) / 20.0
      #expect(actual + 1e-9 >= ideal)
      #expect(actual - ideal <= frameInterval + 1e-9)
    }
  }

  @Test("reset permits the first frame immediately")
  func resetStartsImmediately() {
    var cadence = ThinkingOrbRedrawCadence(framesPerSecond: 20)
    let first = cadence.shouldSchedule(at: 10)
    let early = cadence.shouldSchedule(at: 10.01)
    #expect(first)
    #expect(!early)

    cadence.reset()

    let afterReset = cadence.shouldSchedule(at: 10.01)
    #expect(afterReset)
    #expect(cadence.nextDeadline == 10.06)
  }
}
