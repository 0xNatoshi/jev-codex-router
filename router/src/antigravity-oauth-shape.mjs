import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { foldInterveningAssistantMessages } from "./http-utils.mjs";
import {
  normalizeSchemaLiterals,
  objectRootToolSchema,
} from "./tool-schema-root.mjs";

const DEFAULT_MAX_OUTPUT_TOKENS = 65535;
const GEMINI_THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";
export const GEMINI_THOUGHT_SIGNATURE_SEPARATOR = "__thought__";

const MODEL_FAMILIES = Object.freeze({
  "gemini-3.1-pro": Object.freeze({
    defaultEffort: "low",
    maxOutputTokens: 65535,
    thinkingBudgets: Object.freeze({ low: 1001, high: 10001 }),
    models: Object.freeze({
      low: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
    }),
  }),
  "gemini-3.5-flash": Object.freeze({
    defaultEffort: "medium",
    maxOutputTokens: 65536,
    thinkingBudgets: Object.freeze({ low: 1000, medium: 4000, high: 10000 }),
    models: Object.freeze({
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
    }),
  }),
  "gemini-3.6-flash": Object.freeze({
    defaultEffort: "medium",
    maxOutputTokens: 65536,
    thinkingBudgets: Object.freeze({ low: 1000, medium: 4000, high: 10000 }),
    models: Object.freeze({
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
    }),
  }),
  "gemini-3.7-flash": Object.freeze({
    defaultEffort: "medium",
    maxOutputTokens: 65536,
    thinkingBudgets: Object.freeze({ low: 1000, medium: 4000, high: -1 }),
    models: Object.freeze({
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high",
    }),
  }),
});

const EFFORT_BUDGET = Object.freeze({
  minimal: 2048,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 32768,
  ultra: 32768,
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AntigravityShapeError extends Error {
  constructor(message, { status = 502, code = "antigravity_response_error" } = {}) {
    super(message);
    this.name = "AntigravityShapeError";
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function splitThoughtSignature(id) {
  const value = typeof id === "string" ? id : "";
  const at = value.indexOf(GEMINI_THOUGHT_SIGNATURE_SEPARATOR);
  if (at === -1) return { id: value, signature: undefined };
  return {
    id: value.slice(0, at),
    signature: value.slice(at + GEMINI_THOUGHT_SIGNATURE_SEPARATOR.length) || undefined,
  };
}

function toolCallIdentity(call) {
  const decoded = splitThoughtSignature(call?.id);
  return {
    id: decoded.id,
    signature:
      call?.thought_signature ||
      call?.provider_specific_fields?.thought_signature ||
      call?.function?.provider_specific_fields?.thought_signature ||
      call?.extra_content?.google?.thought_signature ||
      decoded.signature,
  };
}

function signedToolCallId(id, signature) {
  if (!signature || !id) return id;
  return `${splitThoughtSignature(id).id}${GEMINI_THOUGHT_SIGNATURE_SEPARATOR}${signature}`;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
    .map((part) => part.text || "")
    .join("");
}

function imageParts(content) {
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    const url =
      typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url;
    if (typeof url !== "string" || !url) continue;
    const dataMatch = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (dataMatch) {
      parts.push({
        inlineData: { mimeType: dataMatch[1], data: dataMatch[2] },
      });
    } else if (/^https?:\/\//.test(url)) {
      parts.push({ fileData: { fileUri: url } });
    }
  }
  return parts;
}

function functionCallPart(call, { includeThoughtSignature = true } = {}) {
  let args;
  try {
    args = JSON.parse(call.function?.arguments || "{}");
  } catch {
    args = {};
  }
  const identity = toolCallIdentity(call);
  return {
    ...(includeThoughtSignature
      ? { thoughtSignature: identity.signature || GEMINI_THOUGHT_SIGNATURE_SENTINEL }
      : {}),
    functionCall: {
      name: call.function?.name || "",
      args: isPlainObject(args) ? args : {},
      ...(identity.id ? { id: identity.id } : {}),
    },
  };
}

function functionResponsePart(message, callIdToName) {
  let response = message.content;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      response = { output: response };
    }
  }
  const id = splitThoughtSignature(message.tool_call_id).id;
  if (!isPlainObject(response)) response = { output: response };
  return {
    functionResponse: {
      ...(id && callIdToName.get(id) ? { name: callIdToName.get(id) } : {}),
      ...(id ? { id } : {}),
      response,
    },
  };
}

function callIdToNameMap(messages) {
  const map = new Map();
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const id = splitThoughtSignature(call?.id).id;
      if (id && call?.function?.name) map.set(id, call.function.name);
    }
  }
  return map;
}

