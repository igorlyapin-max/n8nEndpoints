#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';
import { serviceDeskEnvironmentExpression } from './servicedesk-async-runbook-runtime.mjs';

const WORKFLOW_PATH = 'workflows/provider-channel-repair-monitor-webhook.json';
const WORKFLOW_ID = 'providerChannelRepairMonitor';
const WORKFLOW_NAME = 'Provider: письмо и мониторинг ремонта канала';

const LOCAL_POSTGRES_CREDENTIAL = {
  id: 'localServiceDeskPostgres',
  name: 'Local ServiceDesk Postgres',
};

const LOCAL_KAFKA_CREDENTIAL = {
  id: 'localRedpandaKafka',
  name: 'Local Redpanda Kafka',
};

const LOCAL_CMDBUILD_CREDENTIAL = {
  id: 'localCmdbuildAdminTest',
  name: 'Local CMDBuild Admin Test',
};

const LOCAL_SMTP_CREDENTIAL = {
  id: 'Fh3kVhbHL6XxDh1c',
  name: 'GreenMail SMTP (local test)',
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

const problemHost = stringValue(body.problem_host || body.problemHost || body.host || body.hostname || body.hostName);
const routerRef = stringValue(body.router_ref || body.routerRef || body.router || body.router_code || body.routerCode);
const routerLookupValue = routerRef || problemHost;
const problemUrl = stringValue(body.problemUrl || body.problem_url);
const serviceRequest = stringValue(body.service_request || body.serviceRequest);
const pollIntervalMinutes = numberFrom(body.poll_interval_minutes, body.pollIntervalMinutes);
const timeoutMinutes = numberFrom(body.timeout_minutes, body.timeoutMinutes);
const templateId = stringValue(body.templateId || body.template_id || 'provider_channel_outage_test');
const fromEmail = stringValue(body.from);
const replyTo = stringValue(body.replyTo || body.reply_to);
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (!problemHost && !routerRef) return response(400, 'missing_problem_host', 'Укажите problem_host или router_ref.');
if (problemHost.length > 500) return response(400, 'problem_host_too_long', 'Поле problem_host слишком длинное.');
if (routerRef.length > 500) return response(400, 'router_ref_too_long', 'Поле router_ref слишком длинное.');
if (!problemUrl) return response(400, 'missing_problem_url', 'Поле problemUrl обязательно.');
if (!serviceRequest) return response(400, 'missing_service_request', 'Поле service_request обязательно.');
if (!fromEmail) return response(400, 'missing_from', 'Поле from обязательно.');
if (!replyTo) return response(400, 'missing_reply_to', 'Поле replyTo обязательно.');
if (serviceRequest.length > 160) return response(400, 'service_request_too_long', 'Поле service_request слишком длинное.');
const invalidEmails = [fromEmail, replyTo, ...list(body.cc), ...list(body.bcc)].filter((value) => value && !emailRe.test(value));
if (invalidEmails.length) return response(400, 'invalid_email', 'Некорректный email адрес.', { addresses: invalidEmails });
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
    host: problemHost || routerRef,
    problem_host: problemHost || null,
    router_ref: routerRef || null,
    router_lookup_value: routerLookupValue,
    router_lookup_source: routerRef ? 'router_ref' : 'problem_host',
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
    from_email: fromEmail,
    reply_to: replyTo,
    reply_mailbox_address: replyTo,
    async_callback: asyncCallback,
    internal_webhook_base_url: internalWebhookBaseUrl,
    direct_recipients: {
      cc: list(body.cc),
      bcc: list(body.bcc)
    }
  }
}];`;

const workerInputCode = String.raw`const state = $input.first().json || {};
return [{ json: state }];`;

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
    problem_host: state.problem_host || null,
    router_ref: state.router_ref || null,
    router_lookup_status: state.router_lookup_status || null,
    router_lookup_source: state.router_lookup_source || null,
    router_lookup_value: state.router_lookup_value || null,
    router_candidates: state.router_candidates || [],
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
  const now = new Date();
  const deadline = new Date(state.deadline_at);
  const failure = {
    code: 'zabbix_status_failed',
    message: 'Не удалось проверить статус Zabbix problem.',
    reason: safeMessage(error),
    checked_at: now.toISOString()
  };
  if (now >= deadline) {
    return [{
      json: terminal('ERROR', 'Не удалось проверить статус Zabbix problem.', {
        error: failure
      })
    }];
  }
  return [{
    json: {
      ...state,
      terminal: false,
      zabbix_status: state.zabbix_status || null,
      zabbix_status_last_error: failure
    }
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
const replyMailboxAddress = sqlString(state.reply_mailbox_address || state.reply_to);
const createTableSql = [
  'CREATE TABLE IF NOT EXISTS n8n_mail_index (',
  '  id bigserial PRIMARY KEY,',
  '  message_id text NOT NULL UNIQUE,',
  "  mailbox text NOT NULL DEFAULT 'INBOX',",
  '  mailbox_address text,',
  '  from_email text,',
  '  subject text,',
  '  body_text text,',
  '  body_truncated boolean NOT NULL DEFAULT false,',
  '  received_at timestamptz NOT NULL,',
  '  indexed_at timestamptz NOT NULL DEFAULT now(),',
  '  is_delivery_failure boolean NOT NULL DEFAULT false,',
  '  delivery_failure_reason text',
  ');',
  'ALTER TABLE n8n_mail_index ADD COLUMN IF NOT EXISTS mailbox_address text;',
  'CREATE INDEX IF NOT EXISTS idx_n8n_mail_index_received_at ON n8n_mail_index (received_at);',
  "CREATE INDEX IF NOT EXISTS idx_n8n_mail_index_mailbox_address ON n8n_mail_index (lower(coalesce(mailbox_address, '')));",
  'CREATE INDEX IF NOT EXISTS idx_n8n_mail_index_delivery_failure ON n8n_mail_index (is_delivery_failure, received_at);'
].join('\n');

const sql = [
  createTableSql,
  'WITH matches AS (',
  '  SELECT id, message_id, mailbox, mailbox_address, from_email, subject, body_text, body_truncated, received_at, indexed_at, is_delivery_failure, delivery_failure_reason',
  '  FROM n8n_mail_index',
  '  WHERE received_at >= ' + sqlString(state.window_start_at) + '::timestamptz',
  '    AND received_at <= now()',
  "    AND lower(coalesce(mailbox_address, '')) = lower(" + replyMailboxAddress + ")",
  "    AND position(lower(" + ticket + ") in lower(coalesce(subject, '') || E'\\n' || coalesce(body_text, ''))) > 0",
  '),',
  'mailbox_index AS (',
  "  SELECT count(*)::int AS count FROM n8n_mail_index WHERE lower(coalesce(mailbox_address, '')) = lower(" + replyMailboxAddress + ")",
  '),',
  'delivery_failures AS (SELECT * FROM matches WHERE is_delivery_failure = true),',
  'first_delivery_failure AS (SELECT * FROM delivery_failures ORDER BY received_at ASC, id ASC LIMIT 1),',
  'first_match AS (SELECT * FROM matches ORDER BY received_at ASC, id ASC LIMIT 1)',
  'SELECT',
  '  ' + sqlString(stateJson) + ' AS state_json,',
  '  (SELECT count(*)::int FROM matches) AS match_count,',
  '  (SELECT count::int FROM mailbox_index) AS mailbox_indexed_count,',
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
const mailboxIndexedCount = Number(row.mailbox_indexed_count || 0);
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
else if (now >= deadline && mailboxIndexedCount === 0) status = 'ERROR';
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
  mailbox_address: selectedMatch ? text(selectedMatch.mailbox_address) : text(state.reply_mailbox_address || state.reply_to),
  reply_mailbox_address: text(state.reply_mailbox_address || state.reply_to),
  mailbox_indexed_count: mailboxIndexedCount,
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
  const replyMailboxMissing = status === 'ERROR' && mailboxIndexedCount === 0;
  const message = replyMailboxMissing
    ? 'Ящик Reply-To не индексируется активным IMAP collector.'
    : status === 'NOT_FOUND'
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
        error: replyMailboxMissing ? { code: 'reply_mailbox_not_indexed', message, reply_mailbox_address: text(state.reply_mailbox_address || state.reply_to) } : undefined,
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
const pollIteration = Number(state.poll_iteration || 0) + 1;
const pollingDiagnostic = {
  schema_version: '1.0',
  current_status: 'polling',
  poll_iteration: pollIteration,
  last_poll_at: now.toISOString(),
  next_poll_at: nextWaitAt,
  checked_resource: 'n8n_mail_index',
  service_request: state.service_request,
  reply_mailbox_address: text(state.reply_mailbox_address || state.reply_to),
  mailbox_indexed_count: mailboxIndexedCount,
  match_count: matchCount,
  delivery_failure_count: deliveryFailureCount,
  zabbix_status: state.zabbix_status?.status || null,
  deadline_at: state.deadline_at,
  last_error: state.zabbix_status_last_error || null,
  correlation_id: state.async_callback?.correlation_id || null,
  wait_id: state.async_callback?.wait_id || null
};
return [{
  json: {
    ...state,
    terminal: false,
    poll_iteration: pollIteration,
    next_wait_seconds: nextWaitSeconds,
    next_wait_at: nextWaitAt,
    polling_diagnostic: pollingDiagnostic,
    response: {
      runbook_status: 'PROGRESS',
      message: 'n8n provider channel repair monitor продолжает polling: ответ провайдера пока не найден.',
      host: state.host,
      problemUrl: state.problemUrl,
      service_request: state.service_request,
      provider_email_context: state.provider_email_context || null,
      email_dispatch: state.email_dispatch || null,
      zabbix_status: state.zabbix_status || null,
      email_result: emailResult,
      polling_diagnostic: pollingDiagnostic,
      started_at: state.started_at,
      poll_interval_minutes: Number(state.poll_interval_minutes),
      timeout_minutes: Number(state.timeout_minutes)
    }
  }
}];`;

