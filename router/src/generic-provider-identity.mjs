export const GENERIC_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeGenericProviderIdSyntax(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  if (!GENERIC_PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error("Provider id must match [a-z0-9][a-z0-9-]*.");
  }
  return providerId;
}

export function normalizeGenericProviderId(value, { reservedProviderIds } = {}) {
  const providerId = normalizeGenericProviderIdSyntax(value);
  if (!reservedProviderIds?.has) {
    throw new Error("Generic provider identity validation requires the checked-in provider registry.");
  }
  if (reservedProviderIds?.has?.(providerId)) {
    throw new Error(`Provider id ${providerId} is already used by the built-in registry.`);
  }
  return providerId;
}
