const fs = require("fs");
const path = require("path");
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

  let promptSources = 0;
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

    const placeholderValidation = validatePromptPlaceholder(arg, `cli_templates.${cli}.args[${i}]`);
    if (!placeholderValidation.ok) {
      return {
        ok: false,
        message: placeholderValidation.message,
      };
    }
    promptSources++;
  }

  if (hasOwn(template, "stdin")) {
    const placeholderValidation = validatePromptPlaceholder(template.stdin, `cli_templates.${cli}.stdin`);
    if (!placeholderValidation.ok) {
      return {
        ok: false,
        message: placeholderValidation.message,
      };
    }
    promptSources++;
  }

  if (promptSources === 0) {
    return {
      ok: false,
      message: `cli_templates.${cli} must include one prompt source: { prompt_file: true } or { prompt_text: true } in args, or stdin: { prompt_file: true }.`,
    };
  }
  if (promptSources > 1) {
    return {
      ok: false,
      message: `cli_templates.${cli} must include exactly one prompt source across args and stdin.`,
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
  const getPromptText = () => options.promptText !== undefined
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
    if (arg.prompt_text === true) return getPromptText();
    throw new Error(`Unsupported placeholder in cli_templates.${cli}.args.`);
  });
  if (extraArgs.length > 0) args.push(...extraArgs);
  const stdin = template.stdin ? resolvePromptPlaceholder(template.stdin, promptFile, getPromptText) : null;
  return { mode: "argv", cmd: template.cmd, args, stdin };
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
    stdio: stdioWithPromptStdin(options.stdio, invocation.stdin),
    shell: false,
  });
  writePromptStdin(child, invocation.stdin);
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

  const spawnOptions = {
    cwd: options.cwd,
    encoding: options.encoding,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    stdio: stdioWithPromptStdin(options.stdio, invocation.stdin),
    shell: false,
  };
  if (invocation.stdin) {
    spawnOptions.input = promptStdinInput(invocation.stdin);
  }

  return {
    mode: "argv",
    result: spawnSync(invocation.cmd, invocation.args, spawnOptions),
  };
}

function cliTemplateMode(template) {
  return typeof template === "string" ? "shell" : "argv";
}

function cliTemplateProcessMatch(cli, template) {
  if (isPlainObject(template)) {
    const cmd = basenameTerm(template.cmd);
    const firstArg = Array.isArray(template.args) && typeof template.args[0] === "string"
      ? basenameTerm(template.args[0])
      : "";
    if (isNodeCommand(cmd) && firstArg) return firstArg;
    return cmd || cli;
  }
  if (typeof template === "string") {
    return firstShellCommandTerm(template) || cli;
  }
  return cli;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function validatePromptPlaceholder(value, label) {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      message: `${label} must be { prompt_file: true } or { prompt_text: true }.`,
    };
  }
  if (value.prompt_file === true && Object.keys(value).length === 1) {
    return { ok: true };
  }
  if (value.prompt_text === true && Object.keys(value).length === 1) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `${label} has an unsupported placeholder object.`,
  };
}

function resolvePromptPlaceholder(value, promptFile, getPromptText) {
  if (value.prompt_file === true) return { kind: "file", value: promptFile };
  if (value.prompt_text === true) return { kind: "text", value: getPromptText() };
  throw new Error("Unsupported prompt placeholder.");
}

function promptStdinInput(stdin) {
  if (!stdin) return undefined;
  if (stdin.kind === "file") return fs.readFileSync(stdin.value);
  return stdin.value;
}

function stdioWithPromptStdin(stdio, stdin) {
  if (!stdin) return stdio;
  if (Array.isArray(stdio)) {
    const next = stdio.slice();
    next[0] = "pipe";
    return next;
  }
  if (typeof stdio === "string") {
    return ["pipe", stdio, stdio];
  }
  return ["pipe", "pipe", "pipe"];
}

function writePromptStdin(child, stdin) {
  if (!stdin) return;
  if (!child.stdin) return;
  child.stdin.on("error", () => {});
  if (stdin.kind === "file") {
    const stream = fs.createReadStream(stdin.value);
    stream.on("error", (err) => child.stdin.destroy(err));
    stream.pipe(child.stdin);
    return;
  }
  child.stdin.end(stdin.value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function basenameTerm(value) {
  const base = path.basename(String(value || "").trim());
  return base.replace(/\.(cmd|exe)$/i, "");
}

function isNodeCommand(value) {
  return /^(node|nodejs)$/.test(String(value || "").toLowerCase());
}

function firstShellCommandTerm(template) {
  const match = String(template || "").trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return basenameTerm(match?.[1] || match?.[2] || match?.[3] || "");
}

module.exports = {
  buildCliTemplateInvocation,
  cliTemplateProcessMatch,
  cliTemplateMode,
  shellQuote,
  spawnCliTemplate,
  spawnCliTemplateSync,
  validateCliTemplate,
};
