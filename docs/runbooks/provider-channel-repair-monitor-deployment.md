# Provider Channel Repair Monitor Deployment

## Workflows

Import and publish the composite workflow plus its dependencies:

- `workflows/provider-channel-repair-monitor-webhook.json`
- `workflows/cmdbuild-provider-email-context-webhook.json`
- `workflows/send-templated-email-webhook.json`
- `workflows/get-zabbix-problem-status-webhook.json`
- `workflows/email-ticket-mailbox-collector.json`
- `workflows/contracts-openapi-webhook.json`

The mailbox collector must be active before the monitor can detect provider replies.

## Runtime Requirements

n8n environment:

- `N8N_WEBHOOK_TOKEN`
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`
- `N8N_WORKFLOW_DEBUG=off|Basic|Verbose`
- `N8N_INTERNAL_WEBHOOK_BASE_URL` or `N8N_WEBHOOK_BASE_URL`; local fallback is `http://127.0.0.1:5678/webhook`
- `ORCHESTRATOR_PUBLIC_URL` is required outside local/dev when HTTP callback delivery is enabled; accepted `callback_url` values must stay under this origin/path
- `NODE_ENV=production`, `N8N_ENVIRONMENT=production` or `ENVIRONMENT=production` in shared/staging/production so non-HTTPS callback URLs are rejected
- `CMDBUILD_BASE_URL`
- `ZABBIX_API_TOKENS_BY_ORIGIN`
- Optional `ZABBIX_API_URLS_BY_ORIGIN`
- Optional `N8N_MAIL_FROM`
- `INTEGRATION_CALLBACK_TOKEN` or `INTEGRATION_CALLBACK_TOKEN__<NORMALIZED_SOURCE>` when `http_callback` or `both` delivery is used

n8n credentials:

- HTTP Basic credential `Local CMDBuild Admin Test` or production equivalent on CMDBuild HTTP nodes.
- SMTP credential on `sendTemplatedEmail` node `Отправка email`.
- IMAP credential on collector node `Получение входящего письма`.
- Postgres credential `Local ServiceDesk Postgres` on `Поиск письма в индексе` and collector storage nodes.
- Kafka credential `Local Redpanda Kafka` on node `Публикация ExternalEvent в Kafka` when `kafka_event` or `both` delivery is used.

Production Kafka credential must be selected by the administrator. Supported baseline modes are `SASL_SSL` with SASL username/password or SCRAM, and `SSL` with mTLS client certificate/key. Broker ACL must limit n8n to the approved result topic.

n8n diagnostics must be available through stdout/stderr and one production logging sink such as syslog, collector/agent/sidecar, ELK/OpenSearch, or a platform log collector. Docker `json-file` alone is acceptable only for the local stand.

## Generation

After changing the generator, contract, catalog or inline documentation:

```bash
node scripts/build-provider-channel-repair-monitor-workflow.mjs
node scripts/build-contract-workflow.mjs
```

Drift/static checks:

```bash
node --check scripts/build-provider-channel-repair-monitor-workflow.mjs
node scripts/build-provider-channel-repair-monitor-workflow.mjs --check
node scripts/build-contract-workflow.mjs --check
node scripts/apply-workflow-inline-documentation.mjs --check
node scripts/test-contracts.mjs
```

## Import

1. Open n8n UI: `http://127.0.0.1:5678`.
2. Import or update dependency workflows listed above.
3. Bind CMDBuild, SMTP, IMAP, Postgres and Kafka credentials.
4. Import `workflows/provider-channel-repair-monitor-webhook.json`.
5. Bind Postgres credential on node `Поиск письма в индексе`.
6. Bind Kafka credential on node `Публикация ExternalEvent в Kafka` if Kafka delivery is enabled.
7. Import/regenerate `workflows/contracts-openapi-webhook.json`.
8. Activate all required workflows and restart n8n after publish if webhook registration changed.

Machine-readable contract:

```text
GET http://127.0.0.1:5678/webhook/contracts/openapi.json
```

Execution endpoint:

```text
POST http://127.0.0.1:5678/webhook/provider/channel-repair/monitor
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
  -d '{"host":"Router for NTbook group 000 (OFF01 Office 01 - Headquarters)","problemUrl":"http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528","service_request":"12345678","poll_interval_minutes":1,"timeout_minutes":1}' \
  http://127.0.0.1:5678/webhook/provider/channel-repair/monitor
```

Expected HTTP status: `401`.

Validation-negative:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{"host":"Router for NTbook group 000 (OFF01 Office 01 - Headquarters)","problemUrl":"http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528","service_request":"12345678","poll_interval_minutes":1,"timeout_minutes":1}' \
  http://127.0.0.1:5678/webhook/provider/channel-repair/monitor
```

Expected HTTP status: `400`, body contains `error.code: missing_async_callback`.

Callback policy-negative:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{"host":"Router for NTbook group 000 (OFF01 Office 01 - Headquarters)","problemUrl":"http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528","service_request":"12345678","poll_interval_minutes":1,"timeout_minutes":1,"invocation":{"invocation_id":"cmd-provider-monitor-bad-callback","action_id":"monitor_provider_channel_repair","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000001","wait_id":"wait-000000000001","correlation_id":"case-000000000001:tool_command:cmd-provider-monitor-bad-callback","event_type":"monitor_provider_channel_repair_completed","callback_url":"http://user:pass@127.0.0.1:18088/external-events/n8n","idempotency_key_base":"case-000000000001:tool_command:cmd-provider-monitor-bad-callback","result_transport":"http_callback"}}}}' \
  http://127.0.0.1:5678/webhook/provider/channel-repair/monitor
```

Expected HTTP status: `400`, body contains `error.code: invalid_callback_url`.

Async accepted smoke:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{"host":"Router for NTbook group 000 (OFF01 Office 01 - Headquarters)","problemUrl":"http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528","service_request":"12345678","poll_interval_minutes":1,"timeout_minutes":1,"invocation":{"invocation_id":"cmd-provider-monitor-123","action_id":"monitor_provider_channel_repair","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000001","wait_id":"wait-000000000001","correlation_id":"case-000000000001:tool_command:cmd-provider-monitor-123","event_type":"monitor_provider_channel_repair_completed","idempotency_key_base":"case-000000000001:tool_command:cmd-provider-monitor-123","result_transport":"kafka_event","result_topic":"external.events"}}}}' \
  http://127.0.0.1:5678/webhook/provider/channel-repair/monitor
```

Expected immediate response: `runbook_status: accepted`. Verify a correlated `ExternalEvent` appears on the selected callback/Kafka transport. Full happy path requires a CMDBuild router with valid provider email/IP, working SMTP/IMAP, and a real Zabbix problem URL.

After wait/resume smoke, inspect recent n8n logs for Code node errors and wait-node warnings. The local n8n 2.21.7/Node 24 stand can emit `TimeoutNegativeWarning` after a Wait node resumes even when the workflow completes; treat this as a runtime limitation to verify during customer n8n version selection. Production deployments should route those logs through the approved second sink; local Docker can be checked with `docker inspect servicedesk-agents-n8n --format '{{json .HostConfig.LogConfig}}'`.

## Rollback

Deactivate `Provider: письмо и мониторинг ремонта канала`. Dependency workflows can remain active if other runbooks use them. Already sent emails, indexed messages and callback/Kafka events are not rolled back by workflow deactivation.
