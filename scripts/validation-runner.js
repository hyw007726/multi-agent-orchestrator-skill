#!/usr/bin/env node

const fs = require("fs");
const { spawn } = require("child_process");

const OUTPUT_LIMIT_BYTES = 200 * 1024;

main();

function main() {
  const jobFile = process.argv[2];
  if (!jobFile) {
    process.stderr.write("Usage: validation-runner.js <job-file>\n");
    process.exit(1);
  }

  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobFile, "utf-8"));
  } catch (err) {
    process.stderr.write(`Failed to read validation job: ${err.message}\n`);
    process.exit(1);
  }

  runValidation(job);
}

function runValidation(job) {
  const cmd = job.cmd;
  const isArgv = Array.isArray(cmd);
  const timeoutMs = Math.max(1, Number(job.timeoutMs) || 1);
  const startedAt = job.startedAt || new Date().toISOString();
  const outputFile = job.outputFile;
  const resultFile = job.resultFile;
  let completed = false;
  let timedOut = false;
  let child = null;
  const tail = createTailBuffer(OUTPUT_LIMIT_BYTES);

  fs.writeFileSync(outputFile, "", "utf-8");

  try {
    child = isArgv
      ? spawn(cmd[0], cmd.slice(1), validationSpawnOptions(job, false))
      : spawn(String(cmd), validationSpawnOptions(job, true));
  } catch (err) {
    writeResult(resultFile, {
      passed: false,
      log: `Validation invocation failed: ${err.message}`,
      error: err.message,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
    return;
  }

  child.stdout.on("data", (chunk) => recordOutput(outputFile, tail, chunk));
  child.stderr.on("data", (chunk) => recordOutput(outputFile, tail, chunk));
  child.on("error", (err) => {
    if (completed) return;
    completed = true;
    writeResult(resultFile, {
      passed: false,
      log: `Validation invocation failed: ${err.message}`,
      error: err.message,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
  });
  child.on("close", (status, signal) => {
    if (completed) return;
    completed = true;
    const output = tail.text().trim();
    if (timedOut) {
      const message = `Validation timed out after ${formatValidationTimeout(timeoutMs, job.timeoutMins)}.`;
      writeResult(resultFile, {
        passed: false,
        status,
        signal,
        timed_out: true,
        log: output ? `${message}\n${output}` : message,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      return;
    }
    if (status !== 0) {
      const exit = signal ? `signal ${signal}` : `exit ${status}`;
      writeResult(resultFile, {
        passed: false,
        status,
        signal,
        log: output || `Validation failed (${exit}).`,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
      return;
    }
    writeResult(resultFile, {
      passed: true,
      status,
      signal,
      log: output,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
  });

  const timeout = setTimeout(() => {
    if (completed) return;
    timedOut = true;
    killChildGroup(child);
    setTimeout(() => {
      if (!completed) killChildGroup(child, "SIGKILL");
    }, 2000).unref();
  }, timeoutMs);
  timeout.unref();

  process.once("SIGTERM", () => {
    if (!completed) {
      timedOut = false;
      killChildGroup(child);
      writeResult(resultFile, {
        passed: false,
        signal: "SIGTERM",
        log: "Validation runner was terminated.",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
    }
    process.exit(0);
  });
}

function validationSpawnOptions(job, shell) {
  return {
    cwd: job.worktree,
    stdio: ["ignore", "pipe", "pipe"],
    shell,
    detached: process.platform !== "win32",
  };
}

function recordOutput(outputFile, tail, chunk) {
  try {
    fs.appendFileSync(outputFile, chunk);
  } catch {}
  tail.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
}

function createTailBuffer(maxBytes) {
  let chunks = [];
  let total = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      total += chunk.length;
      while (total > maxBytes && chunks.length > 0) {
        const first = chunks[0];
        const overflow = total - maxBytes;
        if (first.length <= overflow) {
          chunks.shift();
          total -= first.length;
        } else {
          chunks[0] = first.subarray(overflow);
          total -= overflow;
        }
      }
    },
    text() {
      return Buffer.concat(chunks, total).toString("utf-8");
    },
  };
}

function writeResult(resultFile, result) {
  const tmpPath = `${resultFile}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2) + "\n");
  fs.renameSync(tmpPath, resultFile);
}

function killChildGroup(child, signal = "SIGTERM") {
  if (!child || !Number.isInteger(child.pid)) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

function formatValidationTimeout(timeoutMs, timeoutMins) {
  const mins = Number(timeoutMins);
  const renderedMins = Number.isFinite(mins) ? mins : timeoutMs / 60_000;
  return `${timeoutMs}ms (${renderedMins} minute${renderedMins === 1 ? "" : "s"})`;
}
