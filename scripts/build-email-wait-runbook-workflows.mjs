#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';
import { serviceDeskEnvironmentExpression } from './servicedesk-async-runbook-runtime.mjs';

const COLLECTOR_WORKFLOW_PATH = 'workflows/email-ticket-mailbox-collector.json';
const WAIT_WORKFLOW_PATH = 'workflows/wait-for-email-ticket-webhook.json';

const LOCAL_IMAP_CREDENTIAL = {
  id: '4vumCzVocGKeTH2I',
  name: 'GreenMail IMAP (local test)',
};

const LOCAL_POSTGRES_CREDENTIAL = {
  id: 'localServiceDeskPostgres',
  name: 'Local ServiceDesk Postgres',
};

const LOCAL_KAFKA_CREDENTIAL = {
  id: 'localRedpandaKafka',
  name: 'Local Redpanda Kafka',
};

const SERVICE_DESK_ENVIRONMENT_EXPR_SINGLE = serviceDeskEnvironmentExpression({ quote: "'" });

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const collectorPrepareCode = String.raw`const email = $input.first().json || {};

const sqlString = (value) => {
  if (value === undefined || value === null) return 'NULL';
  return "'" + String(value).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
};

const textOf = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.text) return String(value.text);
    if (value.address) return String(value.address);
    if (Array.isArray(value.value)) return value.value.map(textOf).filter(Boolean).join(', ');
  }
  return String(value);
};

const extractAddress = (value) => {
  const text = textOf(value);
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
};

const stripHtml = (html) => String(html || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeDate = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
};

const subject = String(email.subject || '').trim();
const fromEmail = extractAddress(email.from || email.sender || '');
const bodySource = email.text || email.textPlain || email.plainText || stripHtml(email.html || email.textHtml || '');
const bodyFull = String(bodySource || '');
const bodyLimit = 50000;
const bodyText = bodyFull.slice(0, bodyLimit);
const bodyTruncated = bodyFull.length > bodyLimit;
const receivedAt = normalizeDate(email.date || email.receivedAt || email.received_at || email.headers?.date);
const messageIdRaw = email.messageId || email.messageID || email['message-id'] || email.headers?.['message-id'] || '';
const fallbackId = ['fallback', receivedAt, fromEmail, subject].join(':').replace(/\s+/g, ' ').slice(0, 900);
const messageId = String(messageIdRaw || fallbackId).trim();
const mailbox = String(email.mailbox || 'INBOX').trim() || 'INBOX';
const mailboxAddress = extractAddress(email.mailbox_address || email.mailboxAddress || email.deliveredTo || email.delivered_to || email.headers?.to || email.to || email.envelope?.to || '');

const deliveryText = [subject, fromEmail, bodyText].join('\n').toLowerCase();
const deliveryFailurePatterns = [
  'undeliverable',
  'delivery status notification',
  'delivery has failed',
  'mail delivery failed',
  'failure notice',
  'returned mail',
  'mailer-daemon',
  'postmaster',
  'недостав',
  'не доставлено',
  'сообщение не доставлено'
];
const deliveryFailureReason = deliveryFailurePatterns.find((pattern) => deliveryText.includes(pattern)) || '';
const isDeliveryFailure = Boolean(deliveryFailureReason);

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
  'INSERT INTO n8n_mail_index (',
  '  message_id,',
  '  mailbox,',
  '  mailbox_address,',
  '  from_email,',
  '  subject,',
  '  body_text,',
  '  body_truncated,',
  '  received_at,',
  '  indexed_at,',
  '  is_delivery_failure,',
  '  delivery_failure_reason',
  ') VALUES (',
  '  ' + sqlString(messageId) + ',',
  '  ' + sqlString(mailbox) + ',',
  '  ' + sqlString(mailboxAddress) + ',',
  '  ' + sqlString(fromEmail) + ',',
  '  ' + sqlString(subject) + ',',
  '  ' + sqlString(bodyText) + ',',
  '  ' + (bodyTruncated ? 'true' : 'false') + ',',
  '  ' + sqlString(receivedAt) + '::timestamptz,',
  '  now(),',
  '  ' + (isDeliveryFailure ? 'true' : 'false') + ',',
  '  ' + sqlString(deliveryFailureReason),
  ')',
  'ON CONFLICT (message_id) DO UPDATE SET',
  '  mailbox = EXCLUDED.mailbox,',
  '  mailbox_address = EXCLUDED.mailbox_address,',
  '  from_email = EXCLUDED.from_email,',
  '  subject = EXCLUDED.subject,',
  '  body_text = EXCLUDED.body_text,',
  '  body_truncated = EXCLUDED.body_truncated,',
  '  received_at = EXCLUDED.received_at,',
  '  indexed_at = now(),',
  '  is_delivery_failure = EXCLUDED.is_delivery_failure,',
  '  delivery_failure_reason = EXCLUDED.delivery_failure_reason;',
  "DELETE FROM n8n_mail_index WHERE received_at < now() - interval '7 days';",
  'SELECT ' + sqlString(messageId) + ' AS message_id, ' + sqlString(receivedAt) + '::timestamptz AS received_at, ' + (isDeliveryFailure ? 'true' : 'false') + ' AS is_delivery_failure;'
].join('\n');

return [{ json: { sql, message_id: messageId, subject, from_email: fromEmail, mailbox_address: mailboxAddress, received_at: receivedAt, is_delivery_failure: isDeliveryFailure } }];`;

