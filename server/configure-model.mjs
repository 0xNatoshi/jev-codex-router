// Idempotently declare jev/auto in the embedded router's protected user-model
// overlay. Existing user-curated routes are preserved.
import {
  readUserModels,
  writeUserModels,
} from "../router/src/user-models.mjs";

export const JEV_MODEL = Object.freeze({
  slug: "jev/auto",
  gatewayModel: "jev-auto",
  compHash: "jev-auto-user-v1",
  upstreamModel: "auto",
  provider: "jev",
  listed: true,
  displayName: "Jev Codex Router",
  description:
    "Auto-routing by Jev (TypeSafe): every call is served by luna, terra, sol or astra at the thinking depth it needs.",
  priority: 95,
  defaultEffort: "medium",
  reasoningLevels: [
    { effort: "low", description: "Quick reasoning" },
    { effort: "medium", description: "Balanced reasoning" },
    { effort: "high", description: "Deep reasoning" },
    { effort: "xhigh", description: "Extended reasoning" },
    { effort: "max", description: "Maximum reasoning" },
  ],
  contextWindow: 258400,
  autoCompact: 219640,
  searchTool: { mode: "hosted" },
  supportsSearchHistory: true,
  inputModalities: ["text", "image"],
});

const existing = readUserModels();
const next = [
  ...existing.filter((model) => model?.slug !== JEV_MODEL.slug),
  JEV_MODEL,
];
writeUserModels(next);
process.stdout.write(`${JSON.stringify({
  configured: JEV_MODEL.slug,
  preservedModels: existing.filter((model) => model?.slug !== JEV_MODEL.slug).length,
})}\n`);
