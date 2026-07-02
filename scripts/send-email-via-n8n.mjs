#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_WEBHOOK_URL = 'http://127.0.0.1:5678/webhook/email/send';
const DEFAULT_TIMEOUT_MS = 15000;
const SERVICE_NAME = 'n8n-mail-dispatch';
const ATTACHMENT_FLAGS = new Set([
  'attachment',
  'attachments',
  'attach',
  'file',
  'files',
]);

function usage() {
  return `Usage:
  N8N_WEBHOOK_TOKEN=replace_with_dev_webhook_token \\
  node scripts/send-email-via-n8n.mjs \\
    --to user@example.com \\
    --cc manager@example.com \\
    --bcc audit@example.com \\
    --subject "Subject" \\
    --body "Message text" \\
    --reply-to support@example.com

Options:
  --to <email>          Required. Can be repeated or comma-separated.
  --cc <email>          Optional. Can be repeated or comma-separated.
  --bcc <email>         Optional. Can be repeated or comma-separated.
  --from <email>        Required SMTP From address.
  --reply-to <email>    Required Reply-To address.
  --subject <text>      Required.
  --body <text>         Required.
  --help                Show this help.

Environment:
  N8N_WEBHOOK_URL       Defaults to ${DEFAULT_WEBHOOK_URL}
  N8N_WEBHOOK_TOKEN     Required. Sent as X-ServiceDesk-Token.
  N8N_MAIL_DEBUG        Optional: Basic or Verbose.
  N8N_MAIL_LOG_FILE     Optional NDJSON log sink path.
  N8N_MAIL_TIMEOUT_MS   Optional request timeout, default ${DEFAULT_TIMEOUT_MS}.`;
}

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function normalizeDebugLevel(value) {
  const level = String(value || '').trim().toLowerCase();
  if (level === 'basic') return 'Basic';
  if (level === 'verbose') return 'Verbose';
  return 'Off';
}

function splitAddresses(value) {
  return String(value)
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function maskEmail(value) {
  const text = String(value || '');
  const match = text.match(/([^@\s<>]+)@([^@\s<>]+)/);
  if (!match) return text ? '[redacted]' : '';
  const [, local, domain] = match;
  const maskedLocal = local.length <= 1 ? '*' : `${local[0]}***`;
  const domainParts = domain.split('.');
  const maskedDomain = domainParts
    .map((part, index) => {
      if (index === domainParts.length - 1) return part;
      return part ? `${part[0]}***` : '*';
    })
    .join('.');
  return `${maskedLocal}@${maskedDomain}`;
}

function maskAddressList(values) {
  return values.map(maskEmail);
}

function logEvent(debugLevel, event, fields = {}, severity = 'info') {
  const shouldLog =
    debugLevel === 'Verbose' ||
    (debugLevel === 'Basic' && fields.debug_scope !== 'verbose') ||
    severity === 'error';

  if (!shouldLog) return;

  const record = {
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    severity,
    event,
    ...fields,
  };
  delete record.debug_scope;

  const line = `${JSON.stringify(record)}\n`;
  process.stderr.write(line);

  const logFile = process.env.N8N_MAIL_LOG_FILE;
  if (logFile) {
    appendFileSync(logFile, line, { encoding: 'utf8' });
  }
}

function parseArgs(argv) {
  const parsed = {
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: '',
    from: '',
    replyTo: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--help' || raw === '-h') {
      parsed.help = true;
      continue;
    }

    if (!raw.startsWith('--')) {
      throw new UsageError(`Unexpected positional argument: ${raw}`);
    }

    const [flagWithPrefix, inlineValue] = raw.split(/=(.*)/s, 2);
    const flag = flagWithPrefix.slice(2);
    if (ATTACHMENT_FLAGS.has(flag)) {
      throw new UsageError('Attachments are not supported in v1.');
    }

    const value =
      inlineValue !== undefined
        ? inlineValue
        : argv[index + 1] && !argv[index + 1].startsWith('--')
          ? argv[++index]
          : undefined;

    switch (flag) {
      case 'to':
      case 'cc':
      case 'bcc':
        if (value === undefined) throw new UsageError(`Missing value for --${flag}.`);
        parsed[flag].push(...splitAddresses(value));
        break;
      case 'subject':
        if (value === undefined) throw new UsageError('Missing value for --subject.');
        parsed.subject = value;
        break;
      case 'body':
        if (value === undefined) throw new UsageError('Missing value for --body.');
        parsed.body = value;
        break;
      case 'from':
        if (value === undefined) throw new UsageError('Missing value for --from.');
        parsed.from = value.trim();
        break;
      case 'reply-to':
      case 'replyTo':
        if (value === undefined) throw new UsageError(`Missing value for --${flag}.`);
        parsed.replyTo = value.trim();
        break;
      default:
        throw new UsageError(`Unknown option: --${flag}`);
    }
  }

  return parsed;
}

