#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const WORKFLOW_PATH = 'workflows/ad-password-reset-webhook.json';

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
const expectedInternalToken = envValue('N8N_INTERNAL_RUNBOOK_TOKEN');
const actualInternalToken = headers['x-servicedesk-internal-token'] || headers['X-ServiceDesk-Internal-Token'] || headers['X-Servicedesk-Internal-Token'] || '';
const debugLevel = String(envValue('N8N_WORKFLOW_DEBUG') || 'off');
const defaultAllowedChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function diagnostic(level, event, fields = {}) {
  const order = { off: 0, Basic: 1, Verbose: 2 };
  if ((order[debugLevel] || 0) < (order[level] || 0)) return;
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|password|secret|authorization|login|ldap_filter|base_dn|unicode/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
}

function response(statusCode, code, message, details = {}) {
  diagnostic('Basic', 'ad_password_reset_rejected', { statusCode, code });
  return [{ json: { valid: false, statusCode, response: { error: { code, message, ...details } } } }];
}

function stringValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function integerValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return Number(value);
  }
  return NaN;
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

function randomInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error('invalid_random_bound');
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('crypto_get_random_values_unavailable');
  }
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  do {
    cryptoApi.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % maxExclusive;
}

function sample(chars) {
  return chars[randomInt(chars.length)];
}

function shuffle(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const current = values[index];
    values[index] = values[swapIndex];
    values[swapIndex] = current;
  }
  return values;
}

function generatePassword(length, allowedChars) {
  const uniqueChars = Array.from(new Set(Array.from(allowedChars)));
  const requiredGroups = [
    uniqueChars.filter((char) => /[A-Z]/.test(char)),
    uniqueChars.filter((char) => /[a-z]/.test(char)),
    uniqueChars.filter((char) => /[0-9]/.test(char)),
  ].filter((group) => group.length > 0);
  const result = requiredGroups.map(sample);
  while (result.length < length) result.push(sample(uniqueChars));
  return shuffle(result).join('');
}