// Gemini function responses are grouped into one user content whose parts each
// answer a model functionCall. Chat Completions puts each result in its own
// `tool` message, so adjacent tool messages are collapsed here.
function messagesToContents(messages) {
  const contents = [];
  const systemText = [];
  const callIdToName = callIdToNameMap(messages);
  let pendingToolResponses = [];

  const flushToolResponses = () => {
    if (pendingToolResponses.length === 0) return;
    contents.push({ role: "user", parts: pendingToolResponses });
    pendingToolResponses = [];
  };

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      const text = textFromContent(message.content);
      if (text) systemText.push(text);
      continue;
    }
    if (message.role === "tool") {
      pendingToolResponses.push(functionResponsePart(message, callIdToName));
      continue;
    }
    flushToolResponses();
    if (message.role === "assistant") {
      const parts = [];
      const text = textFromContent(message.content);
      if (text) parts.push({ text });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (let index = 0; index < calls.length; index += 1) {
        parts.push(functionCallPart(calls[index], { includeThoughtSignature: index === 0 }));
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }
    // user (and any unknown role) -> user content
    const parts = [];
    const text = textFromContent(message.content);
    if (text) parts.push({ text });
    parts.push(...imageParts(message.content));
    if (parts.length) contents.push({ role: "user", parts });
  }
  flushToolResponses();
  return { contents, systemText: systemText.join("\n\n") };
}

const MAX_SCHEMA_DEPTH = 16;

function resolveLocalSchemaRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let current = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    if (!isPlainObject(current)) return undefined;
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current[segment];
  }
  return isPlainObject(current) ? current : undefined;
}

// Google accepts no JSON Schema references. Expand local references before
// removing `$defs`, otherwise a ref-rooted Codex tool silently becomes `{}`.
// A recursive reference cannot be represented by Google's protobuf Schema;
// retain its declared object shape at the cycle boundary instead of recursing.
function dereferenceAntigravitySchema(schema, root = schema, stack = new Set(), depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_SCHEMA_DEPTH) return schema;
  let source = schema;
  let nextStack = stack;
  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalSchemaRef(schema.$ref, root);
    if (resolved && !stack.has(schema.$ref)) {
      nextStack = new Set(stack);
      nextStack.add(schema.$ref);
      source = { ...resolved, ...schema };
      delete source.$ref;
    } else {
      source = { ...schema };
      delete source.$ref;
      if (resolved?.type === "object" || isPlainObject(resolved?.properties)) {
        source.type ||= "object";
      }
    }
  }

  const next = { ...source };
  for (const keyword of ["properties", "patternProperties", "$defs", "definitions"]) {
    if (!isPlainObject(source[keyword])) continue;
    next[keyword] = Object.fromEntries(
      Object.entries(source[keyword]).map(([name, child]) => [
        name,
        dereferenceAntigravitySchema(child, root, nextStack, depth + 1),
      ]),
    );
  }
  for (const keyword of [
    "items",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
  ]) {
    if (isPlainObject(source[keyword])) {
      next[keyword] = dereferenceAntigravitySchema(
        source[keyword],
        root,
        nextStack,
        depth + 1,
      );
    } else if (Array.isArray(source[keyword])) {
      next[keyword] = source[keyword].map((child) =>
        dereferenceAntigravitySchema(child, root, nextStack, depth + 1),
      );
    }
  }
  for (const keyword of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (!Array.isArray(source[keyword])) continue;
    next[keyword] = source[keyword].map((child) =>
      dereferenceAntigravitySchema(child, root, nextStack, depth + 1),
    );
  }
  return next;
}