const deliverAsyncResultCode = String.raw`const input = $input.first().json || {};
const response = input.response || {};
const asyncCallback = input.async_callback;
if (!asyncCallback) throw new Error('async_callback is required for async result delivery.');

const normalizeSource = (value) => String(value || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
const transport = String(asyncCallback.result_transport || '');
const statusToExternal = (status) => {
  if (status === 'PROGRESS') return 'progress';
  if (status === 'NOT_FOUND') return 'timeout';
  if (status === 'ERROR' || status === 'DELIVERY_FAILED') return 'error';
  return 'success';
};
const rawRunbookStatus = String(response.runbook_status || 'UNKNOWN');
const externalStatus = statusToExternal(rawRunbookStatus);
const progressIteration = response.polling_diagnostic?.poll_iteration;
const eventSuffix = externalStatus === 'progress' && progressIteration
  ? 'progress_' + String(progressIteration).replace(/[^A-Za-z0-9_.-]+/g, '_')
  : rawRunbookStatus.toLowerCase();
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
  status: externalStatus,
  idempotency_key: asyncCallback.idempotency_key_base + ':provider_channel_repair_' + eventSuffix,
  result: {
    action_id: input.action_id || 'monitor_provider_channel_repair',
    invocation_id: input.invocation_id,
    ...response
  }
};
delete externalEvent.result.delivery_status;
delete externalEvent.result.deliveryStatus;

if (externalStatus === 'error') {
  const errorPayload = response.error && typeof response.error === 'object' ? response.error : {};
  externalEvent.error = {
    code: String(errorPayload.code || response.runbook_status || 'provider_channel_repair_error'),
    message: String(errorPayload.message || response.message || 'Provider channel repair workflow failed.').slice(0, 1000)
  };
}

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
const progressDoneCode = "return [{ json: { ...($input.first().json || {}), progress_delivered: true } }];";

function terminalErrorCode() {
  return String.raw`const baseState = (state) => ({
  ...state,
  terminal: true,
});

