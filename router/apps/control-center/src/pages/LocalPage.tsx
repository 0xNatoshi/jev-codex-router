import { useMemo, useState, type FormEvent } from "react";
import {
  ChevronDown,
  Download,
  Eye,
  Gauge,
  HardDrive,
  Play,
  RefreshCw,
  SearchX,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  InlineNotice,
  PageHeader,
  PanelSkeleton,
  SearchField,
  SectionHeading,
  StatStrip,
  Toggle,
} from "../components";
import { compactNumber, formatBytesGb } from "../lib";
import { BrandLogo, brandForLocalModel } from "../provider-branding";
import type { LocalModel, LocalModelsSnapshot, OperationEvent, RouterControlApi, RouterDataReady, RouterTarget, VisionEngine } from "../types";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";
import "./local-harness-context.css";

interface LocalPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  dataReady: RouterDataReady;
  operation?: OperationEvent | null;
  onRefresh: () => void;
  runAction: RunAction;
}

export function LocalPage({ target, api, refreshing, dataReady, operation, onRefresh, runAction }: LocalPageProps) {
  const [installRef, setInstallRef] = useState("");
  const [forceInstall, setForceInstall] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set());
  const local = target?.modelSettings?.localModels;
  const mlx = local?.mlx;
  const mlxStatus = mlx?.operation?.status || "idle";
  const mlxActive = ["preparing", "downloading", "loading", "starting-server", "verifying", "publishing"].includes(mlxStatus);
  const mlxPublished = mlx?.runtime?.published === true;
  const mlxReady = mlxPublished && mlx?.runtime?.served === true;
  const mlxSupported = mlx?.host?.supported !== false;
  const activeAction = operation?.action || "";
  const ollamaMutationActive = ["downloading", "uninstalling"].includes(local?.download?.status || "") || (
    operation?.status === "started" && (
      activeAction === "installLocalModel" ||
      activeAction === "uninstallLocalModel" ||
      activeAction.startsWith("Install ") ||
      activeAction.startsWith("Remove ")
    )
  );
  const bridge = target?.modelSettings?.visionBridge;
  const installed = local?.models?.filter((model) => model.installed !== false) ?? [];
  const installedCount = typeof local?.installed === "number"
    ? local.installed
    : Array.isArray(local?.installed)
      ? local.installed.length
      : installed.length;
  const enabledTags = Array.isArray(local?.enabled)
    ? local.enabled
    : installed.filter((model) => model.enabled === true).map((model) => model.tag);
  const localEnabledStates = useMemo(() => {
    const enabled = Array.isArray(local?.enabled) ? new Set(local.enabled) : undefined;
    return new Map((local?.models ?? [])
      .filter((model) => model.installed !== false)
      .map((model) => [model.tag, enabled?.has(model.tag) || model.enabled === true]));
  }, [local?.enabled, local?.models]);
  const visionEnabledStates = useMemo(() => new Map([
    ["vision", bridge?.enabled === true],
  ]), [bridge?.enabled]);
  const optimisticLocalModels = useOptimisticValues(localEnabledStates, runAction);
  const optimisticVision = useOptimisticValues(visionEnabledStates, runAction);
  const enabledCount = installed.filter((model) => optimisticLocalModels.value(
    model.tag,
    enabledTags.includes(model.tag) || model.enabled === true,
  )).length;
  const localReaders = bridge?.localModels ?? local?.availableVision ?? [];
  const readerDownloadActive = bridge?.download?.status === "downloading";
  const engines: Array<VisionEngine & { group: string }> = [
    ...(bridge?.nativeEngines ?? []).map((engine) => ({ ...engine, group: "ChatGPT plan" })),
    ...(bridge?.paidEngines ?? []).map((engine) => ({ ...engine, group: "Connected provider" })),
  ];
  const selectedEngine = bridge?.engine || "auto";
  const selectedEngineMeta = engines.find((engine) => engine.slug === selectedEngine);
  const effortOptions = selectedEngineMeta?.efforts?.length
    ? selectedEngineMeta.efforts
    : bridge?.availableEfforts ?? [];
  const catalogModels = local?.availableExplore ?? [];
  const quickPicks = useMemo(
    () => [
      ...(Array.isArray(local?.available) ? local.available : []),
      ...(local?.availableVision ?? []),
    ].slice(0, 8),
    [local?.available, local?.availableVision],
  );
  const catalogFamilies = useMemo(
    () => groupCatalogModels(catalogModels, local?.families, catalogQuery),
    [catalogModels, catalogQuery, local?.families],
  );

  async function installLocal(event: FormEvent) {
    event.preventDefault();
    const model = installRef.trim();
    if (!model || !api) return;
    setInstallRef("");
    await runAction(`Install ${model}`, () => api.installLocalModel(model, forceInstall));
  }

  if (!target) {
    return (
      <div className="local-page">
        <PageHeader
          eyebrow="On-device inference"
          title="Local"
          description="Run, install, measure, and expose Ollama and curated MLX models without leaving the control center."
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
        {!dataReady.snapshot ? (
          <section className="panel-section" aria-label="Loading local models" aria-busy="true">
            <PanelSkeleton label="Loading local model runtime" count={5} />
          </section>
        ) : (
          <EmptyState icon={<SearchX size={22} />} title="Local runtime unavailable" body="Start the router or refresh after setup completes." />
        )}
      </div>
    );
  }

  return (
    <div className="local-page">
      <PageHeader
        eyebrow="On-device inference"
        title="Local"
        description="Run, install, measure, and expose Ollama and curated MLX models without leaving the control center."
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <StatStrip items={[
        { label: "Runtime", value: local?.runtime?.running ? "Online" : "Offline", detail: local?.runtime?.version ? `Ollama ${local.runtime.version}` : "Ollama" },
        { label: "Installed", value: installedCount, detail: `${enabledCount} in Codex` },
        { label: "Model storage", value: formatBytesGb(local?.totalGb), detail: local?.runtime?.modelsPath || "Location managed by Ollama" },
        { label: "Image reader", value: bridge?.engine === "local" ? "Local" : bridge?.resolvedEngineName || "Automatic", detail: optimisticVision.value("vision", bridge?.enabled === true) ? "Bridge enabled" : "Bridge disabled" },
      ]} />

      <InlineNotice tone={local?.runtime?.running ? "success" : "warning"} title={local?.runtime?.running ? "Ollama is ready" : "Ollama is not running"}>
        {local?.machine || "Machine capacity has not been measured yet."}
      </InlineNotice>

      <section className="panel-section mlx-install-card">
        <SectionHeading
          title="Qwen 3.8 27B · MLX"
          description="A separate Apple-silicon runtime served through LM Studio and wired into the Codex proxy."
          action={<Badge tone={mlxReady ? "success" : mlxActive ? "accent" : mlxStatus === "error" ? "danger" : "neutral"}>{mlxReady ? "In Codex" : !mlxSupported ? "Unsupported host" : mlxPublished ? "Repair needed" : mlxActive ? mlxStageLabel(mlxStatus) : mlxStatus === "error" ? "Needs attention" : "Not installed"}</Badge>}
        />
        <div className="mlx-install-layout">
          <div className="mlx-install-copy">
            <strong>Qwen3.8-27B-Uncensored · 4-bit MLX</strong>
            <p>One click installs any missing official local-runtime prerequisites, downloads about 15 GB of weights, starts the loopback server, verifies the model, and publishes <code>{mlx?.model?.slug || "lmstudio/qwen38-27b-uncensored-mlx"}</code> to Codex.</p>
            <div className="mlx-prerequisites" aria-label="MLX prerequisites">
              <span><i className={mlx?.prerequisites?.lms?.available ? "is-ready" : ""} /> LM Studio CLI {mlx?.prerequisites?.lms?.available ? "ready" : "installed during setup"}</span>
              <span><i className={mlx?.prerequisites?.uvx?.available ? "is-ready" : ""} /> Hugging Face downloader {mlx?.prerequisites?.uvx?.available ? "ready" : "installed during setup"}</span>
              <span><i className={mlx?.runtime?.loopbackReachable ? "is-ready" : ""} /> Loopback only</span>
            </div>
            {!mlx?.prerequisites?.lms?.available && mlx?.prerequisites?.lms?.installHint ? <small>{mlx.prerequisites.lms.installHint}</small> : null}
            {!mlx?.prerequisites?.uvx?.available && mlx?.prerequisites?.uvx?.installHint ? <small>{mlx.prerequisites.uvx.installHint}</small> : null}
          </div>
          <div className="mlx-install-actions">
            {mlxActive ? (
              <Button variant="secondary" disabled={!api} onClick={() => api && void runAction("Cancel Qwen MLX installation", () => api.cancelLocalMlx())}>Cancel</Button>
            ) : (
              <Button variant="primary" disabled={!api || mlxReady || !mlxSupported || ollamaMutationActive} onClick={() => api && void runAction("Start Qwen MLX installation", () => api.installLocalMlx())}>
                <Download aria-hidden size={14} strokeWidth={1.7} /> {mlxReady ? "Installed" : mlxPublished ? "Repair and reconnect" : mlxStatus === "error" || mlxStatus === "cancelled" ? "Retry install" : "Install and add to Codex"}
              </Button>
            )}
            <small>By continuing, you consent to the runtime installation, model download, and local proxy publication.</small>
          </div>
        </div>
        <InlineNotice tone="warning" title="Reduced guardrails; local access only">This uncensored checkpoint intentionally weakens model safeguards. The router binds it to loopback only; treat its output and any generated tool arguments as untrusted.</InlineNotice>
        {!mlxSupported ? <InlineNotice tone="warning" title="Apple silicon required">{mlx?.host?.reason || "This MLX model can only be installed on a supported Apple-silicon Mac."}</InlineNotice> : null}
        {ollamaMutationActive && !mlxActive ? <InlineNotice tone="warning" title="Another local-model change is running">Wait for the Ollama download or removal to finish before starting MLX setup.</InlineNotice> : null}
        {mlxActive ? <DownloadProgress tag={mlxStageLabel(mlxStatus)} percent={mlx?.operation?.percent} detail={mlx?.operation?.detail || "Working in the background"} indeterminate={mlx?.operation?.progressMode === "indeterminate"} /> : null}
        {mlxStatus === "error" ? <InlineNotice tone="danger" title="MLX installation stopped">{mlx?.operation?.error || mlx?.operation?.detail || "The installer reported an unknown error. Retry or review the prerequisite hints above."}</InlineNotice> : null}
        {mlxStatus === "cancelled" ? <InlineNotice tone="warning" title="MLX installation cancelled">Downloaded files are kept so a retry can resume without starting over.</InlineNotice> : null}
        {mlxReady ? <InlineNotice tone="success" title="Ready in Codex">Fully quit and reopen Codex to refresh its model picker, then choose <code>{mlx?.model?.slug || "lmstudio/qwen38-27b-uncensored-mlx"}</code>.</InlineNotice> : null}
      </section>

      <div className="lhc-local-grid">
        <section className="panel-section lhc-local-installed">
          <SectionHeading
            title="Installed models"
            description="Enabled models appear in Codex after the picker catalog refreshes."
            action={
              <div className="row-actions">
                {!local?.runtime?.running ? (
                  <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Start local runtime", () => api.controlLocalRuntime("start"))}>
                    <Play aria-hidden size={13} strokeWidth={1.7} /> Start runtime
                  </Button>
                ) : null}
                {local?.runtime?.installed ? (
                  <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Update local runtime", () => api.controlLocalRuntime("update"))}>
                    <RefreshCw aria-hidden size={13} strokeWidth={1.7} /> Update Ollama
                  </Button>
                ) : null}
              </div>
            }
          />
          {installed.length ? (
            <div className="table-list">
              {installed.map((model) => (
                <LocalModelRow
                  key={model.tag}
                  model={model}
                  enabled={optimisticLocalModels.value(model.tag, enabledTags.includes(model.tag) || model.enabled === true)}
                  disabled={!api}
                  onToggle={(next) => api && void optimisticLocalModels.mutate(model.tag, next, `${next ? "Enable" : "Disable"} ${model.tag}`, () => api.setLocalModelEnabled(model.tag, next))}
                  onBenchmark={() => api && void runAction(`Benchmark ${model.tag}`, () => api.benchmarkLocalModel(model.tag))}
                  onRemove={() => setPendingRemoval(model.tag)}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={<HardDrive size={21} />} title="No local models installed" body="Install an Ollama model below. Progress remains visible while the download runs." />
          )}
        </section>

        <section className="panel-section lhc-runtime-facts">
          <SectionHeading title="Runtime details" description="Read-only facts reported by the router and Ollama." />
          <dl>
            <div><dt>State</dt><dd>{local?.runtime?.running ? "Running" : local?.runtime?.installed ? "Stopped" : "Not installed"}</dd></div>
            <div><dt>Version</dt><dd>{local?.runtime?.version || "Not reported"}</dd></div>
            <div><dt>Managed</dt><dd>{local?.runtime?.managed ? "Router managed" : "External runtime"}</dd></div>
            <div><dt>Models path</dt><dd title={local?.runtime?.modelsPath}>{local?.runtime?.modelsPath || "Ollama default"}</dd></div>
          </dl>
        </section>
      </div>

      <section className="panel-section">
        <SectionHeading title="Install a model" description="Enter an Ollama tag or an HTTPS ollama.com model page. The runtime is installed only after this explicit action." />
        <form className="install-form" onSubmit={(event) => void installLocal(event)}>
          <label htmlFor="local-model-ref">Model tag or Ollama URL</label>
          <div>
            <input id="local-model-ref" value={installRef} onChange={(event) => setInstallRef(event.target.value)} placeholder="qwen3.5:9b" spellCheck={false} />
            <Button variant="primary" disabled={!api || !installRef.trim()} type="submit"><Download aria-hidden size={14} strokeWidth={1.7} /> Install</Button>
          </div>
        </form>
        <label className="check-label install-override"><input type="checkbox" checked={forceInstall} onChange={(event) => setForceInstall(event.target.checked)} /> Allow a model larger than the router recommends for this machine</label>
        {local?.download?.status && local.download.status !== "done" ? (
          <DownloadProgress tag={local.download.tag} percent={local.download.percent} detail={local.download.detail || local.download.status} />
        ) : null}
        {quickPicks.length ? (
          <div className="lhc-local-quick-picks">
            <div className="lhc-local-subheading"><strong>Quick picks</strong><span>Shortlist for this machine</span></div>
            <div className="lhc-recommendations">
              {quickPicks.map((model) => (
                <button key={model.tag} type="button" disabled={model.downloadable === false} onClick={() => setInstallRef(model.tag)}>
                  <BrandLogo brand={brandForLocalModel(model)} size="small" />
                  <span><strong>{model.displayName || model.label || model.tag}</strong><small>{formatBytesGb(model.sizeGb)} · {model.fit || "fit unknown"}</small></span>
                  {model.downloadable === false ? <Badge tone="neutral">Cloud only</Badge> : model.recommended ? <Badge tone="accent">Recommended</Badge> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {catalogModels.length ? (
          <div className="lhc-catalog-browser">
            <div className="lhc-catalog-toolbar">
              <SearchField value={catalogQuery} onChange={setCatalogQuery} placeholder="Search Ollama families or tags" />
              <span>{catalogFamilies.length} famil{catalogFamilies.length === 1 ? "y" : "ies"} · {catalogVisibleTagCount(catalogFamilies)} {catalogQuery.trim() ? "matches" : "tags"}</span>
            </div>
            {catalogFamilies.length ? catalogFamilies.map((family) => {
              const expanded = expandedFamilies.has(family.id);
              return (
                <section className="lhc-catalog-family" key={family.id} data-expanded={expanded}>
                  <button
                    type="button"
                    className="lhc-catalog-family-trigger"
                    aria-expanded={expanded}
                    onClick={() => setExpandedFamilies((current) => {
                      const next = new Set(current);
                      if (next.has(family.id)) next.delete(family.id);
                      else next.add(family.id);
                      return next;
                    })}
                  >
                    <BrandLogo brand={brandForLocalModel(family.models[0])} size="medium" />
                    <div>
                      <strong>{family.displayName}</strong>
                      <small>{family.models.length} tags · {familySummary(family.models)}</small>
                    </div>
                    <ChevronDown aria-hidden size={15} strokeWidth={1.7} />
                  </button>
                  {expanded ? (
                    <div className="lhc-catalog-family-panel">
                      {family.researchStatus ? <small className="lhc-catalog-research">{family.researchStatus}{family.researchCapabilities.length ? ` · ${family.researchCapabilities.join(" · ")}` : ""}</small> : null}
                      {family.researchNote ? <p className="lhc-catalog-note">{family.researchNote}</p> : null}
                      <div className="lhc-catalog-model-list">
                        {family.models.map((model) => (
                          <CatalogModelRow key={model.tag} model={model} allowOversized={forceInstall} onSelect={() => setInstallRef(model.tag)} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </section>
              );
            }) : (
              <EmptyState icon={<SearchX size={18} />} title="No Ollama tags match" body="Try a family name, size, or exact tag." />
            )}
          </div>
        ) : null}
      </section>

      <section className="panel-section">
        <SectionHeading title="Image reading" description="Choose how text-only models read pasted images. Local readers stay on this machine." />
        <div className="lhc-vision-settings">
          <div className="setting-row">
            <div><strong>Read pasted images</strong><small>The selected reader runs only when the target model cannot accept images.</small></div>
            <Toggle checked={optimisticVision.value("vision", bridge?.enabled === true)} disabled={!api || !bridge} label="Enable vision bridge" onChange={(next) => api && void optimisticVision.mutate("vision", next, `${next ? "Enable" : "Disable"} vision bridge`, () => api.setVisionBridgeEnabled(next))} />
          </div>
          <div className="form-grid">
            <label>
              <span>Reader</span>
              <select value={selectedEngine} disabled={!api || !bridge} onChange={(event) => api && void runAction("Change image reader", () => api.setVisionBridgeEngine(event.target.value))}>
                <option value="auto">Automatic</option>
                {engines.filter((engine) => engine.group === "ChatGPT plan").length ? (
                  <optgroup label="ChatGPT plan">
                    {engines.filter((engine) => engine.group === "ChatGPT plan").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                  </optgroup>
                ) : null}
                {engines.filter((engine) => engine.group === "Connected provider").length ? (
                  <optgroup label="Connected providers">
                    {engines.filter((engine) => engine.group === "Connected provider").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                  </optgroup>
                ) : null}
                {bridge?.local ? <option value="local">Local: {bridge.local.model || "configured runtime"}</option> : null}
              </select>
            </label>
            <label>
              <span>Reasoning effort</span>
              <select value={bridge?.effort || "default"} disabled={!api || !bridge} onChange={(event) => api && void runAction("Change image-reader effort", () => api.setVisionBridgeEffort(event.target.value))}>
                <option value="default">Reader default</option>
                {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
          </div>
          <InlineNotice tone={bridge?.resolvedEngine ? "success" : "warning"} title={bridge?.resolvedEngine ? "Reader resolved" : "No reader available"}>
            {bridge?.resolvedEngineName ? `${bridge.resolvedEngineName} will transcribe images.` : "Connect a vision provider or download a local image reader."}
          </InlineNotice>
        </div>

        {readerDownloadActive ? <DownloadProgress tag={bridge?.download?.tag} percent={bridge?.download?.percent} detail={bridge?.download?.detail || "Downloading local reader"} /> : null}
        {localReaders.length ? (
          <div className="local-reader-grid lhc-reader-grid">
            {localReaders.map((reader) => {
              const active = bridge?.engine === "local" && bridge.local?.model === reader.tag;
              return (
                <article className="reader-card" key={reader.tag}>
                  <header>
                    <BrandLogo brand={brandForLocalModel(reader)} size="medium" />
                    <div><strong>{reader.label || reader.displayName || reader.tag}</strong><small>{formatBytesGb(reader.sizeGb)} · {reader.accuracy || "untested"}</small></div>
                    {active ? <Badge tone="success">Active</Badge> : reader.recommended ? <Badge tone="accent">Recommended</Badge> : null}
                  </header>
                  <p>{reader.note || "Local model for pasted-image transcription."}</p>
                  {reader.measured?.percent !== undefined ? <small className="reader-score">Reference score {Math.round(reader.measured.percent)}%{reader.measuredLocally ? " · measured here" : ""}</small> : null}
                  <footer>
                    {reader.installed ? (
                      <>
                        <Button variant="ghost" disabled={!api || active} onClick={() => api && void runAction(`Use ${reader.tag} as image reader`, () => api.useLocalVisionModel(reader.tag))}><Eye aria-hidden size={13} strokeWidth={1.7} /> {active ? "In use" : "Use reader"}</Button>
                        <Button variant="ghost" disabled={!api} onClick={() => api && void runAction(`Measure ${reader.tag}`, () => api.benchmarkVisionModel(reader.tag))}><Gauge aria-hidden size={13} strokeWidth={1.7} /> Measure</Button>
                      </>
                    ) : (
                      <Button variant="secondary" disabled={!api || readerDownloadActive || reader.fits === false} onClick={() => api && void runAction(`Download ${reader.tag}`, () => api.downloadVisionModel(reader.tag))}><Download aria-hidden size={13} strokeWidth={1.7} /> Download</Button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        ) : <EmptyState title="No local image readers listed" body="Refresh after Ollama and the local vision catalog are available." />}
      </section>

      <Dialog open={Boolean(pendingRemoval)} title="Remove local model" description="This deletes the model weights from this machine." onClose={() => setPendingRemoval(null)}>
        <p className="dialog-copy">Remove <strong>{pendingRemoval}</strong>? You can download it again later.</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setPendingRemoval(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            const tag = pendingRemoval;
            setPendingRemoval(null);
            if (tag && api) void runAction(`Remove ${tag}`, () => api.uninstallLocalModel(tag));
          }}><Trash2 aria-hidden size={14} strokeWidth={1.7} /> Remove</Button>
        </div>
      </Dialog>
    </div>
  );
}

function mlxStageLabel(status: string) {
  switch (status) {
    case "preparing": return "Preparing";
    case "downloading": return "Downloading 4-bit weights";
    case "loading": return "Loading into MLX";
    case "starting-server": return "Starting loopback server";
    case "verifying": return "Verifying model";
    case "publishing": return "Adding to Codex";
    default: return "MLX setup";
  }
}

interface CatalogFamily {
  id: string;
  displayName: string;
  models: LocalModel[];
  researchStatus?: string;
  researchCapabilities: string[];
  researchNote?: string;
}

function groupCatalogModels(
  models: LocalModel[],
  knownFamilies: LocalModelsSnapshot["families"] | undefined,
  query: string,
): CatalogFamily[] {
  const needle = query.trim().toLocaleLowerCase();
  const groups = new Map<string, CatalogFamily>();
  for (const model of models) {
    const familyId = model.family || model.tag.split(":", 1)[0] || model.tag;
    const searchable = `${model.tag} ${model.displayName || ""} ${model.family || ""}`.toLocaleLowerCase();
    if (needle && !searchable.includes(needle)) continue;
    const known = knownFamilies?.find((family) => family.family === familyId);
    const current = groups.get(familyId) || {
      id: familyId,
      displayName: (known?.displayName || model.displayName || familyId).split(" · ")[0],
      models: [],
      researchStatus: model.researchStatus,
      researchCapabilities: model.researchCapabilities || [],
      researchNote: model.researchNote,
    };
    current.models.push(model);
    if (!current.researchStatus && model.researchStatus) current.researchStatus = model.researchStatus;
    if (!current.researchCapabilities.length && model.researchCapabilities?.length) current.researchCapabilities = model.researchCapabilities;
    if (!current.researchNote && model.researchNote) current.researchNote = model.researchNote;
    groups.set(familyId, current);
  }
  return [...groups.values()]
    .map((family) => ({
      ...family,
      models: [...family.models].sort(catalogModelSort),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function catalogModelSort(left: LocalModel, right: LocalModel): number {
  const leftLatest = left.variant === "latest";
  const rightLatest = right.variant === "latest";
  if (leftLatest !== rightLatest) return leftLatest ? -1 : 1;
  const leftFit = localModelFits(left);
  const rightFit = localModelFits(right);
  if (leftFit !== rightFit) return leftFit ? -1 : 1;
  return (left.tag || "").localeCompare(right.tag || "");
}

function localModelFits(model: LocalModel): boolean {
  return model.downloadable !== false && model.fit !== "too-large" && model.diskFit !== "too-large";
}

function catalogVisibleTagCount(families: CatalogFamily[]): number {
  return families.reduce((count, family) => count + family.models.length, 0);
}

function familySummary(models: LocalModel[]): string {
  const fit = models.filter(localModelFits).length;
  const cloud = models.filter((model) => model.downloadable === false).length;
  if (cloud === models.length) return "cloud only";
  if (fit === models.length) return "all fit this machine";
  if (fit && cloud) return `${fit} fit · ${cloud} cloud`;
  if (fit) return `${fit} fit`;
  if (cloud) return `${cloud} cloud`;
  return "no local variant fits";
}

function CatalogModelRow({ model, allowOversized, onSelect }: { model: LocalModel; allowOversized: boolean; onSelect: () => void }) {
  const downloadable = model.downloadable !== false;
  const tooLarge = model.fit === "too-large" || model.diskFit === "too-large";
  const fitLabel = model.downloadable === false
    ? "Cloud only"
    : tooLarge
      ? "Too large"
      : model.fit === "tight" || model.diskFit === "tight"
        ? "Memory tight"
        : "Fits this machine";
  const tone = model.downloadable === false ? "neutral" : tooLarge ? "danger" : model.fit === "tight" ? "warning" : "success";
  return (
    <article className="lhc-catalog-model">
      <BrandLogo brand={brandForLocalModel(model)} size="small" />
      <div className="lhc-catalog-model-identity">
        <strong>{model.displayName || model.label || model.tag}</strong>
        <small>{model.tag}{model.sizeGb !== undefined ? ` · ${formatBytesGb(model.sizeGb)}` : ""}{model.context ? ` · ${compactNumber(model.context)} context` : ""}</small>
      </div>
      <Badge tone={tone}>{fitLabel}</Badge>
      <Button variant="ghost" disabled={!downloadable || (tooLarge && !allowOversized)} onClick={onSelect}>
        <Download aria-hidden size={13} strokeWidth={1.7} /> Select
      </Button>
    </article>
  );
}

function DownloadProgress({ tag, percent, detail, indeterminate = false }: { tag?: string; percent?: number; detail?: string; indeterminate?: boolean }) {
  return (
    <div className="download-progress">
      <div><strong>{tag || "Local model"}</strong><span>{indeterminate ? "Working…" : `${Math.round(percent || 0)}%`}</span></div>
      {indeterminate ? <progress max="100" /> : <progress max="100" value={percent || 0} />}
      <small>{detail || "Preparing download"}</small>
    </div>
  );
}

function LocalModelRow({ model, enabled, disabled, onToggle, onBenchmark, onRemove }: {
  model: LocalModel;
  enabled: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onBenchmark: () => void;
  onRemove: () => void;
}) {
  const speed = model.observedTokensPerSecond ?? model.speed;
  const maker = brandForLocalModel(model);
  return (
    <article className="local-model-row">
      <div className="local-model-identity">
        <BrandLogo brand={maker} size="medium" />
        <div>
          <strong>{model.displayName || model.label || model.tag}</strong>
          <span>{maker.name}</span>
          <small>{`local/${model.tag}`}</small>
        </div>
      </div>
      <div className="local-model-facts">
        <span>{formatBytesGb(model.sizeGb)}</span>
        <span>{model.context ? `${compactNumber(model.context)} context` : "Context unreported"}</span>
        <span>{Number.isFinite(Number(speed)) ? `${Number(speed).toFixed(1)} tok/s` : "Speed unmeasured"}</span>
      </div>
      <div className="local-model-controls">
        <Button variant="ghost" disabled={disabled} onClick={onBenchmark}><Gauge aria-hidden size={14} strokeWidth={1.7} /> Measure</Button>
        <Button variant="ghost" disabled={disabled} aria-label={`Remove ${model.tag}`} onClick={onRemove}><Trash2 aria-hidden size={14} strokeWidth={1.7} /></Button>
        <div className="local-model-control">
          <span>Codex</span>
          <Toggle checked={enabled} disabled={disabled} label={`Enable ${model.tag} for Codex`} onChange={onToggle} />
        </div>
      </div>
    </article>
  );
}
