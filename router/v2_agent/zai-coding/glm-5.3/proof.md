# v2 agent application: `zai-coding/glm-5.3`

## Route

- Routed slug: `zai-coding/glm-5.3`
- Upstream model ID: `glm-5.3`
- Provider: Z.ai GLM Coding Plan
- Router version: `0.4.0-beta.4`
- Test completed: `2026-08-23T18:26:52.888Z`

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Official model identity | pass | Z.ai's GLM-5.3 release identifies the model, its coding focus, and low/high/max reasoning with max recommended for coding; the Coding Plan page confirms GLM-5.3 availability for coding agents. |
| Streaming Responses | pass | Router probe completed with HTTP 200 and verified streamed text plus a completion event at `2026-08-16T20:40:23.293Z`. |
| Forced function call | pass | Router probe completed with HTTP 200 and verified a function call with valid JSON arguments at `2026-08-16T20:40:23.293Z`. |
| Encrypted relay | pass | Codex `0.149.0-alpha.4.1` created a named GLM-5.3 child at max reasoning; its persisted child turn received an encrypted parent task and completed through the routed model with HTTP 200. |
| Marker-return spawn | pass | The real child returned the first exact certification marker and completed successfully; corresponding routed GLM-5.3 metering recorded HTTP 200 at `2026-08-23T18:24:22.075Z`. |
| Same-thread follow-up | pass | The existing child thread received a second task and returned the second exact marker; corresponding routed GLM-5.3 metering recorded HTTP 200 at `2026-08-23T18:26:52.885Z`. |

## Limits and reviewer reproduction

Reproduction requires an active Z.ai Coding Plan route and a Codex client with native multi-agent v2 enabled. Spawn a named GLM-5.3 child at max reasoning, wait for one exact marker, send a second marker task to the same child thread, and verify both child turns and HTTP-success metering. Do not record prompts, response bodies, encrypted payloads, credentials, or capability-bearing router URLs in repository evidence.
