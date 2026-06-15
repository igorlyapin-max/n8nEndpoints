#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const WORKFLOW_PATH = 'workflows/cmdbuild-provider-email-context-webhook.json';

const LOCAL_CMDBUILD_CREDENTIAL = {
  id: 'localCmdbuildAdminTest',
  name: 'Local CMDBuild Admin Test',
};

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const prepareRequestCode = String.raw`const input = $input.first().json || {};
const headers = input.headers || {};
const body = input.body || {};
const expectedToken = (typeof $env !== 'undefined' && $env.N8N_WEBHOOK_TOKEN) || (typeof process !== 'undefined' && process.env.N8N_WEBHOOK_TOKEN) || '';
const actualToken = headers['x-servicedesk-token'] || headers['X-ServiceDesk-Token'] || headers['X-Servicedesk-Token'] || '';
const debugLevel = String((typeof $env !== 'undefined' && $env.N8N_WORKFLOW_DEBUG) || (typeof process !== 'undefined' && process.env.N8N_WORKFLOW_DEBUG) || 'off');

const diagnostic = (level, event, fields = {}) => {
  const order = { off: 0, Basic: 1, Verbose: 2 };
  if ((order[debugLevel] || 0) < (order[level] || 0)) return;
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|password|secret|body|email/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
};

const response = (statusCode, code, message, details = {}) => {
  diagnostic('Basic', 'cmdbuild_provider_context_rejected', { statusCode, code });
  return [{ json: { valid: false, statusCode, response: { error: { code, message, ...details } } } }];
};

if (!expectedToken || actualToken !== expectedToken) {
  return response(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}

const hostname = String(body.hostname || body.hostName || '').trim();
if (!hostname) return response(400, 'missing_hostname', 'Поле hostname обязательно.');
if (hostname.length > 500) return response(400, 'hostname_too_long', 'Поле hostname слишком длинное.');
if (/[\u0000-\u001f\u007f]/.test(hostname)) {
  return response(400, 'invalid_hostname', 'Поле hostname не должно содержать управляющие символы.');
}

const rawBaseUrl = String((typeof $env !== 'undefined' && $env.CMDBUILD_BASE_URL) || (typeof process !== 'undefined' && process.env.CMDBUILD_BASE_URL) || 'http://172.18.0.4:8080/cmdbuild').trim();
if (!/^https?:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(rawBaseUrl)) {
  return response(500, 'invalid_cmdbuild_base_url', 'CMDBUILD_BASE_URL должен быть http/https URL без query/fragment.');
}
const cmdbuildBaseUrl = rawBaseUrl.replace(/\/+$/, '');
const filter = {
  attribute: {
    simple: {
      attribute: 'Description',
      operator: 'equal',
      value: [hostname]
    }
  }
};
const routerSearchUrl = cmdbuildBaseUrl + '/services/rest/v3/classes/routerG/cards?limit=2&filter=' + encodeURIComponent(JSON.stringify(filter));

diagnostic('Basic', 'cmdbuild_provider_context_accepted', { hostname });

return [{
  json: {
    valid: true,
    statusCode: 200,
    hostname,
    cmdbuild_base_url: cmdbuildBaseUrl,
    router_search_url: routerSearchUrl
  }
}];`;

