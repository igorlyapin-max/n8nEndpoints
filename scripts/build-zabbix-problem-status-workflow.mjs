#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const WORKFLOW_PATH = 'workflows/get-zabbix-problem-status-webhook.json';

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const statusCode = String.raw`const input = $input.first().json;
const headers = input.headers || {};
const body = input.body || {};
const expectedToken = (typeof $env !== 'undefined' && $env.N8N_WEBHOOK_TOKEN) || (typeof process !== 'undefined' && process.env.N8N_WEBHOOK_TOKEN) || '';
const actualToken = headers['x-servicedesk-token'] || headers['X-ServiceDesk-Token'] || headers['X-Servicedesk-Token'] || '';
const debugLevel = String((typeof $env !== 'undefined' && $env.N8N_WORKFLOW_DEBUG) || (typeof process !== 'undefined' && process.env.N8N_WORKFLOW_DEBUG) || 'off');

const diagnostic = (level, event, fields = {}) => {
  const order = { off: 0, Basic: 1, Verbose: 2 };
  if ((order[debugLevel] || 0) < (order[level] || 0)) return;
  const safeFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|password|secret/i.test(key)) continue;
    safeFields[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safeFields }));
};

const response = (statusCode, code, message, details = {}) => [{
  json: {
    statusCode,
    response: {
      error: { code, message, ...details }
    }
  }
}];

const errorResponse = (statusCode, code, message, details = {}) => {
  diagnostic('Basic', 'get_zabbix_problem_status_rejected', { statusCode, code, zabbix_origin: details.zabbix_origin });
  return response(statusCode, code, message, details);
};

if (!expectedToken || actualToken !== expectedToken) {
  return errorResponse(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}

const problemUrlRaw = String(body.problemUrl || body.problem_url || '').trim();
if (!problemUrlRaw) return errorResponse(400, 'missing_problem_url', 'Поле problemUrl обязательно.');

const decodeQuery = (value) => {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, ' '));
  } catch {
    return String(value || '');
  }
};

const parseProblemUrl = (value) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^(https?):\/\/([^/?#]+)(?:\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  if (!authority || authority.includes('@')) return null;
  const params = {};
  for (const part of String(match[3] || '').split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const key = decodeQuery(separator >= 0 ? part.slice(0, separator) : part);
    const paramValue = decodeQuery(separator >= 0 ? part.slice(separator + 1) : '');
    if (key && params[key] === undefined) params[key] = paramValue;
  }
  return {
    origin: scheme + '://' + authority,
    queryParam: (name) => params[name] || ''
  };
};

const problemUrl = parseProblemUrl(problemUrlRaw);
if (!problemUrl) {
  return errorResponse(400, 'invalid_problem_url', 'Поле problemUrl должно быть корректным URL.');
}

const eventid = String(problemUrl.queryParam('eventid') || '').trim();
const triggerid = String(problemUrl.queryParam('triggerid') || '').trim();
if (!eventid) return errorResponse(400, 'missing_eventid', 'problemUrl должен содержать query parameter eventid.');
if (!triggerid) return errorResponse(400, 'missing_triggerid', 'problemUrl должен содержать query parameter triggerid.');
if (!/^[0-9]+$/.test(eventid)) return errorResponse(400, 'invalid_eventid', 'eventid должен быть числовой строкой.', { eventid });
if (!/^[0-9]+$/.test(triggerid)) return errorResponse(400, 'invalid_triggerid', 'triggerid должен быть числовой строкой.', { triggerid });

const zabbixOrigin = problemUrl.origin;

const parseRegistry = (name) => {
  const raw = (typeof $env !== 'undefined' && $env[name]) || (typeof process !== 'undefined' && process.env[name]) || '';
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error(name + ' must be a JSON object.');
  }
};

let tokenRegistry;
let apiUrlRegistry;
try {
  tokenRegistry = parseRegistry('ZABBIX_API_TOKENS_BY_ORIGIN');
  apiUrlRegistry = parseRegistry('ZABBIX_API_URLS_BY_ORIGIN');
} catch (error) {
  return errorResponse(400, 'invalid_zabbix_registry', 'Zabbix registry environment variables must be valid JSON objects.');
}

const zabbixToken = String(tokenRegistry[zabbixOrigin] || '').trim();
if (!zabbixToken) {
  return errorResponse(400, 'unknown_zabbix_origin', 'Для zabbix_origin не найден API token в ZABBIX_API_TOKENS_BY_ORIGIN.', { zabbix_origin: zabbixOrigin });
}

const zabbixApiUrl = String(apiUrlRegistry[zabbixOrigin] || (zabbixOrigin + '/api_jsonrpc.php')).trim();
const httpRequest = this?.helpers?.httpRequest?.bind(this.helpers);

async function zabbixRpc(method, params) {
  if (!httpRequest) {
    throw new Error('n8n httpRequest helper is not available in Code node.');
  }

  let payload;
  try {
    payload = await httpRequest({
      method: 'POST',
      url: zabbixApiUrl,
      headers: {
        'Content-Type': 'application/json-rpc',
        Accept: 'application/json',
        Authorization: 'Bearer ' + zabbixToken
      },
      body: {
        jsonrpc: '2.0',
        method,
        params,
        id: 1
      },
      json: true
    });
  } catch (error) {
    throw new Error('zabbix_api_http_request_failed');
  }
  if (payload.error) {
    throw new Error('zabbix_api_rpc_error');
  }
  return payload.result;
}

function normalizeRecoveryEventid(value) {
  return String(value || '0').trim() || '0';
}

function buildSuccess(status, source, problemDetails) {
  diagnostic('Basic', 'get_zabbix_problem_status_completed', { eventid, triggerid, zabbix_origin: zabbixOrigin, status, source });
  return [{
    json: {
      statusCode: 200,
      response: {
        status,
        eventid,
        triggerid,
        zabbix_origin: zabbixOrigin,
        source,
        problem: problemDetails
      }
    }
  }];
}

let events;
try {
  events = await zabbixRpc('event.get', {
    output: 'extend',
    eventids: [eventid]
  });
} catch (error) {
  return errorResponse(502, 'zabbix_event_get_failed', 'Zabbix event.get failed.', { zabbix_origin: zabbixOrigin });
}

if (Array.isArray(events) && events.length > 0) {
  const event = events.find((candidate) => String(candidate.eventid) === eventid) || events[0];
  if (String(event.objectid) !== triggerid) {
    return errorResponse(409, 'trigger_mismatch', 'eventid найден, но objectid event не совпадает с triggerid из URL.', {
      eventid,
      triggerid,
      zabbix_objectid: String(event.objectid || ''),
      zabbix_origin: zabbixOrigin
    });
  }

  const recoveryEventid = normalizeRecoveryEventid(event.r_eventid);
  const status = recoveryEventid !== '0' || String(event.value || '') === '0' ? 'resolved' : 'problem';
  return buildSuccess(status, 'event', {
    name: event.name,
    severity: event.severity,
    acknowledged: event.acknowledged,
    event_value: String(event.value || ''),
    recovery_eventid: recoveryEventid,
    recovery_clock: String(event.r_clock || '0')
  });
}

let triggers;
try {
  triggers = await zabbixRpc('trigger.get', {
    output: 'extend',
    triggerids: [triggerid]
  });
} catch (error) {
  return errorResponse(502, 'zabbix_trigger_get_failed', 'Zabbix trigger.get failed.', { zabbix_origin: zabbixOrigin });
}

if (!Array.isArray(triggers) || triggers.length === 0) {
  return errorResponse(404, 'zabbix_trigger_not_found', 'Zabbix trigger не найден по triggerid.', { eventid, triggerid, zabbix_origin: zabbixOrigin });
}

const trigger = triggers.find((candidate) => String(candidate.triggerid) === triggerid) || triggers[0];
const triggerValue = String(trigger.value || '0');
const status = triggerValue === '1' ? 'problem' : 'ok';

return buildSuccess(status, 'trigger_fallback', {
  name: trigger.description,
  severity: trigger.priority,
  acknowledged: null,
  event_value: null,
  recovery_eventid: null,
  recovery_clock: null,
  trigger_value: triggerValue
});`;

function workflow() {
  return documentedWorkflow({
    id: 'getZabbixProblemStatus',
    name: 'Zabbix: статус problem по URL',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'zabbix/problem/status',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'get-zabbix-problem-status-webhook',
        name: 'Webhook статуса Zabbix problem',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '42baf9f2-bf82-4d42-8434-afafbc46ea55',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: statusCode,
        },
        id: 'get-zabbix-problem-status-run',
        name: 'Получение статуса Zabbix problem',
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
        id: 'get-zabbix-problem-status-response',
        name: 'Нормализованный ответ',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [800, 300],
      },
    ],
    connections: {
      'Webhook статуса Zabbix problem': {
        main: [
          [
            {
              node: 'Получение статуса Zabbix problem',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Получение статуса Zabbix problem': {
        main: [
          [
            {
              node: 'Нормализованный ответ',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
    },
    active: true,
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
    process.stdout.write('zabbix problem status workflow is up to date\n');
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
