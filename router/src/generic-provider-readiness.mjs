import { readGenericProviders } from "./generic-provider-state.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { readProviderCredentialStore } from "./provider-credential-store.mjs";
import { resolveGenericProviderCredentialReference } from "./provider-credentials.mjs";

function credentialAvailable(provider) {
  const entry = readProviderCredentialStore().credentials.find(
    (candidate) => candidate.id === provider.credentialRef,
  );
  if (!entry || entry.state !== "active") return false;
  if (entry.providerType !== "generic" || entry.providerId !== provider.id) return false;
  if (entry.kind !== "api_key") return false;
  return Boolean(
    resolveGenericProviderCredentialReference(provider.id, entry.secretRef)?.value,
  );
}

// Catalog publication needs a boolean readiness answer, never the credential
// itself. Keep this separate from generic-providers.mjs so setup and provider
// selection do not import the undici request transport before npm dependencies
// have been installed. A credentialless endpoint is ready only after an
// operator explicitly registered and enabled it in generic provider state.
export function genericProviderConfigured(providerId) {
  try {
    const provider = readGenericProviders({ reservedProviderIds: PROVIDERS })
      .find((entry) => entry.id === providerId);
    if (!provider?.enabled) return false;
    return !provider.credentialRef || credentialAvailable(provider);
  } catch {
    return false;
  }
}
