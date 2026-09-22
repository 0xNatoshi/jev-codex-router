import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  AppWindow,
  ArrowUpCircle,
  Boxes,
  Globe2,
  LoaderCircle,
  Route,
  SquareTerminal,
} from "lucide-react";
import cursorLogo from "../assets/clients/cursor.svg";
import cursorDarkLogo from "../assets/clients/cursor-dark.svg";
import codexDarkLogo from "../assets/clients/codex-dark.svg";
import codexLightLogo from "../assets/clients/codex-light.svg";
import deepSeekHarnessLogo from "../assets/clients/deepseek-harness.svg";
import claudeLogo from "../assets/clients/claude.svg";
import geminiLogo from "../assets/providers/gemini.svg";
import openclawLogo from "../assets/clients/openclaw.svg";
import piLogo from "../assets/clients/pi.svg";
import ompLogo from "../assets/clients/omp.svg";
// opencode, Command Code, and Nous Research already ship a mark in this app as
// *providers*. A client row is the same organization, so it reuses that asset
// rather than committing a second copy that would then have to be kept in step.
import opencodeLogo from "../assets/providers/opencode.png";
import commandCodeLogo from "../assets/providers/commandcode.svg";
import nousResearchLogo from "../assets/providers/nousresearch.png";
import { Badge, Button, InlineNotice, PageHeader, PanelSkeleton, SectionHeading, StatStrip, Toggle } from "../components";
import type {
  AgentBridgeDescriptor,
  AgentBridgeSnapshot,
  ContextSessionsSnapshot,
  HarnessDescriptor,
  HarnessId,
  HarnessSnapshot,
  OperationEvent,
  RouterControlApi,
  RouterTarget,
  ViewId,
} from "../types";
import "./local-harness-context.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

interface HarnessPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  operation?: OperationEvent | null;
  onRefresh: () => void;
  runAction: RunAction;
  onNavigate: (view: ViewId) => void;
}

// The six clients that predate the shared publisher keep their order; the five
// document-configured harnesses follow, so an existing user's rows do not move
// under them on upgrade.
const CLIENT_ORDER: HarnessId[] = [
  "openclaw", "cursor", "claude", "gemini", "dsh", "codex",
  "opencode", "pi", "omp", "commandcode", "hermes",
];
const TERMINAL_ONLY_CLIENTS = new Set<HarnessId>(["opencode", "pi", "omp", "commandcode", "hermes"]);
const CLIENT_LOGOS: Record<HarnessId, { light: string; dark?: string; mode: "artwork" | "mask" }> = {
  cursor: { light: cursorLogo, dark: cursorDarkLogo, mode: "artwork" },
  dsh: { light: deepSeekHarnessLogo, mode: "mask" },
  codex: { light: codexLightLogo, dark: codexDarkLogo, mode: "artwork" },
  claude: { light: claudeLogo, mode: "artwork" },
  gemini: { light: geminiLogo, mode: "artwork" },
  openclaw: { light: openclawLogo, mode: "artwork" },
  opencode: { light: opencodeLogo, mode: "artwork" },
  pi: { light: piLogo, mode: "artwork" },
  // omp's official mark is drawn in near-white for a dark ground. Painting it
  // in the surrounding text colour is what keeps it legible in both themes.
  omp: { light: ompLogo, mode: "mask" },
  commandcode: { light: commandCodeLogo, mode: "artwork" },
  hermes: { light: nousResearchLogo, mode: "mask" },
};

const CURSOR_OPERATION_ACTIONS = new Set([
  "connectCursor",
  "disconnectCursor",
  "disconnectHarness",
  "Connect Cursor",
  "Disconnect Cursor",
  "prepareCursorTunnel",
  "Install Cloudflare connector",
  "Sign in to Cloudflare Tunnel",
  "Configure Cursor",
]);

