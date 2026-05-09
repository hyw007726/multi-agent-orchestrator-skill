const WORKER_CONCISION_PROMPT = [
  'Be concise. Do not explain your reasoning unless explicitly asked.',
  'Respond with code only — no preamble, no explanation, no closing summary.',
  'Skip pleasantries, caveats, and self-referential statements.',
  'Answer in the fewest tokens possible without omitting correctness',
].join('\n');

function renderWorkerPrompt(template, vars) {
  let result = template;
  const placeholders = [
    'ASSIGNED_TASK',
    'PROJECT_DESCRIPTION',
    'AGENT_NAME',
    'WORKTREE_PATH',
    'ALLOWED_PATHS_LIST',
    'FORBIDDEN_PATHS_LIST',
    'READ_FIRST_LIST',
    'WORKER_CONCISION_PROMPT',
  ];
  for (const key of placeholders) {
    let value = key === 'WORKER_CONCISION_PROMPT' ? WORKER_CONCISION_PROMPT : vars[key];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      value = '(unspecified)';
    } else if (Array.isArray(value)) {
      value = value.join(', ');
    }
    result = result.replaceAll(`{${key}}`, String(value));
  }
  return result;
}

function renderWorkerRestartPrompt(instruction, contractPrompt = '') {
  const restartBlock = `## Restart Instruction\n${instruction}`;
  if (contractPrompt && contractPrompt.trim()) {
    return `${contractPrompt.trim()}\n\n${restartBlock}`;
  }
  return `## Response Style\n${WORKER_CONCISION_PROMPT}\n\n${restartBlock}`;
}

module.exports = { WORKER_CONCISION_PROMPT, renderWorkerPrompt, renderWorkerRestartPrompt };
