# Chutes-hosted Kimi K3: reasoning, caching, and tools

Checked: 2026-08-10. The current public-catalog, chute-record, and source-revision
recheck was read-only and unauthenticated. Small quota-bearing probes were
previously authorized and run through the installed Router on 2026-08-09; they
were not repeated for this update and did not restart Codex, Router, LiteLLM, or
the tray.

## Practical conclusion

Chutes officially advertises `moonshotai/Kimi-K3-TEE` as supporting reasoning
and tools, and the public source for this exact chute launches SGLang with both
`--reasoning-parser kimi_k3` and `--tool-call-parser kimi_k3`. Reasoning and
ordinary function tools should therefore be treated as supported capabilities,
not inferred from the model name alone.

The exact K3-on-Chutes SSE reasoning key is not fully documented. Chutes' own
model-router documents `delta.reasoning_content`, while the current Chutes
gateway accepts either `delta.reasoning` or `delta.reasoning_content` and
passes the upstream SSE bytes through unchanged. The model-specific OpenAPI
and chute response schema declare streaming but omit both reasoning keys. The
accurate status is therefore: official evidence favors `reasoning_content`,
but only a small live SSE capture can prove the current K3-TEE wire shape.

There is no documented K3-specific flag that turns reasoning *streaming* on.
`stream: true` turns SSE on, and Moonshot says K3 always thinks. Chutes does
have generic `X-Enable-Thinking: true`, `:THINKING`, and
`chat_template_kwargs` handling for models with switchable thinking, but its
source does not identify any of those as required for K3 or as a control over
whether reasoning deltas are exposed. Chutes also does not document the native
Moonshot top-level `reasoning_effort` field for this chute, so low/high/max
must not be advertised as a distinct Chutes effort ladder. An authorized live
probe accepted `low`, but the local picker conservatively retains one adaptive
`high` tier because a single response cannot prove materially different budgets.

Prompt/KV caching is automatic and best-effort on Chutes. The current K3 price
is $3.00/M uncached input tokens, $0.30/M cached input tokens, and $15.00/M
output tokens. A hit is reported as
`usage.prompt_tokens_details.cached_tokens`; there is no documented cache ID or
user cache toggle.

## Evidence status at a glance

| Question | Verified from official sources | Remaining uncertainty |
| --- | --- | --- |
| Does this chute support reasoning? | Yes. The live catalog advertises `reasoning`; the exact chute uses the `kimi_k3` reasoning parser; a live Router probe emitted 25 Codex reasoning-summary deltas. | A single probe does not characterize every instance or load condition. |
| Which SSE field does Chutes use? | Chutes' model-router documents `delta.reasoning_content`; the gateway understands both `reasoning` and `reasoning_content`; the installed LiteLLM bridge converted the live stream successfully. | The Router-facing Responses stream proves successful translation but does not expose which accepted upstream alias the instance used. |
| Is there a reasoning-streaming flag? | `stream: true` enables SSE. Chutes has generic thinking-mode controls. | No official evidence says a separate flag enables K3 reasoning deltas, or that the generic thinking controls are needed for K3. |
| Is prompt caching supported? | Yes. Chutes performs prefix-aware routing, accounts `cached_tokens`, and publishes a cached-input price. | A particular request can miss because prefixes change, cache state is evicted, or load routing wins. |
| Are tools supported for `moonshotai/Kimi-K3-TEE`? | Yes. In addition to the advertised parser, a live forced call returned `codex_router_probe` with valid `{ "value": "ok" }` arguments. | Some Responses-only built-in tool types still have no Chat Completions equivalent. |

## Live verification

The authorized probes were deliberately bounded and recorded event metadata,
not model text:

- A 96-token streaming request returned HTTP 200. The first event arrived in
  2.820 seconds, the first
  `response.reasoning_summary_text.delta` in 2.821 seconds, and the first
  `response.output_text.delta` in 3.724 seconds. The stream contained 25
  reasoning-summary deltas and completed normally.
- A 160-token forced function request returned HTTP 200. The first event
  arrived in 1.829 seconds; the model emitted `codex_router_probe` with valid
  JSON arguments and completed normally.
- Native Sol successfully spawned Chutes K3 as a routed subagent, received an
  exact marker, sent a same-thread follow-up, received the second marker, and
  returned the success marker. Chutes K3 also succeeded as the orchestrator:
  it spawned ClinePass Kimi K3, received an exact marker, followed up on the
  same child, and returned `CHUTES_ORCHESTRATOR_OK`.

Together these probes prove the installed reasoning translation, ordinary
function tools, encrypted routed-subagent handoff, marker return, same-thread
continuation, and Chutes-as-orchestrator paths. They do not prove that a model
will choose optional delegation; a prompt that merely permits subagents can
still be answered directly.

## Reasoning and streamed thinking

