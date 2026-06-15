#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const WORKFLOW_PATH = 'workflows/provider-channel-repair-monitor-webhook.json';

const LOCAL_POSTGRES_CREDENTIAL = {
  id: 'localServiceDeskPostgres',
  name: 'Local ServiceDesk Postgres',
};

const LOCAL_KAFKA_CREDENTIAL = {
  id: 'localRedpandaKafka',
  name: 'Local Redpanda Kafka',
};

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
    if (/token|password|secret|body|callback_url|email/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
};

const response = (statusCode, code, message, details = {}) => {
  diagnostic('Basic', 'provider_channel_repair_monitor_rejected', { statusCode, code });
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
const list = (value) => {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(list);
  return String(value).split(/[;,]/).map((item) => item.trim()).filter(Boolean);
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
  const envName = stringValue(envValue('NODE_ENV') || envValue('N8N_ENVIRONMENT') || envValue('ENVIRONMENT')).toLowerCase();
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

const host = stringValue(body.host || body.hostname || body.hostName);
const problemUrl = stringValue(body.problemUrl || body.problem_url);
const serviceRequest = stringValue(body.service_request || body.serviceRequest);
const pollIntervalMinutes = numberFrom(body.poll_interval_minutes, body.pollIntervalMinutes);
const timeoutMinutes = numberFrom(body.timeout_minutes, body.timeoutMinutes);
const templateId = stringValue(body.templateId || body.template_id || 'provider_channel_outage_test');

if (!host) return response(400, 'missing_host', 'Поле host обязательно.');
if (host.length > 500) return response(400, 'host_too_long', 'Поле host слишком длинное.');
if (!problemUrl) return response(400, 'missing_problem_url', 'Поле problemUrl обязательно.');
if (!serviceRequest) return response(400, 'missing_service_request', 'Поле service_request обязательно.');
if (serviceRequest.length > 160) return response(400, 'service_request_too_long', 'Поле service_request слишком длинное.');
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

const actionId = stringValue(invocation.action_id || 'monitor_provider_channel_repair');
if (actionId !== 'monitor_provider_channel_repair') {
  return response(400, 'invalid_action_id', 'Для этого endpoint action_id должен быть monitor_provider_channel_repair.', { action_id: actionId });
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
const startOfToday = new Date(now);
startOfToday.setHours(0, 0, 0, 0);
const windowStart = new Date(startOfToday);
windowStart.setDate(windowStart.getDate() - 1);
const deadline = new Date(now.getTime() + timeoutMinutes * 60 * 1000);
const invocationId = stringValue(invocation.invocation_id || body.request_id || body.requestId || ('provider-monitor-' + Date.now()));
const requestId = stringValue(body.request_id || body.requestId || invocationId);

const acceptedResponse = {
  runbook_status: 'accepted',
  message: 'n8n provider channel repair monitor принял запрос.',
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

diagnostic('Basic', 'provider_channel_repair_monitor_accepted', {
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
    host,
    problemUrl,
    service_request: serviceRequest,
    poll_interval_minutes: pollIntervalMinutes,
    timeout_minutes: timeoutMinutes,
    poll_seconds: pollIntervalMinutes * 60,
    started_at: now.toISOString(),
    deadline_at: deadline.toISOString(),
    window_start_at: windowStart.toISOString(),
    templateId,
    request_id: requestId,
    replyTo: stringValue(body.replyTo || body.reply_to),
    async_callback: asyncCallback,
    internal_webhook_base_url: internalWebhookBaseUrl,
    direct_recipients: {
      cc: list(body.cc),
      bcc: list(body.bcc)
    }
  }
}];`;

const initialActionsCode = String.raw`const state = $input.first().json || {};
const httpRequest = this?.helpers?.httpRequest?.bind(this.helpers);
if (!httpRequest) throw new Error('n8n httpRequest helper is not available in Code node.');
const internalToken = (typeof $env !== 'undefined' && $env.N8N_WEBHOOK_TOKEN) || (typeof process !== 'undefined' && process.env.N8N_WEBHOOK_TOKEN) || '';

const safeMessage = (error) => {
  const message = error?.message || String(error || 'unknown_error');
  return message.replace(/token|password|secret|authorization/ig, '[redacted]');
};

const terminalError = (code, message, details = {}) => ({
  ...state,
  terminal: true,
  response: {
    runbook_status: 'ERROR',
    message,
    error: { code, message, ...details },
    host: state.host,
    problemUrl: state.problemUrl,
    service_request: state.service_request,
    provider_email_context: state.provider_email_context || null,
    email_dispatch: state.email_dispatch || null,
    zabbix_status: state.zabbix_status || null,
    email_result: null,
    started_at: state.started_at,
    finished_at: new Date().toISOString(),
    poll_interval_minutes: state.poll_interval_minutes,
    timeout_minutes: state.timeout_minutes
  }
});

if (!internalToken) {
  return [{ json: terminalError('missing_internal_webhook_token', 'N8N_WEBHOOK_TOKEN не настроен для internal webhook call.') }];
}

async function postJson(path, body) {
  const url = state.internal_webhook_base_url + path;
  return await httpRequest({
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/json',
      'X-ServiceDesk-Token': internalToken
    },
    body,
    json: true
  });
}

let providerContext;
try {
  providerContext = await postJson('/cmdbuild/provider-email-context', { hostname: state.host });
} catch (error) {
  return [{ json: terminalError('provider_context_failed', 'Не удалось получить параметры письма провайдеру из CMDBuild.', { reason: safeMessage(error) }) }];
}
if (!providerContext || providerContext.status !== 'OK') {
  return [{ json: terminalError('provider_context_invalid', 'CMDBuild вернул некорректный контекст письма провайдеру.') }];
}

const emailPayload = {
  to: [providerContext.provider_email],
  cc: state.direct_recipients?.cc || [],
  bcc: state.direct_recipients?.bcc || [],
  replyTo: state.replyTo || '',
  templateId: state.templateId,
  request_id: state.request_id,
  params: {
    city: providerContext.city,
    location: providerContext.location,
    ip_address: providerContext.ip_address,
    contract: providerContext.contract,
    service_request: state.service_request
  }
};

let emailDispatch;
try {
  emailDispatch = await postJson('/email/send-template', emailPayload);
} catch (error) {
  return [{
    json: terminalError('provider_email_send_failed', 'Не удалось отправить письмо провайдеру.', {
      reason: safeMessage(error),
      provider_email_context: { ...providerContext, provider_email: '[redacted]' }
    })
  }];
}
if (!emailDispatch || emailDispatch.status !== 'sent') {
  return [{ json: terminalError('provider_email_not_sent', 'Endpoint отправки письма не подтвердил отправку.', { email_dispatch: emailDispatch || null }) }];
}

return [{
  json: {
    ...state,
    terminal: false,
    provider_email_context: providerContext,
    email_dispatch: {
      status: 'sent',
      templateId: state.templateId,
      request_id: state.request_id,
      to: providerContext.provider_email
    }
  }
}];`;

const zabbixCheckCode = String.raw`const state = $input.first().json || {};
const httpRequest = this?.helpers?.httpRequest?.bind(this.helpers);
if (!httpRequest) throw new Error('n8n httpRequest helper is not available in Code node.');
const internalToken = (typeof $env !== 'undefined' && $env.N8N_WEBHOOK_TOKEN) || (typeof process !== 'undefined' && process.env.N8N_WEBHOOK_TOKEN) || '';

const safeMessage = (error) => String(error?.message || error || 'unknown_error').replace(/token|password|secret|authorization/ig, '[redacted]');
const terminal = (runbookStatus, message, extra = {}) => ({
  ...state,
  ...extra,
  terminal: true,
  response: {
    runbook_status: runbookStatus,
    message,
    host: state.host,
    problemUrl: state.problemUrl,
    service_request: state.service_request,
    provider_email_context: state.provider_email_context || null,
    email_dispatch: state.email_dispatch || null,
    zabbix_status: extra.zabbix_status || state.zabbix_status || null,
    email_result: null,
    started_at: state.started_at,
    finished_at: new Date().toISOString(),
    poll_interval_minutes: state.poll_interval_minutes,
    timeout_minutes: state.timeout_minutes,
    ...extra
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

const nextState = { ...state, terminal: false, zabbix_status: zabbixStatus };
if (zabbixStatus && ['ok', 'resolved'].includes(String(zabbixStatus.status))) {
  return [{ json: terminal('RESOLVED', 'Zabbix problem перешел в OK/resolved.', { zabbix_status: zabbixStatus }) }];
}

return [{ json: nextState }];`;

const buildEmailSearchSqlCode = String.raw`const state = $input.first().json || {};

const sqlString = (value) => {
  if (value === undefined || value === null) return 'NULL';
  return "'" + String(value).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
};

const stateJson = JSON.stringify(state);
const ticket = sqlString(state.service_request);
const createTableSql = [
  'CREATE TABLE IF NOT EXISTS n8n_mail_index (',
  '  id bigserial PRIMARY KEY,',
  '  message_id text NOT NULL UNIQUE,',
  "  mailbox text NOT NULL DEFAULT 'INBOX',",
  '  from_email text,',
  '  subject text,',
  '  body_text text,',
  '  body_truncated boolean NOT NULL DEFAULT false,',
  '  received_at timestamptz NOT NULL,',
  '  indexed_at timestamptz NOT NULL DEFAULT now(),',
  '  is_delivery_failure boolean NOT NULL DEFAULT false,',
  '  delivery_failure_reason text',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_n8n_mail_index_received_at ON n8n_mail_index (received_at);',
  'CREATE INDEX IF NOT EXISTS idx_n8n_mail_index_delivery_failure ON n8n_mail_index (is_delivery_failure, received_at);'
].join('\n');

const sql = [
  createTableSql,
  'WITH matches AS (',
  '  SELECT id, message_id, mailbox, from_email, subject, body_text, body_truncated, received_at, indexed_at, is_delivery_failure, delivery_failure_reason',
  '  FROM n8n_mail_index',
  '  WHERE received_at >= ' + sqlString(state.window_start_at) + '::timestamptz',
  '    AND received_at <= now()',
  "    AND position(lower(" + ticket + ") in lower(coalesce(subject, '') || E'\\n' || coalesce(body_text, ''))) > 0",
  '),',
  'delivery_failures AS (SELECT * FROM matches WHERE is_delivery_failure = true),',
  'first_delivery_failure AS (SELECT * FROM delivery_failures ORDER BY received_at ASC, id ASC LIMIT 1),',
  'first_match AS (SELECT * FROM matches ORDER BY received_at ASC, id ASC LIMIT 1)',
  'SELECT',
  '  ' + sqlString(stateJson) + ' AS state_json,',
  '  (SELECT count(*)::int FROM matches) AS match_count,',
  '  (SELECT count(*)::int FROM delivery_failures) AS delivery_failure_count,',
  '  (SELECT row_to_json(first_delivery_failure)::text FROM first_delivery_failure) AS delivery_failure_match_json,',
  '  (SELECT row_to_json(first_match)::text FROM first_match) AS first_match_json;'
].join('\n');

return [{ json: { ...state, sql } }];`;

const evaluateEmailResultCode = String.raw`const row = $input.first().json || {};
const parseJson = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const text = (value) => value === undefined || value === null ? null : String(value);
const state = parseJson(row.state_json) || {};
const matchCount = Number(row.match_count || 0);
const deliveryFailureCount = Number(row.delivery_failure_count || 0);
const deliveryFailureMatch = parseJson(row.delivery_failure_match_json);
const firstMatch = parseJson(row.first_match_json);
const selectedMatch = deliveryFailureMatch || firstMatch;
const now = new Date();
const deadline = new Date(state.deadline_at);

let status = null;
if (deliveryFailureCount > 0) status = 'DELIVERY_FAILED';
else if (matchCount === 1) status = 'OK';
else if (matchCount > 1) status = 'MULTI_MAIL';
else if (now >= deadline) status = 'NOT_FOUND';

const emailResult = {
  status,
  ticket_number: state.service_request,
  subject: selectedMatch ? text(selectedMatch.subject) : null,
  body: selectedMatch ? text(selectedMatch.body_text) : null,
  body_truncated: selectedMatch ? Boolean(selectedMatch.body_truncated) : false,
  from: selectedMatch ? text(selectedMatch.from_email) : null,
  received_at: selectedMatch ? text(selectedMatch.received_at) : null,
  message_id: selectedMatch ? text(selectedMatch.message_id) : null,
  mailbox: selectedMatch ? text(selectedMatch.mailbox) : null,
  is_delivery_failure: selectedMatch ? Boolean(selectedMatch.is_delivery_failure) : false,
  delivery_failure_reason: selectedMatch ? text(selectedMatch.delivery_failure_reason) : null,
  match_count: matchCount,
  delivery_failure_count: deliveryFailureCount,
  poll_interval_minutes: Number(state.poll_interval_minutes),
  timeout_minutes: Number(state.timeout_minutes),
  started_at: state.started_at,
  finished_at: now.toISOString()
};

if (status) {
  const message = status === 'NOT_FOUND'
    ? 'Zabbix problem не resolved/ok и письмо провайдера не найдено за время ожидания.'
    : 'Получен результат проверки входящего письма провайдера.';
  return [{
    json: {
      ...state,
      terminal: true,
      response: {
        runbook_status: status,
        message,
        host: state.host,
        problemUrl: state.problemUrl,
        service_request: state.service_request,
        provider_email_context: state.provider_email_context || null,
        email_dispatch: state.email_dispatch || null,
        zabbix_status: state.zabbix_status || null,
        email_result: emailResult,
        started_at: state.started_at,
        finished_at: now.toISOString(),
        poll_interval_minutes: Number(state.poll_interval_minutes),
        timeout_minutes: Number(state.timeout_minutes)
      }
    }
  }];
}

const secondsUntilDeadline = Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 1000));
const pollSeconds = Number(state.poll_seconds || 60);
const nextWaitSeconds = Math.max(1, Math.min(pollSeconds, secondsUntilDeadline || pollSeconds));
const nextWaitAt = new Date(now.getTime() + nextWaitSeconds * 1000).toISOString();
return [{ json: { ...state, terminal: false, next_wait_seconds: nextWaitSeconds, next_wait_at: nextWaitAt } }];`;

const deliverAsyncResultCode = String.raw`const input = $input.first().json || {};
const response = input.response || {};
const asyncCallback = input.async_callback;
if (!asyncCallback) throw new Error('async_callback is required for async result delivery.');

const normalizeSource = (value) => String(value || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
const transport = String(asyncCallback.result_transport || '');
const statusToExternal = (status) => {
  if (status === 'NOT_FOUND') return 'timeout';
  if (status === 'ERROR' || status === 'DELIVERY_FAILED') return 'error';
  return 'success';
};
const eventSuffix = String(response.runbook_status || 'UNKNOWN').toLowerCase();
const shouldPublishKafka = transport === 'kafka_event' || transport === 'both';
const deliveryStatus = {
  requested_transport: transport,
  http_callback: (transport === 'http_callback' || transport === 'both') ? 'pending' : 'not_requested',
  kafka_event: shouldPublishKafka ? 'pending' : 'not_requested'
};
const externalEvent = {
  schema_version: '1.0',
  event_id: asyncCallback.idempotency_key_base + ':provider_channel_repair_' + eventSuffix,
  case_id: asyncCallback.case_id,
  wait_id: asyncCallback.wait_id,
  correlation_id: asyncCallback.correlation_id,
  source: asyncCallback.source,
  event_type: asyncCallback.event_type,
  status: statusToExternal(response.runbook_status),
  idempotency_key: asyncCallback.idempotency_key_base + ':provider_channel_repair_' + eventSuffix,
  result: {
    action_id: input.action_id || 'monitor_provider_channel_repair',
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

function postgresNode(id, name, position) {
  return {
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: '={{ $json.sql }}',
      options: {
        queryBatching: 'independently',
      },
    },
    id,
    name,
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position,
    credentials: {
      postgres: LOCAL_POSTGRES_CREDENTIAL,
    },
  };
}

function workflow() {
  return documentedWorkflow({
    id: 'providerChannelRepairMonitor',
    name: 'Provider: письмо и мониторинг ремонта канала',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'provider/channel-repair/monitor',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'provider-channel-monitor-webhook',
        name: 'Webhook мониторинга ремонта канала',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '087e7a73-5cc0-444b-a630-319f4327f7f1',
        position: [240, 300],
      },
      codeNode('provider-channel-monitor-prepare', 'Подготовка запроса мониторинга', prepareRequestCode, [520, 300]),
      ifNode('provider-channel-monitor-valid', 'Запрос валиден?', [800, 300], '={{ $json.valid }}'),
      respondNode('provider-channel-monitor-validation-error', 'Ответ ошибки валидации', [1080, 480]),
      respondNode('provider-channel-monitor-accepted', 'Ответ accepted', [1080, 160]),
      codeNode('provider-channel-monitor-initial-actions', 'Получение контекста и отправка письма', initialActionsCode, [1360, 160]),
      ifNode('provider-channel-monitor-initial-terminal', 'Начальный этап терминальный?', [1640, 160], '={{ $json.terminal }}'),
      codeNode('provider-channel-monitor-zabbix-check', 'Проверка статуса Zabbix', zabbixCheckCode, [1920, 320]),
      ifNode('provider-channel-monitor-zabbix-terminal', 'Zabbix завершил ранбук?', [2200, 320], '={{ $json.terminal }}'),
      codeNode('provider-channel-monitor-build-email-sql', 'Подготовка SQL поиска письма', buildEmailSearchSqlCode, [2480, 480]),
      postgresNode('provider-channel-monitor-email-search', 'Поиск письма в индексе', [2760, 480]),
      codeNode('provider-channel-monitor-evaluate-email', 'Оценка ответа провайдера', evaluateEmailResultCode, [3040, 480]),
      ifNode('provider-channel-monitor-email-terminal', 'Email завершил ранбук?', [3320, 480], '={{ $json.terminal }}'),
      {
        parameters: {
          resume: 'specificTime',
          dateTime: '={{ $json.next_wait_at }}',
        },
        id: 'provider-channel-monitor-wait',
        name: 'Ожидание следующего опроса',
        type: 'n8n-nodes-base.wait',
        typeVersion: 1.1,
        position: [3600, 620],
      },
      codeNode('provider-channel-monitor-deliver-result', 'Доставка async результата', deliverAsyncResultCode, [3600, 160]),
      ifNode('provider-channel-monitor-needs-kafka', 'Нужна Kafka delivery?', [3880, 160], '={{ $json.shouldPublishKafka }}'),
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
        id: 'provider-channel-monitor-kafka-publish',
        name: 'Публикация ExternalEvent в Kafka',
        type: 'n8n-nodes-base.kafka',
        typeVersion: 1,
        position: [4160, 80],
        credentials: {
          kafka: LOCAL_KAFKA_CREDENTIAL,
        },
      },
      codeNode('provider-channel-monitor-async-done', 'Завершение async ветки', asyncDoneCode, [4440, 160]),
    ],
    connections: {
      'Webhook мониторинга ремонта канала': {
        main: [[{ node: 'Подготовка запроса мониторинга', type: 'main', index: 0 }]],
      },
      'Подготовка запроса мониторинга': {
        main: [[{ node: 'Запрос валиден?', type: 'main', index: 0 }]],
      },
      'Запрос валиден?': {
        main: [
          [{ node: 'Ответ accepted', type: 'main', index: 0 }],
          [{ node: 'Ответ ошибки валидации', type: 'main', index: 0 }],
        ],
      },
      'Ответ accepted': {
        main: [[{ node: 'Получение контекста и отправка письма', type: 'main', index: 0 }]],
      },
      'Получение контекста и отправка письма': {
        main: [[{ node: 'Начальный этап терминальный?', type: 'main', index: 0 }]],
      },
      'Начальный этап терминальный?': {
        main: [
          [{ node: 'Доставка async результата', type: 'main', index: 0 }],
          [{ node: 'Проверка статуса Zabbix', type: 'main', index: 0 }],
        ],
      },
      'Проверка статуса Zabbix': {
        main: [[{ node: 'Zabbix завершил ранбук?', type: 'main', index: 0 }]],
      },
      'Zabbix завершил ранбук?': {
        main: [
          [{ node: 'Доставка async результата', type: 'main', index: 0 }],
          [{ node: 'Подготовка SQL поиска письма', type: 'main', index: 0 }],
        ],
      },
      'Подготовка SQL поиска письма': {
        main: [[{ node: 'Поиск письма в индексе', type: 'main', index: 0 }]],
      },
      'Поиск письма в индексе': {
        main: [[{ node: 'Оценка ответа провайдера', type: 'main', index: 0 }]],
      },
      'Оценка ответа провайдера': {
        main: [[{ node: 'Email завершил ранбук?', type: 'main', index: 0 }]],
      },
      'Email завершил ранбук?': {
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
    process.stdout.write('provider channel repair monitor workflow is up to date\n');
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
