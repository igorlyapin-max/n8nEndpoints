#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import net from 'node:net';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const DEFAULTS = {
  smtpHost: '127.0.0.1',
  smtpPort: 3025,
  imapHost: '127.0.0.1',
  imapPort: 3143,
  from: 'sender@local.test',
  to: 'automation-test@local.test',
  user: 'automation-test@local.test',
  password: 'automation-pass',
  replyUser: 'sender@local.test',
  replyPassword: 'automation-pass',
  timeoutMs: 10000,
  replyTimeoutMs: 30000,
};

function debugLevel() {
  const value = String(process.env.MAILTEST_DEBUG || '').toLowerCase();
  if (value === 'basic') return 'Basic';
  if (value === 'verbose') return 'Verbose';
  return 'Off';
}

function log(level, event, fields = {}, severity = 'info') {
  const enabled = debugLevel();
  if (enabled === 'Off' && severity !== 'error') return;
  if (enabled === 'Basic' && fields.debug_scope === 'verbose') return;
  const record = {
    timestamp: new Date().toISOString(),
    service: 'n8n-mailtest-smoke',
    severity,
    event,
    ...fields,
  };
  delete record.debug_scope;
  const line = `${JSON.stringify(record)}\n`;
  process.stderr.write(line);
  if (process.env.MAILTEST_LOG_FILE) {
    appendFileSync(process.env.MAILTEST_LOG_FILE, line, 'utf8');
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LineClient {
  constructor({ host, port, timeoutMs }) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.lines = [];
  }

  async connect() {
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '');
        this.lines.push(line);
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf('\n');
      }
    });
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
  }

  async readUntil(predicate) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const foundIndex = this.lines.findIndex(predicate);
      if (foundIndex >= 0) {
        return this.lines.splice(0, foundIndex + 1);
      }
      await wait(25);
    }
    throw new Error(`Timed out waiting for ${this.host}:${this.port}`);
  }

  write(line) {
    this.socket.write(`${line}\r\n`);
  }

  close() {
    if (this.socket) this.socket.end();
  }
}

async function smtpSend({ host, port, from, to, subject, body, timeoutMs }) {
  const client = new LineClient({ host, port, timeoutMs });
  await client.connect();
  try {
    await client.readUntil((line) => line.startsWith('220'));
    client.write('EHLO n8n-mailtest-smoke.local');
    await client.readUntil((line) => line.startsWith('250 '));
    client.write(`MAIL FROM:<${from}>`);
    await client.readUntil((line) => line.startsWith('250'));
    client.write(`RCPT TO:<${to}>`);
    await client.readUntil((line) => line.startsWith('250'));
    client.write('DATA');
    await client.readUntil((line) => line.startsWith('354'));
    client.write(`From: ${from}`);
    client.write(`To: ${to}`);
    client.write(`Subject: ${subject}`);
    client.write('Content-Type: text/plain; charset=utf-8');
    client.write('');
    client.write(body);
    client.write('.');
    await client.readUntil((line) => line.startsWith('250'));
    client.write('QUIT');
    return true;
  } finally {
    client.close();
  }
}

async function imapFindSubject({ host, port, user, password, subject, timeoutMs }) {
  const client = new LineClient({ host, port, timeoutMs });
  await client.connect();
  try {
    await client.readUntil((line) => line.startsWith('* OK'));
    client.write(`a1 LOGIN "${user}" "${password}"`);
    await client.readUntil((line) => line.startsWith('a1 OK'));
    client.write('a2 SELECT INBOX');
    await client.readUntil((line) => line.startsWith('a2 OK'));
    client.write(`a3 SEARCH SUBJECT "${subject.replaceAll('"', '\\"')}"`);
    const searchLines = await client.readUntil((line) => line.startsWith('a3 OK'));
    const searchLine = searchLines.find((line) => line.startsWith('* SEARCH')) || '';
    client.write('a4 LOGOUT');
    return searchLine.trim() !== '* SEARCH';
  } finally {
    client.close();
  }
}