Moonshot's official K3 contract is explicit:

- K3 always thinks.
- The top-level `reasoning_effort` values are `low`, `high`, and `max`, with
  `max` as the default.
- A native Moonshot streaming response has separate
  `delta.reasoning_content` and `delta.content` fields.
- Later turns, especially tool turns, must replay the complete assistant
  message, including `reasoning_content` and `tool_calls`.

Sources: [Kimi K3 Quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart.md),
[Reasoning Effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort.md),
and the official [Kimi K3 model card](https://huggingface.co/moonshotai/Kimi-K3/blob/main/README.md).

Chutes' current live model record for `moonshotai/Kimi-K3-TEE` advertises
`reasoning`, `tools`, SSE streaming, a 1,048,576-token context window, and a
65,535-token maximum output. The public chute record reports a hot, TEE-backed
SGLang deployment with five active verified instances at the time rechecked.
Most importantly, the source for the exact chute configures
`--reasoning-parser kimi_k3` and `--tool-call-parser kimi_k3`.

Sources: [live model catalog](https://llm.chutes.ai/v1/models),
[public chute record](https://api.chutes.ai/chutes/0bb5d4c2-b5da-587d-b88e-62b4839028ec),
[exact chute source](https://api.chutes.ai/chutes/code/0bb5d4c2-b5da-587d-b88e-62b4839028ec),
[model page](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee), and
[model guide](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee/llms.txt).

### `reasoning_content` versus `reasoning`

The strongest official field-name evidence is mixed but compatible:

- Chutes' model-router documents reasoning-model streams as
  `delta.reasoning_content` followed by `delta.content` and counts
  `reasoning_content` as useful streamed output:
  [model-router README](https://github.com/chutesai/model-router/blob/61bcd03c48d751619dc243a53e2df4fe7e9004b5/README.md#L210-L237)
  and [server implementation](https://github.com/chutesai/model-router/blob/61bcd03c48d751619dc243a53e2df4fe7e9004b5/model_router/server.py#L1242-L1261).
- The shared Chutes gateway inspects streamed deltas in the order `content`,
  `reasoning`, then `reasoning_content`, so Chutes explicitly supports both
  reasoning spellings:
  [gateway stream handling](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/chute/util.py#L968-L989).
- The same gateway yields each upstream chunk unchanged rather than rewriting
  its JSON field names:
  [raw SSE pass-through](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/chute/util.py#L1054-L1085).
- The [K3 Chutes OpenAPI](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee/openapi.json)
  and the output schema embedded in the
  [public chute record](https://api.chutes.ai/chutes/0bb5d4c2-b5da-587d-b88e-62b4839028ec)
  omit a reasoning delta field altogether.

That evidence is enough to reject an unconditional claim that Chutes always
rewrites K3 to one spelling. It is not enough to distinguish the exact field
emitted today by the `kimi_k3` parser without a wire capture.

The local LiteLLM pin is resilient to either spelling. LiteLLM 1.96.0 maps a
provider `delta.reasoning` alias into its internal `reasoning_content`, then
emits `response.reasoning_summary_text.delta` on the Responses API path. Its
Responses usage conversion also maps
`prompt_tokens_details.cached_tokens` to
`input_tokens_details.cached_tokens`. Source: exact
[LiteLLM 1.96.0 source distribution](https://files.pythonhosted.org/packages/d0/92/1171e76f2a4204a65adb5c827475e4f1d30e7c6a89d3d3e944d58b6fd8a6/litellm-1.96.0.tar.gz),
files `litellm/types/utils.py` lines 1328-1333,
`litellm/responses/litellm_completion_transformation/streaming_iterator.py`
lines 979-992, and
`litellm/responses/litellm_completion_transformation/transformation.py` lines
1998-2015.

### Flags and effort controls

Chutes' public gateway source supports two generic ways to turn thinking mode
on: the `X-Enable-Thinking: true` request header and a model name ending in
`:THINKING`. Either causes Chutes to add
`chat_template_kwargs.thinking=true` and
`chat_template_kwargs.enable_thinking=true`. It also normalizes a
`reasoning_effort` already nested inside `chat_template_kwargs`.

Source: [Chutes invocation normalization](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/invocation/router.py#L966-L1029).

Those are thinking-mode controls, not documented reasoning-*stream* controls.
The K3 chute's model-specific request schema lists `stream` but does not list
`reasoning_effort`, `chat_template_kwargs`, or a reasoning-output flag:
[K3 model guide](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee/llms.txt)
and [K3 OpenAPI](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee/openapi.json).
Moonshot's native top-level `reasoning_effort` contract therefore must not be
claimed as verified on Chutes merely because it works on `api.moonshot.ai`.

There is already a separate local Router integration issue: the curated Chutes
model entry omits `supportsReasoningSummaries`, so the generated Codex catalog
marks reasoning summaries false even though LiteLLM can translate either Chutes
reasoning spelling. That local catalog flag is a plausible reason for an
off-screen thinking phase followed only by final text.

Thirty minutes is not explained by a normal Chutes cold start: Chutes' generic
FAQ describes cold starts as roughly 5-30 seconds
([Chutes FAQ](https://github.com/chutesai/chutes-docs/blob/5cbd19e7962adf5cf1ee1b2edd887690a521d179/src/help/faq.md#L243-L263)).
More plausible contributors are a very large uncached prompt prefill, K3's
always-on reasoning, a high/default-max reasoning setting, and reasoning deltas
that the client does not surface.

## Prompt caching and billing

Chutes owns the inference KV/prefix cache. Codex Router does not cache Kimi's
model state. Chutes' public source shows the mechanism:

- It hashes progressively larger prompt/message prefixes for prefix-aware
  routing: [invocation utility](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/invocation/util.py#L314-L335).
- It prefers an instance likely to hold that prefix when load remains
  reasonable: [instance routing](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/instance/util.py#L520-L574).
- It reads cache-hit tokens from
  `usage.prompt_tokens_details.cached_tokens` for both streaming and
  non-streaming responses:
  [usage accounting](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/chute/util.py#L1104-L1149).
- Its default cached-prompt discount is 90%:
  [pricing constant](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/constants.py#L91-L97),
  and billing subtracts that discount from cached input tokens:
  [billing formula](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/chute/util.py#L1593-L1607).

The current K3 live record prices uncached input at $3.00/M, cached input reads
at $0.30/M, and output at $15.00/M:
[live catalog](https://llm.chutes.ai/v1/models) and
[model OpenAPI pricing](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee/openapi.json).

A hit is automatic and not guaranteed. The prefix must remain identical, the
request must land on an instance retaining that KV state, and the cache must
not have been evicted. Chutes' routing favors likely cache holders only within
its load threshold. The model-specific public request schema exposes no cache
ID, TTL, or enable-cache field, so the precise claim is “no documented user
cache control,” not “a hidden control cannot exist.”

The authoritative proof for one request is a nonzero cached-token count in its
completed usage or Chutes usage records. A generic tray/account total does not
by itself prove a cache hit.

## Tool calls

Tool calling is supported for `moonshotai/Kimi-K3-TEE` as an advertised and
configured capability:

- The live Chutes catalog includes `tools` in this exact model's
  `supported_features`: [live catalog](https://llm.chutes.ai/v1/models).
- The exact deployed chute enables `--tool-call-parser kimi_k3` alongside its
  reasoning parser:
  [exact chute source](https://api.chutes.ai/chutes/code/0bb5d4c2-b5da-587d-b88e-62b4839028ec).
- Chutes' shared gateway sets `tool_choice` to `auto` whenever tools are
  present and the caller omitted a choice:
  [gateway route](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/invocation/router.py#L1051-L1053).
- Moonshot's K3 API supports `tool_choice: "required"`, `"auto"`, and
  `"none"`, and requires replaying the full assistant message before tool
  results:
  [K3 tool-calling best practices](https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice.md),
  [Tool Choice](https://platform.kimi.ai/docs/guide/use-tool-choice.md), and
  [K3 Quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart.md).

Codex, not Chutes, executes the user's local tools. Chutes returns OpenAI-style
`tool_calls`; LiteLLM's Responses bridge turns streamed tool-call arguments
into Responses function-call events; then Codex executes the selected local
function. Some Responses-only built-in tool types have no Chat Completions
equivalent and are deliberately dropped, so “all Codex tool types” must not be
claimed. Ordinary function tools and the Router's custom-tool wrapper are the
supported path.

## Applied outcome and remaining boundary

The local Chutes K3 entry now sets `supportsReasoningSummaries: true` and
`defaultReasoningSummary: "auto"`, and Chutes K3 is selected as a v2 subagent
model. The curation metadata allowlist has a regression test so a future
re-curation path can preserve those fields.

The live probes prove Codex-facing reasoning summaries, forced ordinary
function calls, routed subagent handoff and continuation, and Chutes as an
orchestrator. The one intentionally conservative boundary is effort selection:
the bounded request accepted a Responses `reasoning.effort: "low"` request, but
one response cannot prove that Chutes maps low/high/max to materially distinct
K3 budgets. The local picker therefore retains its existing single adaptive
`high` tier instead of advertising an unverified ladder.

The exact raw upstream alias also remains hidden by the translation layer: the
successful Responses stream proves that one of LiteLLM's accepted Chutes
spellings arrived, but distinguishing `reasoning` from `reasoning_content`
would require a credentialed capture before LiteLLM. That distinction is not
needed for the installed fix because the pinned bridge accepts both.
