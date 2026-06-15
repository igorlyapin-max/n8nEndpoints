#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const WORKFLOW_PATH = 'workflows/ad-password-reset-process-webhook.json';

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const processRequestCode = String.raw`const input = $input.first().json || {};
const headers = input.headers || {};
const body = input.body && typeof input.body === 'object' ? input.body : {};
const envValue = (name) => (typeof $env !== 'undefined' && $env[name]) || (typeof process !== 'undefined' && process.env[name]) || '';
const expectedToken = envValue('N8N_WEBHOOK_TOKEN');
const actualToken = headers['x-servicedesk-token'] || headers['X-ServiceDesk-Token'] || headers['X-Servicedesk-Token'] || '';
const internalRunbookToken = envValue('N8N_INTERNAL_RUNBOOK_TOKEN');
const debugLevel = String(envValue('N8N_WORKFLOW_DEBUG') || 'off');

function diagnostic(level, event, fields = {}) {
  const order = { off: 0, Basic: 1, Verbose: 2 };
  if ((order[debugLevel] || 0) < (order[level] || 0)) return;
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|password|secret|authorization|body|email|full_name|login/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
}

function response(statusCode, payload) {
  return [{ json: { statusCode, response: payload } }];
}

function technicalError(statusCode, code, message, details = {}) {
  diagnostic('Basic', 'ad_password_reset_process_rejected', { statusCode, code });
  return response(statusCode, { error: { code, message, ...details } });
}

function stringValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function hasControlChars(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function safeMessage(error) {
  return String(error?.message || error?.reason || error || 'unknown_error')
    .replace(/token|password|secret|credential|authorization|unicodePwd/ig, '[redacted]')
    .slice(0, 500);
}

function sanitize(value, generatedPassword = '') {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, generatedPassword));
  if (!value || typeof value !== 'object') {
    if (generatedPassword && String(value).includes(generatedPassword)) {
      return String(value).split(generatedPassword).join('[redacted]');
    }
    return value;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^password$/i.test(key)) continue;
    if (/token|secret|authorization|unicode_pwd|unicodePwd/i.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    result[key] = sanitize(entry, generatedPassword);
  }
  return result;
}

function parseInternalBaseUrl(raw) {
  const value = stringValue(raw) || 'http://127.0.0.1:5678/webhook';
  if (!/^https?:\/\/[^?#]+$/i.test(value)) return null;
  return value.replace(/\/+$/, '');
}

function validateTextField(name, value, maxLength) {
  if (!value) return { code: 'missing_' + name, message: 'Поле ' + name + ' обязательно.' };
  if (value.length > maxLength) return { code: name + '_too_long', message: 'Поле ' + name + ' слишком длинное.' };
  if (hasControlChars(value)) return { code: 'invalid_' + name, message: 'Поле ' + name + ' содержит управляющие символы.' };
  return null;
}

if (!expectedToken || actualToken !== expectedToken) {
  return technicalError(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}

const serviceRequest = stringValue(body.service_request, body.serviceRequest);
const applicantFullName = stringValue(body.applicant_full_name, body.applicantFullName);
const employeeFullName = stringValue(body.employee_full_name, body.employeeFullName);
const claimedManagerFullName = stringValue(body.claimed_manager_full_name, body.claimedManagerFullName);
const approvalId = stringValue(body.approval_id, body.approvalId);
const approvedBy = stringValue(body.approved_by, body.approvedBy);
const idempotencyKey = stringValue(body.idempotency_key, body.idempotencyKey);

for (const [name, value, maxLength] of [
  ['service_request', serviceRequest, 160],
  ['applicant_full_name', applicantFullName, 500],
  ['employee_full_name', employeeFullName, 500],
  ['claimed_manager_full_name', claimedManagerFullName, 500],
  ['approval_id', approvalId, 160],
  ['approved_by', approvedBy, 256],
  ['idempotency_key', idempotencyKey, 256],
]) {
  const error = validateTextField(name, value, maxLength);
  if (error) return technicalError(400, error.code, error.message);
}

const internalWebhookBaseUrl = parseInternalBaseUrl(envValue('N8N_INTERNAL_WEBHOOK_BASE_URL') || envValue('N8N_WEBHOOK_BASE_URL'));
if (!internalWebhookBaseUrl) {
  return technicalError(500, 'invalid_internal_webhook_base_url', 'N8N_INTERNAL_WEBHOOK_BASE_URL должен быть http/https URL без query/fragment.');
}
if (!internalRunbookToken) {
  return technicalError(500, 'missing_internal_runbook_token', 'N8N_INTERNAL_RUNBOOK_TOKEN обязателен для вызова AD password reset endpoint.');
}

const httpRequest = this?.helpers?.httpRequest?.bind(this.helpers);
if (!httpRequest) {
  return technicalError(500, 'http_request_helper_unavailable', 'n8n httpRequest helper is not available in Code node.');
}

const steps = {};
let passwordChanged = false;
let notificationSent = false;
let generatedPassword = '';

function businessError(failedStep, errorCode, message, details = {}) {
  diagnostic('Basic', 'ad_password_reset_process_failed', { failed_step: failedStep, error_code: errorCode, password_changed: passwordChanged, notification_sent: notificationSent });
  return response(200, {
    status: 'ERROR',
    service_request: serviceRequest,
    approval_id: approvalId,
    approved_by: approvedBy,
    idempotency_key: idempotencyKey,
    error_code: errorCode,
    failed_step: failedStep,
    message,
    password_changed: passwordChanged,
    notification_sent: notificationSent,
    steps: sanitize(steps, generatedPassword),
    ...sanitize(details, generatedPassword)
  });
}

async function postJson(stepName, path, payload, extraHeaders = {}) {
  try {
    return await httpRequest({
      method: 'POST',
      url: internalWebhookBaseUrl + path,
      headers: {
        'Content-Type': 'application/json',
        'X-ServiceDesk-Token': expectedToken,
        'Idempotency-Key': idempotencyKey + ':' + stepName,
        ...extraHeaders
      },
      body: payload,
      json: true
    });
  } catch (error) {
    throw new Error(stepName + '_call_failed: ' + safeMessage(error));
  }
}

function childFailureCode(stepName, result) {
  const code = result?.error_code || result?.error?.code || 'unexpected_response';
  return stepName + '_' + String(code).replace(/[^A-Za-z0-9_]+/g, '_');
}

function childFailureMessage(defaultMessage, result) {
  return result?.message || result?.error?.message || defaultMessage;
}

diagnostic('Basic', 'ad_password_reset_process_started', { service_request_length: serviceRequest.length });
diagnostic('Verbose', 'ad_password_reset_process_approval_context', { has_approval_id: Boolean(approvalId), idempotency_key_length: idempotencyKey.length });

let applicantResult;
try {
  applicantResult = await postJson('applicant_participant', '/hr/verify-applicant-participant', {
    applicant_full_name: applicantFullName,
    employee_full_name: employeeFullName,
    manager_full_name: claimedManagerFullName
  });
} catch (error) {
  return businessError('applicant_participant', 'applicant_participant_call_failed', 'Не удалось проверить заявителя среди сотрудника и руководителя.', { reason: safeMessage(error) });
}
steps.applicant_participant = applicantResult;
if (!applicantResult || applicantResult.status !== 'OK') {
  return businessError('applicant_participant', childFailureCode('applicant_participant', applicantResult), childFailureMessage('Заявитель не совпадает с сотрудником или руководителем.', applicantResult));
}

let managerResult;
try {
  managerResult = await postJson('manager_verification', '/hr/verify-manager', {
    employee_full_name: employeeFullName,
    claimed_manager_full_name: claimedManagerFullName,
    relation_type: 'both'
  });
} catch (error) {
  return businessError('manager_verification', 'manager_verification_call_failed', 'Не удалось проверить руководителя по кадровой выгрузке.', { reason: safeMessage(error) });
}
steps.manager_verification = managerResult;
if (!managerResult || managerResult.status !== 'OK') {
  return businessError('manager_verification', childFailureCode('manager_verification', managerResult), childFailureMessage('Кадровая выгрузка не подтвердила руководителя.', managerResult));
}
if (!stringValue(managerResult.employee_id) || !stringValue(managerResult.manager_id)) {
  return businessError('manager_verification', 'manager_verification_missing_employee_ids', 'Кадровая выгрузка не вернула табельные номера сотрудника и руководителя.');
}

let employeeAd;
try {
  employeeAd = await postJson('employee_ad_lookup', '/ad/user/login-lookup', {
    full_name: employeeFullName,
    employee_id: managerResult.employee_id
  });
} catch (error) {
  return businessError('employee_ad_lookup', 'employee_ad_lookup_call_failed', 'Не удалось найти сотрудника в AD.', { reason: safeMessage(error) });
}
steps.employee_ad_lookup = employeeAd;
if (!employeeAd || employeeAd.status !== 'OK') {
  return businessError('employee_ad_lookup', childFailureCode('employee_ad_lookup', employeeAd), childFailureMessage('Сотрудник не найден в AD.', employeeAd));
}
if (!stringValue(employeeAd.login)) {
  return businessError('employee_ad_lookup', 'employee_ad_lookup_missing_login', 'AD lookup сотрудника не вернул login.');
}

let managerAd;
try {
  managerAd = await postJson('manager_ad_lookup', '/ad/user/login-lookup', {
    full_name: claimedManagerFullName,
    employee_id: managerResult.manager_id
  });
} catch (error) {
  return businessError('manager_ad_lookup', 'manager_ad_lookup_call_failed', 'Не удалось найти руководителя в AD.', { reason: safeMessage(error) });
}
steps.manager_ad_lookup = managerAd;
if (!managerAd || managerAd.status !== 'OK') {
  return businessError('manager_ad_lookup', childFailureCode('manager_ad_lookup', managerAd), childFailureMessage('Руководитель не найден в AD.', managerAd));
}
if (!stringValue(managerAd.email)) {
  return businessError('manager_ad_lookup', 'manager_ad_lookup_missing_email', 'AD lookup руководителя не вернул email.');
}

let resetResult;
try {
  resetResult = await postJson('password_reset', '/ad/user/reset-password', {
    login: employeeAd.login,
    approval_id: approvalId,
    approved_by: approvedBy,
    idempotency_key: idempotencyKey + ':password_reset',
    service_request: serviceRequest
  }, {
    'X-ServiceDesk-Internal-Token': internalRunbookToken
  });
} catch (error) {
  return businessError('password_reset', 'password_reset_call_failed', 'Не удалось сменить пароль сотрудника.', { reason: safeMessage(error) });
}
if (!resetResult || resetResult.status !== 'OK') {
  steps.password_reset = resetResult;
  return businessError('password_reset', childFailureCode('password_reset', resetResult), childFailureMessage('Смена пароля сотрудника не выполнена.', resetResult));
}
generatedPassword = stringValue(resetResult.password);
steps.password_reset = sanitize(resetResult, generatedPassword);
passwordChanged = true;
if (!generatedPassword) {
  return businessError('password_reset', 'password_reset_missing_generated_password', 'Смена пароля выполнена, но endpoint не вернул сгенерированный пароль для отправки руководителю.');
}

let notificationResult;
try {
  notificationResult = await postJson('notification', '/email/send-template', {
    to: [managerAd.email],
    templateId: 'ad_password_reset_notification',
    request_id: serviceRequest,
    params: {
      service_request: serviceRequest,
      employee_full_name: employeeFullName,
      password: generatedPassword
    }
  });
} catch (error) {
  return businessError('notification', 'notification_call_failed', 'Пароль изменен, но письмо руководителю не отправлено.', { reason: safeMessage(error) });
}
steps.notification = {
  status: notificationResult?.status || null,
  to: managerAd.email,
  templateId: 'ad_password_reset_notification'
};
if (!notificationResult || notificationResult.status !== 'sent') {
  return businessError('notification', childFailureCode('notification', notificationResult), 'Пароль изменен, но endpoint отправки письма не подтвердил отправку.', { notification_response: notificationResult || null });
}
notificationSent = true;

diagnostic('Basic', 'ad_password_reset_process_completed', { password_changed: true, notification_sent: true });

return response(200, {
  status: 'OK',
  service_request: serviceRequest,
  approval_id: approvalId,
  approved_by: approvedBy,
  idempotency_key: idempotencyKey,
  password_changed: true,
  notification_sent: true,
  steps: sanitize(steps, generatedPassword)
});`;

function workflow() {
  return documentedWorkflow({
    id: 'processAdPasswordResetRequest',
    name: 'AD: обработка заявки на смену пароля',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'ad/password-reset/process',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'ad-password-reset-process-webhook',
        name: 'Webhook обработки заявки смены пароля',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '68094f4e-0457-4538-a6e4-76fbfa785368',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: processRequestCode,
        },
        id: 'ad-password-reset-process-run',
        name: 'Обработка заявки смены пароля AD',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [560, 300],
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify($json.response) }}',
          options: {
            responseCode: '={{ $json.statusCode }}',
          },
        },
        id: 'ad-password-reset-process-response',
        name: 'Нормализованный ответ',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [880, 300],
      },
    ],
    connections: {
      'Webhook обработки заявки смены пароля': {
        main: [[{ node: 'Обработка заявки смены пароля AD', type: 'main', index: 0 }]],
      },
      'Обработка заявки смены пароля AD': {
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
    if (checkOnly) process.stdout.write('AD password reset process workflow is up to date\n');
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
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
