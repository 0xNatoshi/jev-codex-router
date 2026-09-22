# v2 agent applications

This directory is the review gate for promoting a routed model to Codex
`multiAgentVersion: "v2"` for every installer. A model is v1 unless its exact
`provider/model` route has an accepted application here **and** the matching
registry change is included in the same pull request.

An application is scoped to the route, not the model family. For example,
`deepseek/deepseek-v4-pro` and `opencode-go/deepseek-v4-pro` need separate
applications because their credentials, upstream adapter, and tool handling
are different.

## What qualifies

All five checks below must pass through the installed router with a real
account that can spend the route's quota:

1. The provider's official documentation and `/models` catalog identify the
   exact upstream model and supported endpoint.
2. A streamed Responses turn emits text and completes normally.
3. A forced function call returns the requested tool name and valid JSON
   arguments.
4. A native Codex parent delegates a child through the encrypted payload
   relay, and the child returns an exact marker.
5. The parent sends a same-thread follow-up to that child and receives the
   second exact marker.

Do not infer any of this from a model name, a successful ordinary chat turn,
or a vendor's generic claim that its API supports tools.

## Submit an application

1. Copy `_template/` to `v2_agent/<provider>/<slug-model>/`; both directory
   names use lowercase letters, digits, `.`, `_`, and `-`. The second segment
   is the routed slug segment, not necessarily the upstream model ID. Record
   that exact upstream ID in `proof.json` even when it contains `/` or `:`.
2. Record stable metadata and redacted outcome summaries in `proof.md` and
   `proof.json`. Do not commit API keys, bearer capabilities, raw prompts,
   decrypted payloads, or provider response bodies.
3. Leave `status` as `draft` until all five checks have passed. Set it to
   `accepted` only in the PR that also sets the exact registry route's
   `multiAgentVersion` to `"v2"`.
4. Run `node scripts/check-v2-agent-applications.mjs`, `npm run check`, and
   the focused routing/catalog tests.
5. Open a draft PR. Reviewers reproduce the marker-return and same-thread
   steps, inspect the redacted evidence, and then approve the registry change.

CI validates the artifact shape and refuses evidence that looks like a
credential. It cannot run billable native Codex delegation on behalf of an
account, so human reproduction remains required.

CI also enforces the registry/application relationship in both directions:
an accepted application must bind one exact checked-in v2 route, and every new
checked-in v2 route must have its accepted application. Six exact Kimi/Grok
route identities certified before this artifact workflow are grandfathered;
changing their slug, provider, or upstream model removes that exception.
