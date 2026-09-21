# Experimental Grok structured patch bridge

This candidate is not a recommended runtime profile. Quality and performance
acceptance are pending. It does not establish parity with Grok CLI or Build.
The original Router-side codec and the negotiated client-hook mode below are
separate opt-ins; neither is installed or enabled automatically.

`CODEX_ROUTER_GROK_STRUCTURED_PATCH=1` opts a Router process into schema version
1 for the exact `grok-oauth/grok-4.6` route. The default is off. The client must
declare a native custom `apply_patch` in that request; history and forced tool
choice alone cannot enable it. Other routes retain their existing behavior.

Router presents structured arguments for that tool and deterministically
compiles them into native patch text. Codex executes the native tool and owns
its permission checks, sandbox, context matching, and newline semantics.
Router does not read source files or apply edits.

## Argument contract

The root contains `operations`, a nonempty array:

- `add`: `path` and `lines`, an array of literal logical lines.
- `delete`: `path`.
- `update`: `path` and `hunks`. Each hunk has `lines` containing `{kind, text}`
  entries; `kind` is `context`, `add`, or `remove`. Optional `anchor` specifies
  the native exact context marker. Optional `endOfFile: true` is allowed only
  on the final hunk.

The canonical schema and bounds are in `src/grok-structured-patch.mjs`. Unknown
fields, ambiguous JSON keys, unsupported operations, embedded line separators,
invalid Unicode, duplicate paths, and no-op update hunks are rejected. Paths
are literal single header values; allowing an absolute path is not permission
to access it. Native Codex authorization still applies.

The serializer authors patch delimiters and line prefixes. It does not fix
source code, search for approximate matches, or request another model response.
The existing native parser owns line-oriented file behavior, including final
newlines. This interface does not promise arbitrary binary or byte-exact file
creation.

Legacy calls, including failed patches outside the new subset, remain in
history as lossless `{input: rawPatch}` envelopes under the collision-resolved
provider tool name. That envelope is not accepted for newly generated calls.
Call IDs, paired results, tool choices, and ordinary same-name tools retain
their identities.

Complete structured arguments are validated before any compiled patch input
is emitted. The response relay compares the source and compiled input across
arguments completion, item completion, and terminal summaries. Ambiguous,
contradictory, or oversized responses fail closed in this mode.

## Evidence and limitations

Usage events expose only `{enabled, applied, schemaVersion}` in
`grokStructuredPatch`; `applied` distinguishes actual conversion from an enabled
flag without a native tool. Historical usage rows need not contain this field.
No prompt, patch content, or reasoning is included in this metadata.

The offline verifier uses real Router, LiteLLM and forwarder processes with
mock xAI responses:

```sh
node scripts/verify-grok-apply-patch-guidance.mjs <venv-python> --structured
```

An optional `--codex=<installed-codex-binary>` additionally verifies the native
handler under `workspace-write`: a context mismatch returns through the full
path, then a supplied correction modifies a temporary fixture. It builds a
temporary catalog using Router's catalog conversion and the binary's bundled
metadata. This separate CLI process is an offline handler probe, not a native
Desktop benchmark or proof of benchmark isolation.

Optional `--native-fault=disconnect` and `--native-fault=duplicate-close`
exercise upstream interruption and repeated item completion with a native
handler. An insertion marker must appear exactly once after the retry or
normal continuation. The default structured verifier also checks invalid
arguments without a hidden Router request and client cancellation propagating
to the mock upstream.

`--native-fault=invalid-arguments` records the observed Codex 0.153.4 recovery
limitation: the client leaves the fixture unchanged, makes six transport attempts, and fails
without model-visible native tool feedback. This records a current limitation,
not successful recovery; a client that changes this behavior fails the negative
oracle and needs a fresh assessment. Context-error recovery does not resolve it. Live
provider schema adherence, benchmark read isolation, and comparative quality
acceptance remain separate gates. Do not enable this mode by default or treat
passing protocol tests as evidence of faster or better model work.


## Negotiated native client hook

The second experimental mode moves serialization into the official Codex
`PreToolUse` hook. This lets invalid structured arguments become a real native
tool error rather than a transport failure. Codex still executes `apply_patch`;
Router does not execute the hook, modify files, synthesize tool results or make
hidden model requests.

Activation requires all three on each request:

- Route exactly `grok-oauth/grok-4.6`.
- Router process environment `CODEX_ROUTER_GROK_PATCH_HOOK=1`.
- Client header `x-codex-router-patch-hook: structured-patch-v1`, or the
  explicit capability base path described under deployment below.

The header or endpoint declares a capability; it is not proof that a hook is trusted or
that its code is protected. The offline native verifier independently checks
hook discovery and command trust using a disposable `CODEX_HOME`. Do not send
this declaration from a client that has not passed its own preflight. If either
opt-in is missing, the previous behavior remains, including the original
`CODEX_ROUTER_GROK_STRUCTURED_PATCH=1` codec when separately enabled. When both
modes are enabled, negotiated hook mode takes precedence. Only a declared
native custom `apply_patch` receives the structured schema; history alone
never grants the executable tool.

Router frames the complete argument string as the literal line
`CODEX_ROUTER_STRUCTURED_PATCH_V1` followed by a newline and the original
arguments. Within the 1 MiB UTF-8 argument bound, whitespace, number spellings,
escapes, duplicate JSON keys and invalid JSON survive transport unchanged.
Outer response syntax, identities, contradictory completion, byte bounds and
cancellation remain transport checks. On subsequent turns Router strips the
prefix to restore the exact provider argument string, including failed calls.
Unprefixed legacy history retains its original `{input: rawPatch}` envelope.
The capability header is consumed locally and is not sent to the provider.

