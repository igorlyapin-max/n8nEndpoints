#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const WORKFLOW_PATH = 'workflows/stage4-runbook-webhook.json';

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const prepareCode = String.raw`const input = $input.first().json;
const headers = input.headers || {};
const body = input.body && typeof input.body === "object" ? input.body : {};
const env = typeof $env !== "undefined" ? $env : {};
function envValue(name) {
  return env[name] || (typeof process !== "undefined" ? process.env[name] : "") || "";
}
const expectedToken = envValue("N8N_WEBHOOK_TOKEN");
const actualToken = headers["x-servicedesk-token"] || headers["X-ServiceDesk-Token"] || headers["X-Servicedesk-Token"] || "";
const debugLevel = String(envValue("N8N_WORKFLOW_DEBUG") || "off");

function diagnostic(level, event, fields = {}) {
  const order = { off: 0, Basic: 1, Verbose: 2 };
  if ((order[debugLevel] || 0) < (order[level] || 0)) return;
  const safeFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|password|secret|callback_url/i.test(key)) continue;
    safeFields[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safeFields }));
}

function error(statusCode, code, message, details = {}) {
  diagnostic("Basic", "stage4_request_rejected", { statusCode, code });
  return [
    {
      json: {
        shouldPublishKafka: false,
        statusCode,
        response: {
          error: {
            code,
            message,
            ...details
          }
        }
      }
    }
  ];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseHttpUrl(raw) {
  const match = String(raw || "").match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)?(?:\?[^#]*)?(?:#.*)?$/);
  if (!match) return null;
  const protocol = match[1].toLowerCase() + ":";
  const authority = match[2] || "";
  const pathname = match[3] || "/";
  if (!authority) return null;
  const atIndex = authority.lastIndexOf("@");
  const hasCredentials = atIndex !== -1;
  const hostPort = hasCredentials ? authority.slice(atIndex + 1) : authority;
  if (!hostPort) return null;
  let hostname = "";
  let originHost = hostPort;
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end <= 1) return null;
    hostname = hostPort.slice(1, end);
    const portPart = hostPort.slice(end + 1);
    if (portPart && !/^:\d{1,5}$/.test(portPart)) return null;
    originHost = "[" + hostname.toLowerCase() + "]" + portPart;
  } else {
    if (hostPort.includes("[") || hostPort.includes("]")) return null;
    const parts = hostPort.split(":");
    if (parts.length > 2) return null;
    hostname = parts[0];
    if (!hostname) return null;
    if (parts[1] !== undefined && !/^\d{1,5}$/.test(parts[1])) return null;
    originHost = hostname.toLowerCase() + (parts[1] !== undefined ? ":" + parts[1] : "");
  }
  return { protocol, hasCredentials, hostname: hostname.toLowerCase(), origin: protocol + "//" + originHost, pathname };
}

function validateCallbackUrl(value) {
  const raw = stringValue(value);
  const parsed = parseHttpUrl(raw);
  if (!parsed) return { reason: "invalid_url" };
  if (!["http:", "https:"].includes(parsed.protocol)) return { reason: "invalid_scheme" };
  if (parsed.hasCredentials) return { reason: "credentials_not_allowed" };
  const envName = stringValue(envValue("NODE_ENV") || envValue("N8N_ENVIRONMENT") || envValue("ENVIRONMENT")).toLowerCase();
  const localEnv = !envName || envName === "development" || envName === "dev" || envName === "local" || envName === "test";
  const production = envName === "production" || envName === "prod";
  const hostname = parsed.hostname.toLowerCase();
  const localHttp = parsed.protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || (!hostname.includes(".") && !/^[0-9.]+$/.test(hostname)));
  const orchestratorBase = stringValue(envValue("ORCHESTRATOR_PUBLIC_URL"));
  if (!orchestratorBase && !localEnv && !localHttp) return { reason: "missing_orchestrator_public_url" };
  if (orchestratorBase) {
    const base = parseHttpUrl(orchestratorBase);
    if (!base || base.hasCredentials) return { reason: "invalid_orchestrator_public_url" };
    const basePath = base.pathname.replace(/\/+$/, "");
    if (parsed.origin !== base.origin || (basePath && parsed.pathname !== basePath && !parsed.pathname.startsWith(basePath + "/"))) {
      return { reason: "outside_orchestrator_public_url" };
    }
  }
  if (parsed.protocol !== "https:" && !(localHttp && !production)) return { reason: "https_required" };
  return null;
}

function callbackTokenFor(source) {
  const normalized = String(source || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  const sourceToken = normalized ? envValue("INTEGRATION_CALLBACK_TOKEN__" + normalized) : "";
  const fallback = envValue("INTEGRATION_CALLBACK_TOKEN");
  return sourceToken || fallback;
}

function buildExternalEvent(asyncCallback, invocation, parameters, acceptedAt) {
  const eventSuffix = "stage4_success";
  const eventIdBase = String(asyncCallback.idempotency_key_base + ":" + eventSuffix).replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 200);
  const event = {
    schema_version: "1.0",
    event_id: eventIdBase,
    case_id: asyncCallback.case_id,
    wait_id: asyncCallback.wait_id,
    correlation_id: asyncCallback.correlation_id,
    source: asyncCallback.source,
    event_type: asyncCallback.event_type,
    status: "success",
    received_at: acceptedAt,
    idempotency_key: asyncCallback.idempotency_key_base + ":" + eventSuffix,
    result: {
      action_id: invocation.action_id,
      invocation_id: invocation.invocation_id || null,
      runbook_status: "completed",
      message: "n8n stage4 runbook completed successfully.",
      parameters
    },
    metadata: {
      workflow_id: "provider_channel_failure",
      transport_requested: asyncCallback.result_transport
    }
  };
  if (asyncCallback.ticket_id) event.ticket_id = asyncCallback.ticket_id;
  return event;
}

if (!expectedToken || actualToken !== expectedToken) {
  return error(401, "unauthorized", "Токен webhook отсутствует или некорректен.");
}

const invocation = isObject(body.invocation) ? body.invocation : {};
const actionId = stringValue(invocation.action_id);

if (!actionId) {
  return error(400, "missing_action_id", "Поле invocation.action_id обязательно.");
}

const parameters = isObject(body.parameters) ? body.parameters : {};
const extensions = isObject(invocation.extensions) ? invocation.extensions : {};
const asyncCallback = isObject(extensions.async_callback) ? extensions.async_callback : undefined;
const acceptedAt = new Date().toISOString();
const response = {
  runbook_status: "accepted",
  message: "n8n webhook ранбука этапа 4 получил авторизованный запрос.",
  invocation_id: invocation.invocation_id,
  action_id: actionId,
  parameters,
  accepted_at: acceptedAt,
  async_delivery: false
};

if (!asyncCallback) {
  diagnostic("Basic", "stage4_direct_request_accepted", { action_id: actionId });
  return [
    {
      json: {
        shouldPublishKafka: false,
        statusCode: 200,
        response
      }
    }
  ];
}

const requiredFields = [
  "source",
  "case_id",
  "wait_id",
  "correlation_id",
  "event_type",
  "idempotency_key_base",
  "result_transport"
];
const missingFields = requiredFields.filter((field) => !stringValue(asyncCallback[field]));

if (missingFields.length > 0) {
  return error(
    400,
    "missing_async_callback_fields",
    "Не указаны обязательные поля invocation.extensions.async_callback.",
    { missing_fields: missingFields }
  );
}

const resultTransport = stringValue(asyncCallback.result_transport);
const allowedTransports = new Set(["http_callback", "kafka_event", "both"]);

if (!allowedTransports.has(resultTransport)) {
  return error(
    400,
    "invalid_result_transport",
    "Поле invocation.extensions.async_callback.result_transport должно быть http_callback, kafka_event или both."
  );
}

const needsCallback = resultTransport === "http_callback" || resultTransport === "both";
const needsKafka = resultTransport === "kafka_event" || resultTransport === "both";

if (needsCallback && !stringValue(asyncCallback.callback_url)) {
  return error(
    400,
    "missing_callback_url",
    "Поле invocation.extensions.async_callback.callback_url обязательно для http_callback или both."
  );
}

if (needsCallback) {
  const callbackError = validateCallbackUrl(asyncCallback.callback_url);
  if (callbackError) {
    return error(400, "invalid_callback_url", "callback_url не соответствует политике безопасности.", callbackError);
  }
}

if (needsKafka && !stringValue(asyncCallback.result_topic)) {
  return error(
    400,
    "missing_result_topic",
    "Поле invocation.extensions.async_callback.result_topic обязательно для kafka_event или both."
  );
}

const externalEvent = buildExternalEvent(asyncCallback, { ...invocation, action_id: actionId }, parameters, acceptedAt);
const deliveryStatus = {
  requested_transport: resultTransport,
  http_callback: needsCallback ? "pending" : "not_requested",
  kafka_event: needsKafka ? "pending" : "not_requested"
};

if (needsCallback) {
  const callbackToken = callbackTokenFor(asyncCallback.source);
  if (!callbackToken) {
    deliveryStatus.http_callback = "failed";
    deliveryStatus.http_callback_error = "missing_callback_token";
    if (!needsKafka) {
      return error(500, "missing_callback_token", "Callback token is not configured for HTTP callback delivery.");
    }
  }
  if (callbackToken) {
    const httpRequest = this?.helpers?.httpRequest?.bind(this.helpers);
    if (!httpRequest) {
      deliveryStatus.http_callback = "failed";
      deliveryStatus.http_callback_error = "http_request_helper_unavailable";
      if (!needsKafka) {
        return error(500, "http_request_helper_unavailable", "n8n httpRequest helper is not available in Code node.");
      }
    } else {
      try {
        await httpRequest({
          method: "POST",
          url: asyncCallback.callback_url,
          headers: {
            "Content-Type": "application/json",
            "X-ServiceDesk-Callback-Token": callbackToken
          },
          body: externalEvent,
          json: true
        });
        deliveryStatus.http_callback = "sent";
        diagnostic("Basic", "stage4_external_event_callback_sent", {
          source: externalEvent.source,
          case_id: externalEvent.case_id,
          wait_id: externalEvent.wait_id,
          correlation_id: externalEvent.correlation_id,
          event_id: externalEvent.event_id
        });
      } catch {
        deliveryStatus.http_callback = "failed";
        deliveryStatus.http_callback_error = "callback_delivery_failed";
        if (!needsKafka) {
          return error(502, "callback_delivery_failed", "ExternalEvent HTTP callback delivery failed.");
        }
      }
    }
  }
}
externalEvent.metadata.delivery_status = deliveryStatus;

response.async_delivery = true;
response.correlation_id = asyncCallback.correlation_id;
response.wait_id = asyncCallback.wait_id;
response.result_transport = resultTransport;
response.result_topic = asyncCallback.result_topic || null;
response.has_callback_url = Boolean(asyncCallback.callback_url);
response.delivery_status = deliveryStatus;

diagnostic("Basic", "stage4_async_request_accepted", {
  source: externalEvent.source,
  case_id: externalEvent.case_id,
  wait_id: externalEvent.wait_id,
  correlation_id: externalEvent.correlation_id,
  event_id: externalEvent.event_id,
  result_transport: resultTransport
});

return [
  {
    json: {
      shouldPublishKafka: needsKafka,
      kafkaTopic: asyncCallback.result_topic || "",
      kafkaHeaders: JSON.stringify({
        schema_version: externalEvent.schema_version,
        source: externalEvent.source,
        event_type: externalEvent.event_type,
        correlation_id: externalEvent.correlation_id,
        idempotency_key: externalEvent.idempotency_key
      }),
      externalEvent,
      delivery_status: deliveryStatus,
      statusCode: 200,
      response
    }
  }
];`;

