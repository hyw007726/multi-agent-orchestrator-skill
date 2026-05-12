"use strict";

const SECOND_TIER_RECOMMENDATIONS = {
  anthropic: {
    family: "anthropic",
    label: "Anthropic/Claude",
    model: "claude-sonnet-4-6",
    reason: "Sonnet is the balanced coding-capable worker tier below Opus.",
  },
  openai: {
    family: "openai",
    label: "OpenAI/Codex",
    model: "gpt-5.1-codex-mini",
    alternate: "gpt-5-mini",
    reason: "Codex mini is the cost-efficient coding worker tier; use GPT-5 mini when the CLI exposes general OpenAI models instead of Codex-specific models.",
  },
  google: {
    family: "google",
    label: "Google/Gemini",
    model: "gemini-2.5-flash",
    reason: "Flash is the price-performance worker tier for agentic and high-volume coding-adjacent tasks.",
  },
};

function recommendationForProvider(family) {
  return SECOND_TIER_RECOMMENDATIONS[family] || null;
}

function recommendationForCli(cli, template, options = {}) {
  const family = inferProviderFamily({ cli, template, model: options.model });
  return recommendationForProvider(family);
}

function inferProviderFamily({ cli = "", template, model = "" } = {}) {
  const text = [model, cli, ...templateTextParts(template)]
    .filter((part) => typeof part === "string" && part.trim() !== "")
    .join(" ")
    .toLowerCase();

  if (!text) return null;
  if (/\b(anthropic|claude)\b/.test(text) || /claude[-_]/.test(text)) return "anthropic";
  if (/\b(gemini|google)\b/.test(text) || /gemini[-_]/.test(text)) return "google";
  if (/\b(openai|codex)\b/.test(text) || /\bgpt[-_]/.test(text) || /\bo[1-9](?:[-_]|$)/.test(text)) return "openai";
  return null;
}

function formatNoConfigModelPrompt(config) {
  const defaultCli = normalize(config?.default_cli) || "kilo";
  const template = config?.cli_templates ? config.cli_templates[defaultCli] : undefined;
  const recommendation = recommendationForCli(defaultCli, template);
  const lines = [
    "Worker model selection prompt:",
    "  No shared or local orchestrator config was found; built-in defaults will be used.",
    "  Workers run autonomously, so persist any worker CLI/model choice before launch:",
    "    - personal machine choice: orchestrator.config.local.jsonc",
    "    - shared project/team policy: orchestrator.config.jsonc",
  ];

  if (recommendation) {
    lines.push(`  Detected worker family: ${recommendation.label}`);
    lines.push(`  Recommended worker model: ${recommendation.model}${recommendation.alternate ? ` (alternate: ${recommendation.alternate})` : ""}`);
    lines.push(`  ${formatConfigTarget(defaultCli, template, recommendation)}`);
  } else {
    lines.push("  Provider family could not be inferred from the default worker CLI.");
    lines.push("  Recommended second-tier worker models:");
    for (const rec of Object.values(SECOND_TIER_RECOMMENDATIONS)) {
      lines.push(`    - ${rec.label}: ${rec.model}${rec.alternate ? ` (alternate: ${rec.alternate})` : ""}`);
    }
  }

  return lines.join("\n");
}

function formatPreflightFailureGuidance(failures, config) {
  const failedClis = unique((failures || []).map((failure) => failure.cli));
  if (failedClis.length === 0) return "";

  const lines = [
    "Model fallback guidance:",
    "  The runtime did not change any model or config automatically.",
  ];

  for (const cli of failedClis) {
    const template = config?.cli_templates ? config.cli_templates[cli] : undefined;
    const recommendation = recommendationForCli(cli, template);
    const failurePhases = unique(failures.filter((failure) => failure.cli === cli).map((failure) => failure.phase)).join(", ");

    if (recommendation) {
      lines.push(`  - ${cli} (${failurePhases}): recommended same-provider worker model is ${recommendation.model}${recommendation.alternate ? ` (alternate: ${recommendation.alternate})` : ""}.`);
      lines.push(`    ${recommendation.reason}`);
      lines.push(`    ${formatConfigTarget(cli, template, recommendation)}`);
    } else {
      lines.push(`  - ${cli} (${failurePhases}): provider family could not be inferred.`);
      lines.push("    Pick a configured, non-interactive, cost-efficient coding model for this CLI.");
      lines.push(`    ${formatConfigTarget(cli, template, null)}`);
    }

    lines.push("    Persist the accepted choice in orchestrator.config.local.jsonc for personal setup, or orchestrator.config.jsonc for shared policy, then rerun preflight.");
  }

  return lines.join("\n");
}

function formatConfigTarget(cli, template, recommendation) {
  if (template === undefined) {
    return `Add cli_templates.${cli} and cli_health_checks.${cli}; pin the model there only if the CLI accepts a model flag.`;
  }

  const model = recommendation?.model || "<worker-model>";
  return `Pin ${model} by adding or replacing the CLI model flag in cli_templates.${cli} when this CLI supports one; otherwise select the model in the CLI's own settings. Do not add a generic default_model key.`;
}

function templateTextParts(template) {
  if (typeof template === "string") return [template];
  if (!template || typeof template !== "object") return [];
  const parts = [];
  if (typeof template.cmd === "string") parts.push(template.cmd);
  if (Array.isArray(template.args)) {
    for (const arg of template.args) {
      if (typeof arg === "string") parts.push(arg);
    }
  }
  return parts;
}

function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim() !== "")));
}

module.exports = {
  SECOND_TIER_RECOMMENDATIONS,
  formatConfigTarget,
  formatNoConfigModelPrompt,
  formatPreflightFailureGuidance,
  inferProviderFamily,
  recommendationForCli,
  recommendationForProvider,
};
