# Provider Channel Repair Monitor Usage

## Purpose

Workflow `Provider: письмо и мониторинг ремонта канала` запускает полный сценарий обращения к провайдеру по аварии канала.

Ранбук принимает `problem_host` из заявки/Zabbix, опциональный `router_ref` для точного поиска `routerG`, `problemUrl`, частоту опроса, общее время ожидания и номер заявки `service_request`. После accepted response n8n inline получает параметры письма из CMDBuild, отправляет провайдеру plain text email через SMTP credential и в цикле проверяет сначала Zabbix status, затем входящую почту.

Этот endpoint async-only. Агент должен передать `invocation.extensions.async_callback`, чтобы terminal result вернулся тому же агенту через canonical ServiceDesk `ExternalEvent`.

## Contract

- Workflow export: `workflows/provider-channel-repair-monitor-webhook.json`
- Endpoint: `POST http://127.0.0.1:5678/webhook/provider/channel-repair/monitor`
- OpenAPI operationId: `monitorProviderChannelRepair`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`

Request:

```json
{
  "problem_host": "ARM C2M-CITY-20260523-ARM-177-13",
  "router_ref": "Router for NTbook group 000 (OFF01 Office 01 - Headquarters)",
  "problemUrl": "http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528",
  "service_request": "12345678",
  "poll_interval_minutes": 15,
  "timeout_minutes": 60,
  "templateId": "provider_channel_outage_test",
  "from": "automation-test@local.test",
  "replyTo": "automation-test@local.test",
  "invocation": {
    "invocation_id": "cmd-provider-monitor-123",
    "action_id": "monitor_provider_channel_repair",
    "extensions": {
      "async_callback": {
        "source": "n8n",
        "case_id": "case-000000000001",
        "wait_id": "wait-000000000001",
        "correlation_id": "case-000000000001:tool_command:cmd-provider-monitor-123",
        "event_type": "monitor_provider_channel_repair_completed",
        "idempotency_key_base": "case-000000000001:tool_command:cmd-provider-monitor-123",
        "result_transport": "kafka_event",
        "result_topic": "external.events"
      }
    }
  }
}
```

Accepted aliases: `problemHost`, `routerRef`, legacy `host`/`hostname`/`hostName` as `problem_host`, `problem_url`, `serviceRequest`, `pollIntervalMinutes`, `timeoutMinutes`, `template_id`, `reply_to`.

Optional fields: `cc`, `bcc`, `request_id`. Required email envelope fields: `from`, `replyTo`. Attachments are not supported in v1.

## Execution Logic

1. Validate `X-ServiceDesk-Token`, required fields, polling bounds and async callback package.
2. Return HTTP `200` with `runbook_status: accepted`.
3. Search CMDBuild `routerG` by exact `Description`, `hostname` or `Code` using `router_ref`; if `router_ref` is absent, the workflow tries the incoming `problem_host` as a lookup value and returns `router_context_not_resolved` when it is not a routerG reference.
4. Read related `IpAddress`, `Room`, `Floor`, `Building`, build provider email subject/body and send it through the workflow SMTP node.
5. Poll every `poll_interval_minutes` until `timeout_minutes`.
6. On each iteration check `POST /webhook/zabbix/problem/status` first.
7. If Zabbix returns `ok` or `resolved`, finish with `runbook_status: RESOLVED`.
8. Otherwise search `n8n_mail_index` for `service_request` in email subject/body filtered by `replyTo` mailbox address.

## Terminal Statuses

- `RESOLVED` - Zabbix problem is `ok` or `resolved`; email wait is no longer needed.
- `OK` - exactly one provider email containing `service_request` was found.
- `MULTI_MAIL` - several provider emails were found; response includes the first by `received_at` and `match_count`.
- `DELIVERY_FAILED` - best-effort NDR/bounce was found for the same `service_request`.
- `NOT_FOUND` - neither Zabbix recovery nor provider email appeared before timeout.
- `ERROR` - CMDBuild lookup, router context resolution, email dispatch, Zabbix status lookup, callback delivery, or validation dependency failed after accepted.

Terminal result is delivered as `ExternalEvent.result` and follows `MonitorProviderChannelRepairResult` in the OpenAPI contract. The result includes `router_lookup_status`, `router_lookup_value`, `router_candidates`, `provider_email_context`, `email_dispatch`, and, when an email is found, `email_result.from`, `email_result.subject` and `email_result.body`.

## Transport Security

- n8n webhook and HTTP callback URLs are selected by the administrator. Local/dev may use `http://127.0.0.1`; shared/staging/production should use HTTPS.
- `callback_url` must use `http` or `https`, must not contain user/password credentials, and when `ORCHESTRATOR_PUBLIC_URL` is configured it must have the same origin and the same or nested path.
- In production mode (`NODE_ENV`, `N8N_ENVIRONMENT` or `ENVIRONMENT` is `production`/`prod`), non-HTTPS callback URLs are rejected outside local/dev loopback or compose-host exceptions.
- Kafka result delivery uses Kafka credentials, broker TLS/SASL/mTLS and ACLs. Kafka is not an HTTPS transport.
- Secrets stay in n8n environment variables or credentials, not in request payload examples.

## Common Errors

- `401 unauthorized` - absent or invalid `X-ServiceDesk-Token`.
- `400 missing_problem_host` - neither `problem_host` nor `router_ref` was provided.
- `400 missing_problem_url` - missing `problemUrl`.
- `400 missing_service_request` - missing `service_request`.
- `400 invalid_poll_interval_minutes` - polling interval is not an integer from 1 to 60.
- `400 invalid_timeout_minutes` - timeout is not an integer from 1 to 240.
- `400 missing_async_callback` - async callback package is absent.
- `400 invalid_action_id` - `invocation.action_id` is not `monitor_provider_channel_repair`.
- `400 missing_result_topic` - `kafka_event` or `both` was selected without `result_topic`.
- `400 missing_callback_url` - `http_callback` or `both` was selected without `callback_url`.
- `400 invalid_callback_url` - `callback_url` violates scheme, credentials, HTTPS, or `ORCHESTRATOR_PUBLIC_URL` policy.
- `router_context_not_resolved` terminal result - `problem_host` was not enough to resolve `routerG`; configure a slot/resolver that passes `router_ref`.