const kafkaResponseCode = String.raw`const input = $input.first().json || {};
const deliveryStatus = {
  ...(input.delivery_status || input.response?.delivery_status || {}),
  kafka_event: "published"
};
return [
  {
    json: {
      statusCode: 200,
      response: {
        ...(input.response || {}),
        runbook_status: "accepted",
        message: "n8n webhook ранбука этапа 4 получил авторизованный запрос; ExternalEvent опубликован в Kafka.",
        async_delivery: true,
        kafka_delivery: true,
        delivery_status: deliveryStatus
      }
    }
  }
];`;

function workflow() {
  return documentedWorkflow({
    id: 'A6GKOMxwTBH5Q4kg',
    name: 'Webhook ранбука этапа 4',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'servicedesk/runbook/start',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'stage4-runbook-webhook',
        name: 'Webhook ранбука',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: 'c3313646-414f-4942-a669-d7fd456ba09f',
        position: [240, 300],
      },
      {
        parameters: {
          jsCode: prepareCode,
        },
        id: 'stage4-runbook-prepare',
        name: 'Подготовка ответа и ExternalEvent',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [520, 300],
      },
      {
        parameters: {
          conditions: {
            boolean: [
              {
                value1: '={{ $json.shouldPublishKafka }}',
                operation: 'equal',
                value2: true,
              },
            ],
          },
          combineOperation: 'all',
        },
        id: 'stage4-runbook-if-kafka',
        name: 'Нужна Kafka delivery?',
        type: 'n8n-nodes-base.if',
        typeVersion: 1,
        position: [800, 300],
      },
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
        id: 'stage4-runbook-kafka-publish',
        name: 'Публикация ExternalEvent в Kafka',
        type: 'n8n-nodes-base.kafka',
        typeVersion: 1,
        position: [1080, 200],
        credentials: {
          kafka: {
            id: 'localRedpandaKafka',
            name: 'Local Redpanda Kafka',
          },
        },
      },
      {
        parameters: {
          jsCode: kafkaResponseCode,
        },
        id: 'stage4-runbook-kafka-response',
        name: 'Ответ после Kafka delivery',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1360, 200],
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify($json.response) }}',
          options: {
            responseCode: '={{ $json.statusCode }}',
          },
        },
        id: 'stage4-runbook-response',
        name: 'Нормализованный ответ',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1640, 300],
      },
    ],
    connections: {
      'Webhook ранбука': {
        main: [
          [
            {
              node: 'Подготовка ответа и ExternalEvent',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Подготовка ответа и ExternalEvent': {
        main: [
          [
            {
              node: 'Нужна Kafka delivery?',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Нужна Kafka delivery?': {
        main: [
          [
            {
              node: 'Публикация ExternalEvent в Kafka',
              type: 'main',
              index: 0,
            },
          ],
          [
            {
              node: 'Нормализованный ответ',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Публикация ExternalEvent в Kafka': {
        main: [
          [
            {
              node: 'Ответ после Kafka delivery',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Ответ после Kafka delivery': {
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
    process.stdout.write('stage4 runbook workflow is up to date\n');
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
