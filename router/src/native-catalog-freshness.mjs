export function nativeCatalogVersionDrift(
  catalog,
  currentVersion,
  { adopted = false } = {},
) {
  if (adopted || !currentVersion) return undefined;
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    return undefined;
  }
  const captured =
    typeof catalog.captured_with === "string" && catalog.captured_with.trim()
      ? catalog.captured_with.trim()
      : undefined;
  if (captured === currentVersion) return undefined;
  return {
    captured: captured || "unknown build",
    current: currentVersion,
  };
}
