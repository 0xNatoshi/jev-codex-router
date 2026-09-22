export const TRUSTED_SEARCH_ORIGIN = "https://api.perplexity.ai";

// Keep this module dependency-light. Catalog construction and doctor import it
// before the request stack is necessarily installed or initialized.
export function trustedSearchProviderDescriptor(provider, { requireGeneric = false } = {}) {
  let endpoint;
  try {
    endpoint = new URL(provider?.baseUrl);
  } catch {
    return false;
  }
  return (!requireGeneric || provider?.generic === true) &&
    provider?.enabled === true &&
    provider.adapter === "openai-chat" &&
    provider.allowPrivate === false &&
    typeof provider.credentialRef === "string" &&
    provider.credentialRef.length > 0 &&
    endpoint.origin === TRUSTED_SEARCH_ORIGIN &&
    ["", "/"].includes(endpoint.pathname) &&
    !endpoint.search &&
    !endpoint.hash;
}