export function HarnessPage({ target, api, refreshing, operation, onRefresh, runAction, onNavigate }: HarnessPageProps) {
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>();
  const [sessions, setSessions] = useState<ContextSessionsSnapshot>();
  const [agentBridges, setAgentBridges] = useState<AgentBridgeSnapshot>();
  const [error, setError] = useState<string>();
  const [cursorHostname, setCursorHostname] = useState("");
  const [pendingHarnessId, setPendingHarnessId] = useState<HarnessId>();
  const loadHarnesses = useCallback(async () => {
    if (!api) return;
    try {
      const [nextHarnesses, nextSessions] = await Promise.all([
        api.getHarnesses(),
        api.getContextSessions(),
      ]);
      setSnapshot(nextHarnesses);
      setSessions(nextSessions);
      setError(undefined);
      if (typeof api.getAgentBridges === "function") {
        try {
          setAgentBridges(await api.getAgentBridges());
        } catch {
          // Agent bridges are optional client-owned sessions. Their detection
          // must never hide the routed Cursor, DeepSeek, and Codex rows.
          setAgentBridges(undefined);
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Client detection failed.");
    }
  }, [api]);

  useEffect(() => { void loadHarnesses(); }, [loadHarnesses]);
  useEffect(() => {
    const saved = snapshot?.harnesses.find((harness) => harness.id === "cursor")?.tunnel?.hostname;
    if (saved) setCursorHostname(saved);
  }, [snapshot]);

  const clients = useMemo(
    () => CLIENT_ORDER.map((id) => snapshot?.harnesses.find((harness) => harness.id === id)).filter(Boolean) as HarnessDescriptor[],
    [snapshot],
  );
  const routedModelCount = target?.models.filter(
    (model) => model.visible && (model.enabled || model.native),
  ).length ?? 0;
  const cursorOperationActive = Boolean(
    pendingHarnessId === "cursor"
    || (operation?.status === "started" && CURSOR_OPERATION_ACTIONS.has(operation.action || "")),
  );
  const refresh = () => {
    onRefresh();
    void loadHarnesses();
  };
  const act = async (label: string, action: () => Promise<unknown>) => {
    await runAction(label, action);
    await loadHarnesses();
  };
  const runHarnessAction = async (harnessId: HarnessId, label: string, action: () => Promise<unknown>) => {
    setPendingHarnessId(harnessId);
    try {
      await act(label, action);
    } finally {
      setPendingHarnessId(undefined);
    }
  };
  const sessionCount = (id: HarnessId) => sessions?.counts[id] ?? 0;
  const routingEnabled = (harness: HarnessDescriptor) => (
    harness.id === "cursor" ? Boolean(harness.appConfigured) : harness.configured
  );
  const toggleRouting = async (harness: HarnessDescriptor, enabled: boolean) => {
    if (!api) return;
    if (enabled) {
      if (harness.id === "cursor") {
        await runHarnessAction("cursor", "Connect Cursor", () => api.connectCursor(cursorHostname.trim() || undefined));
        return;
      }
      await runHarnessAction(harness.id, `Configure ${harness.displayName}`, () => api.setupHarness(harness.id));
      return;
    }
    if (harness.id === "cursor" && api.disconnectCursor) {
      await runHarnessAction("cursor", "Disconnect Cursor", () => api.disconnectCursor());
      return;
    }
    if (!api.disconnectHarness) return;
    await runHarnessAction(
      harness.id,
      `Disconnect ${harness.displayName}`,
      () => api.disconnectHarness(harness.id),
    );
  };
  const setup = async (harness: HarnessDescriptor) => {
    if (!api) return;
    if (harness.id === "cursor") {
      await runHarnessAction("cursor", "Connect Cursor", () => api.connectCursor(cursorHostname.trim() || undefined));
    } else {
      await runHarnessAction(harness.id, `Configure ${harness.displayName}`, () => api.setupHarness(harness.id));
    }
  };
  const openSurface = async (harness: HarnessDescriptor, surface: "app" | "terminal") => {
    if (!api) return;
    await act(
      surface === "app" ? `Open ${harness.displayName} app` : `Open ${harness.displayName} terminal`,
      () => api.launchHarness(harness.id, surface),
    );
  };
  // Updating is its own action, never a step inside setup: publishing a model
  // list must not be the reason somebody's global coding agent changed version.
  const update = async (harness: HarnessDescriptor) => {
    if (!api?.updateHarness) return;
    await act(`Update ${harness.displayName}`, () => api.updateHarness(harness.id));
  };
  const updatableClients = clients.filter((client) => client.canUpdate);
  const updateAll = async () => {
    if (!api?.updateHarness) return;
    await act("Update installed clients", () => api.updateHarness("all"));
  };
  const busy = (harness: HarnessDescriptor) => (
    pendingHarnessId === harness.id
    || (harness.id === "cursor" && cursorOperationActive)
  );

  return (
    <>
      <PageHeader
        eyebrow="Coding clients"
        title="Harness"
        description="Publish the shared routed catalog into each coding client."
        onRefresh={refresh}
        refreshing={refreshing}
      />
      <div className="lhc-harness-summary">
        <StatStrip items={[
          { label: "Clients", value: clients.length, detail: "Supported clients" },
          { label: "Configured", value: clients.filter((client) => client.configured).length, detail: "Using this router" },
          { label: "Sessions", value: sessions?.counts.total ?? 0, detail: "Indexed metadata" },
          { label: "Routed models", value: routedModelCount, detail: "Shared picker" },
        ]} />
        {updatableClients.length ? (
          <Button
            variant="secondary"
            disabled={!api?.updateHarness}
            title={`Runs each client's own updater for: ${updatableClients.map((client) => client.displayName).join(", ")}. Clients that are not installed are skipped.`}
            onClick={() => void updateAll()}
          >
            <ArrowUpCircle aria-hidden size={14} strokeWidth={1.7} /> Update all ({updatableClients.length})
          </Button>
        ) : null}
      </div>

      {error ? <InlineNotice tone="warning" title="Client detection is incomplete">{error}</InlineNotice> : null}

      <div className="lhc-harness-list">
        {!snapshot && !error ? <PanelSkeleton label="Detecting coding clients" variant="list" count={CLIENT_ORDER.length} /> : null}
        {clients.length ? (
          <div className="lhc-harness-table-head" aria-hidden>
            <span>Client</span>
            <span>Models</span>
            <span>Sessions</span>
            <span>Actions</span>
          </div>
        ) : null}
        {clients.map((harness) => {
          const enabled = routingEnabled(harness);
          const harnessBusy = busy(harness);
          const hintId = `harness-hint-${harness.id}`;
          const models = modelFact(harness, routedModelCount);
          return (
            <HarnessRow
              key={harness.id}
              harness={harness}
              sessions={sessionCount(harness.id)}
              models={models}
              bridge={bridgeForHarness(harness.id, agentBridges)}
              onSessions={() => onNavigate("context")}
              setupControl={harness.id === "cursor" && harnessBusy ? (
                <div className="lhc-harness-progress" role="status" aria-live="polite">
                  <div>
                    <LoaderCircle aria-hidden size={14} strokeWidth={1.7} className="spin" />
                    <span>{operation?.status === "started" ? operation.message || "Preparing Cursor setup…" : "Refreshing Cursor setup…"}</span>
                  </div>
                  <progress aria-label="Cursor setup progress" />
                </div>
              ) : harness.id === "cursor" && harness.appInstalled && !enabled ? (
                <div className="lhc-cursor-connect">
                  <div className="lhc-harness-prerequisite">
                    <Globe2 aria-hidden size={14} strokeWidth={1.7} />
                    <span>{cursorTunnelHelp(harness)}</span>
                  </div>
                  <details>
                    <summary>Use an existing Cloudflare hostname</summary>
                    <label className="lhc-harness-origin">
                      <span>Hostname</span>
                      <input
                        value={cursorHostname}
                        placeholder="cursor-router.example.com"
                        spellCheck={false}
                        autoCapitalize="none"
                        onChange={(event) => setCursorHostname(event.target.value)}
                      />
                      <small>Optional. Leave blank to create one under the domain you authorize.</small>
                    </label>
                  </details>
                </div>
              ) : undefined}
              actions={
                <div className="lhc-harness-actions">
                  <div className="lhc-harness-toolbar">
                    <span className="lhc-harness-hint">
                      <Toggle
                        checked={enabled}
                        disabled={!api || harnessBusy || (!enabled && !harness.canInstall)}
                        label={`Route ${harness.displayName} through Codex Router`}
                        onChange={(next) => void toggleRouting(harness, next)}
                      />
                      <span id={hintId} role="tooltip" className="lhc-harness-hint-tooltip">
                        {harnessHint(harness)}
                      </span>
                    </span>
                    <div className="lhc-harness-launch">
                      {enabled ? (
                        <>
                          <Button
                            className="lhc-harness-icon-btn"
                            variant="primary"
                            aria-label={`Open ${harness.displayName} app`}
                            disabled={!api || harnessBusy}
                            title={harness.appInstalled ? `Open ${harness.displayName}` : `Open ${harness.displayName} site`}
                            onClick={() => void openSurface(harness, "app")}
                          >
                            {harnessBusy
                              ? <LoaderCircle aria-hidden size={14} strokeWidth={1.7} className="spin" />
                              : <AppWindow aria-hidden size={14} strokeWidth={1.7} />}
                          </Button>
                          <Button
                            className="lhc-harness-icon-btn"
                            variant="secondary"
                            aria-label={`Open ${harness.displayName} terminal`}
                            disabled={!api || harnessBusy || !harness.cliInstalled || !snapshot?.terminalAvailable}
                            title={
                              !snapshot?.terminalAvailable
                                ? "Terminal launch is available on macOS only"
                                : !harness.cliInstalled
                                  ? `${harness.displayName} CLI is not installed`
                                  : `Open ${harness.displayName} in a terminal`
                            }
                            onClick={() => void openSurface(harness, "terminal")}
                          >
                            <SquareTerminal aria-hidden size={14} strokeWidth={1.7} />
                          </Button>
                        </>
                      ) : (
                        <Button
                          className="lhc-harness-setup-btn"
                          variant="primary"
                          aria-label={`Set up ${harness.displayName}`}
                          disabled={!api || harnessBusy || !harness.canInstall}
                          title={harness.installRequirement}
                          onClick={() => void setup(harness)}
                        >
                          {harnessBusy
                            ? <LoaderCircle aria-hidden size={14} strokeWidth={1.7} className="spin" />
                            : harness.id === "cursor" ? "Connect" : "Set up"}
                        </Button>
                      )}
                    </div>
                    {harness.canUpdate ? (
                      <Button
                        className="lhc-harness-icon-btn"
                        variant="ghost"
                        aria-label={`Update ${harness.displayName}`}
                        disabled={!api?.updateHarness || harnessBusy}
                        title={harness.updateCommand
                          ? `Runs \`${harness.updateCommand}\``
                          : `Update ${harness.displayName}`}
                        onClick={() => void update(harness)}
                      >
                        <ArrowUpCircle aria-hidden size={14} strokeWidth={1.7} />
                      </Button>
                    ) : null}
                  </div>
                </div>
              }
            />
          );
        })}
      </div>

      <section className="panel-section">
        <SectionHeading title={`One router plane, ${clients.length} client stores`} description="Model routes and provider credentials are shared; sessions and client-owned settings remain separate." />
        <div className="lhc-continuity-map">
          <article>
            <Route aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Shared routed catalog</strong><small>{routedModelCount} selected models are republished into every configured client.</small></div>
            <Badge tone={target?.active ? "success" : "neutral"}>{target?.active ? "Active" : "Inactive"}</Badge>
          </article>
          <article>
            <Globe2 aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Cursor public edge</strong><small>Cursor App reaches only the separately keyed app edge; the main loopback capability stays private.</small></div>
            <Badge tone={clients.find((client) => client.id === "cursor")?.configured ? "success" : "neutral"}>Isolated</Badge>
          </article>
          <article>
            <Boxes aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Session ownership</strong><small>The index reads bounded metadata only. Conversation messages stay inside each coding client.</small></div>
            <Badge tone="accent">Local</Badge>
          </article>
        </div>
      </section>
    </>
  );
}

function HarnessRow({ harness, sessions, models, bridge, setupControl, actions, onSessions }: {
  harness: HarnessDescriptor;
  sessions: number;
  models: { label: string; title: string };
  bridge?: AgentBridgeDescriptor;
  setupControl?: ReactNode;
  actions: ReactNode;
  onSessions: () => void;
}) {
  return (
    <section className={`lhc-harness-row is-${harness.id}`}>
      <header>
        <span className="lhc-harness-mark" aria-hidden><HarnessMark id={harness.id} /></span>
        <div>
          <div className="lhc-harness-title">
            <h2>{harness.displayName}</h2>
            <Badge tone={harness.configured ? "success" : harness.cliInstalled || harness.appInstalled ? "accent" : "neutral"}>
              {harness.configured ? "Ready" : harness.cliInstalled || harness.appInstalled ? "Detected" : "Missing"}
            </Badge>
          </div>
          {bridge?.installed ? (
            <p className="lhc-harness-bridge is-available" title="Optional delegated runs use the official client's own login.">
              Agent{bridge.sessions > 0 ? ` · ${bridge.sessions}` : ""}
            </p>
          ) : null}
        </div>
      </header>
      <div className="lhc-harness-facts">
        <div className="lhc-harness-catalog" title={models.title}><span>{models.label}</span></div>
        <button
          className="lhc-harness-sessions"
          type="button"
          title={`${sessions} indexed session${sessions === 1 ? "" : "s"}`}
          onClick={onSessions}
        >
          <span>{sessions}</span>
        </button>
      </div>
      {setupControl ? <div className="lhc-harness-setup">{setupControl}</div> : null}
      <footer>{actions}</footer>
    </section>
  );
}

function bridgeForHarness(id: HarnessId, snapshot?: AgentBridgeSnapshot): AgentBridgeDescriptor | undefined {
  const bridgeId = id === "claude" ? "anthropic" : id === "cursor" || id === "gemini" ? id : undefined;
  return bridgeId ? snapshot?.bridges.find((bridge) => bridge.id === bridgeId) : undefined;
}

function HarnessMark({ id }: { id: HarnessId }) {
  const logo = CLIENT_LOGOS[id];
  return (
    <span
      className={`lhc-harness-logo is-${logo.mode}`}
      data-client-logo={id}
      style={{
        "--lhc-client-logo": `url("${logo.light}")`,
        "--lhc-client-logo-dark": `url("${logo.dark || logo.light}")`,
      } as CSSProperties}
    />
  );
}

function modelFact(harness: HarnessDescriptor, modelCount: number): { label: string; title: string } {
  if (harness.id === "cursor") {
    return harness.configured
      ? { label: String(modelCount), title: `${modelCount} available` }
      : { label: "—", title: "Ready after setup" };
  }
  return harness.configured
    ? { label: String(modelCount), title: `${modelCount} published` }
    : { label: "—", title: "Not published" };
}

function cursorTunnelHelp(harness: HarnessDescriptor): string {
  if (!harness.tunnel?.binaryInstalled) {
    return "Turn Route on to install the connector, authorize Cloudflare, publish models, and reopen Cursor.";
  }
  if (!harness.tunnel.loggedIn) {
    return "Turn Route on, then authorize a domain in the browser.";
  }
  return "Turn Route on to publish models and reopen Cursor.";
}

function harnessHint(harness: HarnessDescriptor): ReactNode {
  if (harness.id === "cursor") {
    return (
      <>
        “Custom API keys” means a Cursor model while routed. Use <code>codex_router/…</code> or turn Route off.
      </>
    );
  }
  if (TERMINAL_ONLY_CLIENTS.has(harness.id)) {
    return <>Route publishes models. Off removes them. Term runs the CLI.</>;
  }
  if (harness.id === "codex") {
    return <>Route points Codex here. Restart Codex after toggling.</>;
  }
  return <>Route publishes models into {harness.displayName}. Off removes only this router’s entry.</>;
}
