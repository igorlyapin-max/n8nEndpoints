#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import { loadMcpToolManifest } from './mcp-tool-manifest.mjs';

const SERVICE_NAME = 'provider-ops-mcp';
const DEFAULT_PORT = 9000;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_N8N_WEBHOOK_BASE_URL = 'http://127.0.0.1:5678/webhook';
const DEFAULT_N8N_HEALTH_URL = 'http://127.0.0.1:5678/healthz';
const REQUEST_TIMEOUT_MS = parseInteger(process.env.MCP_PROVIDER_OPS_REQUEST_TIMEOUT_MS, 30000);

const { manifest, paths: manifestPaths } = loadMcpToolManifest();
const tools = new Map(manifest.tools.map((tool) => [tool.tool_name, tool]));

const config = {
  host: process.env.MCP_PROVIDER_OPS_HOST || DEFAULT_HOST,
  port: parseInteger(process.env.MCP_PROVIDER_OPS_PORT, DEFAULT_PORT),
  scheme: normalizeScheme(process.env.MCP_PROVIDER_OPS_SCHEME || 'http'),
  tlsCertFile: process.env.MCP_PROVIDER_OPS_TLS_CERT_FILE || '',
  tlsKeyFile: process.env.MCP_PROVIDER_OPS_TLS_KEY_FILE || '',
  tlsClientCaFile: process.env.MCP_PROVIDER_OPS_TLS_CLIENT_CA_FILE || '',
  tlsRequireClientCert: String(process.env.MCP_PROVIDER_OPS_TLS_REQUIRE_CLIENT_CERT || 'false').toLowerCase() === 'true',
  token: process.env.MCP_PROVIDER_OPS_TOKEN || '',
  n8nWebhookBaseUrl: trimTrailingSlash(process.env.N8N_WEBHOOK_BASE_URL || DEFAULT_N8N_WEBHOOK_BASE_URL),
  n8nWebhookToken: process.env.N8N_WEBHOOK_TOKEN || '',
  n8nHealthUrl: process.env.N8N_HEALTH_URL || DEFAULT_N8N_HEALTH_URL,
  debugEnabled: String(process.env.DEBUG_LOGGING_ENABLED || process.env.N8N_MCP_DEBUG_ENABLED || 'false').toLowerCase() === 'true',
  debugLevel: process.env.DEBUG_LOGGING_LEVEL || process.env.N8N_MCP_DEBUG_LEVEL || 'Basic',
};

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && (request.url === '/health' || request.url === '/mcp/health')) {
      return sendJson(response, 200, healthPayload());
    }
    if (request.method === 'GET' && (request.url === '/ready' || request.url === '/mcp/ready')) {
      return sendJson(response, 200, await readinessPayload());
    }
    if (request.method !== 'POST' || request.url !== '/mcp') {
      return sendJson(response, 404, { error: { code: 'not_found', message: 'Use POST /mcp.' } });
    }
    const authError = validateAuth(request);
    if (authError) {
      return sendJson(response, authError.status, { error: authError.error });
    }
    const body = await readJsonRequest(request);
    const jsonrpc = await handleJsonRpc(body);
    return sendJson(response, 200, jsonrpc);
  } catch (error) {
    log('error', 'request_failed', { error: safeError(error) });
    return sendJson(response, 500, { error: { code: 'internal_error', message: 'MCP adapter request failed.' } });
  }
});

server.listen(config.port, config.host, () => {
  log('info', 'provider_ops_mcp_started', {
    scheme: config.scheme,
    host: config.host,
    port: config.port,
    tls_client_cert_required: config.tlsRequireClientCert,
    n8n_webhook_base_url: config.n8nWebhookBaseUrl,
    auth_configured: Boolean(config.token),
    n8n_auth_configured: Boolean(config.n8nWebhookToken),
    manifest_id: manifest.manifest_id,
    manifest_contract_version: manifest.contract_version,
    tool_count: tools.size,
  });
});

