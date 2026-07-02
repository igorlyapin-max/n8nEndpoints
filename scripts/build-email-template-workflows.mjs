#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const CATALOG_PATH = 'contracts/email-template-catalog.json';
const CATALOG_WORKFLOW_PATH = 'workflows/email-template-catalog-webhook.json';
const SEND_WORKFLOW_PATH = 'workflows/send-templated-email-webhook.json';
const PARAM_REF_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*}}/g;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function uniq(values) {
  return [...new Set(values)];
}

function extractPlaceholders(...texts) {
  const found = [];
  for (const text of texts) {
    for (const match of String(text).matchAll(PARAM_REF_PATTERN)) {
      found.push(match[1]);
    }
  }
  return uniq(found);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateCatalog(catalog) {
  assert(catalog && typeof catalog === 'object' && !Array.isArray(catalog), 'Catalog must be an object.');
  assert(catalog.schema_version === '1.0', 'Catalog schema_version must be 1.0.');
  assert(Array.isArray(catalog.templates) && catalog.templates.length > 0, 'Catalog must contain templates.');

  const templateIds = new Set();
  for (const template of catalog.templates) {
    assert(/^[a-z][a-z0-9_.-]*$/.test(template.template_id || ''), `Invalid template_id: ${template.template_id}`);
    assert(!templateIds.has(template.template_id), `Duplicate template_id: ${template.template_id}`);
    templateIds.add(template.template_id);
    assert(typeof template.subject_template === 'string' && template.subject_template.trim(), `${template.template_id}: subject_template is required.`);
    assert(typeof template.body_template === 'string' && template.body_template.trim(), `${template.template_id}: body_template is required.`);

    const required = template.required_params || [];
    const optional = template.optional_params || [];
    const params = template.params || [];
    const allowedNames = new Set([...required, ...optional]);
    const paramNames = new Set(params.map((param) => param.name));
    assert(Array.isArray(required), `${template.template_id}: required_params must be an array.`);
    assert(Array.isArray(optional), `${template.template_id}: optional_params must be an array.`);
    assert(Array.isArray(params) && params.length > 0, `${template.template_id}: params must be a non-empty array.`);

    for (const name of [...required, ...optional]) {
      assert(/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name), `${template.template_id}: invalid param name ${name}.`);
      assert(paramNames.has(name), `${template.template_id}: param ${name} is listed but not described in params.`);
    }
    for (const param of params) {
      assert(/^[A-Za-z][A-Za-z0-9_.-]*$/.test(param.name || ''), `${template.template_id}: invalid described param name ${param.name}.`);
      assert(allowedNames.has(param.name), `${template.template_id}: described param ${param.name} is not listed in required_params or optional_params.`);
      assert(required.includes(param.name) === Boolean(param.required), `${template.template_id}: required flag mismatch for ${param.name}.`);
    }

    const placeholders = extractPlaceholders(template.subject_template, template.body_template);
    for (const name of placeholders) {
      assert(allowedNames.has(name), `${template.template_id}: placeholder ${name} is not declared.`);
    }
  }
}

function buildCatalogCode(catalog) {
  return [
    `const catalog = ${stableJson(catalog)};`,
    "return [{ json: { statusCode: 200, response: catalog } }];",
  ].join('\n');
}