function terminalError(state, code, message, details = {}) {
  return baseState({
    ...state,
    response: {
      runbook_status: 'ERROR',
      message,
      error: { code, message, ...details },
      host: state.host,
      problem_host: state.problem_host || null,
      router_ref: state.router_ref || null,
      router_lookup_status: details.router_lookup_status || state.router_lookup_status || 'error',
      router_lookup_source: details.router_lookup_source || state.router_lookup_source || null,
      router_lookup_value: details.router_lookup_value || state.router_lookup_value || null,
      router_candidates: details.router_candidates || state.router_candidates || [],
      problemUrl: state.problemUrl,
      service_request: state.service_request,
      provider_email_context: state.provider_email_context || null,
      email_dispatch: state.email_dispatch || null,
      from: details.from || state.from_email || null,
      reply_to: details.reply_to || state.reply_to || null,
      reply_mailbox_address: details.reply_mailbox_address || state.reply_mailbox_address || null,
      mailbox_wait_strategy: details.mailbox_wait_strategy || state.mailbox_wait_strategy || null,
      zabbix_status: state.zabbix_status || null,
      email_result: null,
      started_at: state.started_at,
      finished_at: new Date().toISOString(),
      poll_interval_minutes: state.poll_interval_minutes,
      timeout_minutes: state.timeout_minutes
    }
  });
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function bodyOf(value) {
  return value && value.body && typeof value.body === 'object' ? value.body : value;
}

function statusOf(value) {
  return Number(value?.statusCode || 200);
}

function safeMessage(error) {
  return String(error?.message || error || 'unknown_error').replace(/token|password|secret|authorization/ig, '[redacted]').slice(0, 500);
}`;
}

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

function executeWorkflowNode(id, name, position) {
  return {
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: WORKFLOW_ID,
        cachedResultName: WORKFLOW_NAME,
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {},
        schema: [],
      },
      mode: 'once',
      options: {
        waitForSubWorkflow: false,
      },
    },
    id,
    name,
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1.3,
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

function providerCmdbuildEmailNodes() {
  const common = terminalErrorCode();
  return [
    codeNode(
      'provider-channel-monitor-cmdbuild-prepare',
      'Подготовка CMDBuild контекста',
      `${common}

const state = $input.first().json || {};
const rawBaseUrl = text((typeof $env !== 'undefined' && $env.CMDBUILD_BASE_URL) || (typeof process !== 'undefined' && process.env.CMDBUILD_BASE_URL) || 'http://172.18.0.4:8080/cmdbuild');
if (!/^https?:\\/\\/[^/?#]+(?:\\/[^?#]*)?$/i.test(rawBaseUrl)) {
  return [{ json: terminalError(state, 'invalid_cmdbuild_base_url', 'CMDBUILD_BASE_URL должен быть http/https URL без query/fragment.') }];
}
const cmdbuildBaseUrl = rawBaseUrl.replace(/\\/+$/, '');
const routerLookupValue = text(state.router_ref || state.router_lookup_value || state.host);
if (!routerLookupValue) {
  return [{ json: terminalError(state, 'missing_router_ref', 'Не задан router_ref для поиска routerG.', { problem_host: state.problem_host || state.host || null }) }];
}
const filter = {
  attribute: {
    or: [
      {
        simple: {
          attribute: 'Description',
          operator: 'equal',
          value: [routerLookupValue]
        }
      },
      {
        simple: {
          attribute: 'hostname',
          operator: 'equal',
          value: [routerLookupValue]
        }
      },
      {
        simple: {
          attribute: 'Code',
          operator: 'equal',
          value: [routerLookupValue]
        }
      }
    ]
  }
};
return [{
  json: {
    ...state,
    terminal: false,
    cmdbuild_base_url: cmdbuildBaseUrl,
    router_lookup_value: routerLookupValue,
    router_search_url: cmdbuildBaseUrl + '/services/rest/v3/classes/routerG/cards?limit=2&filter=' + encodeURIComponent(JSON.stringify(filter))
  }
}];`,
      [1360, 160],
    ),
    {
      id: 'provider-channel-monitor-cmdbuild-search-router',
      name: 'CMDBuild поиск routerG',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.1,
      position: [1640, 160],
      parameters: {
        url: '={{ $json.router_search_url }}',
        options: {
          response: {
            response: {
              neverError: true,
              fullResponse: true,
              responseFormat: 'json',
            },
          },
        },
        authentication: 'genericCredentialType',
        genericAuthType: 'httpBasicAuth',
      },
      credentials: {
        httpBasicAuth: LOCAL_CMDBUILD_CREDENTIAL,
      },
    },
    codeNode(
      'provider-channel-monitor-cmdbuild-parse-router',
      'Разбор routerG для письма',
      `${common}

const state = $('Подготовка CMDBuild контекста').first().json || {};
const searchResponse = $input.first().json || {};
const body = bodyOf(searchResponse);
const httpStatus = statusOf(searchResponse);
if (httpStatus === 401 || httpStatus === 403) {
  return [{ json: terminalError(state, 'cmdbuild_auth_failed', 'CMDBuild authentication failed.', { http_status: httpStatus }) }];
}
if (httpStatus >= 400 || body?.success === false) {
  return [{ json: terminalError(state, 'cmdbuild_lookup_failed', 'CMDBuild routerG lookup failed.', { cmdbuild_status: httpStatus || null }) }];
}

const rows = Array.isArray(body?.data) ? body.data : [];
const total = Number(body?.meta?.total ?? rows.length);
if (total === 0 || rows.length === 0) {
  const code = state.router_lookup_source === 'router_ref' ? 'router_not_found' : 'router_context_not_resolved';
  const message = state.router_lookup_source === 'router_ref'
    ? 'routerG не найден по Description, hostname или Code.'
    : 'Не удалось определить routerG по problem_host. Укажите router_ref или настройте resolver связи host -> routerG.';
  return [{ json: terminalError(state, code, message, {
    hostname: state.host,
    problem_host: state.problem_host || state.host || null,
    router_ref: state.router_ref || null,
    router_lookup_value: state.router_lookup_value || null,
    router_lookup_status: 'not_found',
    router_candidates: []
  }) }];
}
if (total > 1 || rows.length > 1) {
  const candidates = rows.slice(0, 5).map((row) => ({
    router_id: row._id || row.Id || null,
    code: text(row.Code),
    description: text(row.Description),
    hostname: text(row.hostname)
  }));
  return [{ json: terminalError(state, 'router_not_unique', 'По router_ref/problem_host найдено несколько routerG объектов.', {
    hostname: state.host,
    match_count: total || rows.length,
    router_lookup_status: 'not_unique',
    router_lookup_value: state.router_lookup_value || null,
    router_candidates: candidates
  }) }];
}

const router = rows[0] || {};
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
  return [{ json: terminalError(state, 'missing_cmdbuild_field', 'В routerG не заполнены обязательные атрибуты.', {
    hostname: state.host,
    router_id: router._id || null,
    missing_fields: missing
  }) }];
}

return [{
  json: {
    ...state,
    terminal: false,
    router_lookup_status: 'resolved',
    router_lookup_source: state.router_lookup_source || null,
    router_lookup_value: state.router_lookup_value || null,
    router_id: router._id,
    router_code: text(router.Code),
    router_hostname: text(router.hostname) || text(router.Description) || text(router.Code),
    provider_email: providerEmail,
    contract,
    ipaddress_id: ipaddressId,
    room_id: roomId,
    ip_url: state.cmdbuild_base_url + '/services/rest/v3/classes/IpAddress/cards/' + encodeURIComponent(ipaddressId),
    room_url: state.cmdbuild_base_url + '/services/rest/v3/classes/Room/cards/' + encodeURIComponent(roomId)
  }
}];`,
      [1920, 160],
    ),
    ifNode('provider-channel-monitor-cmdbuild-terminal', 'CMDBuild контекст терминальный?', [2200, 160], '={{ $json.terminal }}'),
    {
      id: 'provider-channel-monitor-cmdbuild-get-ip',
      name: 'CMDBuild чтение IpAddress',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.1,
      position: [2480, 300],
      parameters: {
        url: '={{ $json.ip_url }}',
        options: {
          response: {
            response: {
              neverError: true,
              fullResponse: true,
              responseFormat: 'json',
            },
          },
        },
        authentication: 'genericCredentialType',
        genericAuthType: 'httpBasicAuth',
      },
      credentials: {
        httpBasicAuth: LOCAL_CMDBUILD_CREDENTIAL,
      },
    },
    {
      id: 'provider-channel-monitor-cmdbuild-get-room',
      name: 'CMDBuild чтение Room',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.1,
      position: [2760, 300],
      parameters: {
        url: "={{ $('Разбор routerG для письма').first().json.room_url }}",
        options: {
          response: {
            response: {
              neverError: true,
              fullResponse: true,
              responseFormat: 'json',
            },
          },
        },
        authentication: 'genericCredentialType',
        genericAuthType: 'httpBasicAuth',
      },
      credentials: {
        httpBasicAuth: LOCAL_CMDBUILD_CREDENTIAL,
      },
    },
    {
      id: 'provider-channel-monitor-cmdbuild-get-floor',
      name: 'CMDBuild чтение Floor',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.1,
      position: [3040, 300],
      parameters: {
        url: "={{ $('Разбор routerG для письма').first().json.cmdbuild_base_url + '/services/rest/v3/classes/Floor/cards/' + (((($('CMDBuild чтение Room').first().json.body || {}).data || {}).Floor) || '0') }}",
        options: {
          response: {
            response: {
              neverError: true,
              fullResponse: true,
              responseFormat: 'json',
            },
          },
        },
        authentication: 'genericCredentialType',
        genericAuthType: 'httpBasicAuth',
      },
      credentials: {
        httpBasicAuth: LOCAL_CMDBUILD_CREDENTIAL,
      },
    },
    {
      id: 'provider-channel-monitor-cmdbuild-get-building',
      name: 'CMDBuild чтение Building',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.1,
      position: [3320, 300],
      parameters: {
        url: "={{ $('Разбор routerG для письма').first().json.cmdbuild_base_url + '/services/rest/v3/classes/Building/cards/' + (((($('CMDBuild чтение Floor').first().json.body || {}).data || {}).Building) || '0') }}",
        options: {
          response: {
            response: {
              neverError: true,
              fullResponse: true,
              responseFormat: 'json',
            },
          },
        },
        authentication: 'genericCredentialType',
        genericAuthType: 'httpBasicAuth',
      },
      credentials: {
        httpBasicAuth: LOCAL_CMDBUILD_CREDENTIAL,
      },
    },
    codeNode(
      'provider-channel-monitor-cmdbuild-normalize',
      'Нормализация CMDBuild контекста',
      `${common}

const state = $('Разбор routerG для письма').first().json || {};
const ipResponse = $('CMDBuild чтение IpAddress').first().json || {};
const roomResponse = $('CMDBuild чтение Room').first().json || {};
const floorResponse = $('CMDBuild чтение Floor').first().json || {};
const buildingResponse = $('CMDBuild чтение Building').first().json || {};

function dataOf(value) {
  const body = bodyOf(value);
  return body && typeof body === 'object' ? body.data : null;
}

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
    return [{ json: terminalError(state, 'cmdbuild_auth_failed', 'CMDBuild authentication failed.', { class_name: className }) }];
  }
  if (httpStatus >= 400 || body?.success === false) {
    return [{ json: terminalError(state, 'cmdbuild_lookup_failed', 'CMDBuild reference lookup failed.', { class_name: className, cmdbuild_status: httpStatus || null }) }];
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
  return [{ json: terminalError(state, 'missing_cmdbuild_field', 'В CMDBuild reference chain не заполнены обязательные атрибуты.', {
    hostname: state.host,
    router_id: state.router_id || null,
    missing_fields: missing
  }) }];
}