const prepareWaitRequestCode = String.raw`const input = $input.first().json || {};
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
  diagnostic('Basic', 'wait_email_by_ticket_rejected', { statusCode, code });
  return [{ json: { valid: false, statusCode, response: { error: { code, message, ...details } } } }];
};

if (!expectedToken || actualToken !== expectedToken) {
  return response(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}

const numberFrom = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return Number(value);
  }
  return NaN;
};
const stringValue = (value) => value === undefined || value === null ? '' : String(value).trim();
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

const ticketNumber = String(body.ticket_number || body.ticketNumber || '').trim();
const pollIntervalMinutes = numberFrom(body.poll_interval_minutes, body.pollIntervalMinutes);
const timeoutMinutes = numberFrom(body.timeout_minutes, body.timeoutMinutes);

if (!ticketNumber) return response(400, 'missing_ticket_number', 'Поле ticket_number обязательно.');
if (ticketNumber.length > 160) return response(400, 'ticket_number_too_long', 'Поле ticket_number слишком длинное.');
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
const asyncDelivery = Boolean(asyncCallback);
const actionId = String(invocation.action_id || '').trim();
if (asyncDelivery && actionId && actionId !== 'wait_for_email_by_ticket') {
  return response(400, 'invalid_action_id', 'Для этого endpoint action_id должен быть wait_for_email_by_ticket.', { action_id: actionId });
}
if (!asyncDelivery && timeoutMinutes > 5) {
  return response(400, 'direct_timeout_too_long', 'Direct HTTP режим ограничен timeout_minutes <= 5. Для 60 минут используйте async_callback.');
}

if (asyncDelivery) {
  const required = ['source', 'case_id', 'wait_id', 'correlation_id', 'event_type', 'idempotency_key_base', 'result_transport'];
  const missing = required.filter((name) => !String(asyncCallback[name] || '').trim());
  if (missing.length) return response(400, 'missing_async_callback_fields', 'Не указаны обязательные поля async_callback.', { missing_fields: missing });
  const transport = String(asyncCallback.result_transport || '').trim();
  if (!['http_callback', 'kafka_event', 'both'].includes(transport)) {
    return response(400, 'invalid_result_transport', 'result_transport должен быть http_callback, kafka_event или both.', { result_transport: transport });
  }
  if ((transport === 'http_callback' || transport === 'both') && !String(asyncCallback.callback_url || '').trim()) {
    return response(400, 'missing_callback_url', 'callback_url обязателен для http_callback или both.');
  }
  if (transport === 'http_callback' || transport === 'both') {
    const callbackError = validateCallbackUrl(asyncCallback.callback_url);
    if (callbackError) return response(400, 'invalid_callback_url', 'callback_url не соответствует политике безопасности.', callbackError);
  }
  if ((transport === 'kafka_event' || transport === 'both') && !String(asyncCallback.result_topic || '').trim()) {
    return response(400, 'missing_result_topic', 'result_topic обязателен для kafka_event или both.');
  }
}

const now = new Date();
const startOfToday = new Date(now);
startOfToday.setHours(0, 0, 0, 0);
const windowStart = new Date(startOfToday);
windowStart.setDate(windowStart.getDate() - 1);
const deadline = new Date(now.getTime() + timeoutMinutes * 60 * 1000);
const pollSeconds = pollIntervalMinutes * 60;
const invocationId = String(invocation.invocation_id || body.request_id || body.requestId || ('wait-email-' + Date.now())).trim();

const acceptedResponse = {
  runbook_status: 'accepted',
  message: 'n8n wait email runbook принял запрос на ожидание письма.',
  invocation_id: invocationId,
  action_id: actionId || null,
  accepted_at: now.toISOString(),
  async_delivery: asyncDelivery,
  correlation_id: asyncCallback?.correlation_id || null,
  wait_id: asyncCallback?.wait_id || null,
  result_transport: asyncCallback?.result_transport || null,
  result_topic: asyncCallback?.result_topic || null,
  has_callback_url: Boolean(asyncCallback?.callback_url)
};

diagnostic('Basic', 'wait_email_by_ticket_accepted', {
  invocation_id: invocationId,
  async_delivery: asyncDelivery,
  poll_interval_minutes: pollIntervalMinutes,
  timeout_minutes: timeoutMinutes
});

return [{
  json: {
    valid: true,
    statusCode: 200,
    response: acceptedResponse,
    async_delivery: asyncDelivery,
    invocation_id: invocationId,
    action_id: actionId || 'wait_for_email_by_ticket',
    ticket_number: ticketNumber,
    poll_interval_minutes: pollIntervalMinutes,
    timeout_minutes: timeoutMinutes,
    poll_seconds: pollSeconds,
    started_at: now.toISOString(),
    deadline_at: deadline.toISOString(),
    window_start_at: windowStart.toISOString(),
    async_callback: asyncCallback
  }
}];`;

