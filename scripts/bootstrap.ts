#!/usr/bin/env ts-node

import * as fs from "fs";
import * as path from "path";

interface BootstrapArgs {
  coordDir: string;
  project: string;
  requirements: string[];
  constraints: string[];
  chatContext: string;
}

function parseArgs(): BootstrapArgs {
  const args = process.argv.slice(2);
  const config: BootstrapArgs = {
    coordDir: "./coord",
    project: "",
    requirements: [],
    constraints: [],
    chatContext: "",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--coord":
        config.coordDir = args[++i];
        break;
      case "--project":
        config.project = args[++i];
        break;
      case "--requirements":
        config.requirements = args[++i].split(",").map((s: string) => s.trim());
        break;
      case "--constraints":
        config.constraints = args[++i].split(",").map((s: string) => s.trim());
        break;
      case "--chat-context":
        config.chatContext = args[++i];
        break;
      case "--help":
        console.log(`
Bootstrap Multi-Agent Orchestrator coordination

Options:
  --coord <dir>              Path to coordination directory (default: ./coord)
  --project <description>    Project description (required)
  --requirements <list>      Comma-separated requirements
  --constraints <list>       Comma-separated constraints
  --chat-context <string>    Compacted summary of original conversation context
  --help                     Show this help message

Example:
  npx ts-node bootstrap.ts --project "Build a chat app" --requirements "Websockets, React" --chat-context "User prefers dark mode"
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

function bootstrap(config: BootstrapArgs): void {
  const { coordDir, project, requirements, constraints, chatContext } = config;

  if (fs.existsSync(coordDir)) {
    console.log(`Directory ${coordDir} already exists. Skipping creation.`);
  } else {
    fs.mkdirSync(coordDir, { recursive: true });
  }

  const context = {
    project,
    chat_context: chatContext,
    requirements,
    constraints,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(coordDir, "context.json"), JSON.stringify(context, null, 2) + "\n");

  fs.writeFileSync(path.join(coordDir, "decisions.json"), "[]\n");
  
  const decisionsMd = `# Architectural Decisions\n\nThis file acts as the ultimate source of truth for shared API contracts, data models, and structural decisions. Worker agents MUST read this file before they begin coding.\n`;
  fs.writeFileSync(path.join(coordDir, "DECISIONS.md"), decisionsMd);
  fs.writeFileSync(path.join(coordDir, "requests.jsonl"), "");
  fs.writeFileSync(path.join(coordDir, "agents.json"), "{}\n");

  const agentsMd = `# Multi-Agent Coordination

This project is being developed by multiple worker-CLI agents (Kilo Code, Aider, Claude Code, Codex, Gemini, OpenCode, etc.) working in parallel git worktrees.
All agents MUST read and follow these rules.

## Coordination Protocol
- Read \`coord/context.json\` and \`coord/decisions.json\` before starting work.
- Follow all existing decisions strictly. Do not re-decide settled matters.
- **NEVER invent API contracts or data schemas.** If you need to share data with another agent's domain, use the schemas defined in \`context.json\` or submit a request to agree on one.
- If blocked or missing info, DO NOT ASSUME. Write a request to \`coord/requests.jsonl\` and ask for review (see format below).
- Do NOT modify files outside your assigned scope.
- **When you finish your task, you MUST submit a \`review_request\` to \`coord/requests.jsonl\`. Do not just stop working without notifying the orchestrator.**

## Request Format
When you need a decision, review, or clarification, append a SINGLE LINE of JSON to \`coord/requests.jsonl\`. Do NOT format it across multiple lines:
\`\`\`json
{"request_id": "<unique-id>", "agent": "<your-agent-name>", "type": "question|change|conflict|review_request", "priority": "low|medium|high", "content": "Detailed explanation...", "status": "pending", "created_at": "<ISO-timestamp>"}
\`\`\`
If priority is \`high\`, STOP WORKING and wait for the orchestrator to update \`decisions.json\`.
`;

  const agentsMdPath = path.join(coordDir, "AGENTS.md");
  fs.writeFileSync(agentsMdPath, agentsMd);

  const gitignorePath = path.join(process.cwd(), ".gitignore");
  const ignoreEntries = [
    ".kilocode/worktrees/",
    ".agents/worktrees/",
    "coord/orchestrator-loop.out",
    "coord/orchestrator.log",
    "coord/logs/",
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
  console.log(`Global rules written to ${agentsMdPath}`);
}

bootstrap(parseArgs());
