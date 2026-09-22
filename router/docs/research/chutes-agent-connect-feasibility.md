# Chutes provider feasibility for Codex Router

Date checked: 2026-08-10

## Outcome

Yes. Chutes is a clean technical fit for Codex Router as an API-key-backed,
OpenAI-compatible provider. The implementation registers `chutes` as a
catalog-only provider, lets the user store a Chutes key through the router's
hidden local prompt/tray flow, discovers models from Chutes' public live
catalog, and locally curates the models the user wants. It can participate in the
router's signed-in coexistence mode without replacing or reading the user's
ChatGPT authentication.

The 2026-08-10 recheck used only the unauthenticated public catalog, public chute
record, and official source repositories. It made no authenticated account or
inference request. Earlier explicitly authorized compatibility probes are
recorded separately in `chutes-kimi-k3-reasoning-cache-tools.md`; they were not
repeated for this update.

## Official Chutes contract

- Chutes documents the inference base URL as `https://llm.chutes.ai/v1`, with
  `Authorization: Bearer <Chutes key>`, concrete model IDs from `GET /v1/models`,
  and inference through `POST /v1/chat/completions`.
  [Connect Any Agent](https://chutes.ai/agents/connect)
- Chutes' Codex guide calls its Codex support "guide only": it works where the
  runtime accepts an OpenAI-compatible provider, but upstream Codex does not ship
  a built-in Chutes provider. Codex Router supplies exactly that missing provider
  and protocol bridge.
  [Chutes Codex guide](https://chutes.ai/agents/codex)
- The model-specific Kimi K3 OpenAPI document contains
  `/v1/chat/completions`, `/v1/completions`, and `/v1/models`; it does **not**
  advertise `/v1/responses`. Its agent guide explicitly says chat-completions
  streaming is supported.
  [Kimi K3 OpenAPI](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee/openapi.json),
  [Kimi K3 agent guide](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee/llms.txt)
- Chutes' public live catalog is the source of truth for current model IDs and
  capabilities. At the time of this check it advertised 13 hosted LLMs. The
  current `moonshotai/Kimi-K3-TEE` entry reports a 1,048,576-token context,
  65,535-token maximum output, text/image/video input, text output, and feature
  flags for tools, reasoning, JSON mode, and structured output. It also reports
  TEE-backed confidential compute and current per-token prices.
  [Live model catalog](https://llm.chutes.ai/v1/models),
  [Kimi K3 model page](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee)
- Chutes separately documents function calling on its optimized vLLM/SGLang
  serving templates. For Kimi K3 specifically, an earlier authorized live
  Router probe also completed a forced `tool_choice: "required"` function call.
  That evidence remains model-specific rather than a provider-wide claim.
  [Chutes function-calling guide](https://chutes.ai/docs/guides/agents-and-tools)
- The management API exposes authenticated usage/quota surfaces including
  `GET /invocations/usage`, `GET /invocations/stats/llm`,
  `GET /users/me/quotas`, and `GET /users/me/subscription_usage`; the latter is
  described as monthly and four-hour usage versus caps. The current official
  user router returns the account's effective finite balance from `GET /users/me`,
  returns `{ subscription: false }` for an unsubscribed account, and marks a
  custom subscription's monthly window `{ uncapped: true }` while retaining its
  four-hour cap. Chutes also documents
  OAuth 2.0/PKCE with `chutes:invoke`, `account:read`, and `billing:read` scopes.
  [Invocations API](https://chutes.ai/docs/api-reference/invocations),
  [Users API reference](https://chutes.ai/docs/api-reference/users),
  [Chutes authentication](https://chutes.ai/docs/getting-started/authentication),
  [Sign in with Chutes](https://chutes.ai/docs/sign-in-with-chutes/overview),
  [current user/account source](https://github.com/chutesai/chutes-api/blob/646a97480329a414363257872f09c3e87d969cc2/api/user/router.py#L1221-L1349)

## Why the existing router can carry it

The local router already has the needed seams:

- `src/model-registry.mjs` accepts credentialed `openai-compatible` providers,
  isolates their base URL and credential metadata, and allows only text/image
  picker modalities.
- `src/litellm-config.mjs` deliberately converts Codex Responses traffic to
  upstream Chat Completions (`use_chat_completions_api: true`) for ordinary
  OpenAI-compatible providers. Chutes therefore does not need to implement
  `/v1/responses` itself.
- `src/api-forwarder.mjs` strips the caller's OpenAI/ChatGPT headers, resolves
  only the selected provider's credential, rewrites the gateway model to the
  concrete upstream model, sends Bearer auth, and forwards streaming responses.
- `src/provider-onboarding.mjs` already produces an API-key setup card for every
  registered provider. The tray can accept the Chutes key over stdin and store
  it in the router's protected credential file; the key need not enter chat,
  command arguments, or logs.
- `src/config-manager.mjs` defines `codex-router-signed` with
  `requires_openai_auth = true`, Responses wire format, and WebSockets disabled.
  Adding a routed Chutes model does not alter that mode: native model slugs keep
  using the caller's ChatGPT session, while a Chutes slug goes through the
  gateway and only receives the locally stored Chutes key.

## Capability assessment

| Capability | Feasibility | Evidence / caveat |
|---|---|---|
| Chat Completions | Ready | Official endpoint and OpenAPI path. |
| Responses API | Bridge required | Not advertised by Chutes; the router's existing LiteLLM bridge supplies it. |
| SSE streaming | Advertised | Explicitly `Streaming: yes` in the Kimi K3 agent guide. |
| Tool calling | Verified for Kimi K3 | Live catalog and chute source advertise tools; an authorized live Router probe completed a forced function call, and routed subagent probes exercised follow-up tool history. |
| Image input | Advertised, probe required | Live Kimi K3 metadata says `text`, `image`, `video`; the router should expose only `text` and `image`, because its picker schema does not support video. |
| 1M context | Ready as metadata | Current Kimi K3 catalog value is 1,048,576; a conservative auto-compaction threshold around 900,000 matches the router's existing long-context safety margin. |
| Max output | Ready as metadata | Current catalog reports 65,535. |
| Reasoning effort picker | Conservative | A live request accepted `low`, but Chutes does not document Kimi K3's effort ladder and one response does not prove distinct budgets. Curate the single adaptive `high` tier rather than an unverified ladder. |
| Native v2 subagents | Disabled initially | Must remain unset until marker-return spawn, encrypted payload relay, and same-thread follow-up pass through signed coexistence. |
| Usage in tray | Ready | The official account and subscription handlers define effective balance, ordinary monthly/four-hour caps, custom uncapped monthly plans, and unsubscribed responses. The adapter queries both independently and retains whichever usable metrics succeed. |

## Implemented shape and remaining boundary

1. The canonical `chutes` provider definition uses the official base URL,
   `CHUTES_API_KEY`, a dedicated protected credential filename, a dedicated
   Keychain service name, and no OAuth requirement.
2. It remains **catalog-only**, because Chutes' live catalog can change. Public
   discovery and deterministic local curation are covered without checking a
   model into the shared registry or asserting capabilities from its name.
3. Installer selection, provider enablement, protected credentials, doctor,
   support-bundle redaction, tray setup/icon, LiteLLM routing, request profiles,
   and account degradation paths all have Chutes-specific regression coverage.
4. Account reporting preserves every finite balance, including zero and
   negative values, beside subscription quotas. Partial failure of one account
   endpoint does not hide valid metrics from the other; custom inference base
   URLs do not trigger calls to Chutes' official account service.
5. No checked-in Chutes model declares native v2 collaboration. That remains a
   local curation decision unless a model is intentionally shipped to every
   installer with fresh compatibility evidence.

## Recommendation

Ship API-key authentication plus catalog-only discovery and local curation.
OAuth is technically possible, but it adds app registration, PKCE callback,
refresh-token storage, scopes, and expiry handling without being necessary for
this provider surface; it should be a separate, explicitly chosen follow-up.