const buildSearchSqlCode = String.raw`const state = $input.first().json || {};

const sqlString = (value) => {
  if (value === undefined || value === null) return 'NULL';
  return "'" + String(value).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
};

const sqlBool = (value) => value ? 'true' : 'false';
const asyncCallbackJson = state.async_callback ? JSON.stringify(state.async_callback) : '';
const now = new Date();

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

const ticket = sqlString(state.ticket_number);
const sql = [
  createTableSql,
  'WITH matches AS (',
  '  SELECT',
  '    id,',
  '    message_id,',
  '    mailbox,',
  '    mailbox_address,',
  '    from_email,',
  '    subject,',
  '    body_text,',
  '    body_truncated,',
  '    received_at,',
  '    indexed_at,',
  '    is_delivery_failure,',
  '    delivery_failure_reason',
  '  FROM n8n_mail_index',
  '  WHERE received_at >= ' + sqlString(state.window_start_at) + '::timestamptz',
  '    AND received_at <= now()',
  "    AND position(lower(" + ticket + ") in lower(coalesce(subject, '') || E'\\n' || coalesce(body_text, ''))) > 0",
  '),',
  'delivery_failures AS (',
  '  SELECT * FROM matches WHERE is_delivery_failure = true',
  '),',
  'first_delivery_failure AS (',
  '  SELECT * FROM delivery_failures ORDER BY received_at ASC, id ASC LIMIT 1',
  '),',
  'first_match AS (',
  '  SELECT * FROM matches ORDER BY received_at ASC, id ASC LIMIT 1',
  ')',
  'SELECT',
  '  ' + sqlString(state.ticket_number) + ' AS ticket_number,',
  '  ' + sqlString(state.invocation_id) + ' AS invocation_id,',
  '  ' + sqlString(state.action_id) + ' AS action_id,',
  '  ' + sqlString(state.started_at) + ' AS started_at,',
  '  ' + sqlString(state.deadline_at) + ' AS deadline_at,',
  '  ' + sqlString(state.window_start_at) + ' AS window_start_at,',
  '  ' + Number(state.poll_interval_minutes) + '::int AS poll_interval_minutes,',
  '  ' + Number(state.timeout_minutes) + '::int AS timeout_minutes,',
  '  ' + Number(state.poll_seconds) + '::int AS poll_seconds,',
  '  ' + sqlBool(state.async_delivery) + ' AS async_delivery,',
  '  ' + sqlString(asyncCallbackJson) + ' AS async_callback_json,',
  '  ' + sqlString(now.toISOString()) + ' AS checked_at,',
  '  (SELECT count(*)::int FROM matches) AS match_count,',
  '  (SELECT count(*)::int FROM delivery_failures) AS delivery_failure_count,',
  '  (SELECT row_to_json(first_delivery_failure)::text FROM first_delivery_failure) AS delivery_failure_match_json,',
  '  (SELECT row_to_json(first_match)::text FROM first_match) AS first_match_json;'
].join('\n');

return [{ json: { ...state, sql } }];`;

