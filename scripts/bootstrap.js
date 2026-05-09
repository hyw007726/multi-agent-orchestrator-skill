#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

runBootstrap();

function runBootstrap() {
  const config = parseArgs();
  const { coordDir, project, requirements, constraints, chatContext } = config;

  if (fs.existsSync(coordDir)) {
    console.log(`Directory ${coordDir} already exists. Skipping creation.`);
  } else {
    fs.mkdirSync(coordDir, { recursive: true });
  }

  // Schema (see references/schemas.md):
  //   chat_context: compact structured object — { preferences, architecture, naming_conventions, gotchas, ... }
  //   execution_topology: durable topology choice — { execution_mode, reason, dependency_notes }
  //   requirements/constraints: compact summaries only; durable detail belongs in DECISIONS.md.
  //   tasks:        Record<agent-name, { description, read_first?, timeout_mins?, progress_timeout_mins? }>
  // The caller session is expected to populate these between Phase 2 and Phase 4.
  // A legacy `--chat-context "<string>"` is wrapped under a `summary` key so flat-string callers remain valid.
  const chat_context = chatContext.trim() === "" ? {} : { summary: chatContext };

  const context = {
    project,
    chat_context,
    execution_topology: {
      execution_mode: "",
      reason: "",
      dependency_notes: [],
    },
    requirements,
    constraints,
    created_at: new Date().toISOString(),
    tasks: {},
  };
  fs.writeFileSync(path.join(coordDir, "context.json"), JSON.stringify(context, null, 2) + "\n");

  const example = {
    project: "Example: Build a CLI task runner",
    chat_context: {
      preferences: ["Use explicit typing", "Prefer composition over inheritance"],
      architecture: ["Worker-agent pattern with central orchestrator loop", "File-system-based IPC via coord/ directory"],
      naming_conventions: ["camelCase for variables", "kebab-case for agent names"],
      gotchas: ["Node 18 minimum, no top-level await", "Worktree symlinks resolve coord/ to project root"],
    },
    execution_topology: {
      execution_mode: "single_worker",
      reason: "The work is substantial enough for delegated background execution but fits one sequential implementation boundary.",
      dependency_notes: [
        "Commit shared foundation files before launching the worker.",
        "Use parallel or phased only after splitting independent non-overlapping leaves.",
      ],
    },
    requirements: ["Add a new subcommand that accepts --format and --output flags"],
    constraints: ["Must use Node.js built-ins only", "No new npm dependencies", "All paths relative to project root"],
    created_at: new Date().toISOString(),
    tasks: {
      "agent-task-runner": {
        description: "Implement the 'task-runner' subcommand that reads a YAML config, spawns child processes for each job, and writes results to --output",
        cli: "kilo",
        mode: "code",
        read_first: ["src/commands/index.js", "src/lib/process-helpers.js", "tests/commands/"],
        allowed_paths: ["src/commands/task-runner/**", "tests/commands/task-runner/**", "src/lib/process-helpers.js"],
        forbidden_paths: ["package.json", "orchestrator.config.js", "coord/", "README.md"],
        validation_command: ["node", "--test", "tests/commands/task-runner/"],
        timeout_mins: 30,
        progress_timeout_mins: 10,
      },
    },
  };
  fs.writeFileSync(path.join(coordDir, "context.example.json"), JSON.stringify(example, null, 2) + "\n");

  fs.writeFileSync(path.join(coordDir, "decisions.json"), "[]\n");
  fs.writeFileSync(path.join(coordDir, "decisions.jsonl"), "");

  const decisionsMd = buildDecisionsMd(project, requirements, constraints);
  fs.writeFileSync(path.join(coordDir, "DECISIONS.md"), decisionsMd);
  fs.writeFileSync(path.join(coordDir, "CALLER_CONTEXT.md"), buildCallerContextMd({
    project,
    requirements,
    constraints,
    chatContext,
  }));
  fs.writeFileSync(path.join(coordDir, "requests.jsonl"), "");
  fs.mkdirSync(path.join(coordDir, "requests"), { recursive: true });
  fs.mkdirSync(path.join(coordDir, "progress"), { recursive: true });
  fs.writeFileSync(path.join(coordDir, "agents.json"), "{}\n");

  const gitignorePath = path.join(process.cwd(), ".gitignore");
  // `coord` (no trailing slash) matches both the directory at the project root and the
  // per-worktree symlink that spawn-agent.js creates inside each worktree. With a trailing
  // slash the symlink would be considered an untracked file and `git worktree remove`
  // would refuse to clean up the worktree without --force.
  const ignoreEntries = [
    ".kilocode/worktrees/",
    ".agents/worktrees/",
    "coord",
  ];
  let gitignoreContent = "";
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
  }
  const newIgnores = ignoreEntries.filter(entry => !gitignoreContent.includes(entry));
  if (newIgnores.length > 0) {
    const prefix = gitignoreContent.length === 0 || gitignoreContent.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(gitignorePath, prefix + newIgnores.join("\n") + "\n");
    console.log(`Added ${newIgnores.length} entries to .gitignore`);
  }

  console.log(`Successfully bootstrapped multi-agent coordination in ${coordDir}`);

  function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
      coordDir: "./coord",
      project: "",
      requirements: [],
      constraints: [],
      chatContext: "",
    };

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--coord":        config.coordDir    = args[++i]; break;
        case "--project":      config.project     = args[++i]; break;
        case "--requirements": config.requirements = args[++i].split(",").map((s) => s.trim()); break;
        case "--constraints":  config.constraints  = args[++i].split(",").map((s) => s.trim()); break;
        case "--chat-context": config.chatContext  = args[++i]; break;
        case "--help":
          console.log(`
Bootstrap Multi-Agent Orchestrator coordination

Options:
  --coord <dir>              Path to coordination directory (default: ./coord)
  --project <description>    Project description (required)
  --requirements <list>      Comma-separated compact requirements; also written to DECISIONS.md
  --constraints <list>       Comma-separated compact constraints; also written to DECISIONS.md
  --chat-context <string>    Compacted summary of original conversation context; written to CALLER_CONTEXT.md
  --help                     Show this help message

Example:
  node bootstrap.js --project "Build a chat app" --requirements "Websockets, React" --chat-context "User prefers dark mode"
`);
          process.exit(0);
      }
    }

    if (!config.project) {
      console.error("Error: --project is required.");
      process.exit(1);
    }

    return config;
  }
}

