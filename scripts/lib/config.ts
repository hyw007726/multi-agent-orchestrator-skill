import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

export interface OrchestratorConfig {
  default_cli: string;
  orchestrator_cli: string;
  cli_templates: Record<string, string>;
  default_timeout_mins: number;
  default_progress_timeout_mins: number;
  default_max_iterations: number;
  default_max_restarts: number;
  claude_failure_threshold: number;
}

const DEFAULTS: OrchestratorConfig = {
  default_cli: "kilo",
  orchestrator_cli: "claude",
  cli_templates: {},
  default_timeout_mins: 10,
  default_progress_timeout_mins: 15,
  default_max_iterations: 5,
  default_max_restarts: 3,
  claude_failure_threshold: 5,
};

export function loadConfig(cwd: string = process.cwd()): OrchestratorConfig {
  const configPath = path.join(cwd, "orchestrator.config.yml");
  if (!fs.existsSync(configPath)) return { ...DEFAULTS };

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = (yaml.load(raw) ?? {}) as Record<string, unknown>;

  const merged: OrchestratorConfig = { ...DEFAULTS };

  if (typeof parsed.default_cli === "string") merged.default_cli = parsed.default_cli;
  if (typeof parsed.orchestrator_cli === "string") merged.orchestrator_cli = parsed.orchestrator_cli;
  if (parsed.cli_templates && typeof parsed.cli_templates === "object") {
    merged.cli_templates = parsed.cli_templates as Record<string, string>;
  }
  if (typeof parsed.default_timeout_mins === "number") merged.default_timeout_mins = parsed.default_timeout_mins;
  if (typeof parsed.default_progress_timeout_mins === "number") merged.default_progress_timeout_mins = parsed.default_progress_timeout_mins;
  if (typeof parsed.default_max_iterations === "number") merged.default_max_iterations = parsed.default_max_iterations;
  if (typeof parsed.default_max_restarts === "number") merged.default_max_restarts = parsed.default_max_restarts;
  if (typeof parsed.claude_failure_threshold === "number") merged.claude_failure_threshold = parsed.claude_failure_threshold;

  return merged;
}
