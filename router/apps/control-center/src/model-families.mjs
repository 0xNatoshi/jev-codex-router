// Provider-qualified slugs are routing identities, not model identities. The
// same model can be reachable through several credentials, plans, and API
// surfaces, so keep every route while presenting one model family in the UI.

function withoutProviderQualifier(value) {
  return String(value || "").trim().replace(/\s+\([^()]+\)\s*$/u, "").trim();
}

export function modelFamilyName(model) {
  const name = withoutProviderQualifier(model?.displayName || model?.slug);
  return name;
}

export function modelFamilyKey(model) {
  return modelFamilyName(model)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

export function groupModelFamilies(models) {
  const grouped = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const id = modelFamilyKey(model) || String(model?.slug || "model");
    const current = grouped.get(id);
    if (current) current.routes.push(model);
    else grouped.set(id, { id, displayName: modelFamilyName(model), routes: [model] });
  }
  return [...grouped.values()]
    .map((family) => ({
      ...family,
      routes: family.routes.sort((left, right) =>
        String(left.provider).localeCompare(String(right.provider))
          || String(left.slug).localeCompare(String(right.slug))),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function preferredFamilyRoute(family) {
  return family?.routes?.find((model) => model.visible)
    || family?.routes?.find((model) => model.enabled || model.native)
    || family?.routes?.[0];
}