// Claude's compatibility path may narrow schemas, but it must never turn a
// reference it cannot represent into a wider schema. Resolve the full local
// ref chain before protobuf cleaning, and reject the tool if a ref is dangling,
// cyclic, or carries an assertion that conflicts with its target. Annotation
// siblings may override annotations because they do not change accepted input.
function dereferenceClaudeSchema(schema, root = schema, stack = new Set(), depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_SCHEMA_DEPTH) {
    return { ok: true, schema };
  }

  let source = schema;
  let nextStack = stack;
  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalSchemaRef(schema.$ref, root);
    if (!resolved || stack.has(schema.$ref)) return { ok: false };
    nextStack = new Set(stack);
    nextStack.add(schema.$ref);
    const target = dereferenceClaudeSchema(resolved, root, nextStack, depth + 1);
    if (!target.ok || !isPlainObject(target.schema)) return { ok: false };
    const { $ref: _ref, ...siblings } = schema;
    const conflicts = Object.entries(siblings).some(([key, value]) =>
      !CLAUDE_REF_OVERRIDE_ANNOTATIONS.has(key) &&
      Object.hasOwn(target.schema, key) &&
      !isDeepStrictEqual(value, target.schema[key]),
    );
    if (conflicts) return { ok: false };
    source = { ...target.schema, ...siblings };
  }

  const next = { ...source };
  // Definitions are lookup tables, not constraints on their own. Walk them
  // only when an active ref resolves into one; otherwise an unused recursive
  // definition would make a safe tool disappear.
  for (const keyword of ["properties", "patternProperties"]) {
    if (!isPlainObject(source[keyword])) continue;
    const entries = [];
    for (const [name, child] of Object.entries(source[keyword])) {
      const result = dereferenceClaudeSchema(child, root, nextStack, depth + 1);
      if (!result.ok) return result;
      entries.push([name, result.schema]);
    }
    next[keyword] = Object.fromEntries(entries);
  }
  for (const keyword of [
    "items",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
  ]) {
    if (isPlainObject(source[keyword])) {
      const result = dereferenceClaudeSchema(
        source[keyword],
        root,
        nextStack,
        depth + 1,
      );
      if (!result.ok) return result;
      next[keyword] = result.schema;
    } else if (Array.isArray(source[keyword])) {
      const children = [];
      for (const child of source[keyword]) {
        const result = dereferenceClaudeSchema(child, root, nextStack, depth + 1);
        if (!result.ok) return result;
        children.push(result.schema);
      }
      next[keyword] = children;
    }
  }
  for (const keyword of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (!Array.isArray(source[keyword])) continue;
    const children = [];
    for (const child of source[keyword]) {
      const result = dereferenceClaudeSchema(child, root, nextStack, depth + 1);
      if (!result.ok) return result;
      children.push(result.schema);
    }
    next[keyword] = children;
  }
  return { ok: true, schema: next };
}

const UNSUPPORTED_SCHEMA_KEYWORDS = Object.freeze([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$comment",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "default",
  "examples",
  "title",
  "format",
  "pattern",
  "contentMediaType",
  "contentEncoding",
  "encrypted",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minimum",
  "maximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "uniqueItems",
  "prefixItems",
  "patternProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
  "readOnly",
  "writeOnly",
  "deprecated",
  "__proto__",
  "constructor",
  "prototype",
]);

const CLAUDE_UNSUPPORTED_SCHEMA_ANNOTATIONS = new Set(["id", "discriminator"]);
const CLAUDE_REF_OVERRIDE_ANNOTATIONS = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);
const CLAUDE_UNION_SIBLINGS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "$defs",
  "definitions",
  "default",
  "deprecated",
  "description",
  "discriminator",
  "examples",
  "id",
  "readOnly",
  "title",
  "writeOnly",
]);
const CLAUDE_CLEANING_WIDENS_KEYWORDS = new Set([
  "$dynamicRef",
  "$ref",
  "additionalProperties",
  "contains",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "encrypted",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "pattern",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
]);

function jsonSchemaType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (["boolean", "string"].includes(typeof value)) return typeof value;
  if (isPlainObject(value)) return "object";
  return undefined;
}

function schemaTypes(schema) {
  if (!isPlainObject(schema)) return undefined;
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((entry) => typeof entry === "string");
    return types.length ? new Set(types) : undefined;
  }
  if (Object.hasOwn(schema, "const")) {
    const type = jsonSchemaType(schema.const);
    return type ? new Set([type]) : undefined;
  }
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const types = schema.enum.map(jsonSchemaType).filter(Boolean);
    return types.length ? new Set(types) : undefined;
  }
  return undefined;
}

function schemaTypesOverlap(left, right) {
  for (const leftType of left) {
    for (const rightType of right) {
      if (leftType === rightType) return true;
      if (
        (leftType === "integer" && rightType === "number") ||
        (leftType === "number" && rightType === "integer")
      ) {
        return true;
      }
    }
  }
  return false;
}

function finitePrimitiveValues(schema) {
  if (!isPlainObject(schema)) return undefined;
  const values = Object.hasOwn(schema, "const")
    ? [schema.const]
    : Array.isArray(schema.enum)
      ? schema.enum
      : undefined;
  if (!values?.length) return undefined;
  if (values.some((value) => value !== null && !["boolean", "number", "string"].includes(typeof value))) {
    return undefined;
  }
  return values;
}

