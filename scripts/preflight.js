#!/usr/bin/env node

/**
 * Preflight CLI health check. Run this in Phase 1 before any agents are spawned
 * so install / auth issues fail fast (5–10s) instead of being caught by the
 * 10-minute liveness timeout per agent.
 *
 * Usage:
 *   node scripts/preflight.js                   # checks default_cli + orchestrator_cli + reviewer CLIs (with auth)
 *   node scripts/preflight.js --skip-auth       # binary-only check, no API calls (CI / offline)
 *   node scripts/preflight.js --cli kilo --cli aider
 *   node scripts/preflight.js --timeout 15000   # per-CLI timeout in ms (default 10000)
 *
 * Exits 0 if every checked CLI is healthy, non-zero otherwise.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig } = require("./lib/config");
const { spawnCliTemplateSync, validateCliTemplate } = require("./lib/cli-template");
const { formatModelHeadsUp } = require("./lib/model-headsup");

runPreflight();

function runPreflight() {
  const args = parseArgs();
  const config = loadConfig();

  const reviewerClis = Array.isArray(config.reviewers) ? config.reviewers.map((reviewer) => reviewer.cli) : [];
  const clis = args.clis.length > 0
    ? uniqueClis(args.clis)
    : uniqueClis([config.default_cli, config.orchestrator_cli, ...reviewerClis]);

  console.log(formatModelHeadsUp(config, { checkedClis: clis }));
  console.log("");
  console.log(`Preflight: checking ${clis.length} CLI(s) — ${clis.join(", ")} (${args.withAuth ? "install + auth" : "install only"})\n`);

  let allOk = true;
  for (const cli of clis) {
    const versionResult = runVersionCheck(cli, config, args.timeoutMs);
    printResult(cli, "install", versionResult);
    if (!versionResult.ok) allOk = false;

    const templateResult = runTemplateValidation(cli, config);
    if (templateResult) {
      printResult(cli, "template", templateResult);
      if (!templateResult.ok) allOk = false;
    }

    if (!versionResult.ok || (templateResult && !templateResult.ok)) continue;

    if (args.withAuth) {
      const authResult = runAuthCheck(cli, config, args.timeoutMs * 2);
      printResult(cli, "auth", authResult);
      if (!authResult.ok) allOk = false;
    }
  }

  if (!allOk) {
    console.error("\nPreflight FAILED. Fix the issues above before spawning agents.");
    console.error("Common causes: CLI not installed, not on $PATH, missing API key, no default model selected.");
    process.exit(1);
  }
  console.log("\nPreflight passed.");

  // Single-use helpers — only used by runPreflight above. ────────────────────

  function parseArgs() {
    const argv = process.argv.slice(2);
    const out = { clis: [], withAuth: true, timeoutMs: 10000 };
    for (let i = 0; i < argv.length; i++) {
      switch (argv[i]) {
        case "--cli": out.clis.push(argv[++i]); break;
        case "--skip-auth": out.withAuth = false; break;
        case "--auth": break; // no-op — auth is now the default; kept for backwards compat
        case "--timeout": out.timeoutMs = parseInt(argv[++i], 10); break;
        case "--help":
        case "-h":
          console.log(`See header of ${__filename} for usage.`);
          process.exit(0);
      }
    }
    return out;
  }

  // Runs the configured (or default) `--version`-style probe.
  function runVersionCheck(cli, config, timeoutMs) {
    const cmd = config.cli_health_checks[cli];
    if (!cmd) {
      return { ok: false, message: `No health check configured for '${cli}'. Add it under cli_health_checks in orchestrator.config.js.` };
    }
    return runShell(cmd, timeoutMs);
  }

  function runTemplateValidation(cli, config) {
    const template = config.cli_templates[cli];
    if (template === undefined) return null;
    const result = validateCliTemplate(cli, template);
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, message: `${result.mode} mode` };
  }

  // Runs the spawn template with a tiny prompt to confirm the CLI is actually
  // authenticated (not just installed). Costs a few tokens per CLI.
  function runAuthCheck(cli, config, timeoutMs) {
    const template = config.cli_templates[cli];
    if (!template) {
      return { ok: false, message: `No spawn template for '${cli}' to drive an auth check. Add cli_templates.${cli} in orchestrator.config.js.` };
    }
    const promptFile = path.join(os.tmpdir(), `preflight-${cli}-${Date.now()}.txt`);
    const promptText = "Reply with the single word: OK";
    fs.writeFileSync(promptFile, promptText, "utf-8");
    try {
      const { mode, result } = spawnCliTemplateSync(cli, template, {
        promptFile,
        promptText,
        encoding: "utf-8",
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return formatSpawnResult(result, timeoutMs, mode);
      // Don't require "OK" in output — some CLIs print extra chatter. Non-zero exit / timeout are the real signals.
    } finally {
      try { fs.unlinkSync(promptFile); } catch {}
    }
  }

  function runShell(cmd, timeoutMs) {
    const result = spawnSync(cmd, { shell: true, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return formatResult(result, timeoutMs);
  }

  function formatSpawnResult(result, timeoutMs, mode) {
    const formatted = formatResult(result, timeoutMs);
    return formatted.ok
      ? { ok: true, message: `${formatted.message} (${mode})` }
      : formatted;
  }

  function formatResult(result, timeoutMs) {
    if (result.error) {
      const code = result.error.code;
      if (code === "ETIMEDOUT") {
        return { ok: false, message: `Timed out after ${timeoutMs}ms — likely hanging on an interactive prompt (auth / model selection?).` };
      }
      if (code === "ENOENT") {
        return { ok: false, message: `Binary not found on $PATH.` };
      }
      return { ok: false, message: result.error.message };
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      const tail = stderr ? ` — ${stderr.split("\n").slice(-1)[0].slice(0, 200)}` : "";
      return { ok: false, message: `Exit ${result.status}${tail}` };
    }
    const stdout = (result.stdout || "").trim();
    const summary = stdout ? stdout.split("\n")[0].slice(0, 80) : "(silent OK)";
    return { ok: true, message: summary };
  }

  function printResult(cli, phase, result) {
    const mark = result.ok ? "✓" : "✗";
    console.log(`  ${mark} ${cli} (${phase}): ${result.message}`);
  }

  function uniqueClis(values) {
    return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim() !== "")));
  }
}