function createServer(requestHandler) {
  if (config.scheme === 'http') {
    return http.createServer(requestHandler);
  }
  if (!config.tlsCertFile || !config.tlsKeyFile) {
    throw new Error('MCP_PROVIDER_OPS_TLS_CERT_FILE and MCP_PROVIDER_OPS_TLS_KEY_FILE are required for https MCP.');
  }
  const options = {
    cert: fs.readFileSync(config.tlsCertFile),
    key: fs.readFileSync(config.tlsKeyFile),
  };
  if (config.tlsClientCaFile) {
    options.ca = fs.readFileSync(config.tlsClientCaFile);
  }
  if (config.tlsRequireClientCert) {
    options.requestCert = true;
    options.rejectUnauthorized = true;
    if (!config.tlsClientCaFile) {
      throw new Error('MCP_PROVIDER_OPS_TLS_CLIENT_CA_FILE is required when client certificates are required.');
    }
  }
  return https.createServer(options, requestHandler);
}

async function handleJsonRpc(body) {
  const id = body?.id ?? null;
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return jsonRpcError(id, -32600, 'Invalid JSON-RPC request.');
  }
  if (body.method === 'tools/list') {
    return jsonRpcResult(id, {
      tools: Array.from(tools.values()).map(toolDescriptor),
    });
  }
  if (body.method === 'tools/call') {
    try {
      return jsonRpcResult(id, await callTool(body.params || {}));
    } catch (error) {
      log('error', 'tool_call_failed', { error: safeError(error) });
      return jsonRpcError(id, -32000, error.message || 'Tool call failed.');
    }
  }
  return jsonRpcError(id, -32601, `Unsupported method: ${body.method}`);
}