// This is deliberately a proof, not a guess. A selected oneOf branch is a
// narrowing only when every value it accepts is known not to match another
// branch. Primitive type domains, finite literals, and required discriminant
// properties are the small set for which that can be established locally.
function schemasProvablyDisjoint(left, right, depth = 0) {
  if (left === false || right === false) return true;
  if (left === true || right === true || depth > MAX_SCHEMA_DEPTH) return false;
  if (!isPlainObject(left) || !isPlainObject(right)) return false;

  const leftTypes = schemaTypes(left);
  const rightTypes = schemaTypes(right);
  if (leftTypes && rightTypes && !schemaTypesOverlap(leftTypes, rightTypes)) return true;

  const leftValues = finitePrimitiveValues(left);
  const rightValues = finitePrimitiveValues(right);
  if (
    leftValues &&
    rightValues &&
    leftValues.every((leftValue) => !rightValues.some((rightValue) => leftValue === rightValue))
  ) {
    return true;
  }

  const leftRequired = new Set(Array.isArray(left.required) ? left.required : []);
  const rightRequired = new Set(Array.isArray(right.required) ? right.required : []);
  if (isPlainObject(left.properties) && isPlainObject(right.properties)) {
    for (const name of leftRequired) {
      if (!rightRequired.has(name)) continue;
      if (!Object.hasOwn(left.properties, name) || !Object.hasOwn(right.properties, name)) {
        continue;
      }
      if (schemasProvablyDisjoint(left.properties[name], right.properties[name], depth + 1)) {
        return true;
      }
    }
  }
  return false;
}

function withUnionSiblings(schema, keyword, selected) {
  const siblings = Object.entries(schema).filter(([key]) => key !== keyword);
  if (siblings.some(([key]) => !CLAUDE_UNION_SIBLINGS.has(key))) return undefined;
  const merged = { ...selected };
  for (const [key, value] of siblings) {
    if (!Object.hasOwn(merged, key)) merged[key] = value;
  }
  return merged;
}

function survivesClaudeCleaning(schema, depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_SCHEMA_DEPTH) return false;
  for (const [key, value] of Object.entries(schema)) {
    if (CLAUDE_CLEANING_WIDENS_KEYWORDS.has(key)) {
      // Removing the default `additionalProperties: true` changes no accepted
      // instance. Every other value is a constraint the protobuf schema cannot
      // carry, so a union branch containing it is not a safe narrowing.
      if (key !== "additionalProperties" || value !== true) return false;
    }
    if (key === "const" && typeof value !== "string") return false;
    if (key === "enum" && Array.isArray(value) && value.some((entry) => typeof entry !== "string")) {
      return false;
    }
  }
  if (Object.hasOwn(schema, "const") && Array.isArray(schema.enum)) {
    if (!schema.enum.length || schema.enum.some((entry) => entry !== schema.const)) return false;
  }
  if (isPlainObject(schema.properties)) {
    for (const child of Object.values(schema.properties)) {
      if (!survivesClaudeCleaning(child, depth + 1)) return false;
    }
  }
  if (Object.hasOwn(schema, "items")) {
    if (!survivesClaudeCleaning(schema.items, depth + 1)) return false;
  }
  return true;
}

