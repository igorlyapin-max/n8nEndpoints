#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const CONTRACT_PATH = 'contracts/n8n-openapi.json';
const WORKFLOW_PATH = 'workflows/contracts-openapi-webhook.json';
const CODE_NODE_ID = 'contracts-openapi-build-response';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function buildCode(openapi) {
  return [
    `const contract = ${stableJson(openapi)};`,
    "return [{ json: { statusCode: 200, response: contract } }];",
  ].join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const openapi = readJson(CONTRACT_PATH);
  const workflow = readJson(WORKFLOW_PATH);
  const node = workflow.nodes.find((candidate) => candidate.id === CODE_NODE_ID);
  if (!node) {
    throw new Error(`Node ${CODE_NODE_ID} was not found in ${WORKFLOW_PATH}`);
  }

  const nextCode = buildCode(openapi);
  const currentCode = node.parameters?.jsCode || '';
  if (currentCode === nextCode) {
    process.stdout.write('contracts workflow is up to date\n');
    return 0;
  }

  if (checkOnly) {
    process.stderr.write(`${WORKFLOW_PATH} is out of date with ${CONTRACT_PATH}\n`);
    return 1;
  }

  node.parameters.jsCode = nextCode;
  writeFileSync(WORKFLOW_PATH, `${stableJson(workflow)}\n`, 'utf8');
  process.stdout.write(`updated ${WORKFLOW_PATH} from ${CONTRACT_PATH}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
