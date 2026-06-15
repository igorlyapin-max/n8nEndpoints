# Wait For Email By Ticket Deployment

## Workflows

Import and publish both workflows:

- `workflows/email-ticket-mailbox-collector.json`
- `workflows/wait-for-email-ticket-webhook.json`

The collector must be active before the wait webhook can reliably find messages.

## Runtime Requirements

n8n environment:

- `N8N_WEBHOOK_TOKEN`
- `N8N_WORKFLOW_DEBUG=off|Basic|Verbose`
- `ORCHESTRATOR_PUBLIC_URL` is required outside local/dev when HTTP callback delivery is enabled; accepted `callback_url` values must stay under this origin/path
- `NODE_ENV=production`, `N8N_ENVIRONMENT=production` or `ENVIRONMENT=production` in shared/staging/production so non-HTTPS callback URLs are rejected
- `INTEGRATION_CALLBACK_TOKEN` or `INTEGRATION_CALLBACK_TOKEN__<NORMALIZED_SOURCE>` when `http_callback` or `both` delivery is used

n8n credentials:

- IMAP credential on collector node `Получение входящего письма`.
- Postgres credential `Local ServiceDesk Postgres` on nodes `Запись письма в индекс` and `Поиск письма в индексе`.
- Kafka credential `Local Redpanda Kafka` on node `Публикация ExternalEvent в Kafka` when `kafka_event` or `both` delivery is used.

Production Kafka credential must be selected by the administrator. Supported baseline modes are `SASL_SSL` with SASL username/password or SCRAM, and `SSL` with mTLS client certificate/key. Broker ACL must limit n8n to the approved result topic.

HTTP callback URL is supplied by `serviceDeskAgents` in `invocation.extensions.async_callback.callback_url`. It must use `http` or `https`, must not contain user/password credentials, and outside local/dev `ORCHESTRATOR_PUBLIC_URL` must be configured so the callback stays under the same origin/path. Local/dev may use `http://`; production should use HTTPS for n8n webhook and ServiceDesk callback URLs.

n8n diagnostics must be available through stdout/stderr and one production logging sink such as syslog, collector/agent/sidecar, ELK/OpenSearch, or a platform log collector. Docker `json-file` alone is acceptable only for the local stand.

Local dev Postgres credential values:

```text
name: Local ServiceDesk Postgres
type: Postgres
host: postgres
port: 5432
database: n8n
user: n8n
password: from ../serviceDeskAgents/.env N8N_DB_PASSWORD
ssl: disabled
```

The workflow creates `n8n_mail_index` automatically on first collector or wait execution:

```sql
n8n_mail_index(message_id, mailbox, from_email, subject, body_text, received_at, indexed_at, is_delivery_failure)
```

## Import

1. Open n8n UI: `http://127.0.0.1:5678`.
2. Import `workflows/email-ticket-mailbox-collector.json`.
3. Bind IMAP and Postgres credentials.
4. Import `workflows/wait-for-email-ticket-webhook.json`.
5. Bind Postgres and Kafka credentials.
6. Import/regenerate `workflows/contracts-openapi-webhook.json`.
7. Publish both workflows and restart n8n after publish if webhook registration changed.

Machine-readable contract:

```text
GET http://127.0.0.1:5678/webhook/contracts/openapi.json
```

Execution endpoint:

```text
POST http://127.0.0.1:5678/webhook/email/wait-for-ticket
```

## Smoke Checks

Health:

```bash
curl -fsS http://127.0.0.1:5678/healthz
```

Auth-negative:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -d '{"ticket_number":"ГКМ123456","poll_interval_minutes":1,"timeout_minutes":1}' \
  http://127.0.0.1:5678/webhook/email/wait-for-ticket
```

Expected HTTP status: `401`.

Direct timeout cap:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"ticket_number":"ГКМ123456","poll_interval_minutes":15,"timeout_minutes":60}' \
  http://127.0.0.1:5678/webhook/email/wait-for-ticket
```

Expected HTTP status: `400`, body contains `error.code: direct_timeout_too_long`.

Callback policy-negative:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"ticket_number":"ГКМ123456","poll_interval_minutes":1,"timeout_minutes":60,"invocation":{"invocation_id":"cmd-email-wait-bad-callback","action_id":"wait_for_email_by_ticket","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000001","wait_id":"wait-000000000001","correlation_id":"case-000000000001:tool_command:cmd-email-wait-bad-callback","event_type":"wait_for_email_by_ticket_completed","callback_url":"http://user:pass@127.0.0.1:18088/external-events/n8n","idempotency_key_base":"case-000000000001:tool_command:cmd-email-wait-bad-callback","result_transport":"http_callback"}}}}' \
  http://127.0.0.1:5678/webhook/email/wait-for-ticket
```

Expected HTTP status: `400`, body contains `error.code: invalid_callback_url`.

Local happy path with GreenMail:

1. Send a message to `automation-test@local.test` with subject or body containing a unique `ГКМ...` number.
2. Wait until collector workflow indexes the message.
3. Call direct smoke:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"ticket_number":"ГКМ123456","poll_interval_minutes":1,"timeout_minutes":5}' \
  http://127.0.0.1:5678/webhook/email/wait-for-ticket
```

Expected body contains `status: OK`.

Async smoke:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"ticket_number":"ГКМ123456","poll_interval_minutes":15,"timeout_minutes":60,"invocation":{"invocation_id":"cmd-123","action_id":"wait_for_email_by_ticket","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000001","wait_id":"wait-000000000001","correlation_id":"case-000000000001:tool_command:cmd-123","event_type":"wait_for_email_by_ticket_completed","idempotency_key_base":"case-000000000001:tool_command:cmd-123","result_transport":"kafka_event","result_topic":"external.events"}}}}' \
  http://127.0.0.1:5678/webhook/email/wait-for-ticket
```

Expected immediate response: `runbook_status: accepted`. Verify a correlated `ExternalEvent` appears on `external.events`.

After async wait smoke, inspect recent n8n logs for Code node errors and wait-node warnings. The local n8n 2.21.7/Node 24 stand can emit `TimeoutNegativeWarning` after a Wait node resumes even when the workflow completes; treat this as a runtime limitation to verify during customer n8n version selection. Production deployments should route those logs through the approved second sink; local Docker can be checked with `docker inspect servicedesk-agents-n8n --format '{{json .HostConfig.LogConfig}}'`.

## Rollback

Deactivate `Email: ожидание письма по номеру заявки` first, then deactivate `Email: индекс входящих писем` if no other runbook depends on the mailbox index. Already indexed rows in `n8n_mail_index` are not deleted automatically.