function claudeSchemaResult(schema, depth = 0) {
  if (schema === true) return { ok: true, identity: true, schema: {} };
  if (schema === false) return { ok: false, impossible: true };
  if (!isPlainObject(schema) || depth > MAX_SCHEMA_DEPTH) return { ok: false };
  if (schema.type === "null") return { ok: false };

  const unionKeywords = ["anyOf", "oneOf", "allOf"].filter((key) =>
    Array.isArray(schema[key]),
  );
  if (unionKeywords.length > 1) return { ok: false };
  if (unionKeywords.length === 1) {
    const keyword = unionKeywords[0];
    const branches = schema[keyword];
    if (!branches.length) {
      if (keyword !== "allOf") return { ok: false, impossible: true };
      const merged = withUnionSiblings(schema, keyword, {});
      return merged
        ? { ok: true, identity: true, schema: merged }
        : { ok: false };
    }
    const translated = branches.map((branch) => claudeSchemaResult(branch, depth + 1));
    const safelyRepresentable = translated.map(
      (result) => result.ok && survivesClaudeCleaning(result.schema, depth + 1),
    );
    let selected;
    if (keyword === "allOf") {
      if (translated.some((result) => result.impossible)) return { ok: false, impossible: true };
      if (translated.some((result) => !result.ok)) return { ok: false };
      const constraining = translated.filter((result) => !result.identity);
      if (constraining.length > 1) return { ok: false };
      selected = constraining[0] || { ok: true, identity: true, schema: {} };
      if (!survivesClaudeCleaning(selected.schema, depth + 1)) return { ok: false };
    } else if (keyword === "anyOf") {
      selected = translated.find((_result, index) => safelyRepresentable[index]);
      if (!selected) {
        return translated.every((result) => result.impossible)
          ? { ok: false, impossible: true }
          : { ok: false };
      }
    } else {
      for (let index = 0; index < translated.length; index += 1) {
        const candidate = translated[index];
        if (!safelyRepresentable[index]) continue;
        const disjoint = branches.every((branch, otherIndex) =>
          otherIndex === index ||
          translated[otherIndex].impossible ||
          schemasProvablyDisjoint(candidate.schema, branch),
        );
        if (disjoint) {
          selected = candidate;
          break;
        }
      }
      if (!selected) return { ok: false };
    }
    const merged = withUnionSiblings(schema, keyword, selected.schema);
    return merged
      ? { ok: true, identity: selected.identity === true, schema: merged }
      : { ok: false };
  }

  let next = schema;
  const replace = (key, value) => {
    if (next === schema) next = { ...schema };
    next[key] = value;
  };

  if (Array.isArray(schema.type)) {
    const candidateTypes = schema.type.filter(
      (type) => typeof type === "string" && type !== "null",
    );
    let selectedType;
    if (Object.hasOwn(schema, "const")) {
      if (typeof schema.const !== "string" || !candidateTypes.includes("string")) {
        return { ok: false };
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(schema.const)) {
        return { ok: false, impossible: true };
      }
      selectedType = "string";
      replace("enum", [schema.const]);
    } else if (Array.isArray(schema.enum)) {
      const strings = schema.enum.filter((entry) => typeof entry === "string");
      if (!strings.length || !candidateTypes.includes("string")) return { ok: false };
      selectedType = "string";
      replace("enum", strings);
    } else {
      selectedType = candidateTypes[0];
    }
    if (!selectedType) return { ok: false };
    replace("type", selectedType);
  }

  if (isPlainObject(schema.properties)) {
    const properties = [];
    for (const [name, child] of Object.entries(schema.properties)) {
      const translated = claudeSchemaResult(child, depth + 1);
      if (!translated.ok) return translated;
      properties.push([name, translated.schema]);
    }
    replace("properties", Object.fromEntries(properties));
  }

  if (Object.hasOwn(schema, "items")) {
    if (Array.isArray(schema.items)) return { ok: false };
    const translated = claudeSchemaResult(schema.items, depth + 1);
    if (!translated.ok) return translated;
    replace("items", translated.schema);
  }
  return { ok: true, schema: next };
}

// Antigravity's protobuf-backed schema layer rejects annotations and
// validation keywords that ordinary JSON Schema permits. This pass is pure:
// tool schemas are caller-owned objects and must never be mutated in place.
function cleanAntigravitySchema(schema, depth = 0, { sanitizeClaude = false } = {}) {
  if (!isPlainObject(schema) || depth > MAX_SCHEMA_DEPTH) return schema;
  const next = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      UNSUPPORTED_SCHEMA_KEYWORDS.includes(key) ||
      (sanitizeClaude && CLAUDE_UNSUPPORTED_SCHEMA_ANNOTATIONS.has(key))
    ) {
      continue;
    }
    if (key === "const") {
      if (!Array.isArray(schema.enum)) next.enum = [String(value)];
      continue;
    }
    if (key === "enum" && Array.isArray(value)) {
      next.enum = value.map((entry) => String(entry));
      continue;
    }
    if (["properties"].includes(key) && isPlainObject(value)) {
      next[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          cleanAntigravitySchema(child, depth + 1, { sanitizeClaude }),
        ]),
      );
      continue;
    }
    if (key === "items" && isPlainObject(value)) {
      next[key] = cleanAntigravitySchema(value, depth + 1, { sanitizeClaude });
      continue;
    }
    if (["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(value)) {
      next[key] = value.map((child) =>
        cleanAntigravitySchema(child, depth + 1, { sanitizeClaude }),
      );
      continue;
    }
    next[key] = value;
  }
  if (Array.isArray(next.type)) {
    next.type = next.type.find((type) => type !== "null") || next.type[0];
  }
  return next;
}

function antigravityToolSchema(schema, options) {
  const normalized = normalizeSchemaLiterals(schema);
  if (options?.sanitizeClaude) {
    const dereferenced = dereferenceClaudeSchema(normalized);
    if (!dereferenced.ok) return undefined;
    const translated = claudeSchemaResult(dereferenced.schema);
    if (!translated.ok) return undefined;
    const root = translated.schema;
    const objectRoot =
      Object.keys(root).length === 0 ||
      root.type === "object" ||
      (root.type === undefined && isPlainObject(root.properties));
    if (!objectRoot) return undefined;
    return cleanAntigravitySchema(root, 0, options);
  }
  if (!isPlainObject(normalized)) return { type: "object", properties: {} };
  const dereferenced = dereferenceAntigravitySchema(normalized);
  // Flatten while definitions are still present and references are already
  // materialized; stripping first is what used to erase ref-heavy tools.
  const objectRoot = objectRootToolSchema(dereferenced);
  return cleanAntigravitySchema(objectRoot, 0, options);
}

