# CC Switch preserved-provider integration

Research date: 2026-08-09

## Practical outcome

The safest coexistence design on this Mac is to keep Codex's root
`model_provider` equal to `custom` at all times and make that one provider point
at Codex Router's authenticated local Responses endpoint. This preserves the
task bucket that currently contains almost all of the user's tasks while letting
the router choose either the signed-in ChatGPT backend or an external provider
from the requested model slug.

CC Switch does not need to be uninstalled to make that work. It can be retained
as the owner of one dedicated **Codex Router (coexistence)** profile, provided
its own local routing/takeover remains off. Uninstalling the app would remove a
source of accidental config writes, but deleting `~/.cc-switch` would also throw
away the database and the reversible history-migration backups. If CC Switch is
removed, preserve that state directory.

The previously installed Router toggle is not safe: it changes the root provider
from `custom` to `codex-router-signed`, which changes Codex Desktop's task
partition. It should stay off until it is replaced with a provider-preserving
implementation.

## Installed CC Switch identity

The installed bundle is `/Applications/CC Switch.app`, bundle identifier
`com.ccswitch.desktop`, version `3.19.2`. Its signed executable is notarized by
Developer ID **Jason Young (R8UR22V2F9)**, and the binary embeds the updater
endpoint for `farion1231/cc-switch`. The checked source tag is
[`v3.19.2`](https://github.com/farion1231/cc-switch/tree/v3.19.2), commit
`43eaf07355af145aebfee301801779e824d4c221`. CC Switch's own release notes name
`farion1231/cc-switch` as its only official source and GitHub Releases as its
official download channel ([official-channel declaration](https://github.com/farion1231/cc-switch/blob/v3.19.2/docs/release-notes/v3.16.1-en.md#only-official-channels-please-read)).

This establishes the correspondence between the local app and the official
repository/version from first-party evidence. It is not a byte-for-byte
comparison against a downloaded release archive.

## Current machine state (read-only audit)

- CC Switch was not running during this audit. No CC Switch LaunchAgent plist or
  separate helper process was present.
- macOS has CC Switch registered as an enabled login item. Local settings say
  `launchOnStartup=true`, `silentStartup=true`, and `minimizeToTrayOnClose=true`.
  In other words, it can launch invisibly into the menu bar at the next macOS
  login even though it is not running now.
- CC Switch's local proxy configuration has `enabled=0` for Codex and every
  other supported app. It therefore has no active takeover to restore on launch.
- The live Codex config currently has `model_provider = "custom"`. Its
  `[model_providers.custom]` table is the direct-official shape: `name =
  "OpenAI"`, `requires_openai_auth = true`, `supports_websockets = true`,
  `wire_api = "responses"`, and no provider-table `base_url`. The earlier Router
  root-level catalog and `openai_base_url` fields remain present, but a custom
  provider does not use the built-in provider's `openai_base_url` override.
- The Codex state database currently contains 2,475 tasks tagged `custom`, 94
  tagged `openai`, 7 tagged `codex-router-signed`, 1 tagged `codex-router`, and 1
  tagged `alibaba-token-plan`. The dominant durable task bucket on this machine
  is therefore `custom`; changing the root provider away from it explains the
  apparent disappearance after restart.
- CC Switch settings have both `preserveCodexOfficialAuthOnSwitch=true` and
  `unifyCodexSessionHistory=true`. Its recorded completed migration says 1,619
  session files and 2,480 state rows were moved into the `custom` bucket. This is
  why preserving `custom` is especially important here.
- CC Switch currently regards `codex-official` as the selected Codex profile.
  Its stored config was backfilled while the failed signed Router experiment
  was active and now contains stale `codex-router-signed`/Router-managed fields.
  This is a latent overwrite hazard. It must be repaired or superseded by the
  dedicated Router profile before any action that reprojects the current CC
  Switch provider to the live Codex config.
- The stored ClinePass profile exists but is not current. It uses the shared
  `custom` provider id, as CC Switch intends for third-party Codex providers.

No token, API key, ChatGPT access token, or Router capability value was read into
this report.

## What CC Switch actually writes

### Provider storage and switching

Version 3.19.2 stores providers in `~/.cc-switch/cc-switch.db` and device-level
settings in `~/.cc-switch/settings.json`. A Codex provider record contains an
`auth` object plus a TOML `config` string. When switching providers, CC Switch:

1. reads the current live Codex files;
2. backfills that live state into the outgoing provider record;
3. marks the new provider current; and
4. writes the new provider plus common configuration to the live files.

That sequence is implemented in
[`ProviderService::switch_provider`](https://github.com/farion1231/cc-switch/blob/v3.19.2/src-tauri/src/services/provider/mod.rs#L3087-L3147).
It explains how the previously current `codex-official` database record acquired
Router experiment fields even though CC Switch itself was not running at the
time of the later restart: a prior explicit CC Switch operation backfilled the
then-live file, and the stored result persisted.

### ChatGPT login preservation

With **Keep official login when switching third-party providers** enabled, a
third-party switch writes only `config.toml`; it leaves the long-lived ChatGPT
login in `auth.json`. If the provider has a third-party key, CC Switch projects
that key into the active provider table as `experimental_bearer_token`
([write decision and projection](https://github.com/farion1231/cc-switch/blob/v3.19.2/src-tauri/src/codex_config.rs#L2089-L2140)).
For the Router profile, the stored provider auth must therefore be empty: Codex
Router needs Codex to forward the existing ChatGPT credential because
`requires_openai_auth = true`; a provider-scoped third-party bearer token would
replace that header and break signed native routing.

The app's official guide describes the same separation between the ChatGPT login
in `auth.json` and provider runtime configuration in `config.toml`
([official-auth preservation guide](https://github.com/farion1231/cc-switch/blob/v3.19.2/docs/guides/codex-official-auth-preservation-guide-en.md)).

### Why `custom` preserves task visibility

CC Switch explicitly standardizes all managed third-party Codex providers on
the provider id `custom`. Its unified-history option also runs official ChatGPT
traffic under `custom`, without changing authentication or the official
backend. The first-party guide says Codex filters resume/history by the session's
`model_provider`, and explains that unification makes official and third-party
tasks share the `custom` drawer
([unified-history mechanism](https://github.com/farion1231/cc-switch/blob/v3.19.2/docs/guides/codex-unified-session-history-guide-en.md#the-core-mental-model-two-drawers--automatic-backup)).
OpenAI's own issue tracker independently records that changing `model_provider`
hides otherwise intact local sessions from Desktop, resume, fork, and latest-
session lookup ([openai/codex#15494](https://github.com/openai/codex/issues/15494)).

CC Switch's `custom` official table deliberately uses `name = "OpenAI"`,
`requires_openai_auth = true`, and `supports_websockets = true` so official
feature gates and ChatGPT authentication continue to work under the shared
bucket
([provider-table implementation](https://github.com/farion1231/cc-switch/blob/v3.19.2/src-tauri/src/codex_config.rs#L1758-L1782)).

### Background and login behavior

There is no evidence of a separate always-running CC Switch helper that watches
and rewrites `~/.codex/config.toml` while the app process is absent. Source review
found no filesystem watcher for Codex configuration. The macOS startup setting
registers the main `.app` itself as a login item
([auto-launch implementation](https://github.com/farion1231/cc-switch/blob/v3.19.2/src-tauri/src/auto_launch.rs#L18-L68)).

When the app starts, it restores a live proxy takeover only for apps whose
persisted proxy `enabled` flag is true
([startup restore gate](https://github.com/farion1231/cc-switch/blob/v3.19.2/src-tauri/src/lib.rs#L1881-L1933)).
Its periodic background loops perform database backup and session-usage import,
not provider reprojection
([periodic tasks](https://github.com/farion1231/cc-switch/blob/v3.19.2/src-tauri/src/lib.rs#L1204-L1267)).

Live config can still be rewritten while the app is running when the user
switches a provider, changes the unified-history setting, changes a config
directory, imports configuration, enables/disables takeover, or hot-switches a
provider. For example, changing the unified-history switch immediately reapplies
the current official provider
([settings command](https://github.com/farion1231/cc-switch/blob/v3.19.2/src-tauri/src/commands/settings.rs#L60-L114)),
and changing a config directory resynchronizes current providers
([frontend sync trigger](https://github.com/farion1231/cc-switch/blob/v3.19.2/src/hooks/useSettings.ts#L431-L455)).

Therefore, "CC Switch was not running" is true but not dispositive: the live
configuration it wrote earlier remains active after the process quits. On this
machine, a future login can also relaunch the main app silently, although startup
alone should not rewrite Codex while its proxy flag remains disabled.

## Recommended dedicated profile

Create one CC Switch Codex provider named **Codex Router (coexistence)** and make
it the current provider. It should store an empty provider auth object and the
following TOML shape (paths and the capability URL must be filled locally, never
pasted into chat):

```toml
model_provider = "custom"
model = "gpt-5.6-sol"
model_catalog_json = "/Users/rohitsabu/.codex/codex-router/merged-models.json"

[model_providers.custom]
name = "OpenAI"
base_url = "http://127.0.0.1:4202/_codex-router/<local-capability>/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

The corresponding stored auth JSON should be `{}` (or an empty
`OPENAI_API_KEY`, which CC Switch ignores when projecting a bearer token). The
CC Switch form treats a blank key as a soft warning and allows the user to
continue; its custom template already uses `model_provider = "custom"`,
Responses, and `requires_openai_auth = true`
([custom template](https://github.com/farion1231/cc-switch/blob/v3.19.2/src/config/codexTemplates.ts#L15-L29),
[soft validation](https://github.com/farion1231/cc-switch/blob/v3.19.2/src/components/providers/forms/ProviderForm.tsx#L1274-L1337)).

Profile settings:

- Keep **official auth preservation** on.
- Keep **unified Codex session history** on; do not toggle it during setup.
- Keep the provider's **common configuration** enabled so user-owned Codex
  settings, plugins, profiles, MCP entries, and desktop preferences are merged
  into the profile instead of being replaced.
- Select **Responses (native)** as the upstream format.
- Do not enable CC Switch **Local Routing** or Codex **takeover**. Codex Router
  already terminates Responses and performs any external-provider conversion;
  stacking CC Switch's proxy would add a second owner and a second backup/
  restore lifecycle.
- Do not enter a ClinePass, Chutes, or other provider key into this CC Switch
  profile. Those credentials remain provider-scoped inside Codex Router. Never
  paste any key into chat.
- Treat the Router capability URL as sensitive local configuration even though
  it is not an upstream API key.

CC Switch preserves a user-owned `model_catalog_json` path when no CC-generated
model catalog is attached; it only removes a catalog pointer whose filename is
its own `cc-switch-model-catalog.json`
([catalog ownership logic](https://github.com/farion1231/cc-switch/blob/v3.19.2/src-tauri/src/codex_config.rs#L1241-L1268)).
Therefore the dedicated profile should not define CC Switch model-mapping rows;
the Router's `merged-models.json` must remain the single catalog source.

## Why the Router can coexist behind this profile

Codex's official configuration schema defines a provider `base_url` as an
OpenAI-compatible API endpoint and defines `requires_openai_auth` as the switch
that supplies an OpenAI API key or ChatGPT login token
([OpenAI config schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)).
The experimental Router endpoint forwards the signed request headers for native
traffic and dispatches registered external model slugs to their configured
providers; unregistered model slugs remain native GPT traffic. See the local
primary implementation in
[`src/router.mjs`](../../src/router.mjs) and the isolated signed-provider proof in
[`scripts/provider-precedence-probe.mjs`](../../scripts/provider-precedence-probe.mjs).

The provider id itself is not used by the Router dispatch logic; Codex uses it
for its own task partition. Reusing `custom` is therefore the crucial difference
from the rejected `codex-router-signed` attempt. An isolated copy of the probe
was run with the provider id changed to exactly `custom`: it changed no live
configuration, returned exact markers for `clinepass/kimi-k3` and
`gpt-5.6-sol`, and recorded correlated Router events with HTTP 200 for ClinePass
and OpenAI respectively. The remaining gate is Desktop task visibility after a
restart, not request transport.

## Safe implementation order

1. Leave the live system in its current working `custom` state and leave the
   Router's signed toggle off.
2. Back up, without rewriting, `~/.codex/config.toml`, `auth.json`, the Codex
   state database/session headers, `~/.cc-switch/settings.json`, and
   `cc-switch.db`. Record provider-bucket counts.
3. Repair or replace the polluted CC Switch `codex-official` stored config before
   any CC Switch action can reproject it. Preserve its stored ChatGPT auth object.
4. Create the dedicated Router profile above, with common config enabled, and
   make it CC Switch's current Codex provider. Do not start CC Switch takeover.
5. Disable CC Switch's **Launch on Startup** setting after the profile is safely
   current. This is defense in depth, not a functional dependency; the Router
   profile remains useful for deliberate recovery.
6. Use the Router tray's signed-provider toggle after the dedicated profile is
   current. The shipped toggle snapshots the complete selected provider tree,
   replaces it with the authenticated Router transport, and restores it only
   after an ownership check. It never changes root `model_provider`.
7. Start Codex Router and test through a temporary Codex process first, using
   `model_provider = "custom"` with the exact live provider table. Require both
   an exact response marker and a correlated Router usage event for one native
   GPT model and one external model.
8. Before restarting Desktop, assert that root `model_provider` is still
   `custom`, that provider-bucket counts are unchanged, and that no session or
   task database file was written by setup.
9. Let the user restart Codex. Confirm the sidebar/task count before sending any
   test turn. Then run one small native and one small external turn and verify
   Router events plus the external provider's own usage dashboard.
10. Relaunch and quit CC Switch once with its proxy disabled, then compare a
    secret-redacted semantic snapshot of `config.toml`. Startup must be a no-op.

Do not automatically retag the 94 remaining `openai` tasks, the 7 rejected-
candidate tasks, or other provider buckets as part of provider installation.
Any migration must be separately backed up, limited to explicitly recognized
provider ids, and validated against Codex's encrypted reasoning history. The CC
Switch guide warns that a task can be visible yet fail to resume through a
different backend because `encrypted_content` is backend-bound
([cross-provider caveat](https://github.com/farion1231/cc-switch/blob/v3.19.2/docs/guides/codex-unified-session-history-guide-en.md#scenario-b-cross-provider-resume-of-an-old-session-fails---you-think-this-session-is-broken--gone)).

## Decision

Keep CC Switch for now, but use it only as the durable owner of the single
`custom` provider identity and its recovery snapshot. Do not use its local
proxy. Use the Router's signed-provider toggle to route that identity only
after the dedicated profile has passed the desktop task-visibility gate. Once
that gate passes, CC Switch can be uninstalled if desired while preserving
`~/.cc-switch`; it is not required at request time.