function buildSendCode(catalog) {
  return [
    `const catalog = ${stableJson(catalog)};`,
    "const input = $input.first().json;",
    "const headers = input.headers || {};",
    "const body = input.body || {};",
    "const expectedToken = (typeof $env !== 'undefined' && $env.N8N_WEBHOOK_TOKEN) || (typeof process !== 'undefined' && process.env.N8N_WEBHOOK_TOKEN) || '';",
    "const actualToken = headers['x-servicedesk-token'] || headers['X-ServiceDesk-Token'] || headers['X-Servicedesk-Token'] || '';",
    "const debugLevel = String((typeof $env !== 'undefined' && $env.N8N_WORKFLOW_DEBUG) || (typeof process !== 'undefined' && process.env.N8N_WORKFLOW_DEBUG) || 'off');",
    "const diagnostic = (level, event, fields = {}) => {",
    "  const order = { off: 0, Basic: 1, Verbose: 2 };",
    "  if ((order[debugLevel] || 0) < (order[level] || 0)) return;",
    "  const safeFields = {};",
    "  for (const [key, value] of Object.entries(fields)) {",
    "    if (/token|password|secret|body/i.test(key)) continue;",
    "    safeFields[key] = value;",
    "  }",
    "  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safeFields }));",
    "};",
    "const response = (statusCode, code, message, details = {}) => {",
    "  diagnostic('Basic', 'send_templated_email_rejected', { statusCode, code, templateId: details.templateId });",
    "  return [{ json: { shouldSend: false, statusCode, response: { error: { code, message, ...details } } } }];",
    "};",
    "if (!expectedToken || actualToken !== expectedToken) return response(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');",
    "if (body.attachment || body.attachments || body.files) return response(400, 'attachments_not_supported', 'Attachments are not supported in v1.');",
    "const split = value => String(value).split(/[;,]/).map(v => v.trim()).filter(Boolean);",
    "const list = value => Array.isArray(value) ? value.flatMap(split) : split(value || '');",
    "const emailRe = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;",
    "const invalid = values => values.filter(v => !emailRe.test(v));",
    "const fromEmail = String(body.from || '').trim();",
    "const replyTo = String(body.replyTo || body.reply_to || '').trim();",
    "const to = list(body.to);",
    "const cc = list(body.cc);",
    "const bcc = list(body.bcc);",
    "const templateId = String(body.templateId || '').trim();",
    "const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : null;",
    "if (to.length === 0) return response(400, 'missing_to', 'Поле to обязательно.');",
    "if (!fromEmail) return response(400, 'missing_from', 'Поле from обязательно.');",
    "if (!replyTo) return response(400, 'missing_reply_to', 'Поле replyTo обязательно.');",
    "if (!templateId) return response(400, 'missing_template_id', 'Поле templateId обязательно.');",
    "if (!params) return response(400, 'missing_params', 'Поле params обязательно и должно быть объектом.');",
    "const bad = [...invalid(to), ...invalid(cc), ...invalid(bcc), ...(!emailRe.test(fromEmail) ? [fromEmail] : []), ...(!emailRe.test(replyTo) ? [replyTo] : [])];",
    "if (bad.length) return response(400, 'invalid_email', 'Некорректный email адрес.', { addresses: bad });",
    "const template = catalog.templates.find(candidate => candidate.template_id === templateId);",
    "if (!template) return response(400, 'unknown_template_id', 'Шаблон email не найден.', { templateId });",
    "const missing = (template.required_params || []).filter(name => params[name] === undefined || params[name] === null || String(params[name]).trim() === '');",
    "if (missing.length) return response(400, 'missing_template_params', 'Не указаны обязательные параметры шаблона.', { templateId, missing_params: missing });",
    "const paramDefs = new Map((template.params || []).map(param => [param.name, param]));",
    "const controlCharRe = /[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]/;",
    "const rejectParam = (paramName, reason) => response(400, 'invalid_template_param', 'Параметр шаблона не прошел валидацию.', { templateId, param_name: paramName, reason });",
    "for (const paramName of Object.keys(params)) {",
    "  if (!paramDefs.has(paramName)) continue;",
    "  const def = paramDefs.get(paramName);",
    "  const value = params[paramName];",
    "  if (value === undefined || value === null || value === '') continue;",
    "  if (def.type === 'string' && typeof value !== 'string') return rejectParam(paramName, 'expected_string');",
    "  if (def.type === 'number' && typeof value !== 'number') return rejectParam(paramName, 'expected_number');",
    "  if (def.type === 'boolean' && typeof value !== 'boolean') return rejectParam(paramName, 'expected_boolean');",
    "  const text = String(value);",
    "  if (text.length > 2000) return rejectParam(paramName, 'too_long');",
    "  if (controlCharRe.test(text) || /[\\r\\n]/.test(text)) return rejectParam(paramName, 'control_chars_not_allowed');",
    "  if (def.pattern) {",
    "    const re = new RegExp(def.pattern);",
    "    if (!re.test(text)) return rejectParam(paramName, 'pattern_mismatch');",
    "  }",
    "}",
    "const stringify = value => {",
    "  if (value === undefined || value === null) return '';",
    "  if (typeof value === 'string') return value;",
    "  if (typeof value === 'number' || typeof value === 'boolean') return String(value);",
    "  return JSON.stringify(value);",
    "};",
    "const render = text => String(text).replace(/{{\\s*([A-Za-z][A-Za-z0-9_.-]*)\\s*}}/g, (_match, name) => stringify(params[name]));",
    "const subject = render(template.subject_template).trim();",
    "const textBody = render(template.body_template);",
    "if (!subject) return response(400, 'empty_rendered_subject', 'После подстановки шаблона тема письма пустая.', { templateId });",
    "if (!textBody.trim()) return response(400, 'empty_rendered_body', 'После подстановки шаблона тело письма пустое.', { templateId });",
    "if (/[\\r\\n]/.test(subject) || controlCharRe.test(subject)) return response(400, 'invalid_rendered_subject', 'После подстановки шаблона тема письма содержит недопустимые символы.', { templateId });",
    "if (subject.length > 500) return response(400, 'rendered_subject_too_long', 'После подстановки шаблона тема письма слишком длинная.', { templateId });",
    "if (textBody.length > 20000) return response(400, 'rendered_body_too_long', 'После подстановки шаблона тело письма слишком длинное.', { templateId });",
    "const requestId = String(body.request_id || body.requestId || `n8n-templated-mail-${Date.now()}`).trim();",
    "diagnostic('Basic', 'send_templated_email_accepted', { requestId, templateId, to_count: to.length, cc_count: cc.length, bcc_count: bcc.length });",
    "return [{ json: { shouldSend: true, statusCode: 200, requestId, templateId, to, cc, bcc, toEmail: to.join(', '), ccEmail: cc.join(', '), bccEmail: bcc.join(', '), from_email: fromEmail, reply_to: replyTo, replyTo, subject, body: textBody } }];",
  ].join('\n');
}