function antigravityToolName(name) {
  const cleaned = String(name || "")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .replace(/^[^a-zA-Z_]+/, "");
  return cleaned || "tool";
}

function functionDeclarations(chat, options) {
  const declarations = [];
  const includedNames = new Set();
  const omittedNames = new Set();
  let sourceCount = 0;
  for (const tool of Array.isArray(chat.tools) ? chat.tools : []) {
    if (tool?.type !== "function" || !tool.function?.name) continue;
    sourceCount += 1;
    const sourceName = String(tool.function.name);
    const name = antigravityToolName(sourceName);
    const sourceParameters = tool.function.parameters;
    const parameters = antigravityToolSchema(
      options?.sanitizeClaude
        ? sourceParameters === undefined
          ? { type: "object", properties: {} }
          : sourceParameters
        : sourceParameters || { type: "object", properties: {} },
      options,
    );
    if (parameters === undefined) {
      omittedNames.add(sourceName);
      omittedNames.add(name);
      continue;
    }
    includedNames.add(sourceName);
    includedNames.add(name);
    declarations.push({
      name,
      description: tool.function.description,
      parameters,
    });
  }
  return { declarations, includedNames, omittedNames, sourceCount };
}

function copyMessagesForShaping(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    if (!isPlainObject(message)) return message;
    return {
      ...message,
      ...(Array.isArray(message.tool_calls) ? { tool_calls: [...message.tool_calls] } : {}),
    };
  });
}

function modelFamily(model) {
  const value = String(model || "");
  for (const [base, family] of Object.entries(MODEL_FAMILIES)) {
    if (value === base) return { base, family, suffixEffort: undefined };
    for (const effort of Object.keys(family.models)) {
      if (value === `${base}-${effort}`) return { base, family, suffixEffort: effort };
    }
    if (value.startsWith(`${base}-`)) {
      return { base, family, suffixEffort: value.slice(base.length + 1) };
    }
  }
  return undefined;
}

