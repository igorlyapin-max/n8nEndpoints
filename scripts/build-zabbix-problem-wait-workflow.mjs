#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';
import { serviceDeskEnvironmentExpression } from './servicedesk-async-runbook-runtime.mjs';

const WORKFLOW_PATH = 'workflows/wait-zabbix-problem-status-webhook.json';

const LOCAL_KAFKA_CREDENTIAL = {
  id: 'localRedpandaKafka',
  name: 'Local Redpanda Kafka',
};

const SERVICE_DESK_ENVIRONMENT_EXPR_SINGLE = serviceDeskEnvironmentExpression({ quote: "'" });

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const prepareRequestCode = String.raw`const input = $input.first().json || {};
const headers = input.headers || {};
const body = input.body || {};
const envValue = (name) => (typeof $env !== 'undefined' && $env[name]) || (typeof process !== 'undefined' && process.env[name]) || '';
const expectedToken = envValue('N8N_WEBHOOK_TOKEN');
const actualToken = headers['x-servicedesk-token'] || headers['X-ServiceDesk-Token'] || headers['X-Servicedesk-Token'] || '';
const debugLevel = String(envValue('N8N_WORKFLOW_DEBUG') || 'off');

const diagnostic = (level, event, fields = {}) => {
  const order = { off: 0, Basic: 1, Verbose: 2 };
  if ((order[debugLevel] || 0) < (order[level] || 0)) return;
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|password|secret|body|callback_url/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
};

const response = (statusCode, code, message, details = {}) => {
  diagnostic('Basic', 'wait_zabbix_problem_status_rejected', { statusCode, code });
  return [{ json: { valid: false, statusCode, response: { error: { code, message, ...details } } } }];
};

if (!expectedToken || actualToken !== expectedToken) {
  return response(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}

const stringValue = (value) => value === undefined || value === null ? '' : String(value).trim();
const numberFrom = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return Number(value);
  }
  return NaN;
};
const parseHttpUrl = (raw) => {
  const match = String(raw || '').match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)?(?:\?[^#]*)?(?:#.*)?$/);
  if (!match) return null;
  const protocol = match[1].toLowerCase() + ':';
  const authority = match[2] || '';
  const pathname = match[3] || '/';
  if (!authority) return null;
  const atIndex = authority.lastIndexOf('@');
  const hasCredentials = atIndex !== -1;
  const hostPort = hasCredentials ? authority.slice(atIndex + 1) : authority;
  if (!hostPort) return null;
  let hostname = '';
  let originHost = hostPort;
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    if (end <= 1) return null;
    hostname = hostPort.slice(1, end);
    const portPart = hostPort.slice(end + 1);
    if (portPart && !/^:\d{1,5}$/.test(portPart)) return null;
    originHost = '[' + hostname.toLowerCase() + ']' + portPart;
  } else {
    if (hostPort.includes('[') || hostPort.includes(']')) return null;
    const parts = hostPort.split(':');
    if (parts.length > 2) return null;
    hostname = parts[0];
    if (!hostname) return null;
    if (parts[1] !== undefined && !/^\d{1,5}$/.test(parts[1])) return null;
    originHost = hostname.toLowerCase() + (parts[1] !== undefined ? ':' + parts[1] : '');
  }
  return { protocol, hasCredentials, hostname: hostname.toLowerCase(), origin: protocol + '//' + originHost, pathname };
};
const validateCallbackUrl = (value) => {
  const raw = stringValue(value);
  const parsed = parseHttpUrl(raw);
  if (!parsed) return { reason: 'invalid_url' };
  if (!['http:', 'https:'].includes(parsed.protocol)) return { reason: 'invalid_scheme' };
  if (parsed.hasCredentials) return { reason: 'credentials_not_allowed' };
  const envName = stringValue(${SERVICE_DESK_ENVIRONMENT_EXPR_SINGLE}).toLowerCase();
  const localEnv = !envName || envName === 'development' || envName === 'dev' || envName === 'local' || envName === 'test';
  const production = envName === 'production' || envName === 'prod';
  const hostname = parsed.hostname.toLowerCase();
  const localHttp = parsed.protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || (!hostname.includes('.') && !/^[0-9.]+$/.test(hostname)));
  const orchestratorBase = stringValue(envValue('ORCHESTRATOR_PUBLIC_URL'));
  if (!orchestratorBase && !localEnv && !localHttp) return { reason: 'missing_orchestrator_public_url' };
  if (orchestratorBase) {
    const base = parseHttpUrl(orchestratorBase);
    if (!base || base.hasCredentials) return { reason: 'invalid_orchestrator_public_url' };
    const basePath = base.pathname.replace(/\/+$/, '');
    if (parsed.origin !== base.origin || (basePath && parsed.pathname !== basePath && !parsed.pathname.startsWith(basePath + '/'))) {
      return { reason: 'outside_orchestrator_public_url' };
    }
  }
  if (parsed.protocol !== 'https:' && !(localHttp && !production)) return { reason: 'https_required' };
  return null;
};

const problemUrl = stringValue(body.problemUrl || body.problem_url);
const pollIntervalMinutes = numberFrom(body.poll_interval_minutes, body.pollIntervalMinutes);
const timeoutMinutes = numberFrom(body.timeout_minutes, body.timeoutMinutes);

if (!problemUrl) return response(400, 'missing_problem_url', 'Поле problemUrl обязательно.');
if (!Number.isInteger(pollIntervalMinutes) || pollIntervalMinutes < 1 || pollIntervalMinutes > 60) {
  return response(400, 'invalid_poll_interval_minutes', 'poll_interval_minutes должен быть целым числом от 1 до 60.');
}
if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 240) {
  return response(400, 'invalid_timeout_minutes', 'timeout_minutes должен быть целым числом от 1 до 240.');
}
if (pollIntervalMinutes > timeoutMinutes) {
  return response(400, 'poll_interval_exceeds_timeout', 'poll_interval_minutes не должен быть больше timeout_minutes.');
}

const invocation = body.invocation && typeof body.invocation === 'object' ? body.invocation : {};
const asyncCallback = invocation.extensions?.async_callback && typeof invocation.extensions.async_callback === 'object'
  ? invocation.extensions.async_callback
  : null;
if (!asyncCallback) return response(400, 'missing_async_callback', 'Для этого ранбука обязателен invocation.extensions.async_callback.');

const actionId = stringValue(invocation.action_id || 'wait_zabbix_problem_status');
if (actionId !== 'wait_zabbix_problem_status') {
  return response(400, 'invalid_action_id', 'Для этого endpoint action_id должен быть wait_zabbix_problem_status.', { action_id: actionId });
}

const requiredAsync = ['source', 'case_id', 'wait_id', 'correlation_id', 'event_type', 'idempotency_key_base', 'result_transport'];
const missingAsync = requiredAsync.filter((name) => !stringValue(asyncCallback[name]));
if (missingAsync.length) {
  return response(400, 'missing_async_callback_fields', 'Не указаны обязательные поля async_callback.', { missing_fields: missingAsync });
}
const transport = stringValue(asyncCallback.result_transport);
if (!['http_callback', 'kafka_event', 'both'].includes(transport)) {
  return response(400, 'invalid_result_transport', 'result_transport должен быть http_callback, kafka_event или both.', { result_transport: transport });
}
if ((transport === 'http_callback' || transport === 'both') && !stringValue(asyncCallback.callback_url)) {
  return response(400, 'missing_callback_url', 'callback_url обязателен для http_callback или both.');
}
if (transport === 'http_callback' || transport === 'both') {
  const callbackError = validateCallbackUrl(asyncCallback.callback_url);
  if (callbackError) return response(400, 'invalid_callback_url', 'callback_url не соответствует политике безопасности.', callbackError);
}
if ((transport === 'kafka_event' || transport === 'both') && !stringValue(asyncCallback.result_topic)) {
  return response(400, 'missing_result_topic', 'result_topic обязателен для kafka_event или both.');
}

const rawInternalBase = stringValue(
  (typeof $env !== 'undefined' && ($env.N8N_INTERNAL_WEBHOOK_BASE_URL || $env.N8N_WEBHOOK_BASE_URL))
    || (typeof process !== 'undefined' && (process.env.N8N_INTERNAL_WEBHOOK_BASE_URL || process.env.N8N_WEBHOOK_BASE_URL))
    || 'http://127.0.0.1:5678/webhook'
);
if (!/^https?:\/\/[^?#]+$/i.test(rawInternalBase)) {
  return response(500, 'invalid_internal_webhook_base_url', 'N8N_INTERNAL_WEBHOOK_BASE_URL должен быть http/https URL без query/fragment.');
}
const internalWebhookBaseUrl = rawInternalBase.replace(/\/+$/, '');

const now = new Date();
const deadline = new Date(now.getTime() + timeoutMinutes * 60 * 1000);
const invocationId = stringValue(invocation.invocation_id || body.request_id || body.requestId || ('zabbix-wait-' + Date.now()));

const acceptedResponse = {
  runbook_status: 'accepted',
  message: 'n8n Zabbix wait runbook принял запрос.',
  invocation_id: invocationId,
  action_id: actionId,
  accepted_at: now.toISOString(),
  async_delivery: true,
  correlation_id: asyncCallback.correlation_id,
  wait_id: asyncCallback.wait_id,
  result_transport: transport,
  result_topic: asyncCallback.result_topic || null,
  has_callback_url: Boolean(asyncCallback.callback_url)
};

diagnostic('Basic', 'wait_zabbix_problem_status_accepted', {
  invocation_id: invocationId,
  poll_interval_minutes: pollIntervalMinutes,
  timeout_minutes: timeoutMinutes
});

return [{
  json: {
    valid: true,
    statusCode: 200,
    response: acceptedResponse,
    invocation_id: invocationId,
    action_id: actionId,
    problemUrl,
    poll_interval_minutes: pollIntervalMinutes,
    timeout_minutes: timeoutMinutes,
    poll_seconds: pollIntervalMinutes * 60,
    started_at: now.toISOString(),
    deadline_at: deadline.toISOString(),
    async_callback: asyncCallback,
    internal_webhook_base_url: internalWebhookBaseUrl
  }
}];`;

