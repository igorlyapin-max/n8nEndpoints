# Provider Channel Repair Monitor Usage

## Purpose

Workflow `Provider: письмо и мониторинг ремонта канала` запускает полный сценарий обращения к провайдеру по аварии канала.

Ранбук принимает `host`, `problemUrl`, частоту опроса, общее время ожидания и номер заявки `service_request`. После accepted response n8n получает параметры письма из CMDBuild, отправляет провайдеру шаблонное письмо и в цикле проверяет сначала Zabbix status, затем входящую почту.

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
  "host": "Router for NTbook group 000 (OFF01 Office 01 - Headquarters)",
  "problemUrl": "http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528",
  "service_request": "12345678",
  "poll_interval_minutes": 15,
  "timeout_minutes": 60,
  "templateId": "provider_channel_outage_test",
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

Accepted aliases: `hostname`/`hostName`, `problem_url`, `serviceRequest`, `pollIntervalMinutes`, `timeoutMinutes`, `template_id`, `reply_to`.

Optional fields: `cc`, `bcc`, `replyTo`, `request_id`. Attachments are not supported in v1.

## Execution Logic

1. Validate `X-ServiceDesk-Token`, required fields, polling bounds and async callback package.
2. Return HTTP `200` with `runbook_status: accepted`.
3. Call internal `POST /webhook/cmdbuild/provider-email-context` with `host`.
4. Call internal `POST /webhook/email/send-template` with template params `city`, `location`, `ip_address`, `contract`, `service_request`.
5. Poll every `poll_interval_minutes` until `timeout_minutes`.
6. On each iteration check `POST /webhook/zabbix/problem/status` first.
7. If Zabbix returns `ok` or `resolved`, finish with `runbook_status: RESOLVED`.
8. Otherwise search `n8n_mail_index` for `service_request` in email subject/body.

## Terminal Statuses

- `RESOLVED` - Zabbix problem is `ok` or `resolved`; email wait is no longer needed.
- `OK` - exactly one provider email containing `service_request` was found.
- `MULTI_MAIL` - several provider emails were found; response includes the first by `received_at` and `match_count`.
- `DELIVERY_FAILED` - best-effort NDR/bounce was found for the same `service_request`.
- `NOT_FOUND` - neither Zabbix recovery nor provider email appeared before timeout.
- `ERROR` - CMDBuild lookup, email dispatch, Zabbix status lookup, callback delivery, or validation dependency failed after accepted.

Terminal result is delivered as `ExternalEvent.result` and follows `MonitorProviderChannelRepairResult` in the OpenAPI contract. When an email is found, `email_result.from`, `email_result.subject` and `email_result.body` are included.

## Transport Security

- n8n webhook and HTTP callback URLs are selected by the administrator. Local/dev may use `http://127.0.0.1`; shared/staging/production should use HTTPS.
- `callback_url` must use `http` or `https`, must not contain user/password credentials, and when `ORCHESTRATOR_PUBLIC_URL` is configured it must have the same origin and the same or nested path.
- In production mode (`NODE_ENV`, `N8N_ENVIRONMENT` or `ENVIRONMENT` is `production`/`prod`), non-HTTPS callback URLs are rejected outside local/dev loopback or compose-host exceptions.
- Kafka result delivery uses Kafka credentials, broker TLS/SASL/mTLS and ACLs. Kafka is not an HTTPS transport.
- Secrets stay in n8n environment variables or credentials, not in request payload examples.

## Common Errors

- `401 unauthorized` - absent or invalid `X-ServiceDesk-Token`.
- `400 missing_host` - missing `host`.
- `400 missing_problem_url` - missing `problemUrl`.
- `400 missing_service_request` - missing `service_request`.
- `400 invalid_poll_interval_minutes` - polling interval is not an integer from 1 to 60.
- `400 invalid_timeout_minutes` - timeout is not an integer from 1 to 240.
- `400 missing_async_callback` - async callback package is absent.
- `400 invalid_action_id` - `invocation.action_id` is not `monitor_provider_channel_repair`.
- `400 missing_result_topic` - `kafka_event` or `both` was selected without `result_topic`.
- `400 missing_callback_url` - `http_callback` or `both` was selected without `callback_url`.
- `400 invalid_callback_url` - `callback_url` violates scheme, credentials, HTTPS, or `ORCHESTRATOR_PUBLIC_URL` policy.