function positiveTokenLimit(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function resolveAntigravityModel(chat) {
  const requestedModel = String(chat?.model || "");
  const resolvedFamily = modelFamily(requestedModel);
  if (!resolvedFamily) {
    const callerLimit = positiveTokenLimit(
      chat?.max_completion_tokens ?? chat?.max_tokens,
    );
    return {
      model: requestedModel,
      effort: undefined,
      maxOutputTokens: callerLimit
        ? Math.min(callerLimit, DEFAULT_MAX_OUTPUT_TOKENS)
        : DEFAULT_MAX_OUTPUT_TOKENS,
    };
  }
  const { base, family, suffixEffort } = resolvedFamily;
  const effort = String(
    chat?.reasoning_effort || suffixEffort || family.defaultEffort,
  ).toLowerCase();
  if (!Object.hasOwn(family.models, effort)) {
    throw new AntigravityShapeError(
      `Reasoning effort ${JSON.stringify(effort)} is not supported by ${base}.`,
      { status: 400, code: "unsupported_reasoning_effort" },
    );
  }
  const callerLimit = positiveTokenLimit(chat?.max_completion_tokens ?? chat?.max_tokens);
  return {
    model: family.models[effort],
    effort,
    thinkingBudget: family.thinkingBudgets[effort],
    maxOutputTokens: callerLimit
      ? Math.min(callerLimit, family.maxOutputTokens)
      : family.maxOutputTokens,
  };
}

export function toAntigravityRequest(chat, { projectId = "", requestId = undefined } = {}) {
  const messages = copyMessagesForShaping(chat?.messages);
  foldInterveningAssistantMessages(messages);
  const { contents, systemText } = messagesToContents(messages);
  const resolved = resolveAntigravityModel(chat);
  const request = {
    contents,
    generationConfig: {
      maxOutputTokens: resolved.maxOutputTokens,
    },
  };
  if (systemText) {
    request.systemInstruction = { role: "user", parts: [{ text: systemText }] };
  }
  const genericEffort = EFFORT_BUDGET[chat?.reasoning_effort];
  if (Number.isFinite(resolved.thinkingBudget)) {
    request.generationConfig.thinkingConfig = {
      thinkingBudget: resolved.thinkingBudget,
      includeThoughts: true,
    };
  } else if (genericEffort) {
    request.generationConfig.thinkingConfig = {
      thinkingBudget: genericEffort,
      includeThoughts: true,
    };
  }
  const sanitizeClaude = String(chat?.model || "").startsWith("claude-");
  const { declarations, includedNames, omittedNames, sourceCount } = functionDeclarations(
    chat,
    { sanitizeClaude },
  );
  const choice = chat?.tool_choice;
  const forcedName =
    choice?.type === "function" && typeof choice.function?.name === "string"
      ? choice.function.name
      : undefined;
  if (
    sanitizeClaude &&
    forcedName &&
    omittedNames.has(forcedName) &&
    !includedNames.has(forcedName)
  ) {
    throw new AntigravityShapeError(
      `Forced tool ${JSON.stringify(forcedName)} cannot be represented safely for Claude Antigravity.`,
      { status: 400, code: "unsupported_forced_tool_schema" },
    );
  }
  if (
    sanitizeClaude &&
    choice === "required" &&
    sourceCount > 0 &&
    declarations.length === 0
  ) {
    throw new AntigravityShapeError(
      "No required tool can be represented safely for Claude Antigravity.",
      { status: 400, code: "no_representable_required_tool" },
    );
  }
  if (declarations.length) {
    request.tools = [{ functionDeclarations: declarations }];
    let functionCallingConfig;
    if (choice === "none") {
      functionCallingConfig = { mode: "NONE" };
    } else if (choice === "required") {
      functionCallingConfig = { mode: "ANY" };
    } else if (choice?.type === "function" && typeof choice.function?.name === "string") {
      functionCallingConfig = {
        mode: "ANY",
        allowedFunctionNames: [choice.function.name],
      };
    } else {
      functionCallingConfig = { mode: "VALIDATED" };
    }
    request.toolConfig = { functionCallingConfig };
  }

  return {
    project: projectId || "",
    model: resolved.model,
    request,
    requestType: "agent",
    userAgent: "codex-router",
    requestId: requestId || `agent-${randomRequestId()}`,
  };
}

function randomRequestId() {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Response translation: Gemini `streamGenerateContent` SSE -> OpenAI Chat
// Completions chunks.

export function mapAntigravityUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== "object") return undefined;
  const finiteCount = (value) => {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
  };
  const prompt = finiteCount(usageMetadata.promptTokenCount);
  const candidates = finiteCount(usageMetadata.candidatesTokenCount);
  const thoughts = finiteCount(usageMetadata.thoughtsTokenCount);
  const completion = candidates + thoughts;
  const computedTotal = prompt + completion;
  const reportedTotal = Number(usageMetadata.totalTokenCount);
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens:
      Number.isFinite(reportedTotal) && reportedTotal >= computedTotal
        ? reportedTotal
        : computedTotal,
  };
  const cached = Number(usageMetadata.cachedContentTokenCount);
  if (Number.isFinite(cached) && cached >= 0) {
    usage.prompt_tokens_details = { cached_tokens: cached };
  }
  if (thoughts > 0 || usageMetadata.thoughtsTokenCount !== undefined) {
    usage.completion_tokens_details = { reasoning_tokens: thoughts };
  }
  return usage;
}

export function createAntigravityTurnState() {
  return {
    contentText: "",
    reasoningText: "",
    toolCalls: [],
    toolByKey: new Map(),
    usage: undefined,
    finishReason: undefined,
    deltas: [],
    pendingThoughtSignature: undefined,
    sawCandidate: false,
    sawTerminal: false,
    sawMeaningfulOutput: false,
  };
}

function pushContentDelta(state, delta) {
  if (!delta) return;
  state.contentText += delta;
  state.deltas.push({ content: delta });
  state.sawMeaningfulOutput = true;
}

function pushReasoningDelta(state, delta) {
  if (!delta) return;
  state.reasoningText += delta;
  state.deltas.push({ reasoning_content: delta });
  state.sawMeaningfulOutput = true;
}

function ensureToolCall(state, call, thoughtSignature) {
  const rawId = splitThoughtSignature(call?.id).id;
  const signature = thoughtSignature || call?.thoughtSignature;
  // Google may omit functionCall.id. Two calls to the same function are still
  // distinct calls, so only a real upstream id is safe as a merge key.
  const key = rawId || undefined;
  let entry = key ? state.toolByKey.get(key) : undefined;
  if (!entry) {
    const id = rawId || `call_${randomUUID()}`;
    entry = {
      id: signedToolCallId(id, signature),
      type: "function",
      function: { name: call?.name || "", arguments: "" },
      ...(signature
        ? { provider_specific_fields: { thought_signature: signature } }
        : {}),
    };
    state.toolCalls.push(entry);
    if (key) state.toolByKey.set(key, entry);
    state.deltas.push({
      tool_calls: [
        {
          index: state.toolCalls.length - 1,
          id: entry.id,
          type: "function",
          function: { name: entry.function.name, arguments: "" },
        },
      ],
    });
  }
  if (call?.name) entry.function.name = call.name;
  if (signature && !entry.provider_specific_fields?.thought_signature) {
    entry.id = signedToolCallId(rawId || entry.id, signature);
    entry.provider_specific_fields = { thought_signature: signature };
  }
  if (isPlainObject(call?.args) || call?.args === undefined) {
    const serialized = JSON.stringify(isPlainObject(call?.args) ? call.args : {});
    if (serialized !== entry.function.arguments) {
      entry.function.arguments = serialized;
      state.deltas.push({
        tool_calls: [
          {
            index: state.toolCalls.indexOf(entry),
            function: { arguments: serialized },
          },
        ],
      });
    }
  }
  state.sawMeaningfulOutput = true;
  return entry;
}

