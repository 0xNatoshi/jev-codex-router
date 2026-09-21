// A client capability declaration, never authentication or proof of hook trust.
// Normalize only AFTER caller authentication; do not forward it to providers.
export const CODEX_PATCH_HOOK_BASE_PATH = "/v1/_codex-router/structured-patch-v1";

export function codexPatchHookEndpoint(authenticatedPath) {
  if (authenticatedPath === CODEX_PATCH_HOOK_BASE_PATH ||
      authenticatedPath?.startsWith(`${CODEX_PATCH_HOOK_BASE_PATH}/`)) {
    return {
      pathname: `/v1${authenticatedPath.slice(CODEX_PATCH_HOOK_BASE_PATH.length)}`,
      capability: "structured-patch-v1",
    };
  }
  return { pathname: authenticatedPath };
}