const zabbixCheckCode = String.raw`const state = $input.first().json || {};
const httpRequest = this?.helpers?.httpRequest?.bind(this.helpers);
if (!httpRequest) throw new Error('n8n httpRequest helper is not available in Code node.');

const safeMessage = (error) => String(error?.message || error || 'unknown_error').replace(/token|password|secret|authorization/ig, '[redacted]');
const now = new Date();
const deadline = new Date(state.deadline_at);
const internalToken = (typeof $env !== 'undefined' && $env.N8N_WEBHOOK_TOKEN) || (typeof process !== 'undefined' && process.env.N8N_WEBHOOK_TOKEN) || '';

const terminal = (status, message, extra = {}) => ({
  ...state,
  ...extra,
  terminal: true,
  response: {
    status,
    timed_out: Boolean(extra.timed_out),
    message,
    problemUrl: state.problemUrl,
    zabbix_status: extra.zabbix_status || state.zabbix_status || null,
    error: extra.error || null,
    started_at: state.started_at,
    finished_at: new Date().toISOString(),
    poll_interval_minutes: Number(state.poll_interval_minutes),
    timeout_minutes: Number(state.timeout_minutes)
  }
});

if (!internalToken) {
  return [{
    json: terminal('ERROR', 'N8N_WEBHOOK_TOKEN не настроен для internal webhook call.', {
      error: { code: 'missing_internal_webhook_token', message: 'N8N_WEBHOOK_TOKEN не настроен для internal webhook call.' }
    })
  }];
}

let zabbixStatus;
try {
  zabbixStatus = await httpRequest({
    method: 'POST',
    url: state.internal_webhook_base_url + '/zabbix/problem/status',
    headers: {
      'Content-Type': 'application/json',
      'X-ServiceDesk-Token': internalToken
    },
    body: { problemUrl: state.problemUrl },
    json: true
  });
} catch (error) {
  return [{
    json: terminal('ERROR', 'Не удалось проверить статус Zabbix problem.', {
      error: { code: 'zabbix_status_failed', message: 'Не удалось проверить статус Zabbix problem.', reason: safeMessage(error) }
    })
  }];
}

const status = String(zabbixStatus?.status || '');
if (!['problem', 'resolved', 'ok'].includes(status)) {
  return [{
    json: terminal('ERROR', 'Endpoint статуса Zabbix вернул некорректное состояние.', {
      zabbix_status: zabbixStatus || null,
      error: { code: 'invalid_zabbix_status_response', message: 'Endpoint статуса Zabbix вернул некорректное состояние.' }
    })
  }];
}

const nextState = { ...state, terminal: false, zabbix_status: zabbixStatus };
if (status === 'ok' || status === 'resolved') {
  return [{ json: terminal(status, 'Zabbix problem перешел в ok/resolved.', { zabbix_status: zabbixStatus, timed_out: false }) }];
}

if (now >= deadline) {
  return [{ json: terminal('problem', 'Zabbix problem остался в состоянии problem до timeout.', { zabbix_status: zabbixStatus, timed_out: true }) }];
}

const secondsUntilDeadline = Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 1000));
const pollSeconds = Number(state.poll_seconds || 60);
const nextWaitSeconds = Math.max(1, Math.min(pollSeconds, secondsUntilDeadline || pollSeconds));
const nextWaitAt = new Date(now.getTime() + nextWaitSeconds * 1000).toISOString();
return [{ json: { ...nextState, next_wait_seconds: nextWaitSeconds, next_wait_at: nextWaitAt } }];`;

