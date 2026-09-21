import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const METADATA_ID_KEYS = new Set([
  "conversationId",
  "conversation_id",
  "sessionId",
  "session_id",
  "threadId",
  "thread_id",
]);

export const SESSION_INDEX_PATH =
  process.env.CODEX_ROUTER_SESSION_INDEX ||
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "session_index.jsonl");
export const SESSIONS_PATH =
  process.env.CODEX_ROUTER_SESSIONS_PATH ||
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");

let cachedPath;
let cachedModifiedAt = -1;
let cachedNames = new Map();
const cachedRolloutMetadata = new Map();

function headerText(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function uuidIn(value) {
  return typeof value === "string" ? value.match(THREAD_ID_PATTERN)?.[0] : undefined;
}

function metadataThreadId(value) {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (METADATA_ID_KEYS.has(key)) {
      const id = uuidIn(item);
      if (id) return id;
    }
  }
  for (const item of Object.values(value)) {
    const id = metadataThreadId(item);
    if (id) return id;
  }
  return undefined;
}

export function threadIdFromHeaders(headers = {}) {
  for (const name of ["thread-id", "session-id", "session_id"]) {
    const id = uuidIn(headerText(headers, name));
    if (id) return id;
  }

  const metadata = headerText(headers, "x-codex-turn-metadata");
  if (!metadata) return undefined;
  try {
    return metadataThreadId(JSON.parse(metadata));
  } catch {
    return undefined;
  }
}

export function parentThreadIdFromHeaders(headers = {}) {
  return uuidIn(headerText(headers, "x-codex-parent-thread-id"));
}

function findRollout(root, threadId) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findRollout(target, threadId);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
      return target;
    }
  }
  return undefined;
}

function firstJsonLine(filePath) {
  let descriptor;
  try {
    descriptor = openSync(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, length).toString("utf8").split("\n", 1)[0];
    return JSON.parse(line);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function rolloutMetadata(threadId, sessionsPath) {
  if (!threadId) return undefined;
  const key = `${sessionsPath}:${threadId.toLowerCase()}`;
  if (cachedRolloutMetadata.has(key)) return cachedRolloutMetadata.get(key);
  const rolloutPath = findRollout(sessionsPath, threadId);
  const payload = rolloutPath ? firstJsonLine(rolloutPath)?.payload : undefined;
  const spawn = payload?.source?.subagent?.thread_spawn;
  const metadata = {
    threadId,
    parentThreadId: uuidIn(spawn?.parent_thread_id),
    agentPath: typeof spawn?.agent_path === "string" ? spawn.agent_path : undefined,
    agentNickname:
      typeof spawn?.agent_nickname === "string" ? spawn.agent_nickname : undefined,
    isSubagent: Boolean(spawn),
  };
  cachedRolloutMetadata.set(key, metadata);
  return metadata;
}

function rootThreadId(threadId, sessionsPath) {
  let current = threadId;
  const visited = new Set();
  while (current && !visited.has(current.toLowerCase())) {
    visited.add(current.toLowerCase());
    const parent = rolloutMetadata(current, sessionsPath)?.parentThreadId;
    if (!parent) return current;
    current = parent;
  }
  return threadId;
}

function shortAgentName(agentPath) {
  if (typeof agentPath !== "string") return undefined;
  return agentPath.split("/").filter(Boolean).at(-1);
}

function sessionNames(indexPath) {
  try {
    const modifiedAt = statSync(indexPath).mtimeMs;
    if (cachedPath === indexPath && cachedModifiedAt === modifiedAt) return cachedNames;
    const names = new Map();
    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const id = uuidIn(entry?.id);
        const name = typeof entry?.thread_name === "string"
          ? entry.thread_name.replace(/\s+/g, " ").trim()
          : "";
        if (id && name) names.set(id.toLowerCase(), name.slice(0, 240));
      } catch {
        // Ignore a partially written or legacy index row.
      }
    }
    cachedPath = indexPath;
    cachedModifiedAt = modifiedAt;
    cachedNames = names;
    return names;
  } catch {
    return new Map();
  }
}

export function sessionNameFromHeaders(headers, { indexPath = SESSION_INDEX_PATH } = {}) {
  const id = threadIdFromHeaders(headers);
  if (!id) return undefined;
  return sessionNames(indexPath).get(id.toLowerCase());
}

export function activityMetadataFromHeaders(
  headers,
  { indexPath = SESSION_INDEX_PATH, sessionsPath = SESSIONS_PATH } = {},
) {
  const threadId = threadIdFromHeaders(headers);
  const rollout = rolloutMetadata(threadId, sessionsPath);
  const headerParent = parentThreadIdFromHeaders(headers);
  const parentThreadId = rollout?.parentThreadId || headerParent;
  const sessionId = rootThreadId(parentThreadId || threadId, sessionsPath);
  const sessionName = sessionId
    ? sessionNames(indexPath).get(sessionId.toLowerCase())
    : undefined;
  const headerAgent = headerText(headers, "x-openai-subagent")?.trim();
  const agentName = shortAgentName(rollout?.agentPath) ||
    (headerAgent && !["1", "true"].includes(headerAgent.toLowerCase())
      ? headerAgent
      : undefined);
  return {
    ...(threadId ? { threadId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(agentName ? { agentName } : {}),
    ...(rollout?.agentNickname ? { agentNickname: rollout.agentNickname } : {}),
    isSubagent: Boolean(rollout?.isSubagent || parentThreadId || headerAgent),
  };
}
