#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log('fake-cli 1.0.0');
  process.exit(0);
}

const promptFile = args[0];
if (!promptFile) {
  console.error('Error: prompt file argument required');
  process.exit(1);
}

let prompt;
try {
  prompt = fs.readFileSync(promptFile, 'utf-8');
} catch (err) {
  console.error('Error: cannot read prompt file:', err.message);
  process.exit(1);
}

if (prompt.includes('system orchestrator for a multi-agent project')) {
  const requestsStart = prompt.indexOf('## New Requests from Agents');
  const requestsSection = requestsStart !== -1 ? prompt.slice(requestsStart) : prompt;
  const requestIdMatch = requestsSection.match(/"request_id":\s*"([^"]+)"/);
  const requestId = requestIdMatch ? requestIdMatch[1] : 'unknown-req';
  const agentSearchStart = requestIdMatch ? requestsSection.indexOf(requestIdMatch[0]) : 0;
  const remaining = requestsSection.slice(agentSearchStart);
  const agentMatch = remaining.match(/"agent":\s*"([^"]+)"/);
  const agentName = agentMatch ? agentMatch[1] : 'unknown-agent';
  const response = {
    approved: [{
      request_id: requestId,
      decision: 'Smoke-test completion approved.',
      reason: 'Fake orchestrator approved the review request.'
    }],
    rejected: [],
    actions: [{ type: 'end_agent', agent: agentName }]
  };
  console.log(JSON.stringify(response, null, 2));
  process.exit(0);
}

if (prompt.includes('reviewing the completed output')) {
  console.log('Smoke summary: fake review completed.');
  process.exit(0);
}

const maxTimer = setTimeout(function () { process.exit(0); }, 100);
process.on('SIGTERM', function () { clearTimeout(maxTimer); process.exit(0); });

fs.writeFileSync('worker-output.txt', 'Fake CLI worker output for agent-one.\nGenerated at: ' + new Date().toISOString() + '\n', 'utf-8');

if (!fs.existsSync('coord')) {
  fs.mkdirSync('coord');
}

var agentName = 'agent-one';
var agentMatch = prompt.match(/"agent":\s*"([^"]+)"/);
if (agentMatch && agentMatch[1] && agentMatch[1] !== 'string — name of agent') {
  agentName = agentMatch[1];
}

var request = {
  request_id: agentName + '-req-smoke',
  agent: agentName,
  type: 'review_request',
  priority: 'medium',
  status: 'pending',
  content: 'Fake worker ' + agentName + ' has completed its smoke test task: created tests/helpers/fake-cli.js',
  created_at: new Date().toISOString()
};

const requestsDir = path.join('coord', 'requests');
fs.mkdirSync(requestsDir, { recursive: true });
const tmpFile = path.join(requestsDir, agentName + '-smoke.tmp');
const finalFile = path.join(requestsDir, agentName + '-smoke.json');
fs.writeFileSync(tmpFile, JSON.stringify(request) + '\n', 'utf-8');
fs.renameSync(tmpFile, finalFile);