const parseRouterCode = String.raw`const searchResponse = $input.first().json || {};
const requestState = $('Подготовка запроса CMDBuild').first().json || {};

const response = (statusCode, code, message, details = {}) => [{
  json: {
    done: true,
    statusCode,
    response: {
      error: {
        code,
        message,
        ...details
      }
    }
  }
}];

const body = searchResponse.body && typeof searchResponse.body === 'object' ? searchResponse.body : searchResponse;
const httpStatus = Number(searchResponse.statusCode || 200);
if (httpStatus === 401 || httpStatus === 403) {
  return response(502, 'cmdbuild_auth_failed', 'CMDBuild authentication failed.');
}
if (httpStatus >= 400 || body.success === false) {
  return response(502, 'cmdbuild_lookup_failed', 'CMDBuild routerG lookup failed.', { cmdbuild_status: httpStatus || null });
}

const rows = Array.isArray(body.data) ? body.data : [];
const total = Number(body.meta?.total ?? rows.length);
if (total === 0 || rows.length === 0) {
  return response(404, 'router_not_found', 'routerG не найден по Description.', { hostname: requestState.hostname });
}
if (total > 1 || rows.length > 1) {
  return response(409, 'router_not_unique', 'По hostname найдено несколько routerG объектов.', { hostname: requestState.hostname, match_count: total || rows.length });
}

const router = rows[0] || {};
const text = (value) => value === undefined || value === null ? '' : String(value).trim();
const missing = [];
const providerEmail = text(router.email);
const contract = text(router.contract);
const ipaddressId = text(router.ipaddress);
const roomId = text(router.Location);
if (!providerEmail) missing.push('email');
if (!contract) missing.push('contract');
if (!ipaddressId) missing.push('ipaddress');
if (!roomId) missing.push('Location');
if (missing.length) {
  return response(422, 'missing_cmdbuild_field', 'В routerG не заполнены обязательные атрибуты.', {
    hostname: requestState.hostname,
    router_id: router._id || null,
    missing_fields: missing
  });
}

return [{
  json: {
    done: false,
    hostname: requestState.hostname,
    cmdbuild_base_url: requestState.cmdbuild_base_url,
    router_id: router._id,
    router_code: text(router.Code),
    provider_email: providerEmail,
    contract,
    ipaddress_id: ipaddressId,
    room_id: roomId,
    ip_url: requestState.cmdbuild_base_url + '/services/rest/v3/classes/IpAddress/cards/' + encodeURIComponent(ipaddressId),
    room_url: requestState.cmdbuild_base_url + '/services/rest/v3/classes/Room/cards/' + encodeURIComponent(roomId)
  }
}];`;

const normalizeResponseCode = String.raw`const routerState = $('Разбор routerG').first().json || {};
const ipResponse = $('Чтение IpAddress').first().json || {};
const roomResponse = $('Чтение Room').first().json || {};
const floorResponse = $('Чтение Floor').first().json || {};
const buildingResponse = $('Чтение Building').first().json || {};

const response = (statusCode, code, message, details = {}) => [{
  json: {
    statusCode,
    response: {
      error: {
        code,
        message,
        ...details
      }
    }
  }
}];

const bodyOf = (value) => value.body && typeof value.body === 'object' ? value.body : value;
const statusOf = (value) => Number(value.statusCode || 200);
const dataOf = (value) => {
  const body = bodyOf(value);
  return body && typeof body === 'object' ? body.data : null;
};
const text = (value) => value === undefined || value === null ? '' : String(value).trim();

const checkedResponses = [
  ['IpAddress', ipResponse],
  ['Room', roomResponse],
  ['Floor', floorResponse],
  ['Building', buildingResponse]
];
for (const [className, httpResponse] of checkedResponses) {
  const httpStatus = statusOf(httpResponse);
  const body = bodyOf(httpResponse);
  if (httpStatus === 401 || httpStatus === 403) {
    return response(502, 'cmdbuild_auth_failed', 'CMDBuild authentication failed.', { class_name: className });
  }
  if (httpStatus >= 400 || body.success === false) {
    return response(502, 'cmdbuild_lookup_failed', 'CMDBuild reference lookup failed.', { class_name: className, cmdbuild_status: httpStatus || null });
  }
}

const ip = dataOf(ipResponse) || {};
const room = dataOf(roomResponse) || {};
const floor = dataOf(floorResponse) || {};
const building = dataOf(buildingResponse) || {};

const missing = [];
const ipAddress = text(ip.Description);
const location = text(room.Description);
const floorId = text(room.Floor);
const buildingId = text(floor.Building);
const city = text(building.City);
if (!ipAddress) missing.push('IpAddress.Description');
if (!location) missing.push('Room.Description');
if (!floorId) missing.push('Room.Floor');
if (!buildingId) missing.push('Floor.Building');
if (!city) missing.push('Building.City');
if (missing.length) {
  return response(422, 'missing_cmdbuild_field', 'В CMDBuild reference chain не заполнены обязательные атрибуты.', {
    hostname: routerState.hostname,
    router_id: routerState.router_id || null,
    missing_fields: missing
  });
}

return [{
  json: {
    statusCode: 200,
    response: {
      status: 'OK',
      hostname: routerState.hostname,
      router_id: routerState.router_id,
      city,
      location,
      ip_address: ipAddress,
      contract: routerState.contract,
      provider_email: routerState.provider_email
    }
  }
}];`;

function httpGetNode(id, name, url, position) {
  return {
    parameters: {
      url,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBasicAuth',
      options: {
        response: {
          response: {
            fullResponse: true,
            neverError: true,
            responseFormat: 'json',
          },
        },
      },
    },
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.1,
    position,
    credentials: {
      httpBasicAuth: LOCAL_CMDBUILD_CREDENTIAL,
    },
  };
}

