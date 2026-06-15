# Stage 4 Runbook Deployment

## Import And Activation

1. Open n8n UI: `http://127.0.0.1:5678`.
2. Import `workflows/stage4-runbook-webhook.json`.
3. Confirm the workflow name is `Webhook ранбука этапа 4`.
4. Configure the Kafka credential on node `Публикация ExternalEvent в Kafka` when `kafka_event` or `both` delivery will be used.
5. Activate or publish the workflow.
6. Regenerate and import `workflows/contracts-openapi-webhook.json` whenever request, response or async delivery semantics change.
7. Restart n8n after import/publish if webhook registration changed.

Production webhook path:

```text
http://127.0.0.1:5678/webhook/servicedesk/runbook/start
```

Machine-readable contract:

```text
GET http://127.0.0.1:5678/webhook/contracts/openapi.json
```

OpenAPI operationId: `startRunbook`.

Workflow catalog entry: `provider_channel_failure`.

## Runtime Requirements

The n8n runtime must receive:

- `N8N_WEBHOOK_TOKEN`
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`
- `N8N_WORKFLOW_DEBUG=off`, `Basic` or `Verbose`
- `ORCHESTRATOR_PUBLIC_URL` is required outside local/dev when HTTP callback delivery is enabled; accepted `callback_url` values must stay under this origin/path
- `NODE_ENV=production`, `N8N_ENVIRONMENT=production` or `ENVIRONMENT=production` in shared/staging/production so non-HTTPS callback URLs are rejected
- `INTEGRATION_CALLBACK_TOKEN` or `INTEGRATION_CALLBACK_TOKEN__<NORMALIZED_SOURCE>` when `http_callback` or `both` delivery is enabled

`N8N_WORKFLOW_DEBUG` is off by default. `Basic` logs safe structured events without tokens, callback URLs or full business payloads. Use `Verbose` only temporarily during diagnostics.

n8n diagnostics must be available through stdout/stderr and one production logging sink such as syslog, collector/agent/sidecar, ELK/OpenSearch, or a platform log collector. Docker `json-file` alone is acceptable only for the local stand.

Local ServiceDesk default Kafka result topic:

```text
external.events
```

Local Redpanda endpoints:

```text
container broker: redpanda:9092
host broker: 127.0.0.1:19092
```

Kafka credential for local n8n:

```text
name: Local Redpanda Kafka
type: kafka
clientId: n8n-stage4
brokers: redpanda:9092
ssl: false
authentication: false
```

Production Kafka credential must be selected by the administrator:

```text
SASL_SSL: broker TLS + SASL username/password or SCRAM mechanism + broker ACL limited to the result topic
SSL/mTLS: broker TLS + CA + client certificate/key + broker ACL limited to the result topic
```

HTTP webhook and callback endpoints are configured separately from Kafka. Local examples use `http://`, but customer shared/staging/production URLs should be published through HTTPS, for example `https://n8n.example.ru/webhook` and `https://servicedesk.example.ru/external-events/n8n`.

In the local ServiceDesk compose stack these values are configured for service `n8n` in `../serviceDeskAgents/docker-compose.yml`, with values loaded from `../serviceDeskAgents/.env`.

After changing env, recreate only n8n:

```bash
docker compose up -d --force-recreate --no-deps n8n
```

Run the command from `/home/lsk/projects/serviceDeskAgents`.

## Smoke Checks

Health:

```bash
curl -fsS http://127.0.0.1:5678/healthz
```

Contract discovery:

```bash
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json | jq '.openapi,.paths'
```

Auth-negative check:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -d '{"invocation":{"invocation_id":"smoke-no-token","action_id":"start_systemcenter_runbook"},"parameters":{"source":"smoke"}}' \
  http://127.0.0.1:5678/webhook/servicedesk/runbook/start
```

Expected HTTP status: `401`.

Validation-negative check:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"invocation":{"invocation_id":"smoke-missing-action"},"parameters":{"source":"smoke"}}' \
  http://127.0.0.1:5678/webhook/servicedesk/runbook/start
```

Expected HTTP status: `400`, body contains `error.code: missing_action_id`.

Callback policy-negative check:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"invocation":{"invocation_id":"cmd-bad-callback","action_id":"start_systemcenter_runbook","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000001","ticket_id":"ticket-000000000001","run_id":"run-000000000001","wait_id":"wait-000000000001","correlation_id":"case-000000000001:tool_command:cmd-bad-callback","event_type":"start_systemcenter_runbook_completed","callback_url":"http://user:pass@127.0.0.1:18088/external-events/n8n","idempotency_key_base":"case-000000000001:tool_command:cmd-bad-callback","result_transport":"http_callback"}}},"parameters":{"source":"smoke"}}' \
  http://127.0.0.1:5678/webhook/servicedesk/runbook/start
```

Expected HTTP status: `400`, body contains `error.code: invalid_callback_url`.

Direct happy path:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"invocation":{"invocation_id":"smoke-with-token","action_id":"start_systemcenter_runbook"},"parameters":{"source":"smoke"}}' \
  http://127.0.0.1:5678/webhook/servicedesk/runbook/start
```

Expected HTTP status: `200`, body contains `runbook_status: accepted` and `async_delivery: false`.

Kafka async smoke:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"invocation":{"invocation_id":"cmd-123","action_id":"start_systemcenter_runbook","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000001","ticket_id":"ticket-000000000001","run_id":"run-000000000001","wait_id":"wait-000000000001","correlation_id":"case-000000000001:tool_command:cmd-123","event_type":"start_systemcenter_runbook_completed","idempotency_key_base":"case-000000000001:tool_command:cmd-123","result_transport":"kafka_event","result_topic":"external.events"}}},"parameters":{"source":"smoke","channelName":"provider-link-1"}}' \
  http://127.0.0.1:5678/webhook/servicedesk/runbook/start
```

Expected HTTP status: `200`. Verify one message on `external.events`; its JSON must contain `status: success`, matching `case_id`, `wait_id`, `correlation_id` and `idempotency_key`.

HTTP callback smoke requires a real ServiceDesk wait/callback URL and configured callback token:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"invocation":{"invocation_id":"cmd-124","action_id":"start_systemcenter_runbook","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000002","ticket_id":"ticket-000000000002","run_id":"run-000000000002","wait_id":"wait-000000000002","correlation_id":"case-000000000002:tool_command:cmd-124","event_type":"start_systemcenter_runbook_completed","callback_url":"http://serviceDeskAgents:18088/external-events/n8n","idempotency_key_base":"case-000000000002:tool_command:cmd-124","result_transport":"http_callback"}}},"parameters":{"source":"smoke","channelName":"provider-link-1"}}' \
  http://127.0.0.1:5678/webhook/servicedesk/runbook/start
```

Expected HTTP status: `200`, and ServiceDesk must record the correlated `ExternalEvent`.

After async smoke, inspect recent n8n logs for Code node errors. Production deployments should route those logs through the approved second sink; local Docker can be checked with `docker inspect servicedesk-agents-n8n --format '{{json .HostConfig.LogConfig}}'`.

## Rollback

Deactivate `Webhook ранбука этапа 4` in n8n UI or via local REST API. If webhook registration changed, restart n8n after deactivation. Already delivered Kafka or callback `ExternalEvent` messages are not rolled back by deactivating the workflow.
