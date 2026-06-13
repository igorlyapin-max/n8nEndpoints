#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const WORKFLOW_PATH = 'workflows/update-zabbix-problem-webhook.json';

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const updateCode = String.raw`const input = $input.first().json;
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
    if (/token|password|secret|message/i.test(key)) continue;
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
  diagnostic('Basic', 'update_zabbix_problem_rejected', { statusCode, code, zabbix_origin: details.zabbix_origin });
  return response(statusCode, code, message, details);
};

if (!expectedToken || actualToken !== expectedToken) {
  return errorResponse(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}

const problemUrlRaw = String(body.problemUrl || body.problem_url || '').trim();
const messageRaw = String(body.message || '').trim();
if (!problemUrlRaw) return errorResponse(400, 'missing_problem_url', 'Поле problemUrl обязательно.');
if (!messageRaw) return errorResponse(400, 'missing_message', 'Поле message обязательно.');
if (messageRaw.length > 2000) return errorResponse(400, 'message_too_long', 'Поле message не должно превышать 2000 символов.');

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

const formattedMessage = messageRaw + '\n';
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

let problems;
try {
  problems = await zabbixRpc('problem.get', {
    output: ['eventid', 'objectid', 'name', 'acknowledged', 'severity'],
    eventids: [eventid],
    recent: true,
    selectAcknowledges: 'extend'
  });
} catch (error) {
  return errorResponse(502, 'zabbix_problem_get_failed', 'Zabbix problem.get failed.', { zabbix_origin: zabbixOrigin });
}

if (!Array.isArray(problems) || problems.length === 0) {
  return errorResponse(404, 'zabbix_problem_not_found', 'Zabbix problem не найден по eventid.', { eventid, triggerid, zabbix_origin: zabbixOrigin });
}

const problem = problems.find((candidate) => String(candidate.eventid) === eventid) || problems[0];
if (String(problem.objectid) !== triggerid) {
  return errorResponse(409, 'trigger_mismatch', 'eventid найден, но objectid problem не совпадает с triggerid из URL.', {
    eventid,
    triggerid,
    zabbix_objectid: String(problem.objectid || ''),
    zabbix_origin: zabbixOrigin
  });
}

try {
  await zabbixRpc('event.acknowledge', {
    eventids: [eventid],
    action: 4,
    message: formattedMessage
  });
} catch (error) {
  return errorResponse(502, 'zabbix_event_acknowledge_failed', 'Zabbix event.acknowledge failed.', { eventid, triggerid, zabbix_origin: zabbixOrigin });
}

diagnostic('Basic', 'update_zabbix_problem_updated', { eventid, triggerid, zabbix_origin: zabbixOrigin });

return [{
  json: {
    statusCode: 200,
    response: {
      status: 'updated',
      eventid,
      triggerid,
      zabbix_origin: zabbixOrigin,
      message: formattedMessage,
      problem: {
        name: problem.name,
        severity: problem.severity,
        acknowledged: problem.acknowledged
      }
    }
  }
}];`;

function workflow() {
  return {
    id: 'updateZabbixProblem',
    name: 'Zabbix: обновление problem по URL',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'zabbix/problem/update',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'update-zabbix-problem-webhook',
        name: 'Webhook обновления Zabbix problem',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '227cbfaa-e4b0-48f6-b3c9-dfcd4bff6ab5',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: updateCode,
        },
        id: 'update-zabbix-problem-run',
        name: 'Обновление Zabbix problem',
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
        id: 'update-zabbix-problem-response',
        name: 'Нормализованный ответ',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [800, 300],
      },
    ],
    connections: {
      'Webhook обновления Zabbix problem': {
        main: [
          [
            {
              node: 'Обновление Zabbix problem',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Обновление Zabbix problem': {
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
    active: false,
    settings: {
      executionOrder: 'v1',
    },
  };
}

function main() {
  const expected = `${stableJson(workflow())}\n`;
  const checkOnly = process.argv.includes('--check');
  const current = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, 'utf8') : '';
  if (current === expected) {
    process.stdout.write('zabbix problem workflow is up to date\n');
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