function embeddedPayloadError(error) {
  if (!error || typeof error !== "object") return undefined;
  const upstreamStatus = Number(error.code ?? error.statusCode);
  const status =
    Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599
      ? upstreamStatus
      : 502;
  return new AntigravityShapeError(
    typeof error.message === "string" && error.message
      ? `Google Antigravity returned an embedded error: ${error.message}`
      : "Google Antigravity returned an embedded stream error.",
    { status, code: String(error.status || error.code || "antigravity_stream_error") },
  );
}

const CONTENT_FILTER_FINISH_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "RECITATION",
  "BLOCKLIST",
  "SPII",
  "IMAGE_SAFETY",
]);

// Applies one Gemini SSE `data:` payload. Parts arrive incrementally, so text
// parts append to the running candidate and functionCall parts merge by id.
export function applyAntigravitySsePayload(state, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AntigravityShapeError("Google Antigravity sent a malformed stream payload.");
  }
  const topLevelError = embeddedPayloadError(payload.error);
  if (topLevelError) throw topLevelError;
  const response =
    isPlainObject(payload.response) &&
    (payload.response.candidates !== undefined ||
      payload.response.usageMetadata !== undefined ||
      payload.response.promptFeedback !== undefined ||
      payload.response.error !== undefined)
      ? payload.response
      : payload;
  const responseError = embeddedPayloadError(response.error);
  if (responseError) throw responseError;
  const blockReason = response.promptFeedback?.blockReason;
  if (typeof blockReason === "string" && blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
    throw new AntigravityShapeError(
      `Google Antigravity blocked the prompt (${blockReason}).`,
      { status: 400, code: "content_filter" },
    );
  }
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  for (const candidate of candidates) {
    state.sawCandidate = true;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const partSignature =
        typeof part.thoughtSignature === "string" && part.thoughtSignature
          ? part.thoughtSignature
          : undefined;
      if (typeof part.text === "string" && part.text.length > 0) {
        if (part.thought === true) pushReasoningDelta(state, part.text);
        else pushContentDelta(state, part.text);
      }
      if (part.functionCall) {
        ensureToolCall(
          state,
          part.functionCall,
          partSignature || state.pendingThoughtSignature,
        );
        state.pendingThoughtSignature = undefined;
      } else if (
        partSignature &&
        part.thought === true &&
        (part.text === undefined || part.text === "")
      ) {
        state.pendingThoughtSignature = partSignature;
      }
    }
    if (typeof candidate.finishReason === "string") {
      state.finishReason = candidate.finishReason;
      state.sawTerminal = true;
    }
  }
  if (response.usageMetadata) {
    state.usage = mapAntigravityUsage(response.usageMetadata);
  }
  return state;
}

export function finalizeAntigravityTurn(state) {
  if (!state.sawCandidate) {
    throw new AntigravityShapeError(
      "Google Antigravity ended its stream without returning a candidate.",
      { code: "missing_candidate" },
    );
  }
  if (!state.sawTerminal) {
    throw new AntigravityShapeError(
      "Google Antigravity ended its stream before the candidate completed.",
      { code: "incomplete_stream" },
    );
  }
  const contentFiltered = CONTENT_FILTER_FINISH_REASONS.has(state.finishReason);
  if (!state.sawMeaningfulOutput && !contentFiltered) {
    throw new AntigravityShapeError(
      "Google Antigravity completed without returning output.",
      { code: "empty_response" },
    );
  }
  const finishReason = state.toolCalls.length
    ? "tool_calls"
    : state.finishReason === "MAX_TOKENS"
      ? "length"
      : contentFiltered
        ? "content_filter"
        : "stop";
  return {
    contentText: state.contentText,
    reasoningText: state.reasoningText,
    toolCalls: state.toolCalls,
    usage: state.usage,
    deltas: state.deltas,
    finishReason,
  };
}
