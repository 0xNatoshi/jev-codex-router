import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHECKED_IN_MODELS } from "../src/model-registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APPLICATIONS_ROOT = path.join(ROOT, "v2_agent");
const REQUIRED_CHECKS = Object.freeze([
  "streaming",
  "toolCall",
  "encryptedRelay",
  "markerReturn",
  "sameThreadFollowUp",
]);
const APPLICATION_STATUSES = new Set(["draft", "accepted", "rejected"]);
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RESERVED_SOURCE_HOST =
  /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|localhost|test)$/i;
// These six routes were already repository-certified before the application
// gate existed. The identity tuple, rather than only the slug, prevents a
// future provider or upstream-model swap from inheriting that grandfathering.
const PRE_WORKFLOW_V2_ROUTES = new Set([
  '["grok-api/grok-4.5","grok-api","grok-4.5"]',
  '["grok-oauth/grok-4.5","grok-oauth","grok-4.5"]',
  '["kimi-api/kimi-k3","kimi-api","kimi-k3"]',
  '["kimi-oauth/k3","kimi-oauth","k3"]',
  '["kimi-oauth/kimi-for-coding","kimi-oauth","kimi-for-coding"]',
  '["kimi-oauth/kimi-for-coding-highspeed","kimi-oauth","kimi-for-coding-highspeed"]',
]);

function fail(message) {
  throw new Error(`v2-agent application: ${message}`);
}

function directories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();
}