const deliverAsyncResultCode = String.raw`const input = $input.first().json || {};
const response = input.response || {};
const asyncCallback = input.async_callback;
if (!asyncCallback) throw new Error('async_callback is required for async result delivery.');

const normalizeSource = (value) => String(value || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
const transport = String(asyncCallback.result_transport || '');
const resultStatus = String(response.status || 'ERROR');
const externalStatus = resultStatus === 'ERROR'
  ? 'error'
  : (response.timed_out ? 'timeout' : 'success');
const eventSuffix = response.timed_out ? resultStatus + '_timeout' : resultStatus;
const shouldPublishKafka = transport === 'kafka_event' || transport === 'both';
const deliveryStatus = {
  requested_transport: transport,
  http_callback: (transport === 'http_callback' || transport === 'both') ? 'pending' : 'not_requested',
  kafka_event: shouldPublishKafka ? 'pending' : 'not_requested'
};
const externalEvent = {
  schema_version: '1.0',
  event_id: asyncCallback.idempotency_key_base + ':zabbix_problem_wait_' + eventSuffix,
  case_id: asyncCallback.case_id,
  wait_id: asyncCallback.wait_id,
  correlation_id: asyncCallback.correlation_id,
  source: asyncCallback.source,
  event_type: asyncCallback.event_type,
  status: externalStatus,
  idempotency_key: asyncCallback.idempotency_key_base + ':zabbix_problem_wait_' + eventSuffix,
  result: {
    action_id: input.action_id || 'wait_zabbix_problem_status',
    invocation_id: input.invocation_id,
    ...response,
    delivery_status: deliveryStatus
  }
};

if (transport === 'http_callback' || transport === 'both') {
  const sourceKey = normalizeSource(asyncCallback.source);
  const token = (typeof $env !== 'undefined' && ($env['INTEGRATION_CALLBACK_TOKEN__' + sourceKey] || $env.INTEGRATION_CALLBACK_TOKEN))
    || (typeof process !== 'undefined' && (process.env['INTEGRATION_CALLBACK_TOKEN__' + sourceKey] || process.env.INTEGRATION_CALLBACK_TOKEN))
    || '';
  if (!token) {
    deliveryStatus.http_callback = 'failed';
    deliveryStatus.http_callback_error = 'missing_callback_token';
    if (!shouldPublishKafka) throw new Error('missing_callback_token');
  }
  const httpRequest = this?.helpers?.httpRequest?.bind(this.helpers);
  if (token && !httpRequest) {
    deliveryStatus.http_callback = 'failed';
    deliveryStatus.http_callback_error = 'http_request_helper_unavailable';
    if (!shouldPublishKafka) throw new Error('n8n httpRequest helper is not available in Code node.');
  }
  if (token && httpRequest) {
    try {
      await httpRequest({
        method: 'POST',
        url: asyncCallback.callback_url,
        headers: {
          'Content-Type': 'application/json',
          'X-ServiceDesk-Callback-Token': token
        },
        body: externalEvent,
        json: true
      });
      deliveryStatus.http_callback = 'sent';
    } catch (error) {
      deliveryStatus.http_callback = 'failed';
      deliveryStatus.http_callback_error = 'callback_delivery_failed';
      if (!shouldPublishKafka) throw new Error('callback_delivery_failed');
    }
  }
}

return [{
  json: {
    ...input,
    externalEvent,
    shouldPublishKafka,
    delivery_status: deliveryStatus,
    kafkaTopic: asyncCallback.result_topic || '',
    kafkaHeaders: JSON.stringify({
      correlation_id: asyncCallback.correlation_id,
      wait_id: asyncCallback.wait_id,
      idempotency_key: externalEvent.idempotency_key,
      event_type: asyncCallback.event_type
    })
  }
}];`;