function catalogWorkflow(catalog) {
  return documentedWorkflow({
    id: 'emailTemplateCatalog',
    name: 'Contracts: Email template catalog',
    nodes: [
      {
        parameters: {
          httpMethod: 'GET',
          path: 'contracts/email-templates.json',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'email-template-catalog-webhook',
        name: 'Webhook каталога email-шаблонов',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '8406c38d-d3a2-4ba5-84d0-1cfbf93884db',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: buildCatalogCode(catalog),
        },
        id: 'email-template-catalog-build-response',
        name: 'Подготовка каталога email-шаблонов',
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
        id: 'email-template-catalog-response',
        name: 'Ответ каталога email-шаблонов',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [800, 300],
      },
    ],
    connections: {
      'Webhook каталога email-шаблонов': {
        main: [
          [
            {
              node: 'Подготовка каталога email-шаблонов',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Подготовка каталога email-шаблонов': {
        main: [
          [
            {
              node: 'Ответ каталога email-шаблонов',
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
      saveDataErrorExecution: 'none',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: false,
    },
  });
}

function sendWorkflow(catalog) {
  return documentedWorkflow({
    id: 'sendTemplatedEmail',
    name: 'Email: отправка письма по шаблону',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'email/send-template',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'send-templated-email-webhook',
        name: 'Webhook отправки письма по шаблону',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '55fba4bb-d20f-43f7-9d30-5088a1f74da9',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: buildSendCode(catalog),
        },
        id: 'send-templated-email-validate-request',
        name: 'Подготовка шаблонного письма',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [520, 300],
      },
      {
        parameters: {
          conditions: {
            boolean: [
              {
                value1: '={{ $json.shouldSend }}',
                operation: 'equal',
                value2: true,
              },
            ],
          },
          combineOperation: 'all',
        },
        id: 'send-templated-email-if-valid',
        name: 'Запрос валиден?',
        type: 'n8n-nodes-base.if',
        typeVersion: 1,
        position: [800, 300],
      },
      {
        parameters: {
          resource: 'email',
          operation: 'send',
          fromEmail: '={{ $json.from_email }}',
          toEmail: '={{ $json.toEmail }}',
          subject: '={{ $json.subject }}',
          emailFormat: 'text',
          text: '={{ $json.body }}',
          options: {
            appendAttribution: false,
            ccEmail: '={{ $json.ccEmail }}',
            bccEmail: '={{ $json.bccEmail }}',
            replyTo: '={{ $json.reply_to }}',
          },
        },
        id: 'send-templated-email-node',
        name: 'Отправка email',
        type: 'n8n-nodes-base.emailSend',
        typeVersion: 2.1,
        position: [1080, 200],
        credentials: {
          smtp: {
            id: 'Fh3kVhbHL6XxDh1c',
            name: 'GreenMail SMTP (local test)',
          },
        },
        continueOnFail: true,
      },
      {
        parameters: {
          jsCode: "const result = $input.first().json || {};\nconst err = result.error || result.message?.error;\nif (err) {\n  const message = typeof err === 'string' ? err : (err.message || 'Email Send node failed.');\n  return [{ json: { statusCode: 502, response: { error: { code: 'email_send_failed', message } } } }];\n}\nreturn [{ json: { statusCode: 200, response: { status: 'sent' } } }];",
        },
        id: 'send-templated-email-build-response',
        name: 'Результат отправки',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1340, 200],
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify($json.response) }}',
          options: {
            responseCode: '={{ $json.statusCode }}',
          },
        },
        id: 'send-templated-email-success-response',
        name: 'Ответ отправки',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1600, 200],
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify($json.response) }}',
          options: {
            responseCode: '={{ $json.statusCode }}',
          },
        },
        id: 'send-templated-email-error-response',
        name: 'Ответ ошибки',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1080, 420],
      },
    ],
    connections: {
      'Webhook отправки письма по шаблону': {
        main: [
          [
            {
              node: 'Подготовка шаблонного письма',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Подготовка шаблонного письма': {
        main: [
          [
            {
              node: 'Запрос валиден?',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Запрос валиден?': {
        main: [
          [
            {
              node: 'Отправка email',
              type: 'main',
              index: 0,
            },
          ],
          [
            {
              node: 'Ответ ошибки',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Отправка email': {
        main: [
          [
            {
              node: 'Результат отправки',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Результат отправки': {
        main: [
          [
            {
              node: 'Ответ отправки',
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
      saveDataErrorExecution: 'none',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: false,
    },
  });
}

function expectedFiles(catalog) {
  return new Map([
    [CATALOG_WORKFLOW_PATH, `${stableJson(catalogWorkflow(catalog))}\n`],
    [SEND_WORKFLOW_PATH, `${stableJson(sendWorkflow(catalog))}\n`],
  ]);
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const catalog = readJson(CATALOG_PATH);
  validateCatalog(catalog);
  const files = expectedFiles(catalog);
  let drift = false;

  for (const [path, expected] of files) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current === expected) continue;
    if (checkOnly) {
      process.stderr.write(`${path} is out of date with ${CATALOG_PATH}\n`);
      drift = true;
    } else {
      writeFileSync(path, expected, 'utf8');
      process.stdout.write(`updated ${path} from ${CATALOG_PATH}\n`);
    }
  }

  if (!drift && checkOnly) {
    process.stdout.write('email template workflows are up to date\n');
  }
  return drift ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
