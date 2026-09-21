function text(value) {
  return String(value || "").trim();
}

export function catalogModelName(modelId) {
  return text(modelId)
    .split(/[\/_-]+/)
    .filter(Boolean)
    .map((part) => /^\d/.test(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

// Catalog discovery is renderer state rather than part of the selected router
// snapshot. Flatten every source that has actually been loaded so the page's
// global model search can see candidates before they have been curated.
export function loadedCatalogModels(directory, catalogStates) {
  const results = [];
  for (const entry of Array.isArray(directory) ? directory : []) {
    // Renderer state can outlive the setup snapshot that made it eligible.
    // Once a credential is removed, never let that previous account's models
    // remain searchable while React waits for the next state cleanup/render.
    if (entry?.setup?.configured === false) continue;
    for (const source of entry?.setup?.catalogSources || []) {
      const catalog = catalogStates?.[source.id]?.data;
      if (!catalog || !Array.isArray(catalog.discovered)) continue;
      const registered = new Set(Array.isArray(catalog.registered) ? catalog.registered : []);
      const unregistered = new Set(Array.isArray(catalog.unregistered) ? catalog.unregistered : []);
      const addable = new Set(
        Array.isArray(catalog.addable) ? catalog.addable : [...unregistered],
      );
      const free = new Set(Array.isArray(catalog.free) ? catalog.free : []);
      for (const modelId of catalog.discovered) {
        const id = text(modelId);
        if (!id) continue;
        const metadata = catalog.metadata?.[id];
        const blockedReason = text(catalog.blocked?.[id]);
        results.push({
          key: `${source.id}\0${id}`,
          modelId: id,
          displayName: catalogModelName(id),
          providerId: text(entry.id),
          providerName: text(entry.displayName) || text(entry.id),
          sourceId: text(source.id),
          sourceName: text(source.displayName) || text(source.id),
          registered: registered.has(id),
          addable: addable.has(id),
          ...(blockedReason ? { blockedReason } : {}),
          contextWindow: metadata?.contextWindow ?? catalog.contextLengths?.[id],
          ...(Number.isInteger(metadata?.maxOutputTokens)
            ? { maxOutputTokens: metadata.maxOutputTokens }
            : {}),
          ...(Array.isArray(metadata?.inputModalities)
            ? { inputModalities: metadata.inputModalities }
            : {}),
          ...(Array.isArray(metadata?.reasoning?.supportedEfforts)
            ? { reasoningEfforts: metadata.reasoning.supportedEfforts }
            : {}),
          ...(typeof metadata?.supportsTools === "boolean"
            ? { supportsTools: metadata.supportsTools }
            : {}),
          isFree: free.has(id) || id === "big-pickle" || id.endsWith("-free"),
        });
      }
    }
  }
  return results.sort((left, right) =>
    left.displayName.localeCompare(right.displayName)
      || left.providerName.localeCompare(right.providerName)
      || left.sourceName.localeCompare(right.sourceName)
      || left.modelId.localeCompare(right.modelId));
}

export function searchLoadedCatalogModels(directory, catalogStates, query) {
  const needle = text(query).toLocaleLowerCase();
  if (!needle) return [];
  return loadedCatalogModels(directory, catalogStates).filter((model) => (
    `${model.displayName} ${model.modelId} ${model.providerName} ${model.providerId} ${model.sourceName} ${model.sourceId}`
      .toLocaleLowerCase()
      .includes(needle)
  ));
}

// Credential mutations invalidate the persistent catalog in the router. Drop
// the matching renderer copies at the same success boundary so global search
// cannot keep showing the previous account while a fresh snapshot is loading.
export function clearProviderCatalogStates(current, catalogSources) {
  const sourceIds = new Set((Array.isArray(catalogSources) ? catalogSources : [])
    .map((source) => text(source?.id))
    .filter(Boolean));
  if (!sourceIds.size) return current;
  const next = { ...(current || {}) };
  let changed = false;
  for (const sourceId of sourceIds) {
    if (!Object.hasOwn(next, sourceId)) continue;
    delete next[sourceId];
    changed = true;
  }
  return changed ? next : current;
}

// Discovery reads are intentionally not serialized with credential mutations:
// a provider can take tens of seconds to answer and must not hold the mutation
// queue that stores or removes a key. A per-source generation makes that safe.
// Replacing a credential invalidates the generation captured by every earlier
// read, so an old account's eventual response cannot repopulate renderer state.
export function beginCatalogRequest(generations, sourceId) {
  const source = text(sourceId);
  if (!source) return 0;
  const next = Math.max(0, Number(generations?.[source]) || 0) + 1;
  generations[source] = next;
  return next;
}

export function invalidateProviderCatalogRequests(generations, catalogSources) {
  for (const source of Array.isArray(catalogSources) ? catalogSources : []) {
    beginCatalogRequest(generations, source?.id);
  }
}

export function catalogRequestIsCurrent(generations, sourceId, generation) {
  const source = text(sourceId);
  return Boolean(source) && Number.isSafeInteger(generation) && generation > 0
    && generations?.[source] === generation;
}

function changePendingCatalogModels(current, providerId, modelIds, delta) {
  const provider = text(providerId);
  if (!provider || !Array.isArray(modelIds) || !modelIds.length) return current;
  const nextCounts = { ...(current?.[provider] || {}) };
  for (const rawId of modelIds) {
    const modelId = text(rawId);
    if (!modelId) continue;
    const count = Math.max(0, (Number(nextCounts[modelId]) || 0) + delta);
    if (count > 0) nextCounts[modelId] = count;
    else delete nextCounts[modelId];
  }
  const next = { ...(current || {}) };
  if (Object.keys(nextCounts).length) next[provider] = nextCounts;
  else delete next[provider];
  return next;
}

// IPC serializes catalog mutations, but renderer clicks can queue more than
// one operation before the first finishes. Counts keep one completion from
// clearing another operation's placeholder, including two adds of the same id.
export function addPendingCatalogModels(current, providerId, modelIds) {
  return changePendingCatalogModels(current, providerId, modelIds, 1);
}

export function removePendingCatalogModels(current, providerId, modelIds) {
  return changePendingCatalogModels(current, providerId, modelIds, -1);
}

export function pendingCatalogModelIds(current, providerId) {
  return Object.entries(current?.[providerId] || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([modelId]) => modelId);
}

export function modelRouteProviderId(model) {
  const slug = text(model?.slug);
  const slash = slug.indexOf("/");
  return slash > 0 ? slug.slice(0, slash) : "";
}

export function modelRouteProtocol(model) {
  const routeProvider = modelRouteProviderId(model);
  if (routeProvider.endsWith("-messages")) return "messages";
  if (routeProvider.endsWith("-responses")) return "responses";
  return "default";
}

export function modelRouteKind(model) {
  if (model?.native) return "Native Codex route";
  const protocol = modelRouteProtocol(model);
  if (protocol === "messages") return "Messages API route";
  if (protocol === "responses") return "Responses API route";
  const routeProvider = modelRouteProviderId(model);
  if (routeProvider.includes("oauth")) return "OAuth route";
  if (model?.isFree) return "Free provider route";
  return "Provider API route";
}
