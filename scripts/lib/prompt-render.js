function renderWorkerPrompt(template, vars) {
  let result = template;
  const placeholders = [
    'ASSIGNED_TASK',
    'PROJECT_DESCRIPTION',
    'AGENT_NAME',
    'WORKTREE_PATH',
    'ALLOWED_PATHS_LIST',
    'FORBIDDEN_PATHS_LIST',
  ];
  for (const key of placeholders) {
    let value = vars[key];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      value = '(unspecified)';
    } else if (Array.isArray(value)) {
      value = value.join(', ');
    }
    result = result.replaceAll(`{${key}}`, String(value));
  }
  return result;
}

module.exports = { renderWorkerPrompt };
