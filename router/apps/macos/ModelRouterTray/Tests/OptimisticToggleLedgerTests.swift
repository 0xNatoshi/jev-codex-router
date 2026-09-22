import Testing

@testable import ModelRouterTray

@Suite("Optimistic toggle ledger")
struct OptimisticToggleLedgerTests {
  @Test("a pending intent overrides an older authoritative snapshot")
  func pendingIntentWins() {
    var ledger = OptimisticToggleLedger<String>()
    _ = ledger.request(true, for: "provider")

    #expect(ledger.value(for: "provider", authoritative: false))
  }

  @Test("only the newest rapid toggle can reconcile")
  func lastIntentWins() {
    var ledger = OptimisticToggleLedger<String>()
    let first = ledger.request(true, for: "model")
    let last = ledger.request(false, for: "model")

    let staleReconciled = ledger.reconcile(first, for: "model")
    #expect(!staleReconciled)
    #expect(!ledger.value(for: "model", authoritative: true))
    let latestReconciled = ledger.reconcile(last, for: "model")
    #expect(latestReconciled)
    #expect(ledger.value(for: "model", authoritative: true))
  }

  @Test("a failed current intent rolls back to authoritative state")
  func currentFailureRollsBack() {
    var ledger = OptimisticToggleLedger<String>()
    let intent = ledger.request(true, for: "vision")

    let reconciled = ledger.reconcile(intent, for: "vision")
    #expect(reconciled)
    #expect(!ledger.value(for: "vision", authoritative: false))
  }

  @Test("independent switches retain independent pending state")
  func keysAreIndependent() {
    var ledger = OptimisticToggleLedger<RouterToggleKey>()
    _ = ledger.request(true, for: .provider("deepseek"))
    _ = ledger.request(false, for: .pickerModel("deepseek/chat"))

    #expect(ledger.value(for: .provider("deepseek"), authoritative: false))
    #expect(!ledger.value(for: .pickerModel("deepseek/chat"), authoritative: true))
  }
}