function workflow() {
  return documentedWorkflow({
    id: 'getCmdbuildProviderEmailContext',
    name: 'CMDBuild: параметры письма провайдеру',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'cmdbuild/provider-email-context',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'cmdbuild-provider-context-webhook',
        name: 'Webhook контекста провайдера',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '5d3c4ad5-8f7a-41b9-a2d1-1bc7a8f4426a',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: prepareRequestCode,
        },
        id: 'cmdbuild-provider-context-prepare',
        name: 'Подготовка запроса CMDBuild',
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
        id: 'cmdbuild-provider-context-valid',
        name: 'Запрос валиден?',
        type: 'n8n-nodes-base.if',
        typeVersion: 1,
        position: [780, 300],
      },
      httpGetNode(
        'cmdbuild-provider-context-search-router',
        'Поиск routerG',
        '={{ $json.router_search_url }}',
        [1040, 200],
      ),
      {
        parameters: {
          jsCode: parseRouterCode,
        },
        id: 'cmdbuild-provider-context-parse-router',
        name: 'Разбор routerG',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1300, 200],
      },
      {
        parameters: {
          conditions: {
            boolean: [
              {
                value1: '={{ $json.done }}',
                value2: true,
              },
            ],
          },
        },
        id: 'cmdbuild-provider-context-done',
        name: 'Ответ уже готов?',
        type: 'n8n-nodes-base.if',
        typeVersion: 1,
        position: [1560, 200],
      },
      httpGetNode(
        'cmdbuild-provider-context-get-ip',
        'Чтение IpAddress',
        '={{ $json.ip_url }}',
        [1820, 120],
      ),
      httpGetNode(
        'cmdbuild-provider-context-get-room',
        'Чтение Room',
        "={{ $('Разбор routerG').first().json.room_url }}",
        [2080, 120],
      ),
      httpGetNode(
        'cmdbuild-provider-context-get-floor',
        'Чтение Floor',
        "={{ $('Разбор routerG').first().json.cmdbuild_base_url + '/services/rest/v3/classes/Floor/cards/' + (((($('Чтение Room').first().json.body || {}).data || {}).Floor) || '0') }}",
        [2340, 120],
      ),
      httpGetNode(
        'cmdbuild-provider-context-get-building',
        'Чтение Building',
        "={{ $('Разбор routerG').first().json.cmdbuild_base_url + '/services/rest/v3/classes/Building/cards/' + (((($('Чтение Floor').first().json.body || {}).data || {}).Building) || '0') }}",
        [2600, 120],
      ),
      {
        parameters: {
          jsCode: normalizeResponseCode,
        },
        id: 'cmdbuild-provider-context-normalize',
        name: 'Нормализация ответа',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [2860, 120],
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify($json.response) }}',
          options: {
            responseCode: '={{ $json.statusCode }}',
          },
        },
        id: 'cmdbuild-provider-context-response',
        name: 'Нормализованный ответ',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [3120, 300],
      },
    ],
    connections: {
      'Webhook контекста провайдера': {
        main: [[{ node: 'Подготовка запроса CMDBuild', type: 'main', index: 0 }]],
      },
      'Подготовка запроса CMDBuild': {
        main: [[{ node: 'Запрос валиден?', type: 'main', index: 0 }]],
      },
      'Запрос валиден?': {
        main: [
          [{ node: 'Поиск routerG', type: 'main', index: 0 }],
          [{ node: 'Нормализованный ответ', type: 'main', index: 0 }],
        ],
      },
      'Поиск routerG': {
        main: [[{ node: 'Разбор routerG', type: 'main', index: 0 }]],
      },
      'Разбор routerG': {
        main: [[{ node: 'Ответ уже готов?', type: 'main', index: 0 }]],
      },
      'Ответ уже готов?': {
        main: [
          [{ node: 'Нормализованный ответ', type: 'main', index: 0 }],
          [{ node: 'Чтение IpAddress', type: 'main', index: 0 }],
        ],
      },
      'Чтение IpAddress': {
        main: [[{ node: 'Чтение Room', type: 'main', index: 0 }]],
      },
      'Чтение Room': {
        main: [[{ node: 'Чтение Floor', type: 'main', index: 0 }]],
      },
      'Чтение Floor': {
        main: [[{ node: 'Чтение Building', type: 'main', index: 0 }]],
      },
      'Чтение Building': {
        main: [[{ node: 'Нормализация ответа', type: 'main', index: 0 }]],
      },
      'Нормализация ответа': {
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
    process.stdout.write('cmdbuild provider context workflow is up to date\n');
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