return [{
  json: {
    ...state,
    terminal: false,
      provider_email_context: {
        status: 'OK',
        hostname: state.router_hostname || state.router_code || state.router_lookup_value || state.host,
        problem_host: state.problem_host || state.host || null,
        router_ref: state.router_ref || state.router_code || null,
        router_id: state.router_id,
        router_code: state.router_code || null,
        city,
      location,
      ip_address: ipAddress,
      contract: state.contract,
      provider_email: state.provider_email
    }
  }
}];`,
      [3600, 300],
    ),
    codeNode(
      'provider-channel-monitor-email-prepare',
      'Подготовка email провайдеру',
      `${common}

const state = $input.first().json || {};
const context = state.provider_email_context || {};
if (!context || context.status !== 'OK') {
  return [{ json: terminalError(state, 'provider_context_invalid', 'CMDBuild вернул некорректный контекст письма провайдеру.') }];
}

const emailRe = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
const toEmail = text(context.provider_email);
if (!emailRe.test(toEmail)) {
  return [{ json: terminalError(state, 'invalid_provider_email', 'CMDBuild вернул некорректный email провайдера.', { router_id: context.router_id || null }) }];
}

const mailboxWaitStrategy = 'imap_index_by_service_request';
const fromEmail = text(state.from_email);
const replyTo = text(state.reply_to);
if (!fromEmail) {
  return [{ json: terminalError(state, 'missing_from', 'Поле from обязательно.', {
    mailbox_wait_strategy: mailboxWaitStrategy
  }) }];
}
if (!replyTo) {
  return [{ json: terminalError(state, 'missing_reply_to', 'Поле replyTo обязательно.', {
    mailbox_wait_strategy: mailboxWaitStrategy
  }) }];
}
if (!emailRe.test(fromEmail) || !emailRe.test(replyTo)) {
  return [{ json: terminalError(state, 'invalid_email', 'Некорректный email адрес.', {
    from: fromEmail,
    reply_to: replyTo,
    mailbox_wait_strategy: mailboxWaitStrategy
  }) }];
}