const evaluateSearchResultCode = String.raw`const row = $input.first().json || {};

const parseCount = (value) => Number(value || 0);
const parseJson = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const text = (value) => value === undefined || value === null ? null : String(value);

const matchCount = parseCount(row.match_count);
const deliveryFailureCount = parseCount(row.delivery_failure_count);
const deliveryFailureMatch = parseJson(row.delivery_failure_match_json);
const firstMatch = parseJson(row.first_match_json);
const selectedMatch = deliveryFailureMatch || firstMatch;
const now = new Date();
const deadline = new Date(row.deadline_at);
let status = null;

if (deliveryFailureCount > 0) status = 'DELIVERY_FAILED';
else if (matchCount === 1) status = 'OK';
else if (matchCount > 1) status = 'MULTI_MAIL';
else if (now >= deadline) status = 'NOT_FOUND';

const secondsUntilDeadline = Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 1000));
const pollSeconds = Number(row.poll_seconds || 60);
const nextWaitSeconds = Math.max(1, Math.min(pollSeconds, secondsUntilDeadline || pollSeconds));
const nextWaitAt = new Date(now.getTime() + nextWaitSeconds * 1000).toISOString();

const terminalResponse = {
  status,
  ticket_number: row.ticket_number,
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
  poll_interval_minutes: Number(row.poll_interval_minutes),
  timeout_minutes: Number(row.timeout_minutes),
  started_at: row.started_at,
  finished_at: now.toISOString()
};

return [{
  json: {
    ...row,
    terminal: Boolean(status),
    statusCode: 200,
    response: terminalResponse,
    status,
    next_wait_seconds: nextWaitSeconds,
    next_wait_at: nextWaitAt
  }
}];`;

const deliverAsyncResultCode = String.raw`const input = $input.first().json || {};
const response = input.response || {};
const asyncCallback = input.async_callback_json ? JSON.parse(input.async_callback_json) : input.async_callback;
if (!asyncCallback) {
  throw new Error('async_callback is required for async result delivery.');
}

const normalizeSource = (value) => String(value || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
const transport = String(asyncCallback.result_transport || '');
const terminalStatusToExternal = (status) => {
  if (status === 'NOT_FOUND') return 'timeout';
  if (status === 'DELIVERY_FAILED') return 'error';
  return 'success';
};
const eventSuffix = String(response.status || 'UNKNOWN').toLowerCase();
const shouldPublishKafka = transport === 'kafka_event' || transport === 'both';
const deliveryStatus = {
  requested_transport: transport,
  http_callback: (transport === 'http_callback' || transport === 'both') ? 'pending' : 'not_requested',
  kafka_event: shouldPublishKafka ? 'pending' : 'not_requested'
};
const externalEvent = {
  schema_version: '1.0',
  event_id: asyncCallback.idempotency_key_base + ':email_wait_' + eventSuffix,
  case_id: asyncCallback.case_id,
  wait_id: asyncCallback.wait_id,
  correlation_id: asyncCallback.correlation_id,
  source: asyncCallback.source,
  event_type: asyncCallback.event_type,
  status: terminalStatusToExternal(response.status),
  idempotency_key: asyncCallback.idempotency_key_base + ':email_wait_' + eventSuffix,
  result: {
    action_id: input.action_id || 'wait_for_email_by_ticket',
    invocation_id: input.invocation_id,
    runbook_status: response.status,
    ticket_number: response.ticket_number,
    message: response.status === 'NOT_FOUND'
      ? 'Письмо с указанным номером заявки не найдено за время ожидания.'
      : 'Ранбук ожидания письма завершен.',
    email: {
      subject: response.subject,
      body: response.body,
      body_truncated: response.body_truncated,
      from: response.from,
      received_at: response.received_at,
      message_id: response.message_id,
      mailbox: response.mailbox,
      is_delivery_failure: response.is_delivery_failure,
      delivery_failure_reason: response.delivery_failure_reason
    },
    match_count: response.match_count,
    delivery_failure_count: response.delivery_failure_count,
    poll_interval_minutes: response.poll_interval_minutes,
    timeout_minutes: response.timeout_minutes,
    started_at: response.started_at,
    finished_at: response.finished_at,
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
    kafkaTopic: asyncCallback.result_topic || 'external.events',
    kafkaHeaders: JSON.stringify({
      correlation_id: asyncCallback.correlation_id,
      wait_id: asyncCallback.wait_id,
      idempotency_key: externalEvent.idempotency_key,
      event_type: asyncCallback.event_type
    })
  }
}];`;