function secretLike(value) {
  // Evidence is intentionally summaries and metadata. A proof must never turn
  // into a durable copy of an API key, bearer capability, or decrypted task.
  return [
    /\b(?:sk|rk|sess|token)[_-][a-z0-9_-]{12,}\b/i,
    /\bgh[pousr]_[a-z0-9]{20,}\b/i,
    /\bgithub_pat_[a-z0-9_]{20,}\b/i,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bAIza[a-z0-9_-]{30,}\b/i,
    /\bya29\.[a-z0-9_-]{20,}\b/i,
    /\bhf_[a-z0-9]{20,}\b/i,
    /\bxox[baprs]-[a-z0-9-]{10,}\b/i,
    /\bglpat-[a-z0-9_-]{20,}\b/i,
    /\bnpm_[a-z0-9]{30,}\b/i,
    /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /authorization\s*:\s*bearer/i,
    /bearer\s+[a-z0-9._-]{16,}/i,
    /(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret)\s*[:=]\s*["']?[a-z0-9+/_=-]{16,}/i,
  ].some((pattern) => pattern.test(value));
}

function strictIsoInstant(value) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function officialHttpsSource(value) {
  if (typeof value !== "string") return false;
  try {
    const source = new URL(value);
    if (source.protocol !== "https:" || source.username || source.password) return false;
    const hostname = source.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    return Boolean(hostname) &&
      hostname.includes(".") &&
      isIP(hostname) === 0 &&
      !RESERVED_SOURCE_HOST.test(hostname);
  } catch {
    return false;
  }
}

function routeIdentity({ slug, provider, upstreamModel }) {
  return JSON.stringify([slug, provider, upstreamModel]);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function checkPass(check, label) {
  if (!check || check.outcome !== "pass") fail(`${label} must record outcome: "pass"`);
  if (!Number.isInteger(check.status) || check.status < 200 || check.status > 299) {
    fail(`${label} must record a successful HTTP status`);
  }
  if (!strictIsoInstant(check.observedAt)) {
    fail(`${label} must record an ISO observedAt timestamp`);
  }
}

function checkAcceptedProof(proof, location, models) {
  if (!Array.isArray(proof.officialSources) || proof.officialSources.length === 0 ||
      proof.officialSources.some((source) => !officialHttpsSource(source))) {
    fail(`${location}: accepted applications need one or more HTTPS officialSources`);
  }
  for (const key of REQUIRED_CHECKS) checkPass(proof.checks?.[key], `${location}: checks.${key}`);
  if (!strictIsoInstant(proof.testedAt)) {
    fail(`${location}: accepted applications need an ISO testedAt timestamp`);
  }
  if (typeof proof.routerVersion !== "string" || !proof.routerVersion.trim()) {
    fail(`${location}: accepted applications need routerVersion`);
  }
  const route = (Array.isArray(models) ? models : []).find((model) =>
    model?.slug === proof.slug &&
    model.provider === proof.provider &&
    model.upstreamModel === proof.model
  );
  if (!route) {
    fail(`${location}: accepted application does not match an exact registry route`);
  }
  if (route.multiAgentVersion !== "v2") {
    fail(`${location}: accepted application requires the exact registry route to declare multiAgentVersion v2`);
  }
}

export function validateV2AgentApplications(
  applicationsRoot = DEFAULT_APPLICATIONS_ROOT,
  { models = CHECKED_IN_MODELS } = {},
) {
  const applications = [];
  for (const provider of directories(applicationsRoot)) {
    if (!SAFE_SEGMENT.test(provider)) fail(`invalid provider directory ${provider}`);
    const providerRoot = path.join(applicationsRoot, provider);
    for (const routeName of directories(providerRoot)) {
      if (!SAFE_SEGMENT.test(routeName)) fail(`invalid model directory ${provider}/${routeName}`);
      const location = `${provider}/${routeName}`;
      const root = path.join(providerRoot, routeName);
      const markdown = path.join(root, "proof.md");
      const json = path.join(root, "proof.json");
      if (!existsSync(markdown) || !lstatSync(markdown).isFile()) fail(`${location} is missing proof.md`);
      if (!existsSync(json) || !lstatSync(json).isFile()) fail(`${location} is missing proof.json`);
      const markdownText = readFileSync(markdown, "utf8");
      if (!markdownText.includes("## Evidence")) fail(`${location}: proof.md needs an Evidence section`);
      const proof = readJson(json);
      if (proof?.version !== 1) fail(`${location}: proof.json version must be 1`);
      if (proof.provider !== provider) {
        fail(`${location}: proof.json provider must match its directory`);
      }
      if (typeof proof.model !== "string" || !proof.model.trim() || /[\u0000-\u001f]/.test(proof.model)) {
        fail(`${location}: proof.json needs the exact upstream model id`);
      }
      const slugParts = typeof proof.slug === "string" ? proof.slug.split("/") : [];
      if (
        slugParts.length !== 2 ||
        slugParts.some((segment) => !SAFE_SEGMENT.test(segment)) ||
        slugParts[0] !== provider ||
        slugParts[1] !== routeName
      ) {
        fail(`${location}: proof.json slug must match its provider/route directory`);
      }
      if (!APPLICATION_STATUSES.has(proof.status)) fail(`${location}: invalid status`);
      const serialized = `${markdownText}\n${JSON.stringify(proof)}`;
      if (secretLike(serialized)) fail(`${location}: proof artifacts must not contain credentials or bearer values`);
      if (proof.status === "accepted") checkAcceptedProof(proof, location, models);
      applications.push({ provider, model: proof.model, slug: proof.slug, status: proof.status });
    }
  }
  const accepted = new Set(
    applications
      .filter((application) => application.status === "accepted")
      .map((application) => routeIdentity({
        slug: application.slug,
        provider: application.provider,
        upstreamModel: application.model,
      })),
  );
  for (const model of Array.isArray(models) ? models : []) {
    if (model?.multiAgentVersion !== "v2") continue;
    const identity = routeIdentity(model);
    if (PRE_WORKFLOW_V2_ROUTES.has(identity) || accepted.has(identity)) continue;
    fail(`${model.slug}: registry v2 route needs an accepted application for the exact route`);
  }
  return applications;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const applications = validateV2AgentApplications(process.argv[2] || DEFAULT_APPLICATIONS_ROOT);
  process.stdout.write(`v2-agent applications valid (${applications.length})\n`);
}