const subject = ('Пропадание связи по каналу ' + text(context.city)).trim();
const body = [
  'Добрый день.',
  'Фиксируем пропадание канала на объекте по адресу ' + text(context.location),
  'IP адрес ' + text(context.ip_address),
  '№ ' + text(context.contract),
  'Просьба выяснить причину и устранить аварию.',
  '',
  'Запись в системе учета заявок ГКМ Наряд № ' + text(state.service_request),
  '',
  '!! Просьба, при ответе на письмо, цитировать всю переписку, использовать кнопку "Ответить всем";',
  'При необходимости для оперативного решения вопросов или получения уточнений звонить:',
  '+7-495- 11111111 (в рабочее время)',
  '+7-495- 22222222 (круглосуточно)',
  ''
].join('\\n');

return [{
  json: {
    ...state,
    terminal: false,
    toEmail,
    ccEmail: (state.direct_recipients?.cc || []).join(', '),
    bccEmail: (state.direct_recipients?.bcc || []).join(', '),
    from_email: fromEmail,
    reply_to: replyTo,
    reply_mailbox_address: replyTo,
    mailbox_wait_strategy: mailboxWaitStrategy,
    email_subject: subject,
    email_body: body
  }
}];`,
      [3880, 300],
    ),
    {
      id: 'provider-channel-monitor-email-send',
      name: 'Отправка email провайдеру',
      type: 'n8n-nodes-base.emailSend',
      typeVersion: 2.1,
      position: [4160, 300],
      parameters: {
        text: '={{ $json.email_body }}',
        options: {
          ccEmail: '={{ $json.ccEmail }}',
          replyTo: '={{ $json.reply_to }}',
          bccEmail: '={{ $json.bccEmail }}',
          appendAttribution: false,
        },
        subject: '={{ $json.email_subject }}',
        toEmail: '={{ $json.toEmail }}',
        resource: 'email',
        fromEmail: '={{ $json.from_email }}',
        operation: 'send',
        emailFormat: 'text',
      },
      credentials: {
        smtp: LOCAL_SMTP_CREDENTIAL,
      },
      continueOnFail: true,
    },
    codeNode(
      'provider-channel-monitor-email-result',
      'Результат email провайдеру',
      `${common}

