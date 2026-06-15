#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const WORKFLOW_PATH = 'workflows/hr-applicant-participant-webhook.json';

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const verifyApplicantCode = String.raw`const input = $input.first().json || {};
const headers = input.headers || {};
const body = input.body && typeof input.body === 'object' ? input.body : {};
const env = typeof $env !== 'undefined' ? $env : {};
const envValue = (name) => env[name] || (typeof process !== 'undefined' ? process.env[name] : '') || '';
const expectedToken = envValue('N8N_WEBHOOK_TOKEN');
const actualToken = headers['x-servicedesk-token'] || headers['X-ServiceDesk-Token'] || headers['X-Servicedesk-Token'] || '';
const debugLevel = String(envValue('N8N_WORKFLOW_DEBUG') || 'off');

function diagnostic(level, event, fields = {}) {
  const order = { off: 0, Basic: 1, Verbose: 2 };
  if ((order[debugLevel] || 0) < (order[level] || 0)) return;
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|password|secret|authorization|full_name|name|person|employee|manager|applicant/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
}

function response(statusCode, payload) {
  return [{ json: { statusCode, response: payload } }];
}

function error(statusCode, code, message, details = {}) {
  diagnostic('Basic', 'hr_applicant_participant_rejected', { statusCode, code });
  return response(statusCode, { error: { code, message, ...details } });
}

function businessError(code, message, details = {}) {
  diagnostic('Basic', 'hr_applicant_participant_business_error', { code });
  return response(200, { status: 'ERROR', error_code: code, message, ...details });
}

function stringValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function nameKey(value) {
  return normalizeName(value).toLocaleLowerCase('ru-RU');
}

function hasControlChars(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

if (!expectedToken || actualToken !== expectedToken) {
  return error(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}

const applicantFullName = normalizeName(stringValue(body.applicant_full_name, body.applicantFullName));
const employeeFullName = normalizeName(stringValue(body.employee_full_name, body.employeeFullName));
const managerFullName = normalizeName(stringValue(body.manager_full_name, body.managerFullName));

if (!applicantFullName) return error(400, 'missing_applicant_full_name', 'Поле applicant_full_name обязательно.');
if (!employeeFullName) return error(400, 'missing_employee_full_name', 'Поле employee_full_name обязательно.');
if (!managerFullName) return error(400, 'missing_manager_full_name', 'Поле manager_full_name обязательно.');

const values = [applicantFullName, employeeFullName, managerFullName];
if (values.some((value) => value.length > 300)) {
  return error(400, 'full_name_too_long', 'ФИО не должно превышать 300 символов.');
}
if (values.some(hasControlChars)) {
  return error(400, 'invalid_full_name', 'ФИО не должно содержать управляющие символы.');
}

const applicantKey = nameKey(applicantFullName);
const employeeKey = nameKey(employeeFullName);
const managerKey = nameKey(managerFullName);
const matchesEmployee = applicantKey === employeeKey;
const matchesManager = applicantKey === managerKey;

const common = {
  applicant_full_name: applicantFullName,
  employee_full_name: employeeFullName,
  manager_full_name: managerFullName
};

if (!matchesEmployee && !matchesManager) {
  return businessError('applicant_not_participant', 'Заявитель не совпадает ни с сотрудником, ни с руководителем.', common);
}

const matchedRole = matchesEmployee && matchesManager ? 'both' : matchesEmployee ? 'employee' : 'manager';
diagnostic('Basic', 'hr_applicant_participant_ok', { matched_role: matchedRole });

return response(200, {
  status: 'OK',
  matched_role: matchedRole,
  ...common
});`;

function workflow() {
  return documentedWorkflow({
    id: 'verifyApplicantParticipant',
    name: 'HR: проверка заявителя среди участников',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'hr/verify-applicant-participant',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'hr-applicant-participant-webhook',
        name: 'Webhook проверки заявителя',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: 'e29b9c4f-4189-4e3d-9238-4fa7d9e4d605',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: verifyApplicantCode,
        },
        id: 'hr-applicant-participant-verify',
        name: 'Проверка заявителя',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [520, 300],
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify($json.response) }}',
          options: {
            responseCode: '={{ $json.statusCode }}',
          },
        },
        id: 'hr-applicant-participant-response',
        name: 'Нормализованный ответ',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [780, 300],
      },
    ],
    connections: {
      'Webhook проверки заявителя': {
        main: [[{ node: 'Проверка заявителя', type: 'main', index: 0 }]],
      },
      'Проверка заявителя': {
        main: [[{ node: 'Нормализованный ответ', type: 'main', index: 0 }]],
      },
    },
    active: false,
    settings: {
      executionOrder: 'v1',
      saveDataErrorExecution: 'none',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: false,
    },
  });
}

function main() {
  const expected = `${stableJson(workflow())}\n`;
  const checkOnly = process.argv.includes('--check');
  const current = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, 'utf8') : '';
  if (current === expected) {
    process.stdout.write('HR applicant participant workflow is up to date\n');
    return 0;
  }
  if (checkOnly) {
    process.stderr.write(`${WORKFLOW_PATH} is out of date\n`);
    return 1;
  }
  writeFileSync(WORKFLOW_PATH, expected, 'utf8');
  process.stdout.write(`updated ${WORKFLOW_PATH}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
