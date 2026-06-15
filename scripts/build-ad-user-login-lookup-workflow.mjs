#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const WORKFLOW_PATH = 'workflows/ad-user-login-lookup-webhook.json';

const AD_LDAP_CREDENTIAL = {
  id: 'msAdLdap',
  name: 'MS AD LDAPS',
};

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const prepareRequestCode = String.raw`const input = $input.first().json || {};
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
    if (/token|password|secret|authorization|full_name|employee_id|ldap_filter|base_dn/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
}

function response(statusCode, code, message, details = {}) {
  diagnostic('Basic', 'ad_user_login_lookup_rejected', { statusCode, code });
  return [{ json: { valid: false, statusCode, response: { error: { code, message, ...details } } } }];
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

function validAttributeName(value) {
  return /^[A-Za-z][A-Za-z0-9.-]*$/.test(value);
}

function escapeLdapFilterValue(value) {
  return String(value).replace(/[\u0000()*\\]/g, (char) => {
    if (char === '\u0000') return '\\00';
    if (char === '(') return '\\28';
    if (char === ')') return '\\29';
    if (char === '*') return '\\2a';
    if (char === '\\') return '\\5c';
    return char;
  });
}

if (!expectedToken || actualToken !== expectedToken) {
  return response(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}

const fullName = stringValue(body.full_name, body.fullName);
const employeeId = stringValue(body.employee_id, body.employeeId);
if (!fullName) return response(400, 'missing_full_name', 'Поле full_name обязательно.');
if (!employeeId) return response(400, 'missing_employee_id', 'Поле employee_id обязательно.');
if (fullName.length > 300) return response(400, 'full_name_too_long', 'Поле full_name слишком длинное.');
if (employeeId.length > 100) return response(400, 'employee_id_too_long', 'Поле employee_id слишком длинное.');
if (hasControlChars(fullName) || hasControlChars(employeeId)) {
  return response(400, 'invalid_search_value', 'ФИО и табельный номер не должны содержать управляющие символы.');
}

const fullNameAttribute = stringValue(body.full_name_attribute, body.fullNameAttribute, envValue('AD_FULL_NAME_ATTRIBUTE')) || 'displayName';
const employeeIdAttribute = stringValue(body.employee_id_attribute, body.employeeIdAttribute, envValue('AD_EMPLOYEE_ID_ATTRIBUTE')) || 'employeeID';
const loginAttribute = stringValue(body.login_attribute, body.loginAttribute, envValue('AD_LOGIN_ATTRIBUTE')) || 'sAMAccountName';
const emailAttribute = stringValue(body.email_attribute, body.emailAttribute, envValue('AD_EMAIL_ATTRIBUTE')) || 'mail';
const attributeNames = [fullNameAttribute, employeeIdAttribute, loginAttribute, emailAttribute];
const invalidAttribute = attributeNames.find((attribute) => !validAttributeName(attribute));
if (invalidAttribute) {
  return response(400, 'invalid_ad_attribute', 'Имя AD атрибута содержит недопустимые символы.', { attribute: invalidAttribute });
}

const baseDn = stringValue(body.base_dn, body.baseDN, envValue('AD_BASE_DN'));
if (!baseDn) return response(500, 'missing_ad_base_dn', 'AD_BASE_DN или поле base_dn обязательно для поиска в AD.');
if (baseDn.length > 1000 || hasControlChars(baseDn)) {
  return response(400, 'invalid_base_dn', 'base_dn не должен содержать управляющие символы и не должен быть длиннее 1000 символов.');
}

const ldapFilter = '(&(objectClass=user)(!(objectClass=computer))(' +
  fullNameAttribute + '=' + escapeLdapFilterValue(fullName) + ')(' +
  employeeIdAttribute + '=' + escapeLdapFilterValue(employeeId) + '))';
const ldapAttributes = Array.from(new Set([loginAttribute, emailAttribute, fullNameAttribute, employeeIdAttribute, 'distinguishedName']));

diagnostic('Basic', 'ad_user_login_lookup_accepted', {
  full_name_attribute: fullNameAttribute,
  employee_id_attribute: employeeIdAttribute,
  login_attribute: loginAttribute,
  email_attribute: emailAttribute,
});

return [{
  json: {
    valid: true,
    statusCode: 200,
    full_name: fullName,
    employee_id: employeeId,
    base_dn: baseDn,
    full_name_attribute: fullNameAttribute,
    employee_id_attribute: employeeIdAttribute,
    login_attribute: loginAttribute,
    email_attribute: emailAttribute,
    ldap_filter: ldapFilter,
    ldap_attributes: ldapAttributes,
    matched_by: {
      full_name_attribute: fullNameAttribute,
      employee_id_attribute: employeeIdAttribute,
      login_attribute: loginAttribute,
      email_attribute: emailAttribute
    }
  }
}];`;

