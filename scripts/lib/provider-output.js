"use strict";

function extractJsonObject(text) {
  const streamText = extractTextFromJsonStream(text);
  if (streamText && streamText !== text) {
    const parsedFromStream = extractJsonObjectFromText(streamText);
    if (parsedFromStream) return parsedFromStream;
  }
  return extractJsonObjectFromText(text);
}

function extractTextFromJsonStream(text) {
  if (typeof text !== "string" || text.trim() === "") return text;

  let sawJson = false;
  const parts = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = tryParseAny(line.trim());
    if (parsed === undefined) {
      parts.push(line);
      continue;
    }

    sawJson = true;
    const eventText = collectEventText(parsed).join("");
    if (eventText.trim() !== "") parts.push(eventText);
  }

  return sawJson ? parts.join("\n") : text;
}

function collectEventText(value) {
  const out = [];
  collectText(value, out);
  return out;
}

function extractJsonObjectFromText(text) {
  if (typeof text !== "string" || text.trim() === "") return null;

  const trimmed = text.trim();
  const direct = tryParseObject(trimmed);
  if (direct) return direct;

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRe.exec(text)) !== null) {
    const parsed = tryParseObject(fenceMatch[1].trim());
    if (parsed) return parsed;
  }

  // Fast path: the orchestrator's JSON verdict is almost always the last object
  // in verbose stream-json output. Try the final balanced object first so we
  // don't JSON.parse every {...} substring from the top on the common case.
  const lastObject = lastBalancedObject(text);
  if (lastObject) {
    const parsed = tryParseObject(lastObject);
    if (parsed) return parsed;
  }

  for (const candidate of balancedObjectCandidates(text)) {
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
  }
  return null;
}

// Scans from the last `}` backward to its matching `{` (string-aware) and
// returns that substring, or null if no balanced object closes the text.
function lastBalancedObject(text) {
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (inString) {
      if (ch === "\"" && !isEscaped(text, i)) inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "}") {
      depth++;
    } else if (ch === "{") {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;

  function isEscaped(s, idx) {
    let backslashes = 0;
    for (let j = idx - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
    return backslashes % 2 === 1;
  }
}

function collectText(value, out) {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return;
  }
  if (!isPlainObject(value)) return;

  const type = normalize(value.type);
  if (isToolPayload(type)) return;

  if (typeof value.text === "string") out.push(value.text);
  if (typeof value.delta === "string") out.push(value.delta);
  if (typeof value.output_text === "string") out.push(value.output_text);
  if (typeof value.content === "string") out.push(value.content);
  if (typeof value.message === "string" && isMessageText(value)) out.push(value.message);
  if (typeof value.result === "string" && type === "result") out.push(value.result);

  for (const key of ["message", "content", "part", "parts", "response", "output", "outputs", "item", "msg", "data"]) {
    const child = value[key];
    if (child !== undefined && typeof child !== "string") collectText(child, out);
  }
}

function isMessageText(value) {
  const type = normalize(value.type);
  const role = normalize(value.role);
  return role === "assistant" || type.includes("message") || type === "assistant" || type === "content";
}

function isToolPayload(type) {
  return type.includes("tool") || type.includes("function_call");
}

function balancedObjectCandidates(text) {
  const out = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

function tryParseObject(text) {
  const parsed = tryParseAny(text);
  return isPlainObject(parsed) ? parsed : null;
}

function tryParseAny(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalize(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  collectEventText,
  extractJsonObject,
  extractJsonObjectFromText,
  extractTextFromJsonStream,
};