const asyncDoneCode = "return [{ json: { delivered: true, status: $input.first().json.externalEvent?.status || 'unknown' } }];";

function ifNode(id, name, position, valueExpression) {
  return {
    parameters: {
      conditions: {
        boolean: [
          {
            value1: valueExpression,
            operation: 'equal',
            value2: true,
          },
        ],
      },
      combineOperation: 'all',
    },
    id,
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 1,
    position,
  };
}

function codeNode(id, name, jsCode, position) {
  return {
    parameters: { jsCode },
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function respondNode(id, name, position) {
  return {
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify($json.response) }}',
      options: {
        responseCode: '={{ $json.statusCode }}',
      },
    },
    id,
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position,
  };
}

function workflow() {
  return documentedWorkflow({
    id: 'waitZabbixProblemStatus',
    name: 'Zabbix: ожидание статуса problem',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'zabbix/problem/wait',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'wait-zabbix-problem-webhook',
        name: 'Webhook ожидания Zabbix problem',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '88467d63-8e75-4da7-b39e-f69dbe33c7d0',
        position: [240, 300],
      },
      codeNode('wait-zabbix-problem-prepare', 'Подготовка запроса ожидания Zabbix', prepareRequestCode, [520, 300]),
      ifNode('wait-zabbix-problem-valid', 'Запрос валиден?', [800, 300], '={{ $json.valid }}'),
      respondNode('wait-zabbix-problem-validation-error', 'Ответ ошибки валидации', [1080, 480]),
      respondNode('wait-zabbix-problem-accepted', 'Ответ accepted', [1080, 160]),
      codeNode('wait-zabbix-problem-check', 'Проверка статуса Zabbix', zabbixCheckCode, [1360, 160]),
      ifNode('wait-zabbix-problem-terminal', 'Zabbix ожидание завершено?', [1640, 160], '={{ $json.terminal }}'),
      {
        parameters: {
          resume: 'specificTime',
          dateTime: '={{ $json.next_wait_at }}',
        },
        id: 'wait-zabbix-problem-wait',
        name: 'Ожидание следующего опроса',
        type: 'n8n-nodes-base.wait',
        typeVersion: 1.1,
        position: [1920, 320],
      },
      codeNode('wait-zabbix-problem-deliver-result', 'Доставка async результата', deliverAsyncResultCode, [1920, 40]),
      ifNode('wait-zabbix-problem-needs-kafka', 'Нужна Kafka delivery?', [2200, 40], '={{ $json.shouldPublishKafka }}'),
      {
        parameters: {
          topic: '={{ $json.kafkaTopic }}',
          sendInputData: false,
          message: '={{ JSON.stringify($json.externalEvent) }}',
          jsonParameters: true,
          useSchemaRegistry: false,
          useKey: true,
          key: '={{ $json.externalEvent.case_id }}',
          headerParametersJson: '={{ $json.kafkaHeaders }}',
          options: {
            acks: true,
            compression: false,
            timeout: 30000,
          },
        },
        id: 'wait-zabbix-problem-kafka-publish',
        name: 'Публикация ExternalEvent в Kafka',
        type: 'n8n-nodes-base.kafka',
        typeVersion: 1,
        position: [2480, -40],
        credentials: {
          kafka: LOCAL_KAFKA_CREDENTIAL,
        },
      },
      codeNode('wait-zabbix-problem-async-done', 'Завершение async ветки', asyncDoneCode, [2760, 40]),
    ],
    connections: {
      'Webhook ожидания Zabbix problem': {
        main: [[{ node: 'Подготовка запроса ожидания Zabbix', type: 'main', index: 0 }]],
      },
      'Подготовка запроса ожидания Zabbix': {
        main: [[{ node: 'Запрос валиден?', type: 'main', index: 0 }]],
      },
      'Запрос валиден?': {
        main: [
          [
            { node: 'Ответ accepted', type: 'main', index: 0 },
            { node: 'Проверка статуса Zabbix', type: 'main', index: 0 },
          ],
          [{ node: 'Ответ ошибки валидации', type: 'main', index: 0 }],
        ],
      },
      'Проверка статуса Zabbix': {
        main: [[{ node: 'Zabbix ожидание завершено?', type: 'main', index: 0 }]],
      },
      'Zabbix ожидание завершено?': {
        main: [
          [{ node: 'Доставка async результата', type: 'main', index: 0 }],
          [{ node: 'Ожидание следующего опроса', type: 'main', index: 0 }],
        ],
      },
      'Ожидание следующего опроса': {
        main: [[{ node: 'Проверка статуса Zabbix', type: 'main', index: 0 }]],
      },
      'Доставка async результата': {
        main: [[{ node: 'Нужна Kafka delivery?', type: 'main', index: 0 }]],
      },
      'Нужна Kafka delivery?': {
        main: [
          [{ node: 'Публикация ExternalEvent в Kafka', type: 'main', index: 0 }],
          [{ node: 'Завершение async ветки', type: 'main', index: 0 }],
        ],
      },
      'Публикация ExternalEvent в Kafka': {
        main: [[{ node: 'Завершение async ветки', type: 'main', index: 0 }]],
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
    process.stdout.write('wait zabbix problem status workflow is up to date\n');
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
