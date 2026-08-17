# Provider Ops MCP Adapter

Внешний MCP endpoint для `ServiceDeskAgents` capability bindings. Adapter является границей исполнения: `ServiceDeskAgents` видит только MCP tools/capabilities, а n8n webhook paths, workflow ids и внутренние поля остаются private implementation detail этого MCP окружения.

## Runtime Contract

- MCP URL для ServiceDesk при HTTP: `http://hostmachine:9000/mcp`
- MCP URL для ServiceDesk при HTTPS: `https://hostmachine:9000/mcp`
- Host smoke URL при HTTP: `http://127.0.0.1:9000/mcp`
- Host smoke URL при HTTPS: `https://127.0.0.1:9000/mcp`
- Health: `GET /health`
- Ready: `GET /ready`
- Auth: `Authorization: Bearer $MCP_PROVIDER_OPS_TOKEN`
- Transport security выбирает администратор: `MCP_PROVIDER_OPS_SCHEME=http|https`.

Adapter публикует tools из `contracts/mcp-tool-manifest.json`:

- `provider_channel_repair_monitor`
- `zabbix_problem_update`
- `zabbix_problem_status_wait`

`tools/list` строится из manifest и возвращает business descriptions, canonical input schema, output schema и async event contract. Эти описания использует ServiceDesk LLM-assistant при формировании capability-шагов.

## ServiceDesk Async Flow

Для `ServiceDeskAgents` этот adapter является MCP execution boundary. Административная цепочка выглядит так:

1. `ServiceDeskAgents` открывает durable `wait_state` с `source=mcp`, формирует `async_context` и публикует команду в `mcp.commands`.
2. `async-mcp-worker` вызывает этот adapter через MCP JSON-RPC `tools/call` на `POST /mcp`.
3. Adapter проверяет Bearer token, выбирает tool из `contracts/mcp-tool-manifest.json`, валидирует inputs и обязательный `async_context`.
4. Adapter мапит canonical MCP inputs во внутренний n8n payload и вызывает n8n webhook через `N8N_WEBHOOK_BASE_URL` с header `X-ServiceDesk-Token`.
5. Для async tool adapter возвращает MCP response `status=accepted` с `external_execution_id` и тем же `correlation_id`. Это только подтверждение приема команды, не бизнес-результат runbook.
6. n8n workflow доставляет progress или terminal result обратно в `ServiceDeskAgents` как canonical `ExternalEvent` через `callback_url`, Kafka `result_topic` или оба транспорта.

Внутри n8n payload async callback передается как `invocation.extensions.async_callback`. В нем сохраняются `source=mcp`, `case_id`, `run_id`, `wait_id`, `correlation_id`, `event_type`, `idempotency_key_base`, `result_transport`, `callback_url` и/или `result_topic`.

n8n workflow ids, webhook paths, node names и внутренние result поля остаются private implementation detail этого MCP окружения. В сценариях `ServiceDeskAgents` должны использоваться только capability id, canonical inputs/outputs, MCP accepted acknowledgement и canonical `ExternalEvent`.

## Source Of Truth

Manifest-driven цепочка:

1. n8n workflow source/generator обновляет workflow JSON.
2. Публикация/экспорт обновляет `contracts/n8n-openapi.json` и `contracts/n8n-workflow-catalog.json`.
3. `contracts/mcp-tool-manifest.json` описывает, какие n8n операции публикуются как MCP tools.
4. `scripts/mcp-tool-manifest.mjs` валидирует manifest против OpenAPI и workflow catalog.
5. `scripts/provider-ops-mcp-server.mjs` только исполняет manifest: не содержит hardcoded списка capabilities.

Новый runbook добавляется так:

1. Создать или обновить n8n workflow обычным publish/import способом проекта.
2. Убедиться, что OpenAPI содержит `operationId`, webhook path и schema операции.
3. Убедиться, что workflow catalog содержит `workflow_id`, `openapi_operation_id` и `enabled=true`.
4. Добавить tool в `contracts/mcp-tool-manifest.json`: `tool_name`, `capability_id`, `workflow_id`, `operation_id`, `webhook_path`, `execution_mode`, input/output schemas, aliases и mapping.
5. Для async tool указать `action_id`, `expected_event_type`, `async_context_required=true`, `result_mapping.type=accepted_ack` и mapping `invocation` с `async_invocation=true`.
6. Запустить `node scripts/validate-mcp-manifest.mjs` и `node scripts/test-contracts.mjs`.
7. Пересобрать и перезапустить adapter.

## Environment

Required:

