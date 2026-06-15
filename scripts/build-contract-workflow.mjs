#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const CONTRACT_PATH = 'contracts/n8n-openapi.json';
const LOCALES_PATH = 'contracts/n8n-openapi.locales.json';
const WORKFLOW_PATH = 'workflows/contracts-openapi-webhook.json';
const CODE_NODE_ID = 'contracts-openapi-build-response';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function assertLocalesConfig(locales) {
  if (!locales || typeof locales !== 'object' || Array.isArray(locales)) {
    throw new Error(`${LOCALES_PATH} must contain an object`);
  }
  if (locales.default_locale !== 'en') {
    throw new Error(`${LOCALES_PATH} default_locale must be en`);
  }
  if (!Array.isArray(locales.supported_locales) || !locales.supported_locales.includes(locales.default_locale)) {
    throw new Error(`${LOCALES_PATH} supported_locales must include default_locale`);
  }
  if (!locales.overlays || typeof locales.overlays !== 'object' || Array.isArray(locales.overlays)) {
    throw new Error(`${LOCALES_PATH} overlays must contain an object`);
  }
  for (const locale of locales.supported_locales) {
    const overlay = locales.overlays[locale] || {};
    if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
      throw new Error(`${LOCALES_PATH} overlay for ${locale} must be an object`);
    }
    for (const [pointer, value] of Object.entries(overlay)) {
      if (!pointer.startsWith('/')) {
        throw new Error(`${LOCALES_PATH} overlay pointer must start with /: ${pointer}`);
      }
      if (typeof value !== 'string') {
        throw new Error(`${LOCALES_PATH} overlay value must be string for ${pointer}`);
      }
    }
  }
}

function buildCode(openapi, locales) {
  return [
    `const baseContract = ${stableJson(openapi)};`,
    `const localeConfig = ${stableJson(locales)};`,
    '',
    "const input = $input.first().json || {};",
    'const query = input.query || input.queryParameters || {};',
    "const rawLang = Array.isArray(query.lang) ? query.lang[0] : query.lang;",
    "const requestedLocale = String(rawLang || localeConfig.default_locale).trim().toLowerCase();",
    'const supportedLocales = localeConfig.supported_locales || [localeConfig.default_locale];',
    '',
    'if (!supportedLocales.includes(requestedLocale)) {',
    '  return [{',
    '    json: {',
    '      statusCode: 400,',
    '      response: {',
    '        error: {',
    "          code: 'unsupported_locale',",
    "          message: 'Unsupported lang query parameter.',",
    '          locale: requestedLocale,',
    '          supported_locales: supportedLocales',
    '        }',
    '      }',
    '    }',
    '  }];',
    '}',
    '',
    'const clone = (value) => JSON.parse(JSON.stringify(value));',
    "const decodePointerSegment = (segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~');",
    'const applyOverlay = (target, overlay) => {',
    '  for (const [pointer, value] of Object.entries(overlay || {})) {',
    "    const segments = pointer.split('/').slice(1).map(decodePointerSegment);",
    '    let current = target;',
    '    for (const segment of segments.slice(0, -1)) {',
    '      current = current?.[segment];',
    '      if (current === undefined || current === null) {',
    "        throw new Error('OpenAPI locale overlay points to missing path: ' + pointer);",
    '      }',
    '    }',
    '    const leaf = segments[segments.length - 1];',
    '    if (!Object.prototype.hasOwnProperty.call(current || {}, leaf)) {',
    "      throw new Error('OpenAPI locale overlay points to missing field: ' + pointer);",
    '    }',
    '    current[leaf] = value;',
    '  }',
    '};',
    '',
    'const contract = clone(baseContract);',
    'applyOverlay(contract, localeConfig.overlays?.[requestedLocale]);',
    'return [{ json: { statusCode: 200, response: contract } }];',
  ].join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const openapi = readJson(CONTRACT_PATH);
  const locales = readJson(LOCALES_PATH);
  assertLocalesConfig(locales);
  const workflow = readJson(WORKFLOW_PATH);
  const node = workflow.nodes.find((candidate) => candidate.id === CODE_NODE_ID);
  if (!node) {
    throw new Error(`Node ${CODE_NODE_ID} was not found in ${WORKFLOW_PATH}`);
  }

  const nextCode = buildCode(openapi, locales);
  node.parameters.jsCode = nextCode;
  const expected = `${stableJson(documentedWorkflow(workflow))}\n`;
  const current = readFileSync(WORKFLOW_PATH, 'utf8');
  if (current === expected) {
    process.stdout.write('contracts workflow is up to date\n');
    return 0;
  }

  if (checkOnly) {
    process.stderr.write(`${WORKFLOW_PATH} is out of date with ${CONTRACT_PATH}\n`);
    return 1;
  }

  writeFileSync(WORKFLOW_PATH, expected, 'utf8');
  process.stdout.write(`updated ${WORKFLOW_PATH} from ${CONTRACT_PATH}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
