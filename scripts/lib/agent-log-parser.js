"use strict";

const { collectEventText } = require("./provider-output");

function parseAgentState(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;

    const jsonSummary = summarizeJsonLine(line);
    if (jsonSummary) return jsonSummary;

    const textSummary = summarizeText(line);
    if (textSummary) return textSummary;
  }
  return null;
}

function summarizeJsonLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return summarizeJsonEvent(parsed);
}

function summarizeJsonEvent(event) {
  const toolCalls = findToolCalls(event);
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const summary = summarizeToolCall(toolCalls[i]);
    if (summary) return summary;
  }

  const text = collectEventText(event).join("\n");
  if (!text.trim()) return null;
  for (const line of text.split(/\r?\n/).reverse()) {
    const summary = summarizeText(line.trim());
    if (summary) return summary;
  }
  return null;
}

function summarizeText(line) {
  if (!line) return null;
  let match;
  if ((match = line.match(/Editing file:?\s+(.*)/i))) return `Editing: ${match[1]}`;
  if ((match = line.match(/Tool Use:\s+(?:replace|write_file|edit)\s+.*?in\s+(.*)/i))) return `Editing: ${match[1]}`;
  if (line.match(/Tool Use:\s+replace\s*(.*)/i)) return "Editing file";
  if ((match = line.match(/Tool Use:\s+read_file\s+(.*)/i))) return `Reading: ${match[1]}`;
  if ((match = line.match(/Tool Use:\s+bash\s+(.*)/i)) || (match = line.match(/Running command:?\s+(.*)/i))) {
    return `Running: ${match[1].substring(0, 30)}...`;
  }
  if ((match = line.match(/Tokens:\s+(\d+)/i))) return `Processing... (Tokens: ${match[1]})`;
  if ((match = line.match(/Applied edit to\s+(.*)/i))) return `Saved: ${match[1]}`;
  if (line.match(/Running tests/i)) return "Testing...";
  return null;
}

function findToolCalls(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) findToolCalls(item, out);
    return out;
  }
  if (!isPlainObject(value)) return out;

  const type = normalize(value.type);
  const name = toolName(value, type);
  const input = toolInput(value);
  if (name && (isToolLike(type) || input !== undefined)) {
    out.push({ name, input: input === undefined ? value : input });
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") findToolCalls(child, out);
  }
  return out;
}

function summarizeToolCall(call) {
  const tool = normalizeToolName(call.name);
  const input = normalizeInput(call.input);
  const filePath = extractPath(input);

  if (/(read|view|open|getfile|cat)/.test(tool)) {
    return filePath ? `Reading: ${filePath}` : "Reading file";
  }
  if (/(edit|write|replace|multiedit|patch|create|update|save)/.test(tool)) {
    return filePath ? `Editing: ${filePath}` : "Editing file";
  }
  if (/(bash|shell|terminal|command|exec|run)/.test(tool)) {
    const command = extractCommand(input);
    return command ? `Running: ${command.substring(0, 30)}...` : "Running command";
  }
  if (/(grep|search|rg|glob|find)/.test(tool)) {
    const target = extractSearchTarget(input);
    return target ? `Searching: ${target.substring(0, 30)}...` : "Searching";
  }
  return null;
}

function toolName(value, type) {
  if (typeof value.name === "string" && (isToolLike(type) || toolInput(value) !== undefined)) return value.name;
  for (const key of ["tool_name", "toolName"]) {
    if (typeof value[key] === "string") return value[key];
  }
  if (typeof value.tool === "string") return value.tool;
  if (isPlainObject(value.function) && typeof value.function.name === "string") return value.function.name;
  return "";
}

function toolInput(value) {
  for (const key of ["input", "args", "arguments", "parameters"]) {
    if (value[key] !== undefined) return value[key];
  }
  if (isPlainObject(value.function)) {
    for (const key of ["arguments", "args", "parameters"]) {
      if (value.function[key] !== undefined) return value.function[key];
    }
  }
  return undefined;
}

function normalizeInput(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractPath(value) {
  return findStringByKeys(value, [
    "file_path",
    "filepath",
    "absolute_path",
    "relative_path",
    "target_file",
    "filename",
    "path",
    "file",
  ]);
}

function extractCommand(value) {
  const found = findValueByKeys(value, ["command", "cmd", "shell_command", "script"]);
  if (Array.isArray(found)) return found.map(String).join(" ");
  return typeof found === "string" ? found : "";
}

function extractSearchTarget(value) {
  return findStringByKeys(value, ["pattern", "query", "regex", "glob", "path", "include"]);
}

function findStringByKeys(value, keys) {
  const found = findValueByKeys(value, keys);
  return typeof found === "string" ? found : "";
}

function findValueByKeys(value, keys, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === "string") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValueByKeys(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;

  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findValueByKeys(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isToolLike(type) {
  return type.includes("tool") || type.includes("function") || type.includes("exec") || type.includes("command");
}

function normalizeToolName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalize(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  parseAgentState,
  summarizeJsonEvent,
  summarizeText,
};
