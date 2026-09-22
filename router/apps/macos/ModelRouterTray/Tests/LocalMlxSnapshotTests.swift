import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Curated MLX tray state")
struct LocalMlxSnapshotTests {
  @Test("the shared local-model snapshot decodes every MLX install stage")
  func decodesInstallStages() throws {
    let stages = [
      "preparing", "downloading", "loading", "starting-server", "verifying", "publishing",
    ]

    for stage in stages {
      let progressMode = stage == "downloading" ? "indeterminate" : "determinate"
      let data = Data("""
      {
        "installed": 0,
        "enabled": 0,
        "totalGb": 0,
        "models": [],
        "mlx": {
          "host": {
            "supported": true,
            "platform": "darwin",
            "arch": "arm64"
          },
          "model": {
            "id": "qwen38-27b-uncensored-mlx",
            "slug": "lmstudio/qwen38-27b-uncensored-mlx",
            "source": "orcarouter/Qwen3.8-27B-Uncensored-MLX",
            "precision": "4-bit",
            "contextLength": 32768
          },
          "prerequisites": {
            "lms": {
              "available": false,
              "automaticWithYes": true,
              "source": "https://lmstudio.ai/install.sh"
            },
            "uvx": {"available": true}
          },
          "operation": {
            "status": "\(stage)",
            "detail": "working",
            "percent": 42,
            "progressMode": "\(progressMode)",
            "startedAt": 1000,
            "updatedAt": 2000,
            "workerPid": 123
          },
          "runtime": {
            "loopbackReachable": false,
            "served": false,
            "published": false
          }
        }
      }
      """.utf8)

      let snapshot = try JSONDecoder().decode(LocalModelsSnapshot.self, from: data)
      #expect(snapshot.mlx?.operation.status == stage)
      #expect(snapshot.mlx?.operation.isRunning == true)
      #expect(snapshot.mlx?.operation.percent == 42)
      #expect(snapshot.mlx?.operation.showsDeterminateProgress == (stage != "downloading"))
      #expect(snapshot.mlx?.host?.supported == true)
      #expect(snapshot.mlx?.prerequisites?.lms.automaticWithYes == true)
      #expect(snapshot.mlx?.prerequisites?.lms.source == "https://lmstudio.ai/install.sh")
    }
  }

  @Test("an Intel Mac carries the backend refusal reason")
  func decodesUnsupportedHost() throws {
    let data = Data("""
    {
      "model": null,
      "host": {
        "supported": false,
        "platform": "darwin",
        "arch": "x86_64",
        "reason": "The curated MLX model requires an Apple silicon Mac."
      },
      "prerequisites": null,
      "operation": {"status":"idle"},
      "runtime": null
    }
    """.utf8)
    let snapshot = try JSONDecoder().decode(LocalMlxSnapshot.self, from: data)
    #expect(snapshot.host?.supported == false)
    #expect(snapshot.host?.arch == "x86_64")
    #expect(snapshot.host?.reason == "The curated MLX model requires an Apple silicon Mac.")
    #expect(!snapshot.operation.isRunning)
  }

  @Test("ready means verified locally and published to Codex")
  func requiresEveryReadySignal() {
    #expect(LocalMlxRuntime(loopbackReachable: true, served: true, published: true).ready)
    #expect(!LocalMlxRuntime(loopbackReachable: false, served: true, published: true).ready)
    #expect(!LocalMlxRuntime(loopbackReachable: true, served: false, published: true).ready)
    #expect(!LocalMlxRuntime(loopbackReachable: true, served: true, published: false).ready)
  }

  @Test("older routers without an MLX field remain decodable")
  func toleratesOlderRouter() throws {
    let data = Data("""
    {"installed":0,"enabled":0,"totalGb":0,"models":[]}
    """.utf8)
    let snapshot = try JSONDecoder().decode(LocalModelsSnapshot.self, from: data)
    #expect(snapshot.mlx == nil)
  }

  @Test("terminal stages are not polled forever")
  func terminalStagesAreIdle() {
    for stage in ["idle", "done", "error", "cancelled"] {
      let operation = LocalMlxOperation(
        status: stage,
        detail: nil,
        percent: nil,
        progressMode: nil,
        startedAt: nil,
        updatedAt: nil,
        workerPid: nil,
        error: nil
      )
      #expect(!operation.isRunning)
    }
  }
}
