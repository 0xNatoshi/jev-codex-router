import { PROVIDER_CREDENTIAL_STORE_PATH } from "./paths.mjs";
import {
  ensureCredentialReference,
  readProviderCredentialStore,
  removeCredentialReference,
} from "./provider-credential-store.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import {
  getProviderApiKeyPool,
  deleteProviderApiKeyPool,
  removeProviderApiKey,
  setProviderApiKeyPaused,
  setProviderApiKeyPoolPolicy,
  upsertProviderApiKey,
} from "./provider-api-key-pool.mjs";
import { providerApiKeyPoolReadiness } from "./provider-api-key-routing.mjs";

function canonicalProvider(providerId) {
  const provider = PROVIDERS.get(providerId);
  if (!provider?.credential) throw new Error(`Unknown API-key provider: ${providerId}`);
  return provider.variantOf || provider.id;
}

function storedCredential(providerId, credentialId, credentialStorePath) {
  const provider = canonicalProvider(providerId);
  const credential = readProviderCredentialStore(credentialStorePath).credentials.find(
    (entry) => entry.id === credentialId,
  );
  if (!credential || credential.providerId !== provider || credential.kind !== "api_key") {
    throw new Error(`Credential ${credentialId} is not an API key for ${provider}.`);
  }
  if (credential.state !== "active") {
    throw new Error(`Credential ${credentialId} is not active.`);
  }
  return { provider, credential };
}

export function storedCredentialRequiresServiceEnvironment(
  providerId,
  credentialId,
  { credentialStorePath = PROVIDER_CREDENTIAL_STORE_PATH } = {},
) {
  return storedCredential(providerId, credentialId, credentialStorePath)
    .credential.secretRef.type === "environment";
}

// Removal is deliberately classified from the pool membership that is about
// to be changed, not from the command spelling: `remove` and `delete` carry
// only opaque credential ids. A missing credential-store entry is treated as
// environment-backed. It cannot prove that the installed service definition
// holds no retired variable, so omitting the reinstall reminder would be the
// unsafe answer.
export function storedCredentialPoolUsesServiceEnvironment(
  providerId,
  {
    credentialId,
    credentialStorePath = PROVIDER_CREDENTIAL_STORE_PATH,
    poolStatePath,
  } = {},
) {
  const provider = canonicalProvider(providerId);
  const pool = getProviderApiKeyPool(provider, { filePath: poolStatePath });
  if (!pool.valid) return true;
  const candidates = credentialId
    ? pool.credentials.filter((entry) => entry.id === credentialId)
    : pool.credentials;
  if (candidates.length === 0) return false;

  const stored = readProviderCredentialStore(credentialStorePath);
  const byId = new Map(stored.credentials.map((entry) => [entry.id, entry]));
  return candidates.some((candidate) => {
    const credential = byId.get(candidate.id);
    if (
      !credential ||
      credential.providerId !== provider ||
      credential.kind !== "api_key"
    ) {
      return true;
    }
    return credential.secretRef?.type === "environment";
  });
}

export async function addStoredCredentialToPool(
  providerId,
  credentialId,
  { credentialStorePath = PROVIDER_CREDENTIAL_STORE_PATH, poolStatePath } = {},
) {
  const { provider } = storedCredential(providerId, credentialId, credentialStorePath);
  return upsertProviderApiKey(provider, { id: credentialId }, { filePath: poolStatePath });
}

export async function addEnvironmentCredentialToPool(
  providerId,
  environmentName,
  { credentialStorePath = PROVIDER_CREDENTIAL_STORE_PATH, poolStatePath } = {},
) {
  const provider = canonicalProvider(providerId);
  const ensured = ensureCredentialReference({
    providerId: provider,
    kind: "api_key",
    secretRef: { type: "environment", name: environmentName },
  }, credentialStorePath);
  const credential = ensured.credential;
  try {
    const poolCredential = await upsertProviderApiKey(
      provider,
      { id: credential.id },
      { filePath: poolStatePath },
    );
    return { credential: { id: credential.id, providerId: provider }, poolCredential };
  } catch (error) {
    if (ensured.created) removeCredentialReference(credential.id, credentialStorePath);
    throw error;
  }
}

export async function setStoredCredentialPoolState(providerId, credentialId, paused, options = {}) {
  const provider = canonicalProvider(providerId);
  return setProviderApiKeyPaused(provider, credentialId, paused, { filePath: options.poolStatePath });
}

export async function setStoredCredentialPoolPolicy(providerId, strategy, options = {}) {
  const provider = canonicalProvider(providerId);
  return setProviderApiKeyPoolPolicy(provider, { strategy }, { filePath: options.poolStatePath });
}

export async function removeStoredCredentialFromPool(providerId, credentialId, options = {}) {
  const provider = canonicalProvider(providerId);
  return removeProviderApiKey(provider, credentialId, { filePath: options.poolStatePath });
}

export async function deleteStoredCredentialPool(providerId, options = {}) {
  const provider = canonicalProvider(providerId);
  return deleteProviderApiKeyPool(provider, { filePath: options.poolStatePath });
}

export function storedCredentialPoolStatus(providerId, options = {}) {
  const canonical = canonicalProvider(providerId);
  const status = getProviderApiKeyPool(canonical, { filePath: options.poolStatePath });
  const authority = providerApiKeyPoolReadiness(PROVIDERS.get(canonical), {
    poolStatePath: options.poolStatePath,
    credentialStorePath: options.credentialStorePath,
  });
  return {
    ...status,
    readiness: authority.configured
      ? authority.readiness
      : {
          usable: false,
          reason: "pool_not_configured",
          credentialCount: 0,
          eligibleCredentialCount: 0,
          resolvableCredentialCount: 0,
        },
  };
}