const normalizeResponseCode = String.raw`const requestState = $('Подготовка AD запроса').first().json || {};
const inputItems = typeof $input.all === 'function' ? $input.all() : [$input.first()];

function response(statusCode, payload) {
  return [{ json: { statusCode, response: payload } }];
}

function businessError(code, message, details = {}) {
  return response(200, {
    status: 'ERROR',
    error_code: code,
    message,
    full_name: requestState.full_name || null,
    employee_id: requestState.employee_id || null,
    matched_by: requestState.matched_by || null,
    ...details
  });
}

function safeReason(value) {
  const raw = String(value?.message || value?.reason || value || 'LDAP lookup failed.');
  return raw.replace(/token|password|secret|credential|bind/ig, '[redacted]').slice(0, 300);
}

function valueOf(entry, attribute) {
  if (!entry || !attribute) return '';
  if (entry[attribute] !== undefined && entry[attribute] !== null) {
    const value = Array.isArray(entry[attribute]) ? entry[attribute][0] : entry[attribute];
    return String(value ?? '').trim();
  }
  const wanted = String(attribute).toLowerCase();
  const key = Object.keys(entry).find((candidate) => candidate.toLowerCase() === wanted);
  if (!key) return '';
  const value = Array.isArray(entry[key]) ? entry[key][0] : entry[key];
  return String(value ?? '').trim();
}

function summarize(entry) {
  return {
    login: valueOf(entry, requestState.login_attribute) || null,
    email: valueOf(entry, requestState.email_attribute) || null,
    full_name: valueOf(entry, requestState.full_name_attribute) || requestState.full_name || null,
    employee_id: valueOf(entry, requestState.employee_id_attribute) || requestState.employee_id || null
  };
}

const ldapFailure = inputItems.find((item) => item?.error || item?.json?.error);
if (ldapFailure) {
  return response(502, {
    error: {
      code: 'ad_lookup_failed',
      message: 'LDAP/AD lookup failed.',
      reason: safeReason(ldapFailure.error || ldapFailure.json.error)
    }
  });
}

const entries = inputItems
  .map((item) => item?.json || {})
  .filter((entry) => {
    if (!entry || Object.keys(entry).length === 0) return false;
    if (entry.valid === true && entry.ldap_filter) return false;
    return Boolean(
      valueOf(entry, requestState.login_attribute) ||
      valueOf(entry, requestState.email_attribute) ||
      valueOf(entry, requestState.full_name_attribute) ||
      valueOf(entry, requestState.employee_id_attribute) ||
      valueOf(entry, 'distinguishedName') ||
      valueOf(entry, 'dn')
    );
  });

if (entries.length === 0) {
  return businessError('ad_user_not_found', 'Пользователь AD не найден по ФИО и табельному номеру.', { match_count: 0 });
}
if (entries.length > 1) {
  return businessError('ad_user_not_unique', 'По ФИО и табельному номеру найдено несколько пользователей AD.', {
    match_count: entries.length,
    candidates: entries.slice(0, 10).map(summarize)
  });
}

const entry = entries[0];
const login = valueOf(entry, requestState.login_attribute);
const email = valueOf(entry, requestState.email_attribute);
if (!login) {
  return businessError('ad_login_not_found', 'Пользователь AD найден, но login атрибут пустой.', {
    match_count: 1,
    candidates: [summarize(entry)]
  });
}
if (!email) {
  return businessError('ad_email_not_found', 'Пользователь AD найден, но email атрибут пустой.', {
    match_count: 1,
    candidates: [summarize(entry)]
  });
}

return response(200, {
  status: 'OK',
  login,
  email,
  full_name: requestState.full_name,
  employee_id: requestState.employee_id,
  matched_by: requestState.matched_by || {
    full_name_attribute: requestState.full_name_attribute,
    employee_id_attribute: requestState.employee_id_attribute,
    login_attribute: requestState.login_attribute,
    email_attribute: requestState.email_attribute
  }
});`;

function workflow() {
  return documentedWorkflow({
    id: 'lookupAdUserLogin',
    name: 'AD: поиск login и email пользователя',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'ad/user/login-lookup',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'ad-login-lookup-webhook',
        name: 'Webhook поиска login AD',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '01b5e709-e660-4eb3-bd9d-fecb3f6fa0d3',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: prepareRequestCode,
        },
        id: 'ad-login-lookup-prepare',
        name: 'Подготовка AD запроса',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [520, 300],
      },
      {
        parameters: {
          conditions: {
            boolean: [
              {
                value1: '={{ $json.valid }}',
                value2: true,
              },
            ],
          },
        },
        id: 'ad-login-lookup-valid',
        name: 'Запрос валиден?',
        type: 'n8n-nodes-base.if',
        typeVersion: 1,
        position: [780, 300],
      },
      {
        parameters: {
          operation: 'search',
          baseDN: '={{ $json.base_dn }}',
          searchFor: 'custom',
          customFilter: '={{ $json.ldap_filter }}',
          returnAll: false,
          limit: 2,
          options: {
            attributes: '={{ $json.ldap_attributes }}',
            pageSize: 0,
            scope: 'sub',
          },
        },
        id: 'ad-login-lookup-search',
        name: 'LDAP поиск пользователя',
        type: 'n8n-nodes-base.ldap',
        typeVersion: 1,
        position: [1040, 200],
        alwaysOutputData: true,
        continueOnFail: true,
        credentials: {
          ldap: AD_LDAP_CREDENTIAL,
        },
      },
      {
        parameters: {
          jsCode: normalizeResponseCode,
        },
        id: 'ad-login-lookup-normalize',
        name: 'Нормализация AD ответа',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1300, 200],
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify($json.response) }}',
          options: {
            responseCode: '={{ $json.statusCode }}',
          },
        },
        id: 'ad-login-lookup-response',
        name: 'Нормализованный ответ',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1560, 300],
      },
    ],
    connections: {
      'Webhook поиска login AD': {
        main: [[{ node: 'Подготовка AD запроса', type: 'main', index: 0 }]],
      },
      'Подготовка AD запроса': {
        main: [[{ node: 'Запрос валиден?', type: 'main', index: 0 }]],
      },
      'Запрос валиден?': {
        main: [
          [{ node: 'LDAP поиск пользователя', type: 'main', index: 0 }],
          [{ node: 'Нормализованный ответ', type: 'main', index: 0 }],
        ],
      },
      'LDAP поиск пользователя': {
        main: [[{ node: 'Нормализация AD ответа', type: 'main', index: 0 }]],
      },
      'Нормализация AD ответа': {
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
    process.stdout.write('AD user login lookup workflow is up to date\n');
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