if (!expectedToken || actualToken !== expectedToken) {
  return response(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}
if (!expectedInternalToken) {
  return response(500, 'missing_internal_runbook_token', 'N8N_INTERNAL_RUNBOOK_TOKEN обязателен для AD password reset endpoint.');
}
if (actualInternalToken !== expectedInternalToken) {
  return response(403, 'forbidden_internal_runbook_token', 'Внутренний токен ранбука отсутствует или некорректен.');
}

const login = stringValue(body.login);
if (!login) return response(400, 'missing_login', 'Поле login обязательно.');
if (login.length > 256 || hasControlChars(login)) {
  return response(400, 'invalid_login', 'Поле login не должно содержать управляющие символы и не должно быть длиннее 256 символов.');
}

const passwordLength = integerValue(body.password_length, body.passwordLength, 12);
if (!Number.isInteger(passwordLength) || passwordLength < 8 || passwordLength > 128) {
  return response(400, 'invalid_password_length', 'password_length должен быть целым числом от 8 до 128.', { password_length: Number.isFinite(passwordLength) ? passwordLength : null });
}

const allowedChars = stringValue(envValue('AD_PASSWORD_ALLOWED_CHARS')) || defaultAllowedChars;
const uniqueAllowedChars = Array.from(new Set(Array.from(allowedChars)));
if (allowedChars.length > 512 || uniqueAllowedChars.length < 2 || hasControlChars(allowedChars)) {
  return response(500, 'invalid_allowed_chars_config', 'AD_PASSWORD_ALLOWED_CHARS должен содержать минимум 2 уникальных символа, не содержать управляющие символы и быть не длиннее 512 символов.');
}

const loginAttribute = stringValue(envValue('AD_PASSWORD_RESET_LOGIN_ATTRIBUTE'), envValue('AD_LOGIN_ATTRIBUTE')) || 'sAMAccountName';
if (!validAttributeName(loginAttribute)) {
  return response(500, 'invalid_ad_attribute_config', 'Имя AD атрибута содержит недопустимые символы.', { attribute: loginAttribute });
}

const baseDn = stringValue(envValue('AD_PASSWORD_RESET_BASE_DN'), envValue('AD_BASE_DN'));
if (!baseDn) return response(500, 'missing_ad_base_dn', 'AD_PASSWORD_RESET_BASE_DN или AD_BASE_DN обязательно для поиска в AD.');
if (baseDn.length > 1000 || hasControlChars(baseDn)) {
  return response(500, 'invalid_base_dn_config', 'AD password reset base DN не должен содержать управляющие символы и не должен быть длиннее 1000 символов.');
}

let password;
try {
  password = generatePassword(passwordLength, allowedChars);
} catch (error) {
  return response(500, 'password_generation_failed', 'Не удалось сгенерировать пароль криптографическим генератором.');
}

const ldapFilter = '(&(objectClass=user)(!(objectClass=computer))(' + loginAttribute + '=' + escapeLdapFilterValue(login) + '))';

diagnostic('Basic', 'ad_password_reset_accepted', {
  login_attribute: loginAttribute,
  password_length: passwordLength,
  allowed_chars_length: uniqueAllowedChars.length,
});
diagnostic('Verbose', 'ad_password_reset_search_prepared', {
  ldap_attributes_count: 3,
  password_length: passwordLength,
});

return [{
  json: {
    valid: true,
    statusCode: 200,
    login,
    password,
    password_length: passwordLength,
    change_on_first_login: true,
    base_dn: baseDn,
    login_attribute: loginAttribute,
    ldap_filter: ldapFilter,
    ldap_attributes: Array.from(new Set([loginAttribute, 'distinguishedName', 'dn'])),
    unicode_pwd: '"' + password + '"',
    pwd_last_set: '0',
    matched_by: {
      login_attribute: loginAttribute
    }
  }
}];`;

const prepareUpdateCode = String.raw`const requestState = $('Подготовка AD reset запроса').first().json || {};
const inputItems = typeof $input.all === 'function' ? $input.all() : [$input.first()];

function response(statusCode, payload) {
  return [{ json: { update_required: false, statusCode, response: payload } }];
}

function businessError(code, message, details = {}) {
  return response(200, {
    status: 'ERROR',
    error_code: code,
    message,
    login: requestState.login || null,
    matched_by: requestState.matched_by || null,
    ...details
  });
}

function redact(value) {
  let raw = String(value?.message || value?.reason || value || 'LDAP operation failed.');
  if (requestState.password) raw = raw.split(requestState.password).join('[redacted]');
  return raw.replace(/token|password|secret|credential|bind|unicodePwd/ig, '[redacted]').slice(0, 300);
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

const ldapFailure = inputItems.find((item) => item?.error || item?.json?.error);
if (ldapFailure) {
  return businessError('ad_user_lookup_failed', 'Не удалось найти пользователя AD перед сменой пароля.', {
    reason: redact(ldapFailure.error || ldapFailure.json.error)
  });
}

const entries = inputItems
  .map((item) => item?.json || {})
  .filter((entry) => {
    if (!entry || Object.keys(entry).length === 0) return false;
    if (entry.valid === true && entry.ldap_filter) return false;
    return Boolean(
      valueOf(entry, requestState.login_attribute) ||
      valueOf(entry, 'distinguishedName') ||
      valueOf(entry, 'dn')
    );
  });

if (entries.length === 0) {
  return businessError('ad_user_not_found', 'Пользователь AD не найден по login.', { match_count: 0 });
}
if (entries.length > 1) {
  return businessError('ad_user_not_unique', 'По login найдено несколько пользователей AD.', { match_count: entries.length });
}

const entry = entries[0];
const dn = valueOf(entry, 'distinguishedName') || valueOf(entry, 'dn');
if (!dn) {
  return businessError('ad_user_dn_not_found', 'Пользователь AD найден, но DN не вернулся из LDAP search.', { match_count: 1 });
}

return [{
  json: {
    update_required: true,
    statusCode: 200,
    dn,
    login: requestState.login,
    password: requestState.password,
    password_length: requestState.password_length,
    change_on_first_login: true,
    login_attribute: requestState.login_attribute,
    unicode_pwd: requestState.unicode_pwd,
    pwd_last_set: requestState.pwd_last_set,
    matched_by: requestState.matched_by || {
      login_attribute: requestState.login_attribute
    }
  }
}];`;

const normalizeUpdateCode = String.raw`const state = $('Подготовка смены пароля').first().json || {};
const inputItems = typeof $input.all === 'function' ? $input.all() : [$input.first()];

function response(statusCode, payload) {
  return [{ json: { statusCode, response: payload } }];
}

function redact(value) {
  let raw = String(value?.message || value?.reason || value || 'LDAP password update failed.');
  if (state.password) raw = raw.split(state.password).join('[redacted]');
  return raw.replace(/token|password|secret|credential|bind|unicodePwd/ig, '[redacted]').slice(0, 300);
}

function businessError(code, message, details = {}) {
  return response(200, {
    status: 'ERROR',
    error_code: code,
    message,
    login: state.login || null,
    matched_by: state.matched_by || null,
    ...details
  });
}

if (!state.update_required) {
  return response(state.statusCode || 500, state.response || { error: { code: 'invalid_reset_state', message: 'Некорректное состояние workflow смены пароля.' } });
}

const ldapFailure = inputItems.find((item) => item?.error || item?.json?.error);
if (ldapFailure) {
  return businessError('ad_password_update_failed', 'Не удалось сменить пароль пользователя AD.', {
    reason: redact(ldapFailure.error || ldapFailure.json.error)
  });
}

const results = inputItems.map((item) => item?.json || {});
const success = results.some((entry) => {
  if (!entry || typeof entry !== 'object' || Object.keys(entry).length === 0) return false;
  if (entry.success === true || entry.updated === true) return true;
  const marker = String(entry.result || entry.status || '').toLowerCase();
  return marker === 'success' || marker === 'ok' || marker === 'updated' || marker === 'true';
});
if (!success) {
  return businessError('ad_password_update_unconfirmed', 'LDAP node не подтвердил смену пароля пользователя AD.', {
    update_result_count: results.filter((entry) => entry && typeof entry === 'object' && Object.keys(entry).length > 0).length
  });
}

return response(200, {
  status: 'OK',
  login: state.login,
  password: state.password,
  password_length: state.password_length,
  change_on_first_login: true,
  matched_by: state.matched_by || {
    login_attribute: state.login_attribute
  }
});`;

function workflow() {
  return documentedWorkflow({
    id: 'resetAdUserPassword',
    name: 'AD: смена пароля пользователя',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'ad/user/reset-password',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'ad-password-reset-webhook',
        name: 'Webhook смены пароля AD',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '46edfa64-3d6f-4a06-99f1-14f465afcc32',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: prepareRequestCode,
        },
        id: 'ad-password-reset-prepare',
        name: 'Подготовка AD reset запроса',
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
        id: 'ad-password-reset-valid',
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
        id: 'ad-password-reset-search',
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
          jsCode: prepareUpdateCode,
        },
        id: 'ad-password-reset-build-update',
        name: 'Подготовка смены пароля',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1300, 200],
      },
      {
        parameters: {
          conditions: {
            boolean: [
              {
                value1: '={{ $json.update_required }}',
                value2: true,
              },
            ],
          },
        },
        id: 'ad-password-reset-update-required',
        name: 'Нужно менять пароль?',
        type: 'n8n-nodes-base.if',
        typeVersion: 1,
        position: [1560, 200],
      },
      {
        parameters: {
          operation: 'update',
          dn: '={{ $json.dn }}',
          attributes: {
            replace: [
              {
                id: 'unicodePwd',
                value: '={{ $json.unicode_pwd }}',
              },
              {
                id: 'pwdLastSet',
                value: '={{ $json.pwd_last_set }}',
              },
            ],
          },
        },
        id: 'ad-password-reset-update',
        name: 'LDAP смена пароля',
        type: 'n8n-nodes-base.ldap',
        typeVersion: 1,
        position: [1820, 120],
        alwaysOutputData: true,
        continueOnFail: true,
        credentials: {
          ldap: AD_LDAP_CREDENTIAL,
        },
      },
      {
        parameters: {
          jsCode: normalizeUpdateCode,
        },
        id: 'ad-password-reset-normalize',
        name: 'Нормализация смены пароля',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [2080, 120],
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify($json.response) }}',
          options: {
            responseCode: '={{ $json.statusCode }}',
          },
        },
        id: 'ad-password-reset-response',
        name: 'Нормализованный ответ',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [2340, 300],
      },
    ],
    connections: {
      'Webhook смены пароля AD': {
        main: [[{ node: 'Подготовка AD reset запроса', type: 'main', index: 0 }]],
      },
      'Подготовка AD reset запроса': {
        main: [[{ node: 'Запрос валиден?', type: 'main', index: 0 }]],
      },
      'Запрос валиден?': {
        main: [
          [{ node: 'LDAP поиск пользователя', type: 'main', index: 0 }],
          [{ node: 'Нормализованный ответ', type: 'main', index: 0 }],
        ],
      },
      'LDAP поиск пользователя': {
        main: [[{ node: 'Подготовка смены пароля', type: 'main', index: 0 }]],
      },
      'Подготовка смены пароля': {
        main: [[{ node: 'Нужно менять пароль?', type: 'main', index: 0 }]],
      },
      'Нужно менять пароль?': {
        main: [
          [{ node: 'LDAP смена пароля', type: 'main', index: 0 }],
          [{ node: 'Нормализованный ответ', type: 'main', index: 0 }],
        ],
      },
      'LDAP смена пароля': {
        main: [[{ node: 'Нормализация смены пароля', type: 'main', index: 0 }]],
      },
      'Нормализация смены пароля': {
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
    process.stdout.write('AD password reset workflow is up to date\n');
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
