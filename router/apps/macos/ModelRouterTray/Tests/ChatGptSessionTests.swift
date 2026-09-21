import Foundation
import Testing

@testable import ModelRouterTray

@Suite("ChatGPT session sharing")
struct ChatGptSessionTests {
  private func snapshot(_ session: String) throws -> RouterSnapshot {
    let json = """
    {
      "targets": {},
      "chatgptSession": \(session)
    }
    """
    return try JSONDecoder().decode(RouterSnapshot.self, from: Data(json.utf8))
  }

  @Test("the tray decodes only the safe consent and usability projection")
  func decodesSafeProjectionWithoutSecrets() throws {
    let secret = "secret-token-must-not-cross-the-tray-boundary"
    let decoded = try snapshot(
      """
      {
        "sharing": "enabled",
        "session": "usable",
        "present": true,
        "expiresInHours": 11.5,
        "token": "\(secret)",
        "accountId": "account-secret",
        "path": "/private/auth.json"
      }
      """
    )

    #expect(decoded.chatgptSession?.sharing == .enabled)
    #expect(decoded.chatgptSession?.session == .usable)
    #expect(decoded.chatgptSession?.present == true)
    #expect(decoded.chatgptSession?.expiresInHours == 11.5)
    let fields = Set(Mirror(reflecting: decoded.chatgptSession!).children.compactMap(\.label))
    #expect(fields == ["sharing", "session", "present", "expiresInHours"])
    #expect(!String(reflecting: decoded.chatgptSession).contains(secret))
    #expect(!String(reflecting: decoded.chatgptSession).contains("/private/auth.json"))
  }

  @Test("unknown consent states fail closed without hiding router status")
  func refusesUnknownStates() throws {
    let decoded = try snapshot(
      """
      {
        "sharing": "automatic",
        "session": "usable",
        "present": true
      }
      """
    )
    #expect(decoded.targets.isEmpty)
    #expect(decoded.chatgptSession == nil)
    #expect(!ChatGptSessionControlPolicy.allowsChange(to: true, status: decoded.chatgptSession))
  }

  @Test("only a usable login can be shared and actions have fixed argv")
  func validatesActions() throws {
    let usable = try snapshot(
      #"{"sharing":"disabled","session":"usable","present":true}"#
    ).chatgptSession
    let expired = try snapshot(
      #"{"sharing":"enabled","session":"expired","present":true}"#
    ).chatgptSession

    #expect(ChatGptSessionControlPolicy.allowsChange(to: true, status: usable))
    #expect(!ChatGptSessionControlPolicy.allowsChange(to: true, status: expired))
    #expect(ChatGptSessionControlPolicy.allowsChange(to: false, status: expired))
    #expect(ChatGptSessionControlPolicy.arguments(enabled: true) == ["chatgpt-session", "enable"])
    #expect(ChatGptSessionControlPolicy.arguments(enabled: false) == ["chatgpt-session", "disable"])
    #expect(RouterControlContractPolicy.access(for: ["chatgpt-session", "status"]) == .read)
    #expect(RouterControlContractPolicy.access(for: ["chatgpt-session", "enable"]) == .mutation)
    #expect(RouterControlContractPolicy.access(for: ["chatgpt-session", "enable", "future"]) == .mutation)
  }
}
