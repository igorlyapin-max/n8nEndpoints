# Stage 4 Runbook Deployment

## Import And Activation

1. Open n8n UI: `http://127.0.0.1:5678`.
2. Import `workflows/stage4-runbook-webhook.json`.
3. Confirm the workflow name is `Webhook ранбука этапа 4`.
4. Activate the workflow.
5. Production webhook path must be:

```text
http://127.0.0.1:5678/webhook/servicedesk/runbook/start
```

Machine-readable contract must be available through workflow `Contracts: OpenAPI discovery`:

```text
GET http://127.0.0.1:5678/webhook/contracts/openapi.json
```

OpenAPI operationId for this runbook: `startRunbook`.

## Runtime Requirements

The local n8n container must receive:

- `N8N_WEBHOOK_TOKEN`
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`

In the local ServiceDesk compose stack these values are configured for service `n8n` in `../serviceDeskAgents/docker-compose.yml`, with values loaded from `../serviceDeskAgents/.env`.

After changing these environment variables, recreate only n8n:

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

Happy path:

```bash
curl -i \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN" \
  -d '{"invocation":{"invocation_id":"smoke-with-token","action_id":"start_systemcenter_runbook"},"parameters":{"source":"smoke"}}' \
  http://127.0.0.1:5678/webhook/servicedesk/runbook/start
```

Expected HTTP status: `200`, body contains `runbook_status: accepted`.

## Rollback

Deactivate `Webhook ранбука этапа 4` in n8n UI or via local REST API. The workflow export can remain in the repository; production calls stop once the workflow is inactive.
