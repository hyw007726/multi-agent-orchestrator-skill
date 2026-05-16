const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf-8", ...options });
  if (result.error) {
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")}\n${result.error.message}`
    );
  }
  if (result.status !== 0) {
    const msg = [
      `Command failed with exit code ${result.status}: ${cmd} ${args.join(" ")}`,
      `stdout: ${result.stdout || "(empty)"}`,
      `stderr: ${result.stderr || "(empty)"}`,
    ].join("\n");
    throw new Error(msg);
  }
  return result;
}

function start(cmd, args, options = {}) {
  const stdio = options.stdio || ["ignore", "pipe", "pipe"];
  const child = spawn(cmd, args, { ...options, stdio });
  return child;
}

function waitFor(predicate, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    function check() {
      try {
        const result = predicate();
        if (result) return resolve(result);
      } catch (_) {
        // predicate threw, retry
      }
      if (Date.now() - startTime >= timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }
      setTimeout(check, intervalMs);
    }
    check();
  });
}

function createTempProject(prefix, options = {}) {
  const tmpDir = options.tmpDir || os.tmpdir();
  const root = fs.mkdtempSync(
    path.join(tmpDir, `${prefix || "test"}-`)
  );

  run("git", ["init"], { cwd: root });
  run("git", ["config", "user.email", "test@test.test"], { cwd: root });
  run("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "# Test Project\n");
  run("git", ["add", "README.md"], { cwd: root });
  run("git", ["commit", "-m", "Initial commit"], { cwd: root });

  function cleanup() {
    cleanupProcessesForRoot(root);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) {
      // best-effort cleanup
    }
  }

  return { root, cleanup };
}

function writeProjectConfig(projectRoot, fakeCliPath) {
  const configPath = path.join(projectRoot, "orchestrator.config.js");
  const content =
    [
      "module.exports = {",
      '  default_cli: "fake",',
      '  orchestrator_cli: "fake",',
      "  cli_templates: {",
      `    fake: { cmd: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fakeCliPath)}, { prompt_file: true }] },`,
      "  },",
      "  cli_health_checks: {",
      '    fake: "node -e \\"process.exit(0)\\"",',
      "  },",
      "  poll_min_ms: 250,",
      "  poll_max_ms: 500,",
      "  launch_dashboard: false,",
      "  launch_review_terminal: false,",
      "};",
    ].join("\n") + "\n";
  fs.writeFileSync(configPath, content);
}

function bootstrapProject(projectRoot, projectDescription) {
  const r = repoRoot();
  run(
    "node",
    [
      path.join(r, "scripts", "bootstrap.js"),
      "--project",
      projectDescription,
      "--coord",
      "./coord",
    ],
    { cwd: projectRoot }
  );
}

function addKiloWorktree(projectRoot, agentName) {
  // The test worker uses the fake CLI, so spawn-agent.js expects the non-kilo
  // worktree base even though this helper mirrors the real workflow shape.
  const worktreesDir = path.join(projectRoot, ".agents", "worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });
  const relativeWorktree = path.join(".agents", "worktrees", agentName);
  run("git", ["worktree", "add", relativeWorktree, "-b", agentName], {
    cwd: projectRoot,
  });
}

function spawnWorker(projectRoot, agentName, promptFile, validateArg) {
  const r = repoRoot();
  const args = [
    path.join(r, "scripts", "spawn-agent.js"),
    "--agent",
    agentName,
    "--prompt-file",
    promptFile,
    "--coord",
    "./coord",
    "--cli",
    "fake",
  ];
  if (validateArg !== undefined && validateArg !== null && validateArg !== "") {
    args.push("--validate", validateArg);
  }
  run("node", args, { cwd: projectRoot });
}

function runLoop(projectRoot) {
  const r = repoRoot();
  const result = spawnSync(
    "node",
    [
      path.join(r, "scripts", "orchestrator-loop.js"),
      "--coord",
      "./coord",
      "--poll-interval",
      "250",
    ],
    {
      encoding: "utf-8",
      cwd: projectRoot,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    }
  );
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status != null ? result.status : null,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function cleanupProcess(child) {
  if (!child) return;
  try {
    if (typeof child === "number") {
      process.kill(child, "SIGTERM");
    } else if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  } catch (_) {
    // never throws
  }
}

function cleanupProcessesForRoot(root) {
  if (process.platform === "win32") return;
  const result = spawnSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout) return;
  for (const line of result.stdout.split("\n")) {
    if (!line.includes(root)) continue;
    const match = line.trim().match(/^(\d+)\s+/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    cleanupProcess(pid);
  }
}

module.exports = {
  repoRoot,
  run,
  start,
  waitFor,
  createTempProject,
  writeProjectConfig,
  bootstrapProject,
  addKiloWorktree,
  spawnWorker,
  runLoop,
  readJson,
  readJsonl,
  cleanupProcess,
};
