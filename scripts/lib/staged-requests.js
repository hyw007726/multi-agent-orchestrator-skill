const fs = require("fs");
const path = require("path");
const { updateJSONL } = require("./locking");

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STAGED_REQUEST_TYPES = new Set(["question", "change", "conflict", "review_request"]);
const REQUEST_PRIORITIES = new Set(["low", "medium", "high"]);

// Shared — called at the very beginning of each runLoop cycle and from the
// vanished-worker check when a worker may have staged a request after the
// initial consolidation.
function consolidateStagedRequests(paths) {
  const requestsDir = paths.requestsDir;
  if (!fs.existsSync(requestsDir)) return;

  const entries = fs.readdirSync(requestsDir);
  const jsonFiles = entries.filter(f => f.endsWith(".json"));
  if (jsonFiles.length === 0) return;

  const collected = [];
  const consumedFiles = [];
  const malformedFiles = [];
  const context = stagedRequestContext(paths);

  for (const file of jsonFiles) {
    const filePath = path.join(requestsDir, file);
    const parsed = readAndValidateStagedRequest(filePath, file, context);
    if (parsed.ok) {
      collected.push(parsed.request);
      consumedFiles.push(filePath);
    } else {
      malformedFiles.push({ filePath, error: parsed.error });
    }
  }

  if (collected.length > 0) {
    updateJSONL(paths.requests, (current) => {
      current.push(...collected);
    });
    for (const filePath of consumedFiles) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  if (malformedFiles.length > 0) {
    const malformedDir = path.join(requestsDir, "malformed");
    fs.mkdirSync(malformedDir, { recursive: true });
    for (const { filePath, error } of malformedFiles) {
      const dest = path.join(malformedDir, path.basename(filePath));
      try {
        fs.renameSync(filePath, dest);
      } catch {
        try { fs.unlinkSync(filePath); } catch {}
      }
      try {
        fs.writeFileSync(`${dest}.error.txt`, `${error}\n`, "utf-8");
      } catch {}
    }
  }
}

// Shared — used by the vanished-worker check in runLoop.
// Reads all .json files from the staging directory and returns parsed objects
// WITHOUT moving/deleting them (that's consolidateStagedRequests's job).
function readStagedRequests(paths) {
  const requestsDir = paths.requestsDir;
  if (!fs.existsSync(requestsDir)) return [];

  const entries = fs.readdirSync(requestsDir);
  const jsonFiles = entries.filter(f => f.endsWith(".json"));
  if (jsonFiles.length === 0) return [];

  const out = [];
  const context = stagedRequestContext(paths);
  for (const file of jsonFiles) {
    const parsed = readAndValidateStagedRequest(path.join(requestsDir, file), file, context);
    if (parsed.ok) out.push(parsed.request);
  }
  return out;
}

function stagedRequestContext(paths) {
  const agents = readJSONIfExists(paths.agents);
  const context = readJSONIfExists(paths.context);
  const knownAgents = new Set([
    ...Object.keys(isPlainObject(agents) ? agents : {}),
    ...Object.keys(isPlainObject(context?.tasks) ? context.tasks : {}),
  ]);
  return { knownAgents };
}

function readAndValidateStagedRequest(filePath, fileName, context) {
  let request;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    request = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err.message}` };
  }

  const validation = validateStagedRequest(request, fileName, context);
  if (!validation.ok) return validation;
  return { ok: true, request };
}

function validateStagedRequest(request, fileName, context = {}) {
  if (!isPlainObject(request)) {
    return { ok: false, error: "Staged request must be a JSON object." };
  }

  const errors = [];
  if (!isSafeRequestId(request.request_id)) errors.push("request_id must be a safe non-empty id (letters, numbers, dot, underscore, colon, or dash; max 200 chars).");
  if (!isSafeAgentName(request.agent)) errors.push("agent must be a safe non-empty agent name.");
  if (!STAGED_REQUEST_TYPES.has(request.type)) errors.push(`type must be one of: ${Array.from(STAGED_REQUEST_TYPES).join(", ")}.`);
  if (!REQUEST_PRIORITIES.has(request.priority)) errors.push("priority must be low, medium, or high.");
  if (request.status !== "pending") errors.push('status must be "pending" for staged worker requests.');
  if (typeof request.content !== "string" || request.content.trim() === "") errors.push("content must be a non-empty string.");
  if (!isIsoTimestamp(request.created_at)) errors.push("created_at must be an ISO 8601 timestamp string.");

  const knownAgents = context.knownAgents instanceof Set ? context.knownAgents : new Set();
  if (knownAgents.size > 0 && isSafeAgentName(request.agent) && !knownAgents.has(request.agent)) {
    errors.push(`agent "${request.agent}" is not present in agents.json or context.json tasks.`);
  }

  const matchingFileAgent = inferAgentFromStagedFile(fileName, knownAgents);
  if (matchingFileAgent && request.agent !== matchingFileAgent) {
    errors.push(`agent "${request.agent}" does not match staging filename context "${matchingFileAgent}".`);
  }

  if (errors.length > 0) return { ok: false, error: errors.join(" ") };
  return { ok: true };
}

function inferAgentFromStagedFile(fileName, knownAgents) {
  if (!(knownAgents instanceof Set) || knownAgents.size === 0) return "";
  const base = path.basename(fileName, ".json");
  const matches = Array.from(knownAgents)
    .filter((agent) => base === agent || base.startsWith(`${agent}-`))
    .sort((a, b) => b.length - a.length);
  return matches[0] || "";
}

function isSafeRequestId(value) {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value);
}

function isSafeAgentName(value) {
  return typeof value === "string" && SAFE_AGENT_NAME.test(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function readJSONIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  SAFE_REQUEST_ID,
  SAFE_AGENT_NAME,
  STAGED_REQUEST_TYPES,
  REQUEST_PRIORITIES,
  consolidateStagedRequests,
  readStagedRequests,
  stagedRequestContext,
  readAndValidateStagedRequest,
  validateStagedRequest,
  inferAgentFromStagedFile,
  isSafeRequestId,
  isSafeAgentName,
  isIsoTimestamp,
};