const state = $('Подготовка email провайдеру').first().json || {};
const result = $input.first().json || {};
const err = result.error || result.message?.error;
if (err) {
  return [{ json: terminalError(state, 'provider_email_send_failed', 'Не удалось отправить письмо провайдеру.', {
    reason: safeMessage(err),
    provider_email_context: {
      ...state.provider_email_context,
      provider_email: '[redacted]'
    }
  }) }];
}

return [{
  json: {
    ...state,
    terminal: false,
    email_dispatch: {
      status: 'sent',
      templateId: state.templateId,
      request_id: state.request_id,
      to: state.toEmail,
      from: state.from_email,
      reply_to: state.reply_to,
      reply_mailbox_address: state.reply_mailbox_address,
      mailbox_wait_strategy: state.mailbox_wait_strategy
    }
  }
}];`,
      [4440, 300],
    ),
  ];
}

function workflow() {
  return documentedWorkflow({
    id: WORKFLOW_ID,
    name: WORKFLOW_NAME,
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
      {
        parameters: {
          inputSource: 'passthrough',
        },
        id: 'provider-channel-monitor-worker-trigger',
        name: 'Worker мониторинга ремонта канала',
        type: 'n8n-nodes-base.executeWorkflowTrigger',
        typeVersion: 1.1,
        position: [240, 620],
      },
      codeNode('provider-channel-monitor-prepare', 'Подготовка запроса мониторинга', prepareRequestCode, [520, 300]),
      codeNode('provider-channel-monitor-worker-input', 'Подготовка state worker', workerInputCode, [520, 620]),
      ifNode('provider-channel-monitor-valid', 'Запрос валиден?', [800, 300], '={{ $json.valid }}'),
      respondNode('provider-channel-monitor-validation-error', 'Ответ ошибки валидации', [1080, 480]),
      executeWorkflowNode('provider-channel-monitor-dispatch-worker', 'Запуск worker мониторинга', [1080, 160]),
      respondNode('provider-channel-monitor-accepted', 'Ответ accepted', [1360, 160]),
      ...providerCmdbuildEmailNodes(),
      ifNode('provider-channel-monitor-initial-terminal', 'Начальный этап терминальный?', [4720, 160], '={{ $json.terminal }}'),
      codeNode('provider-channel-monitor-zabbix-check', 'Проверка статуса Zabbix', zabbixCheckCode, [5000, 320]),
      ifNode('provider-channel-monitor-zabbix-terminal', 'Zabbix завершил ранбук?', [5280, 320], '={{ $json.terminal }}'),
      codeNode('provider-channel-monitor-build-email-sql', 'Подготовка SQL поиска письма', buildEmailSearchSqlCode, [5560, 480]),
      postgresNode('provider-channel-monitor-email-search', 'Поиск письма в индексе', [5840, 480]),
      codeNode('provider-channel-monitor-evaluate-email', 'Оценка ответа провайдера', evaluateEmailResultCode, [6120, 480]),
      ifNode('provider-channel-monitor-email-terminal', 'Email завершил ранбук?', [6400, 480], '={{ $json.terminal }}'),
      codeNode('provider-channel-monitor-deliver-progress', 'Доставка polling diagnostics', deliverAsyncResultCode, [6680, 520]),
      ifNode('provider-channel-monitor-progress-needs-kafka', 'Нужна Kafka delivery diagnostics?', [6960, 520], '={{ $json.shouldPublishKafka }}'),
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
        id: 'provider-channel-monitor-progress-kafka-publish',
        name: 'Публикация polling diagnostics в Kafka',
        type: 'n8n-nodes-base.kafka',
        typeVersion: 1,
        position: [7240, 440],
        credentials: {
          kafka: LOCAL_KAFKA_CREDENTIAL,
        },
      },
      codeNode('provider-channel-monitor-progress-done', 'Завершение polling diagnostics', progressDoneCode, [7520, 520]),
      {
        parameters: {
          resume: 'specificTime',
          dateTime: '={{ $json.next_wait_at }}',
        },
        id: 'provider-channel-monitor-wait',
        name: 'Ожидание следующего опроса',
        type: 'n8n-nodes-base.wait',
        typeVersion: 1.1,
        position: [7800, 620],
      },
      codeNode('provider-channel-monitor-deliver-result', 'Доставка async результата', deliverAsyncResultCode, [6680, 160]),
      ifNode('provider-channel-monitor-needs-kafka', 'Нужна Kafka delivery?', [6960, 160], '={{ $json.shouldPublishKafka }}'),
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
        position: [7240, 80],
        credentials: {
          kafka: LOCAL_KAFKA_CREDENTIAL,
        },
      },
      codeNode('provider-channel-monitor-async-done', 'Завершение async ветки', asyncDoneCode, [7520, 160]),
    ],
    connections: {
      'Webhook мониторинга ремонта канала': {
        main: [[{ node: 'Подготовка запроса мониторинга', type: 'main', index: 0 }]],
      },
      'Worker мониторинга ремонта канала': {
        main: [[{ node: 'Подготовка state worker', type: 'main', index: 0 }]],
      },
      'Подготовка запроса мониторинга': {
        main: [[{ node: 'Запрос валиден?', type: 'main', index: 0 }]],
      },
      'Подготовка state worker': {
        main: [[{ node: 'Подготовка CMDBuild контекста', type: 'main', index: 0 }]],
      },
      'Запрос валиден?': {
        main: [
          [{ node: 'Запуск worker мониторинга', type: 'main', index: 0 }],
          [{ node: 'Ответ ошибки валидации', type: 'main', index: 0 }],
        ],
      },
      'Запуск worker мониторинга': {
        main: [[{ node: 'Ответ accepted', type: 'main', index: 0 }]],
      },
      'Подготовка CMDBuild контекста': {
        main: [[{ node: 'CMDBuild поиск routerG', type: 'main', index: 0 }]],
      },
      'CMDBuild поиск routerG': {
        main: [[{ node: 'Разбор routerG для письма', type: 'main', index: 0 }]],
      },
      'Разбор routerG для письма': {
        main: [[{ node: 'CMDBuild контекст терминальный?', type: 'main', index: 0 }]],
      },
      'CMDBuild контекст терминальный?': {
        main: [
          [{ node: 'Доставка async результата', type: 'main', index: 0 }],
          [{ node: 'CMDBuild чтение IpAddress', type: 'main', index: 0 }],
        ],
      },
      'CMDBuild чтение IpAddress': {
        main: [[{ node: 'CMDBuild чтение Room', type: 'main', index: 0 }]],
      },
      'CMDBuild чтение Room': {
        main: [[{ node: 'CMDBuild чтение Floor', type: 'main', index: 0 }]],
      },
      'CMDBuild чтение Floor': {
        main: [[{ node: 'CMDBuild чтение Building', type: 'main', index: 0 }]],
      },
      'CMDBuild чтение Building': {
        main: [[{ node: 'Нормализация CMDBuild контекста', type: 'main', index: 0 }]],
      },
      'Нормализация CMDBuild контекста': {
        main: [[{ node: 'Подготовка email провайдеру', type: 'main', index: 0 }]],
      },
      'Подготовка email провайдеру': {
        main: [[{ node: 'Отправка email провайдеру', type: 'main', index: 0 }]],
      },
      'Отправка email провайдеру': {
        main: [[{ node: 'Результат email провайдеру', type: 'main', index: 0 }]],
      },
      'Результат email провайдеру': {
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
          [{ node: 'Доставка polling diagnostics', type: 'main', index: 0 }],
        ],
      },
      'Доставка polling diagnostics': {
        main: [[{ node: 'Нужна Kafka delivery diagnostics?', type: 'main', index: 0 }]],
      },
      'Нужна Kafka delivery diagnostics?': {
        main: [
          [{ node: 'Публикация polling diagnostics в Kafka', type: 'main', index: 0 }],
          [{ node: 'Завершение polling diagnostics', type: 'main', index: 0 }],
        ],
      },
      'Публикация polling diagnostics в Kafka': {
        main: [[{ node: 'Завершение polling diagnostics', type: 'main', index: 0 }]],
      },
      'Завершение polling diagnostics': {
        main: [[{ node: 'Ожидание следующего опроса', type: 'main', index: 0 }]],
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