```bash
export MCP_PROVIDER_OPS_TOKEN=dev-provider-ops-token-local-20260704
```

Optional:

```bash
export N8N_WEBHOOK_TOKEN=dev-n8n-webhook-token-local
export N8N_WEBHOOK_BASE_URL=http://servicedesk-agents-n8n:5678/webhook
export N8N_HEALTH_URL=http://servicedesk-agents-n8n:5678/healthz
export MCP_PROVIDER_OPS_PUBLISHED_HOST=0.0.0.0
export MCP_PROVIDER_OPS_PUBLISHED_PORT=9000
export MCP_PROVIDER_OPS_SCHEME=http
export MCP_PROVIDER_OPS_MANIFEST_PATH=contracts/mcp-tool-manifest.json
export MCP_PROVIDER_OPS_OPENAPI_PATH=contracts/n8n-openapi.json
export MCP_PROVIDER_OPS_WORKFLOW_CATALOG_PATH=contracts/n8n-workflow-catalog.json
export DEBUG_LOGGING_ENABLED=false
export DEBUG_LOGGING_LEVEL=Basic
```

`MCP_PROVIDER_OPS_PUBLISHED_HOST=0.0.0.0` нужен локальному Docker-стенду, потому что `ServiceDeskAgents` вызывает endpoint из контейнера через `hostmachine:9000`.

HTTPS включается администратором:

```bash
export MCP_PROVIDER_OPS_SCHEME=https
export MCP_PROVIDER_OPS_TLS_CERTS_DIR=./certs/mcp-provider-ops
export MCP_PROVIDER_OPS_TLS_CERT_FILE=/app/tls/server.crt
export MCP_PROVIDER_OPS_TLS_KEY_FILE=/app/tls/server.key
```

mTLS для входящих вызовов ServiceDesk включается дополнительно:

```bash
export MCP_PROVIDER_OPS_TLS_CLIENT_CA_FILE=/app/tls/client-ca.crt
export MCP_PROVIDER_OPS_TLS_REQUIRE_CLIENT_CERT=true
```

В `ServiceDeskAgents` соответствующее MCP окружение должно использовать `https://.../mcp` и один из режимов `transport_security.mode`: `https_system_ca`, `https_custom_ca` или `https_mtls`. Для custom CA и mTLS refs указываются как `env:MCP_PROVIDER_OPS_CA_CERT_FILE`, `env:MCP_PROVIDER_OPS_CLIENT_CERT_FILE`, `env:MCP_PROVIDER_OPS_CLIENT_KEY_FILE`; сами env значения должны быть путями к файлам внутри контейнера ServiceDesk.

Debug logging по умолчанию выключен. `DEBUG_LOGGING_LEVEL=Basic` оставляет безопасные structured events, `Verbose` временно включает расширенные diagnostic events без токенов и секретов. Логи пишутся JSON lines в stdout/stderr контейнера и дальше идут через Docker logging pipeline стенда.

## Start

n8n runtime, backed by the existing local `n8n` Postgres database and `servicedesk-agents_n8n-data` volume:

```bash
docker compose -f docker-compose.n8n.yml -f docker-compose.n8n-zabbix-token.override.yml up -d
```

MCP adapter:

```bash
docker compose -f docker-compose.mcp-provider-ops.yml up -d --build
```

Restart after env, manifest, OpenAPI, catalog, script or Dockerfile changes:

```bash
docker compose -f docker-compose.mcp-provider-ops.yml up -d --build --force-recreate provider-ops-mcp
```

## Validation

Manifest validation:

```bash
node scripts/validate-mcp-manifest.mjs
```

Contract tests:

```bash
node scripts/test-contracts.mjs
```

## Smoke

Health:

```bash
curl -fsS http://127.0.0.1:9000/health
```

При `MCP_PROVIDER_OPS_SCHEME=https` используйте HTTPS URL и доверенный CA:

```bash
curl -fsS --cacert ./certs/mcp-provider-ops/ca.crt https://127.0.0.1:9000/health
```

Tools list:

```bash
curl -fsS \
  -H "Authorization: Bearer ${MCP_PROVIDER_OPS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"tools-list","method":"tools/list","params":{}}' \
  http://127.0.0.1:9000/mcp
```

Expected result contains three tools from `contracts/mcp-tool-manifest.json`; health contains `manifest_id=provider-ops-mcp-tools`.

Ready checks n8n availability:

```bash
curl -fsS http://127.0.0.1:9000/ready
```

`status: degraded` means the MCP adapter is alive, but n8n is not reachable or required tokens are missing.
