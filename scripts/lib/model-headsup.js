"use strict";

const {
  formatConfigTarget,
  recommendationForCli,
} = require("./model-recommendations");

const MODEL_FLAGS = new Set(["--model", "--llm", "--model-id", "--model_id", "-m"]);

function summarizeCliModel(cli, template) {
  const pinned = extractModelFromTemplate(template);
  const recommendation = recommendationForCli(cli, template, { model: pinned?.model });
  if (pinned) {
    return {
      cli,
      known: true,
      model: pinned.model,
      recommendation,
      source: `cli_templates.${cli} ${pinned.flag}`,
      message: `model ${pinned.model} (from cli_templates.${cli} ${pinned.flag})`,
    };
  }

  if (template === undefined) {
    return {
      cli,
      known: false,
      model: null,
      recommendation,
      source: "missing cli template",
      message: `no cli_templates.${cli} configured; runtime cannot invoke this CLI until a template is added`,
    };
  }

  if (cli === "claude") {
    return {
      cli,
      known: false,
      model: null,
      recommendation,
      source: "Claude CLI default/current session",
      message: "model is not pinned; Claude CLI may use its current/default model",
      warning: `Add --model ${recommendation?.model || "<id>"} to cli_templates.${cli} for predictable worker cost.`,
    };
  }

  return {
    cli,
    known: false,
    model: null,
    recommendation,
    source: `${cli} CLI config/default`,
    message: `model selected by ${cli}'s CLI config/default; exact model not visible unless pinned in cli_templates.${cli}`,
  };
}

function formatModelHeadsUp(config, options = {}) {
  const workerClis = unique(options.workerClis || [config.default_cli]);
  const orchestratorCli = options.orchestratorCli || config.orchestrator_cli;
  const reviewers = Array.isArray(options.reviewers)
    ? options.reviewers
    : (Array.isArray(config.reviewers) ? config.reviewers : []);
  const reviewerClis = unique(reviewers.map((reviewer) => reviewer.cli));
  const checkedClis = unique(options.checkedClis || []);

  const lines = ["Model heads-up:"];

  lines.push("  Worker CLI(s):");
  for (const cli of workerClis) {
    lines.push(...formatCliLines(cli, config));
  }

  if (orchestratorCli && workerClis.includes(orchestratorCli)) {
    lines.push(`  Orchestrator CLI: same as worker CLI (${orchestratorCli})`);
  } else if (orchestratorCli) {
    lines.push("  Orchestrator CLI:");
    lines.push(...formatCliLines(orchestratorCli, config));
  }

  if (reviewers.length > 0) {
    lines.push("  Plan reviewer CLI(s):");
    for (const reviewer of reviewers) {
      lines.push(...formatReviewerLines(reviewer, config));
    }
  }

  const extraClis = checkedClis.filter((cli) => (
    !workerClis.includes(cli) &&
    cli !== orchestratorCli &&
    !reviewerClis.includes(cli)
  ));
  if (extraClis.length > 0) {
    lines.push("  Additional checked CLI(s):");
    for (const cli of extraClis) {
      lines.push(...formatCliLines(cli, config));
    }
  }

  return lines.join("\n");
}

function formatCliLines(cli, config) {
  const templates = config.cli_templates || {};
  const template = templates[cli];
  const summary = summarizeCliModel(cli, template);
  const lines = [`    - ${cli}: ${summary.message}`];
  if (summary.warning) lines.push(`      Warning: ${summary.warning}`);
  if (!summary.known && summary.recommendation) {
    const recommendation = summary.recommendation;
    lines.push(`      Recommended worker tier: ${recommendation.model}${recommendation.alternate ? ` (alternate: ${recommendation.alternate})` : ""} - ${recommendation.reason}`);
    lines.push(`      Config: ${formatConfigTarget(cli, template, recommendation)}`);
  }
  return lines;
}

function formatReviewerLines(reviewer, config) {
  const templates = config.cli_templates || {};
  const template = templates[reviewer.cli];
  const summary = summarizeCliModel(reviewer.cli, template);
  const details = [];
  if (reviewer.model) {
    details.push(`reviewer override ${reviewer.model} via ${reviewer.model_flag || "--model"}`);
  }
  if (Array.isArray(reviewer.template_args) && reviewer.template_args.length > 0) {
    details.push(`template args ${reviewer.template_args.join(" ")}`);
  }
  const suffix = details.length > 0 ? `; ${details.join("; ")}` : "";
  const focus = reviewer.review_focus ? ` - ${reviewer.review_focus}` : "";
  const lines = [`    - ${reviewer.name} (${reviewer.cli}): ${summary.message}${suffix}${focus}`];
  if (summary.warning) lines.push(`      Warning: ${summary.warning}`);
  if (!summary.known && summary.recommendation) {
    const recommendation = summary.recommendation;
    lines.push(`      Recommended worker tier: ${recommendation.model}${recommendation.alternate ? ` (alternate: ${recommendation.alternate})` : ""} - ${recommendation.reason}`);
    lines.push(`      Config: ${formatConfigTarget(reviewer.cli, template, recommendation)}`);
  }
  return lines;
}

function extractModelFromTemplate(template) {
  if (typeof template === "string") return extractModelFromShellTemplate(template);
  if (template && Array.isArray(template.args)) return extractModelFromArgs(template.args);
  return null;
}

function extractModelFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") continue;

    const equalsMatch = arg.match(/^(--model|--llm|--model-id|--model_id)=(.+)$/);
    if (equalsMatch) {
      return { flag: equalsMatch[1], model: stripQuotes(equalsMatch[2]) };
    }

    if (MODEL_FLAGS.has(arg)) {
      const next = args[i + 1];
      if (typeof next === "string" && next.trim() !== "") {
        return { flag: arg, model: stripQuotes(next) };
      }
    }
  }

  return null;
}

function extractModelFromShellTemplate(template) {
  const re = /(?:^|\s)(--model|--llm|--model-id|--model_id|-m)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
  const match = re.exec(template);
  if (!match) return null;
  return {
    flag: match[1],
    model: stripQuotes(match[2] || match[3] || match[4]),
  };
}

function stripQuotes(value) {
  return String(value).replace(/^["']|["']$/g, "");
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim() !== "")));
}

module.exports = {
  extractModelFromTemplate,
  formatModelHeadsUp,
  summarizeCliModel,
};