function buildCallerContextMd({ project, requirements, constraints, chatContext }) {
  const chatSummary = String(chatContext || "").trim();
  return [
    "# Caller Context",
    "",
    "This file preserves compressed caller-session context for the headless orchestration loop. It is for user intent, chat nuance, environment assumptions, and non-durable rationale that should not bloat coord/context.json. Durable requirements, shared contracts, and ownership rules belong in coord/DECISIONS.md.",
    "",
    "## User Intent",
    project ? `- ${project}` : "- Fill in the user's intent before launch.",
    "",
    "## Important Chat Nuance",
    chatSummary ? `- ${chatSummary}` : "- Fill in user preferences, caveats, and chat nuance that the background loop cannot infer from files.",
    "",
    "## Environment Assumptions",
    "- Fill in local runtime assumptions, external services, credentials, platform constraints, and anything workers should not rediscover expensively.",
    "",
    "## Non-Durable Rationale",
    "- Fill in temporary planning rationale, tradeoffs, and context that informed this run but should not become durable project policy.",
    "",
    "## Compact Inputs",
    "### Requirements",
    formatMarkdownList(requirements, "No bootstrap requirements were provided."),
    "",
    "### Constraints",
    formatMarkdownList(constraints, "No bootstrap constraints were provided."),
    "",
  ].join("\n");
}

function buildDecisionsMd(project, requirements, constraints) {
  return [
    "# Architectural Decisions",
    "",
    "This file is the curated human-readable contract for durable requirements, shared API contracts, data models, file ownership, and structural decisions. The orchestrator session curates this file; the background loop includes it in arbitration prompts but does not automatically rewrite it. Worker agents MUST read this file before they begin coding.",
    "",
    "## Project",
    project ? `- ${project}` : "- Fill this in during decomposition.",
    "",
    "## Durable Requirements",
    formatMarkdownList(requirements, "Move durable product and technical requirements here instead of expanding coord/context.json."),
    "",
    "## Constraints",
    formatMarkdownList(constraints, "Move durable constraints here instead of expanding coord/context.json."),
    "",
    "## Shared Contracts",
    "- Record API shapes, data models, invariants, and cross-agent integration points here.",
    "",
    "## File Ownership",
    "- Record which agent owns each path or module before launch.",
    "",
  ].join("\n");
}

function formatMarkdownList(items, fallback) {
  const cleaned = (items || []).map((item) => String(item).trim()).filter(Boolean);
  if (cleaned.length === 0) return `- ${fallback}`;
  return cleaned.map((item) => `- ${item}`).join("\n");
}
