# Stage 4 Runbook Usage

## Purpose

This n8n webhook accepts an approved ServiceDesk action request for `start_systemcenter_runbook`.

The same endpoint is used in two modes:

- Direct HTTP call from an external application that reads the OpenAPI contract and passes `X-ServiceDesk-Token`.
- ServiceDesk async call where `serviceDeskAgents` wraps the command and passes `invocation.extensions.async_callback` so the final result returns to the same waiting agent context.

The current stage4 workflow is a safe stub: after accepting an async request it emits a terminal `success` ServiceDesk `ExternalEvent` immediately. A production long-running runbook must keep the same `ExternalEvent` contract, but emit the event only after real runbook completion.

## Caller Contract

- Workflow export: `workflows/stage4-runbook-webhook.json`
- Production endpoint: `POST http://127.0.0.1:5678/webhook/servicedesk/runbook/start`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- OpenAPI operationId: `startRunbook`
- Workflow catalog entry: `provider_channel_failure`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`
- Content type: `application/json`
- Required body field: `invocation.action_id`

Direct HTTP payload:

```json
{
  "invocation": {
    "invocation_id": "example-invocation",
    "action_id": "start_systemcenter_runbook"
  },
  "parameters": {
    "source": "servicedesk"
  }
}
```

ServiceDesk async payload:

```json
{
  "invocation": {
    "invocation_id": "cmd-123",
    "action_id": "start_systemcenter_runbook",
    "extensions": {
      "async_callback": {
        "source": "n8n",
        "case_id": "case-000000000001",
        "ticket_id": "ticket-000000000001",
        "run_id": "run-000000000001",
        "wait_id": "wait-000000000001",
        "correlation_id": "case-000000000001:tool_command:cmd-123",
        "event_type": "start_systemcenter_runbook_completed",
        "idempotency_key_base": "case-000000000001:tool_command:cmd-123",
        "result_transport": "kafka_event",
        "result_topic": "external.events"
      }
    }
  },
  "parameters": {
    "source": "servicedesk",
    "channelName": "provider-link-1"
  }
}
```

`result_transport` must be one of:

- `http_callback`: n8n sends the final `ExternalEvent` to `callback_url`.
- `kafka_event`: n8n publishes the final `ExternalEvent` to `result_topic`.
- `both`: n8n delivers the same final event through both transports.

When `result_transport` is `http_callback` or `both`, `callback_url` is required. HTTP callback auth uses header `X-ServiceDesk-Callback-Token`; n8n reads the token from `INTEGRATION_CALLBACK_TOKEN__<NORMALIZED_SOURCE>` first, then from `INTEGRATION_CALLBACK_TOKEN`.

When `result_transport` is `kafka_event` or `both`, `result_topic` is required. Local ServiceDesk default topic is `external.events`.

Transport security:

- HTTP callback URL is admin-configured by `serviceDeskAgents` and passed in `callback_url`. Local/dev may use `http://`; production should use `https://`.
- `callback_url` must use `http` or `https`, must not contain user/password credentials, and when `ORCHESTRATOR_PUBLIC_URL` is configured it must have the same origin and the same or nested path.
- In production mode (`NODE_ENV`, `N8N_ENVIRONMENT` or `ENVIRONMENT` is `production`/`prod`), non-HTTPS callback URLs are rejected outside local/dev loopback or compose-host exceptions.
- Kafka delivery is secured by Kafka credential, broker ACL and either `SASL_SSL` or `SSL`/mTLS. Do not model Kafka as HTTPS.

## ExternalEvent Result

Async delivery sends the canonical ServiceDesk `ExternalEvent`:

```json
{
  "schema_version": "1.0",
  "event_id": "case-000000000001:tool_command:cmd-123:stage4_success",
  "case_id": "case-000000000001",
  "wait_id": "wait-000000000001",
  "correlation_id": "case-000000000001:tool_command:cmd-123",
  "source": "n8n",
  "event_type": "start_systemcenter_runbook_completed",
  "status": "success",
  "idempotency_key": "case-000000000001:tool_command:cmd-123:stage4_success",
  "result": {
    "action_id": "start_systemcenter_runbook",
    "invocation_id": "cmd-123",
    "runbook_status": "completed",
    "message": "n8n stage4 runbook completed successfully."
  }
}
```

Kafka and HTTP callback carry the same business event. Do not build separate caller logic for Kafka-specific payloads.

## Responses

Successful direct call:

```json
{
  "runbook_status": "accepted",
  "message": "n8n webhook ранбука этапа 4 получил авторизованный запрос.",
  "invocation_id": "example-invocation",
  "action_id": "start_systemcenter_runbook",
  "parameters": {
    "source": "servicedesk"
  },
  "accepted_at": "2026-06-13T10:00:00.000Z",
  "async_delivery": false
}
```

Successful async call response does not echo `callback_url`:

```json
{
  "runbook_status": "accepted",
  "message": "n8n webhook ранбука этапа 4 получил авторизованный запрос.",
  "invocation_id": "cmd-123",
  "action_id": "start_systemcenter_runbook",
  "accepted_at": "2026-06-13T10:00:00.000Z",
  "async_delivery": true,
  "correlation_id": "case-000000000001:tool_command:cmd-123",
  "wait_id": "wait-000000000001",
  "result_transport": "kafka_event",
  "result_topic": "external.events",
  "has_callback_url": false
}
```

Common errors:

- `401 unauthorized` - missing or invalid `X-ServiceDesk-Token`.
- `400 missing_action_id` - `invocation.action_id` is absent.
- `400 missing_async_callback_fields` - required async callback correlation fields are absent.
- `400 invalid_result_transport` - result transport is not `http_callback`, `kafka_event` or `both`.
- `400 missing_callback_url` - HTTP callback was selected without `callback_url`.
- `400 invalid_callback_url` - `callback_url` violates scheme, credentials, HTTPS, or `ORCHESTRATOR_PUBLIC_URL` policy.
- `400 missing_result_topic` - Kafka delivery was selected without `result_topic`.
- `500 missing_callback_token` - HTTP callback was selected, but callback token env is not configured.
- `502 callback_delivery_failed` - HTTP callback transport failed.

## Safety Policy

Do not call this webhook directly from LLM code paths. Production calls must go through:

```text
LangGraph -> Tool Registry -> Integration Dispatcher -> n8n_webhook adapter
```

Action tools require operator approval before dispatch.

n8n workflow logic must not directly mutate ServiceDesk case state. For async runbooks, ServiceDesk state continues only after `serviceDeskAgents` receives the correlated `ExternalEvent`.