async function callTool(params) {
  const toolName = params?.name;
  const tool = tools.get(toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName || 'empty'}`);
  }
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const inputs = args.inputs && typeof args.inputs === 'object' ? args.inputs : args;
  const asyncContext = args.async_context && typeof args.async_context === 'object' ? args.async_context : null;
  validateRequiredInputs(tool, inputs);
  if (tool.execution_mode === 'async') {
    validateAsyncContext(tool, asyncContext);
  }
  ensureConfigured();
  const n8nBody = mapInputsForTool(tool, inputs, asyncContext);
  const n8nResult = await postN8n(n8nCallPath(tool.webhook_path), n8nBody, tool, asyncContext);
  const mcpResult = toMcpResult(tool, n8nResult, asyncContext);
  log('info', 'tool_call_completed', {
    tool_name: tool.tool_name,
    capability_id: tool.capability_id,
    execution_mode: tool.execution_mode,
    correlation_id: asyncContext?.correlation_id,
    status: mcpResult.status,
  });
  return mcpResult;
}

function toolDescriptor(tool) {
  return {
    name: tool.tool_name,
    description: tool.description,
    inputSchema: tool.input_schema,
    _meta: {
      servicedesk: {
        capability_id: tool.capability_id,
        contract_version: manifest.contract_version,
        execution_mode: tool.execution_mode,
        execution_modes: [tool.execution_mode],
        output_schema: tool.output_schema,
        async_event_contracts: tool.execution_mode === 'async'
          ? {
              [tool.expected_event_type]: {
                statuses: ['progress', 'success', 'error', 'timeout', 'cancelled'],
                result_schema: tool.output_schema,
              },
            }
          : {},
      },
    },
  };
}

function mapInputsForTool(tool, inputs, asyncContext) {
  const output = {};
  for (const [targetField, mapping] of Object.entries(tool.input_mapping || {})) {
    if (mapping?.async_invocation === true) {
      output[targetField] = buildN8nInvocation(tool, asyncContext);
      continue;
    }
    if (!mapping?.input) {
      continue;
    }
    const value = inputValue(inputs, tool, mapping.input);
    if (!hasValue(value)) {
      continue;
    }
    output[targetField] = mapping.type === 'integer' ? integerOrOriginal(value) : value;
  }
  return output;
}

function buildN8nInvocation(tool, asyncContext) {
  return {
    invocation_id: invocationIdFrom(asyncContext),
    action_id: tool.action_id,
    extensions: {
      async_callback: {
        source: 'mcp',
        case_id: asyncContext.case_id,
        ticket_id: asyncContext.ticket_id,
        run_id: asyncContext.run_id,
        wait_id: asyncContext.wait_id,
        correlation_id: asyncContext.correlation_id,
        event_type: tool.expected_event_type,
        idempotency_key_base: asyncContext.idempotency_key_base,
        result_transport: asyncContext.result_transport,
        callback_url: asyncContext.callback_url,
        result_topic: asyncContext.result_topic,
      },
    },
  };
}

function toMcpResult(tool, n8nResult, asyncContext) {
  if (tool.result_mapping?.type === 'accepted_ack') {
    return acceptedResult(tool, n8nResult, asyncContext);
  }
  return {
    status: 'success',
    result: n8nResult,
  };
}

function acceptedResult(tool, n8nResult, asyncContext) {
  const externalExecutionId = firstString(
    n8nResult.external_execution_id,
    n8nResult.invocation_id,
    invocationIdFrom(asyncContext),
  ) || `${tool.tool_name}:${asyncContext.correlation_id}`;
  return {
    status: 'accepted',
    external_execution_id: externalExecutionId,
    correlation_id: asyncContext.correlation_id,
    message: firstString(n8nResult.message) || 'Execution accepted.',
    diagnostics: {
      capability_id: tool.capability_id,
      expected_event_type: tool.expected_event_type,
      runbook_status: n8nResult.runbook_status || null,
      result_transport: n8nResult.result_transport || asyncContext.result_transport,
      result_topic: n8nResult.result_topic || asyncContext.result_topic || null,
      wait_id: asyncContext.wait_id,
    },
  };
}

async function postN8n(path, body, tool, asyncContext) {
  const url = `${config.n8nWebhookBaseUrl}${path}`;
  log('debug', 'n8n_call_started', {
    tool_name: tool.tool_name,
    capability_id: tool.capability_id,
    correlation_id: asyncContext?.correlation_id,
    url_origin: safeUrlOrigin(url),
    payload_keys: Object.keys(body || {}).sort(),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ServiceDesk-Token': config.n8nWebhookToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`n8n response is not JSON for ${tool.tool_name}: HTTP ${response.status}`);
      }
    }
    if (!response.ok) {
      const code = parsed?.error?.code || `http_${response.status}`;
      const message = parsed?.error?.message || response.statusText || 'n8n webhook error';
      throw new Error(`n8n ${tool.tool_name} failed: ${code}: ${message}`);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function readinessPayload() {
  const payload = healthPayload();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(config.n8nHealthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    payload.n8n = { status: response.ok ? 'ok' : 'error', http_status: response.status };
    payload.status = response.ok && payload.auth_configured && payload.n8n_auth_configured ? 'ok' : 'degraded';
  } catch (error) {
    payload.status = 'degraded';
    payload.n8n = { status: 'error', error: error.name || 'n8n_health_failed' };
  }
  return payload;
}

function healthPayload() {
  return {
    schema_version: '1.0',
    service: SERVICE_NAME,
    status: 'ok',
    scheme: config.scheme,
    tls_client_cert_required: config.tlsRequireClientCert,
    auth_configured: Boolean(config.token),
    n8n_auth_configured: Boolean(config.n8nWebhookToken),
    manifest_id: manifest.manifest_id,
    manifest_contract_version: manifest.contract_version,
    manifest_paths: manifestPaths,
    tools: Array.from(tools.keys()),
  };
}

function validateAuth(request) {
  if (!config.token) {
    return {
      status: 503,
      error: { code: 'mcp_auth_not_configured', message: 'MCP_PROVIDER_OPS_TOKEN is required.' },
    };
  }
  const expected = `Bearer ${config.token}`;
  if (request.headers.authorization !== expected) {
    return {
      status: 401,
      error: { code: 'unauthorized', message: 'Missing or invalid Bearer token.' },
    };
  }
  return null;
}

function ensureConfigured() {
  if (!config.n8nWebhookToken) {
    throw new Error('N8N_WEBHOOK_TOKEN is required for n8n webhook calls.');
  }
}

function validateRequiredInputs(tool, inputs) {
  const missing = tool.required_inputs.filter((name) => !hasValue(inputValue(inputs, tool, name)));
  if (missing.length) {
    throw new Error(`Missing required input(s) for ${tool.tool_name}: ${missing.join(', ')}`);
  }
}

function validateAsyncContext(tool, asyncContext) {
  if (!asyncContext) {
    throw new Error('async_context is required for async tool calls.');
  }
  const required = [
    'case_id',
    'run_id',
    'wait_id',
    'correlation_id',
    'capability_id',
    'contract_version',
    'expected_event_type',
    'idempotency_key_base',
    'result_transport',
  ];
  const missing = required.filter((name) => !firstString(asyncContext[name]));
  if (missing.length) {
    throw new Error(`async_context missing required field(s): ${missing.join(', ')}`);
  }
  if (asyncContext.capability_id !== tool.capability_id) {
    throw new Error(`async_context.capability_id must be ${tool.capability_id}.`);
  }
  if (asyncContext.contract_version !== manifest.contract_version) {
    throw new Error(`async_context.contract_version must be ${manifest.contract_version}.`);
  }
  if (asyncContext.expected_event_type !== tool.expected_event_type) {
    throw new Error(`async_context.expected_event_type must be ${tool.expected_event_type}.`);
  }
  if (['http_callback', 'both'].includes(asyncContext.result_transport) && !firstString(asyncContext.callback_url)) {
    throw new Error('async_context.callback_url is required for http_callback/both.');
  }
  if (['kafka_event', 'both'].includes(asyncContext.result_transport) && !firstString(asyncContext.result_topic)) {
    throw new Error('async_context.result_topic is required for kafka_event/both.');
  }
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) {
    throw new Error('Empty request body.');
  }
  return JSON.parse(text);
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function inputValue(inputs, tool, canonicalName) {
  const aliases = Array.from(new Set([canonicalName, ...(tool.input_aliases?.[canonicalName] || [])]));
  for (const alias of aliases) {
    if (Object.hasOwn(inputs, alias) && hasValue(inputs[alias])) {
      return normalizeScalar(inputs[alias]);
    }
  }
  return undefined;
}

function hasValue(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

function normalizeScalar(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function integerOrOriginal(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : value;
  }
  if (typeof value === 'string' && /^[-+]?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return value;
}

function invocationIdFrom(asyncContext) {
  const key = firstString(asyncContext?.idempotency_key_base, asyncContext?.correlation_id);
  const parts = key.split(':').filter(Boolean);
  return parts.at(-1) || key || `mcp-${Date.now()}`;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeScheme(value) {
  const scheme = String(value || '').trim().toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    return scheme;
  }
  throw new Error('MCP_PROVIDER_OPS_SCHEME must be http or https.');
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function n8nCallPath(webhookPath) {
  const normalizedPath = webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`;
  if (config.n8nWebhookBaseUrl.endsWith('/webhook') && normalizedPath.startsWith('/webhook/')) {
    return normalizedPath.slice('/webhook'.length);
  }
  return normalizedPath;
}

function safeUrlOrigin(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid_url';
  }
}

function safeError(error) {
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]'),
  };
}

function log(level, event, fields = {}) {
  if (level === 'debug' && !(config.debugEnabled && config.debugLevel === 'Verbose')) {
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    service: SERVICE_NAME,
    level,
    event,
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
