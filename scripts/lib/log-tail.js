"use strict";

const fs = require("fs");

// Read the trailing portion of a log file without loading the whole thing into
// memory. Stream-json workers can produce hundreds of MB on long runs; loading
// every byte just to grab the last N lines blocks the event loop and pushes the
// process toward heap exhaustion. We seek backwards from the end and read at
// most `maxBytes` (default 64 KB), which is plenty for the 50-line tails the
// dashboard and progress-timeout requests use.
const DEFAULT_TAIL_BYTES = 64 * 1024;

// Cap for rotateLogIfTooLarge below. Rotation is a one-shot at agent (re)spawn,
// not a live truncation — a running worker holds the log fd open in append
// mode, so renaming the file mid-run would silently redirect writes to the
// rotated path. Rotating at spawn time keeps the active fd pointed at a fresh
// file.
const DEFAULT_MAX_LOG_BYTES = 256 * 1024 * 1024;

function tailLines(filePath, lineCount, { maxBytes = DEFAULT_TAIL_BYTES } = {}) {
  if (!filePath) return "";
  const limit = Math.max(0, Math.floor(Number(lineCount) || 0));
  if (limit === 0) return "";

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return "";
  }

  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) return "";

    const cap = Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : DEFAULT_TAIL_BYTES;
    const readSize = Math.min(cap, size);
    const buf = Buffer.allocUnsafe(readSize);
    const start = size - readSize;
    fs.readSync(fd, buf, 0, readSize, start);

    const text = buf.toString("utf-8");
    const hadTrailingNewline = text.endsWith("\n");
    const split = text.split(/\r?\n/);
    if (hadTrailingNewline) split.pop();
    // The 64 KB window may start mid-line. Drop the first fragment so we don't
    // surface a truncated head of an earlier line — but only when we have more
    // than one line to spare.
    if (start > 0 && split.length > 1) split.shift();

    const tail = split.slice(-limit).join("\n");
    return tail ? `${tail}${hadTrailingNewline ? "\n" : ""}` : "";
  } catch {
    return "";
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Move `path.log` to `path.log.1` if it exceeds `maxBytes`. Overwrites a
// pre-existing `.log.1`. Returns true if rotation happened. Intended to be
// called at agent (re)spawn time, before the new log fd is opened — see
// scripts/spawn-agent.js. Callers that pass a non-positive maxBytes are opting
// out of rotation entirely.
function rotateLogIfTooLarge(filePath, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  if (!filePath) return false;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size <= maxBytes) return false;

  const rotated = `${filePath}.1`;
  try {
    try { fs.unlinkSync(rotated); } catch {}
    fs.renameSync(filePath, rotated);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  tailLines,
  rotateLogIfTooLarge,
  DEFAULT_TAIL_BYTES,
  DEFAULT_MAX_LOG_BYTES,
};
