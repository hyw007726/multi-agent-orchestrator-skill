"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { tailLines, rotateLogIfTooLarge } = require("../scripts/lib/log-tail");

describe("tailLines", () => {
  it("returns empty when the file is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-tail-missing-"));
    try {
      assert.strictEqual(tailLines(path.join(dir, "nope.log"), 10), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the last N lines and preserves a trailing newline", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-tail-small-"));
    try {
      const file = path.join(dir, "small.log");
      fs.writeFileSync(file, "a\nb\nc\nd\ne\n", "utf-8");
      assert.strictEqual(tailLines(file, 3), "c\nd\ne\n");
      assert.strictEqual(tailLines(file, 10), "a\nb\nc\nd\ne\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not load the whole file when the tail window is smaller than the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-tail-big-"));
    try {
      const file = path.join(dir, "big.log");
      const fd = fs.openSync(file, "w");
      try {
        // Write ~200 KB so a 64 KB seek-from-end window is meaningfully smaller.
        const padding = "x".repeat(1000);
        for (let i = 0; i < 200; i++) {
          fs.writeSync(fd, `line-${i.toString().padStart(4, "0")}-${padding}\n`);
        }
      } finally {
        fs.closeSync(fd);
      }
      const tail = tailLines(file, 3, { maxBytes: 4096 });
      const lines = tail.replace(/\n+$/, "").split("\n");
      assert.strictEqual(lines.length, 3);
      assert.match(lines[2], /^line-0199-/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 lines when lineCount is 0 or negative", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-tail-zero-"));
    try {
      const file = path.join(dir, "x.log");
      fs.writeFileSync(file, "a\nb\n", "utf-8");
      assert.strictEqual(tailLines(file, 0), "");
      assert.strictEqual(tailLines(file, -3), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not lose the leading complete line when the window starts at a line boundary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-tail-boundary-"));
    try {
      const file = path.join(dir, "boundary.log");
      // Line 1: 50 bytes, Line 2: 50 bytes.
      const line1 = "L1".padEnd(49, ".") + "\n";
      const line2 = "L2".padEnd(49, ".") + "\n";
      fs.writeFileSync(file, line1 + line2, "utf-8");

      // Exactly line 2.
      const tail = tailLines(file, 10, { maxBytes: 50 });
      assert.strictEqual(tail, line2);

      // Window starts at the \n of line 1.
      const tail2 = tailLines(file, 10, { maxBytes: 51 });
      assert.strictEqual(tail2, line2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rotateLogIfTooLarge", () => {
  it("returns false when the file is under the cap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotate-noop-"));
    try {
      const file = path.join(dir, "small.log");
      fs.writeFileSync(file, "hi\n", "utf-8");
      assert.strictEqual(rotateLogIfTooLarge(file, 1024), false);
      assert.strictEqual(fs.existsSync(`${file}.1`), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rotates and overwrites a pre-existing .1 when the file exceeds the cap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotate-overwrite-"));
    try {
      const file = path.join(dir, "big.log");
      const rotated = `${file}.1`;
      fs.writeFileSync(rotated, "OLD\n", "utf-8");
      fs.writeFileSync(file, "x".repeat(2048), "utf-8");

      assert.strictEqual(rotateLogIfTooLarge(file, 512), true);
      assert.strictEqual(fs.existsSync(file), false);
      assert.strictEqual(fs.readFileSync(rotated, "utf-8").length, 2048);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats maxBytes <= 0 as 'never rotate'", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotate-off-"));
    try {
      const file = path.join(dir, "huge.log");
      fs.writeFileSync(file, "x".repeat(2048), "utf-8");
      assert.strictEqual(rotateLogIfTooLarge(file, 0), false);
      assert.strictEqual(rotateLogIfTooLarge(file, -1), false);
      assert.strictEqual(fs.existsSync(file), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