const asyncDoneCode = "return [{ json: { delivered: true, status: $input.first().json.externalEvent?.status || 'unknown' } }];";

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

function collectorWorkflow() {
  return documentedWorkflow({
    id: 'emailTicketMailboxCollector',
    name: 'Email: индекс входящих писем',
    nodes: [
      {
        parameters: {
          mailbox: 'INBOX',
          postProcessAction: 'nothing',
          format: 'simple',
          downloadAttachments: false,
          options: {
            customEmailConfig: '["ALL"]',
            trackLastMessageId: true,
          },
        },
        id: 'email-ticket-collector-imap-trigger',
        name: 'Получение входящего письма',
        type: 'n8n-nodes-base.emailReadImap',
        typeVersion: 2.1,
        position: [240, 300],
        credentials: {
          imap: LOCAL_IMAP_CREDENTIAL,
        },
      },
      {
        parameters: {
          jsCode: collectorPrepareCode,
        },
        id: 'email-ticket-collector-prepare',
        name: 'Подготовка индекса письма',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [520, 300],
      },
      postgresNode('email-ticket-collector-upsert', 'Запись письма в индекс', [800, 300]),
    ],
    connections: {
      'Получение входящего письма': {
        main: [[{ node: 'Подготовка индекса письма', type: 'main', index: 0 }]],
      },
      'Подготовка индекса письма': {
        main: [[{ node: 'Запись письма в индекс', type: 'main', index: 0 }]],
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

function waitWorkflow() {
  return documentedWorkflow({
    id: 'waitForEmailByTicket',
    name: 'Email: ожидание письма по номеру заявки',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'email/wait-for-ticket',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'wait-email-webhook',
        name: 'Webhook ожидания письма',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: 'bb9a42de-11f7-44c4-85f3-b49c3e6f88e0',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: prepareWaitRequestCode,
        },
        id: 'wait-email-prepare-request',
        name: 'Подготовка запроса ожидания',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [520, 300],
      },
      ifNode('wait-email-request-valid', 'Запрос валиден?', [800, 300], '={{ $json.valid }}'),
      respondNode('wait-email-validation-error-response', 'Ответ ошибки валидации', [1080, 460]),
      ifNode('wait-email-is-async', 'Async режим?', [1080, 220], '={{ $json.async_delivery }}'),
      respondNode('wait-email-accepted-response', 'Ответ accepted', [1340, 120]),
      {
        parameters: {
          jsCode: buildSearchSqlCode,
        },
        id: 'wait-email-build-search-sql',
        name: 'Подготовка SQL поиска',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1340, 300],
      },
      postgresNode('wait-email-search-index', 'Поиск письма в индексе', [1600, 300]),
      {
        parameters: {
          jsCode: evaluateSearchResultCode,
        },
        id: 'wait-email-evaluate-result',
        name: 'Оценка результата поиска',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1860, 300],
      },
      ifNode('wait-email-terminal', 'Результат терминальный?', [2120, 300], '={{ $json.terminal }}'),
      ifNode('wait-email-terminal-async', 'Терминал async?', [2380, 220], '={{ $json.async_delivery }}'),
      respondNode('wait-email-terminal-response', 'Ответ terminal direct', [2640, 340]),
      {
        parameters: {
          resume: 'specificTime',
          dateTime: '={{ $json.next_wait_at }}',
        },
        id: 'wait-email-wait-interval',
        name: 'Ожидание следующего опроса',
        type: 'n8n-nodes-base.wait',
        typeVersion: 1.1,
        position: [2380, 500],
      },
      {
        parameters: {
          jsCode: deliverAsyncResultCode,
        },
        id: 'wait-email-deliver-async-result',
        name: 'Доставка async результата',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [2640, 120],
      },
      ifNode('wait-email-needs-kafka', 'Нужна Kafka delivery?', [2900, 120], '={{ $json.shouldPublishKafka }}'),
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
        id: 'wait-email-kafka-publish',
        name: 'Публикация ExternalEvent в Kafka',
        type: 'n8n-nodes-base.kafka',
        typeVersion: 1,
        position: [3160, 40],
        credentials: {
          kafka: LOCAL_KAFKA_CREDENTIAL,
        },
      },
      {
        parameters: {
          jsCode: asyncDoneCode,
        },
        id: 'wait-email-async-done',
        name: 'Завершение async ветки',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [3420, 120],
      },
    ],
    connections: {
      'Webhook ожидания письма': {
        main: [[{ node: 'Подготовка запроса ожидания', type: 'main', index: 0 }]],
      },
      'Подготовка запроса ожидания': {
        main: [[{ node: 'Запрос валиден?', type: 'main', index: 0 }]],
      },
      'Запрос валиден?': {
        main: [
          [{ node: 'Async режим?', type: 'main', index: 0 }],
          [{ node: 'Ответ ошибки валидации', type: 'main', index: 0 }],
        ],
      },
      'Async режим?': {
        main: [
          [
            { node: 'Ответ accepted', type: 'main', index: 0 },
            { node: 'Подготовка SQL поиска', type: 'main', index: 0 },
          ],
          [{ node: 'Подготовка SQL поиска', type: 'main', index: 0 }],
        ],
      },
      'Подготовка SQL поиска': {
        main: [[{ node: 'Поиск письма в индексе', type: 'main', index: 0 }]],
      },
      'Поиск письма в индексе': {
        main: [[{ node: 'Оценка результата поиска', type: 'main', index: 0 }]],
      },
      'Оценка результата поиска': {
        main: [[{ node: 'Результат терминальный?', type: 'main', index: 0 }]],
      },
      'Результат терминальный?': {
        main: [
          [{ node: 'Терминал async?', type: 'main', index: 0 }],
          [{ node: 'Ожидание следующего опроса', type: 'main', index: 0 }],
        ],
      },
      'Терминал async?': {
        main: [
          [{ node: 'Доставка async результата', type: 'main', index: 0 }],
          [{ node: 'Ответ terminal direct', type: 'main', index: 0 }],
        ],
      },
      'Ожидание следующего опроса': {
        main: [[{ node: 'Подготовка SQL поиска', type: 'main', index: 0 }]],
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

function writeIfChanged(path, workflow, checkOnly) {
  const expected = `${stableJson(workflow)}\n`;
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current === expected) return false;
  if (checkOnly) {
    process.stderr.write(`${path} is out of date\n`);
    process.exitCode = 1;
    return true;
  }
  writeFileSync(path, expected, 'utf8');
  process.stdout.write(`updated ${path}\n`);
  return true;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const workflows = [
    [COLLECTOR_WORKFLOW_PATH, collectorWorkflow()],
    [WAIT_WORKFLOW_PATH, waitWorkflow()],
  ];

  let changed = false;
  for (const [path, workflow] of workflows) {
    if (checkOnly) {
      if (existsSync(path)) readJson(path);
    }
    changed = writeIfChanged(path, workflow, checkOnly) || changed;
  }
  if (!changed && !process.exitCode) {
    process.stdout.write('email wait runbook workflows are up to date\n');
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
