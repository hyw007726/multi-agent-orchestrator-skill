const fs = require("fs");
const { spawn, spawnSync } = require("child_process");

function validateCliTemplate(cli, template) {
  if (typeof template === "string") {
    if (template.trim() === "") {
      return { ok: false, message: `cli_templates.${cli} shell template must not be empty.` };
    }
    if (!template.includes("{prompt_file}")) {
      return { ok: false, message: `cli_templates.${cli} shell template must include {prompt_file}.` };
    }
    return { ok: true, mode: "shell" };
  }

  if (!isPlainObject(template)) {
    return { ok: false, message: `cli_templates.${cli} must be a shell string or { cmd, args } object.` };
  }

  if (typeof template.cmd !== "string" || template.cmd.trim() === "") {
    return { ok: false, message: `cli_templates.${cli}.cmd must be a non-empty string.` };
  }
  if (template.cmd.includes("\0")) {
    return { ok: false, message: `cli_templates.${cli}.cmd must not contain NUL bytes.` };
  }
  if (!Array.isArray(template.args)) {
    return { ok: false, message: `cli_templates.${cli}.args must be an array.` };
  }

  let hasPrompt = false;
  for (let i = 0; i < template.args.length; i++) {
    const arg = template.args[i];
    if (typeof arg === "string") {
      if (arg.includes("\0")) {
        return { ok: false, message: `cli_templates.${cli}.args[${i}] must not contain NUL bytes.` };
      }
      if (arg.includes("{prompt_file}")) {
        return {
          ok: false,
          message: `cli_templates.${cli}.args[${i}] must use { prompt_file: true } instead of string interpolation.`,
        };
      }
      continue;
    }

    if (!isPlainObject(arg)) {
      return {
        ok: false,
        message: `cli_templates.${cli}.args[${i}] must be a string, { prompt_file: true }, or { prompt_text: true }.`,
      };
    }
    if (arg.prompt_file === true && Object.keys(arg).length === 1) {
      hasPrompt = true;
      continue;
    }
    if (arg.prompt_text === true && Object.keys(arg).length === 1) {
      hasPrompt = true;
      continue;
    }
    return {
      ok: false,
      message: `cli_templates.${cli}.args[${i}] has an unsupported placeholder object.`,
    };
  }

  if (!hasPrompt) {
    return {
      ok: false,
      message: `cli_templates.${cli}.args must include { prompt_file: true } or { prompt_text: true }.`,
    };
  }

  return { ok: true, mode: "argv" };
}

function buildCliTemplateInvocation(cli, template, options) {
  const validation = validateCliTemplate(cli, template);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const promptFile = options.promptFile;
  const promptText = options.promptText !== undefined
    ? options.promptText
    : fs.readFileSync(promptFile, "utf-8");
  const extraArgs = options.extraArgs || [];

  if (validation.mode === "shell") {
    let command = template.replace(/\{prompt_file\}/g, shellQuote(promptFile));
    if (extraArgs.length > 0) {
      command += " " + extraArgs.map(shellQuote).join(" ");
    }
    return { mode: "shell", command };
  }

  const args = template.args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg.prompt_file === true) return promptFile;
    if (arg.prompt_text === true) return promptText;
    throw new Error(`Unsupported placeholder in cli_templates.${cli}.args.`);
  });
  if (extraArgs.length > 0) args.push(...extraArgs);
  return { mode: "argv", cmd: template.cmd, args };
}

function spawnCliTemplate(cli, template, options) {
  const invocation = buildCliTemplateInvocation(cli, template, options);
  if (invocation.mode === "shell") {
    const child = spawn(invocation.command, {
      cwd: options.cwd,
      detached: options.detached,
      stdio: options.stdio,
      shell: true,
    });
    child.templateMode = "shell";
    return child;
  }

  const child = spawn(invocation.cmd, invocation.args, {
    cwd: options.cwd,
    detached: options.detached,
    stdio: options.stdio,
    shell: false,
  });
  child.templateMode = "argv";
  return child;
}

function spawnCliTemplateSync(cli, template, options) {
  const invocation = buildCliTemplateInvocation(cli, template, options);
  if (invocation.mode === "shell") {
    return {
      mode: "shell",
      result: spawnSync(invocation.command, {
        cwd: options.cwd,
        encoding: options.encoding,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        stdio: options.stdio,
        shell: true,
      }),
    };
  }

  return {
    mode: "argv",
    result: spawnSync(invocation.cmd, invocation.args, {
      cwd: options.cwd,
      encoding: options.encoding,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      stdio: options.stdio,
      shell: false,
    }),
  };
}

function cliTemplateMode(template) {
  return typeof template === "string" ? "shell" : "argv";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  buildCliTemplateInvocation,
  cliTemplateMode,
  shellQuote,
  spawnCliTemplate,
  spawnCliTemplateSync,
  validateCliTemplate,
};