function validateEmail(value, fieldName) {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(value)) {
    throw new UsageError(`Invalid email in ${fieldName}: ${value}`);
  }
}

function validateInput(input) {
  if (input.help) return;
  if (input.to.length === 0) throw new UsageError('Missing required --to.');
  if (!input.from) throw new UsageError('Missing required --from.');
  if (!input.replyTo) throw new UsageError('Missing required --reply-to.');
  if (!input.subject.trim()) throw new UsageError('Missing required --subject.');
  if (!input.body.trim()) throw new UsageError('Missing required --body.');

  input.to.forEach((email) => validateEmail(email, '--to'));
  input.cc.forEach((email) => validateEmail(email, '--cc'));
  input.bcc.forEach((email) => validateEmail(email, '--bcc'));
  validateEmail(input.from, '--from');
  validateEmail(input.replyTo, '--reply-to');
}

async function postJson(url, token, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-ServiceDesk-Token': token,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let responseBody = responseText;
    try {
      responseBody = responseText ? JSON.parse(responseText) : {};
    } catch {
      responseBody = { raw: responseText };
    }
    return {
      ok: response.ok,
      status: response.status,
      body: responseBody,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const debugLevel = normalizeDebugLevel(process.env.N8N_MAIL_DEBUG);
  const startedAt = Date.now();
  const requestId = randomUUID();

  try {
    const input = parseArgs(process.argv.slice(2));
    if (input.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    validateInput(input);

    const webhookUrl = process.env.N8N_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
    const webhookToken = process.env.N8N_WEBHOOK_TOKEN;
    if (!webhookToken) {
      throw new UsageError('N8N_WEBHOOK_TOKEN is required.');
    }

    const timeoutMs = Number.parseInt(
      process.env.N8N_MAIL_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS),
      10,
    );
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new UsageError('N8N_MAIL_TIMEOUT_MS must be a positive integer.');
    }

    const url = new URL(webhookUrl);
    const payload = {
      request_id: requestId,
      to: input.to,
      from: input.from,
      replyTo: input.replyTo,
      subject: input.subject,
      body: input.body,
    };
    if (input.cc.length) payload.cc = input.cc;
    if (input.bcc.length) payload.bcc = input.bcc;

    logEvent(debugLevel, 'email_dispatch_request', {
      request_id: requestId,
      webhook_origin: url.origin,
      to_count: input.to.length,
      cc_count: input.cc.length,
      bcc_count: input.bcc.length,
      from: maskEmail(input.from),
      reply_to: maskEmail(input.replyTo),
      subject_length: input.subject.length,
      body_length: input.body.length,
    });
    logEvent(debugLevel, 'email_dispatch_request_verbose', {
      debug_scope: 'verbose',
      request_id: requestId,
      to: maskAddressList(input.to),
      cc: maskAddressList(input.cc),
      bcc: maskAddressList(input.bcc),
      reply_to: input.replyTo ? maskEmail(input.replyTo) : '',
    });

    const result = await postJson(webhookUrl, webhookToken, payload, timeoutMs);
    const durationMs = Date.now() - startedAt;

    logEvent(debugLevel, 'email_dispatch_response', {
      request_id: requestId,
      status_code: result.status,
      duration_ms: durationMs,
    }, result.ok ? 'info' : 'error');

    if (!result.ok) {
      process.stderr.write(`${JSON.stringify({
        error: 'n8n_webhook_error',
        status: result.status,
        response: result.body,
      })}\n`);
      return 1;
    }

    process.stdout.write(`${JSON.stringify({
      status: 'ok',
      request_id: requestId,
      n8n: result.body,
    })}\n`);
    return 0;
  } catch (error) {
    const isUsage = error instanceof UsageError;
    logEvent(debugLevel, 'email_dispatch_failed', {
      request_id: requestId,
      error_name: error.name,
      error_message: error.message,
    }, 'error');

    if (isUsage) {
      process.stderr.write(`${error.message}\n\n${usage()}\n`);
      return 2;
    }

    process.stderr.write(`${JSON.stringify({
      error: 'email_dispatch_failed',
      message: error.message,
    })}\n`);
    return 1;
  }
}

process.exitCode = await main();
