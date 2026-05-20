const path = require("path");

function getPaths(coordDir) {
  return {
    requests: path.join(coordDir, "requests.jsonl"),
    requestsDir: path.join(coordDir, "requests"),
    decisions: path.join(coordDir, "decisions.json"),
    decisionsAudit: path.join(coordDir, "decisions.jsonl"),
    decisionsMd: path.join(coordDir, "DECISIONS.md"),
    callerContextMd: path.join(coordDir, "CALLER_CONTEXT.md"),
    context: path.join(coordDir, "context.json"),
    agents: path.join(coordDir, "agents.json"),
    progressDir: path.join(coordDir, "progress"),
  };
}

module.exports = { getPaths };