`scripts/grok-patch-hook.mjs` is the native command entrypoint. It accepts one
UTF-8 JSON event from stdin (at most 8 MiB, allowing JSON escaping overhead).
Only exact model, canonical native tool name and prefix match. The shared pure
codec either returns `updatedInput.command` with a native patch, or a native
`deny` with a bounded, content-free reason. Native Codex then performs its own
parse, context matching, authorization and sandbox checks. Other events pass
unchanged. Input/runtime failures exit nonzero without exposing source text.
The original framed input is not valid native patch syntax if the hook is
absent or untrusted; this is not a claim that arbitrary hook failures deny
ordinary native tool calls.

To replace the input, the hook must answer `permissionDecision: "allow"`;
Codex refuses `updatedInput` otherwise. Whether that decision also skips an
approval Codex would request under `untrusted` or `on-request` is not
established by the native probe, which runs with `approval_policy="never"`.
Until a native control under those policies shows an approval request or an
unchanged file, use hook mode only where the patch would not need approval.

While either codec is enabled it applies to the whole response. An ordinary
tool call in the same response whose streamed arguments the relay cannot verify
-- duplicate JSON keys, or an arguments event with no known output item -- fails
the stream instead of passing through. This affects only the opt-in experiment.

Diagnostics add only optional `mode: "client_hook"` to `grokStructuredPatch`.
Old metadata and usage records remain readable. No new content logging is
introduced.

### Offline verification

The same explicitly supplied hash-locked Python environment is used for all
three protocol variants. No live provider is contacted:

```sh
node scripts/verify-grok-apply-patch-guidance.mjs <venv-python> --native-hook
node scripts/verify-grok-apply-patch-guidance.mjs <venv-python> --native-hook --codex=<codex-binary>
```

The native probe checks invalid arguments, correlated real tool feedback,
corrected arguments and one fixture update through Router, LiteLLM, the Grok
forwarder and a local mock provider. Optional `--native-hook-control=missing`,
`untrusted`, or `changed` uses a valid operation and asserts refusal without a
write; `changed` means a changed discovered command, not modified source.
`--native-fault=disconnect` and `duplicate-close` check recovery without a
repeated insertion. Identical provider completions may be deduplicated before
reaching Router; the full-path oracle is one completed call and one insertion,
not mandatory rejection of that duplicate. Contradictory completions are still
rejected. `--native-error-padding=N` measures argument and provider-visible feedback
sizes in bytes without printing their contents. `--native-outside-dir=/absolute/parent`
creates and removes its own canary under that explicitly supplied parent; a
trusted-hook update must be refused by native permissions and leave both the
canary and in-workspace fixture unchanged. Choose a parent outside the native
workspace and writable roots for this negative control.

### Deployment and acceptance boundaries

Clients whose built-in provider cannot set the capability header may explicitly
select `/v1/_codex-router/structured-patch-v1` as their Router base path.
The existing bearer or caller-path authentication is still required. Router
normalizes the path only after authentication, consumes the capability locally,
and still requires the exact Grok 4.6 route and Router hook flag. Other model
routes retain their tool behavior. The endpoint is a client declaration, not
proof that the hook was discovered, trusted or executed.

On the shared WebSocket edge, a streamed `error` without a valid HTTP failure
status receives status 502. Native Codex otherwise ignores that event and can
wait indefinitely on the still-open socket. Existing 400–599 statuses and error
details are preserved. This changes failure framing for every WebSocket route;
it does not initiate a Router retry or replay a partially delivered response.

The Codex config manager preserves this explicitly selected base on enable,
repair and caller-capability refresh; fresh installs continue to select `/v1`.
Selecting it requires the same independent protected-payload and native-trust
preflight as the header. Ordinary already-loaded Desktop tasks retain their
provider endpoint; changing the file does not update their existing children.
Verify a freshly loaded real Desktop task and child before claiming activation.

An installer can persist the Router opt-in as the private state file
`grok-patch-hook.json`, exactly `{"version":1,"enabled":true}`. macOS, Linux
and Windows service renderers retain this setting during regeneration. An
explicit `CODEX_ROUTER_GROK_PATCH_HOOK` environment value takes precedence;
only `1` enables it. Missing or malformed state cannot enable it. To roll back,
restore the ordinary client base, remove the opt-in file and service flag, and
reload the service and client. This file neither installs nor trusts a hook.

The offline endpoint probe also supports the ordinary built-in OpenAI provider
with a disposable noncredential fixture; it does not select a custom profile:

```sh
node scripts/verify-grok-apply-patch-guidance.mjs <venv-python> --native-hook --native-hook-endpoint --codex=<codex-binary>
```

This repository does not automatically install or trust the hook, change
Codex configuration, set the capability header, or provision benchmark
isolation. The temporary native CLI fixture is not a native Desktop benchmark.
It establishes protocol/handler behavior, not isolation of every Desktop tool.

Native hook command trust hashes command configuration, not the script or its
imports. Hooks run outside the native patch sandbox. Before any live pilot,
the Node executable, script and complete imported module graph must be protected
from model writes, and client preflight must independently verify the trusted
command and supported transport version. A source hash manifest, chmod alone,
or a source tree in writable scratch storage does not enforce that boundary.

Codex may echo the original command when reporting a denied hook. A short
reason therefore does not bound the complete feedback; near-limit invalid
arguments can consume substantial context. Native version and measured
provider-visible feedback sizes must be recorded separately from token counts.
Downstream truncation or aging can change this measurement; it is not a bound
on the original native denial or future provider context. No performance
or quality gain follows from passing these deterministic checks.
