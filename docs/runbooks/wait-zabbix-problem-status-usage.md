# Wait Zabbix Problem Status Usage

## Purpose

Workflow `Zabbix: ожидание статуса problem` ожидает, пока Zabbix problem по UI URL станет `ok` или `resolved`.

Ранбук read-only: он не закрывает problem, не добавляет сообщения и не меняет Zabbix. Проверка состояния выполняется через existing endpoint `getZabbixProblemStatus`.

Этот endpoint async-only. Агент должен передать `invocation.extensions.async_callback`, чтобы terminal result вернулся тому же ожидающему агенту через canonical ServiceDesk `ExternalEvent`.

## Contract

- Workflow export: `workflows/wait-zabbix-problem-status-webhook.json`
- Endpoint: `POST http://127.0.0.1:5678/webhook/zabbix/problem/wait`
- OpenAPI operationId: `waitZabbixProblemStatus`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`

Request:

```json
{
  "problemUrl": "http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528",
  "poll_interval_minutes": 15,
  "timeout_minutes": 60,
  "invocation": {
    "invocation_id": "cmd-zabbix-wait-123",
    "action_id": "wait_zabbix_problem_status",
    "extensions": {
      "async_callback": {
        "source": "n8n",
        "case_id": "case-000000000001",
        "wait_id": "wait-000000000001",
        "correlation_id": "case-000000000001:tool_command:cmd-zabbix-wait-123",
        "event_type": "wait_zabbix_problem_status_completed",
        "idempotency_key_base": "case-000000000001:tool_command:cmd-zabbix-wait-123",
        "result_transport": "kafka_event",
        "result_topic": "external.events"
      }
    }
  }
}
```

Accepted aliases: `problem_url`, `pollIntervalMinutes`, `timeoutMinutes`.

## Execution Logic

1. Validate `X-ServiceDesk-Token`, required fields, polling bounds and async callback package.
2. Return HTTP `200` with `runbook_status: accepted`.
3. Call internal `POST /webhook/zabbix/problem/status` immediately.
4. If status is `ok` or `resolved`, deliver terminal `ExternalEvent`.
5. If status is `problem` and deadline remains, wait `poll_interval_minutes` or the remaining time, whichever is smaller.
6. If timeout expires while status is still `problem`, deliver `status: problem` with `timed_out: true`.

## Terminal Statuses

- `ok` - original event is unavailable and current trigger is OK.
- `resolved` - original event is available and has recovery evidence.
- `problem` - timeout expired before recovery; `timed_out` is `true`.
- `ERROR` - internal Zabbix status endpoint failed or returned an unexpected response after accepted.

Terminal result is delivered as `ExternalEvent.result` and follows `WaitZabbixProblemStatusResult` in the OpenAPI contract.

## Transport Security

- n8n webhook and HTTP callback URLs are selected by the administrator. Local/dev may use `http://127.0.0.1`; shared/staging/production should use HTTPS.
- `callback_url` must use `http` or `https`, must not contain user/password credentials, and when `ORCHESTRATOR_PUBLIC_URL` is configured it must have the same origin and the same or nested path.
- In production mode (`NODE_ENV`, `N8N_ENVIRONMENT` or `ENVIRONMENT` is `production`/`prod`), non-HTTPS callback URLs are rejected outside local/dev loopback or compose-host exceptions.
- Kafka result delivery uses Kafka credentials, broker TLS/SASL/mTLS and ACLs. Kafka is not an HTTPS transport.
- Secrets stay in n8n environment variables or credentials, not in request payload examples.

## Common Errors

- `401 unauthorized` - absent or invalid `X-ServiceDesk-Token`.
- `400 missing_problem_url` - missing `problemUrl`.
- `400 invalid_poll_interval_minutes` - polling interval is not an integer from 1 to 60.
- `400 invalid_timeout_minutes` - timeout is not an integer from 1 to 240.
- `400 poll_interval_exceeds_timeout` - polling interval is larger than timeout.
- `400 missing_async_callback` - async callback package is absent.
- `400 invalid_action_id` - `invocation.action_id` is not `wait_zabbix_problem_status`.
- `400 missing_result_topic` - `kafka_event` or `both` was selected without `result_topic`.
- `400 missing_callback_url` - `http_callback` or `both` was selected without `callback_url`.
- `400 invalid_callback_url` - `callback_url` violates scheme, credentials, HTTPS, or `ORCHESTRATOR_PUBLIC_URL` policy.