async function main() {
  const requestId = randomUUID();
  const config = {
    smtpHost: process.env.MAILTEST_SMTP_HOST || DEFAULTS.smtpHost,
    smtpPort: Number(process.env.MAILTEST_SMTP_PORT || DEFAULTS.smtpPort),
    imapHost: process.env.MAILTEST_IMAP_HOST || DEFAULTS.imapHost,
    imapPort: Number(process.env.MAILTEST_IMAP_PORT || DEFAULTS.imapPort),
    from: process.env.MAILTEST_FROM || DEFAULTS.from,
    to: process.env.MAILTEST_TO || DEFAULTS.to,
    user: process.env.MAILTEST_IMAP_USER || DEFAULTS.user,
    password: process.env.MAILTEST_IMAP_PASSWORD || DEFAULTS.password,
    replyUser: process.env.MAILTEST_REPLY_IMAP_USER || process.env.MAILTEST_FROM || DEFAULTS.replyUser,
    replyPassword: process.env.MAILTEST_REPLY_IMAP_PASSWORD || DEFAULTS.replyPassword,
    timeoutMs: Number(process.env.MAILTEST_TIMEOUT_MS || DEFAULTS.timeoutMs),
    replyTimeoutMs: Number(process.env.MAILTEST_REPLY_TIMEOUT_MS || DEFAULTS.replyTimeoutMs),
  };
  const subject = process.env.MAILTEST_SUBJECT || `n8n mailtest smoke ${requestId}`;
  const body = process.env.MAILTEST_BODY || `Smoke test ${requestId}`;
  const expectReply = String(process.env.MAILTEST_EXPECT_REPLY || '').toLowerCase() === 'true';

  try {
    log('Basic', 'mailtest_smoke_start', {
      request_id: requestId,
      smtp_host: config.smtpHost,
      smtp_port: config.smtpPort,
      imap_host: config.imapHost,
      imap_port: config.imapPort,
    });
    await smtpSend({
      host: config.smtpHost,
      port: config.smtpPort,
      from: config.from,
      to: config.to,
      subject,
      body,
      timeoutMs: config.timeoutMs,
    });
    const found = await imapFindSubject({
      host: config.imapHost,
      port: config.imapPort,
      user: config.user,
      password: config.password,
      subject,
      timeoutMs: config.timeoutMs,
    });
    if (!found) {
      throw new Error('Sent message was not found in IMAP INBOX');
    }
    let replyFound = false;
    if (expectReply) {
      const replySubject = `Re: ${subject}`;
      const deadline = Date.now() + config.replyTimeoutMs;
      while (Date.now() < deadline && !replyFound) {
        replyFound = await imapFindSubject({
          host: config.imapHost,
          port: config.imapPort,
          user: config.replyUser,
          password: config.replyPassword,
          subject: replySubject,
          timeoutMs: Math.min(config.timeoutMs, 5000),
        });
        if (!replyFound) await wait(1000);
      }
      if (!replyFound) {
        throw new Error(`Auto reply was not found in ${config.replyUser} INBOX`);
      }
    }
    const result = {
      status: 'ok',
      request_id: requestId,
      subject,
      reply_checked: expectReply,
      reply_found: replyFound,
      smtp: `${config.smtpHost}:${config.smtpPort}`,
      imap: `${config.imapHost}:${config.imapPort}`,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    log('Basic', 'mailtest_smoke_ok', { request_id: requestId });
    return 0;
  } catch (error) {
    log('Basic', 'mailtest_smoke_failed', {
      request_id: requestId,
      error_name: error.name,
      error_message: error.message,
    }, 'error');
    process.stderr.write(`${JSON.stringify({ error: 'mailtest_smoke_failed', message: error.message })}\n`);
    return 1;
  }
}

process.exitCode = await main();
