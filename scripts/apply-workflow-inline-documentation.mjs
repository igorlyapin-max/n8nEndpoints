#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { applyWorkflowInlineDocumentation } from './workflow-inline-documentation.mjs';

const WORKFLOWS_DIR = 'workflows';

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const files = readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
  let drift = false;

  for (const file of files) {
    const path = `${WORKFLOWS_DIR}/${file}`;
    const current = readFileSync(path, 'utf8');
    const workflow = JSON.parse(current);
    const expected = `${stableJson(applyWorkflowInlineDocumentation(workflow))}\n`;

    if (current === expected) continue;
    if (checkOnly) {
      process.stderr.write(`${path} is missing current workflow inline documentation\n`);
      drift = true;
    } else {
      writeFileSync(path, expected, 'utf8');
      process.stdout.write(`updated inline documentation in ${path}\n`);
    }
  }

  if (!drift && checkOnly) {
    process.stdout.write('workflow inline documentation is up to date\n');
  }
  return drift ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
