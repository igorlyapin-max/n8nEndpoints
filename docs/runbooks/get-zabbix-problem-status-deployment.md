# Get Zabbix Problem Status Deployment

## Предусловия

- n8n UI доступен по `http://127.0.0.1:5678`.
- В окружении контейнера n8n задан `N8N_WEBHOOK_TOKEN`.
- В окружении контейнера n8n задан `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, чтобы Code node мог читать env registry.
- Опционально задан `N8N_WORKFLOW_DEBUG=Basic` для безопасных structured diagnostics; `Verbose` используйте только временно.
- Для каждого Zabbix origin задан token в `ZABBIX_API_TOKENS_BY_ORIGIN`.
- Workflow `Contracts: OpenAPI discovery` импортирован и активирован.

## Environment

Минимальная настройка:

```text
ZABBIX_API_TOKENS_BY_ORIGIN={"http://localhost:8081":"<zabbix-api-token>"}
```

Если URL из заявки указывает на адрес, недоступный из контейнера n8n, задайте API URL override:

```text
ZABBIX_API_URLS_BY_ORIGIN={"http://localhost:8081":"http://zabbix-web:8080/api_jsonrpc.php"}
```

Secrets не хранятся в workflow JSON или repository.

## Генерация

После изменения workflow generator выполните:

```bash
node scripts/build-zabbix-problem-status-workflow.mjs
node scripts/build-contract-workflow.mjs
```

Проверка drift:

```bash
node scripts/build-zabbix-problem-status-workflow.mjs --check
node scripts/build-contract-workflow.mjs --check
node scripts/test-contracts.mjs
```

## Импорт

1. Откройте n8n UI: `http://127.0.0.1:5678`.
2. Импортируйте `workflows/get-zabbix-problem-status-webhook.json`.
3. Убедитесь, что workflow называется `Zabbix: статус problem по URL`.
4. Активируйте workflow.
5. Если import/publish сообщает о необходимости обновить webhook registration, перезапустите n8n.

OpenAPI operationId: `getZabbixProblemStatus`.

## Smoke

Health:

```bash
curl -fsS http://127.0.0.1:5678/healthz
```

Auth-negative:

```bash
curl -sS -o /tmp/n8n-zabbix-status-unauthorized.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -d '{"problemUrl":"http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528"}' \
  http://127.0.0.1:5678/webhook/zabbix/problem/status
```

Expected HTTP status: `401`.

Invalid URL negative:

```bash
curl -sS -o /tmp/n8n-zabbix-status-invalid-url.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{"problem_url":"file:///tmp/problem?triggerid=61119&eventid=90528"}' \
  http://127.0.0.1:5678/webhook/zabbix/problem/status
```

Expected HTTP status: `400`, body contains `error.code: invalid_problem_url`.

Active problem happy path requires a real active or recent Zabbix problem URL:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{"problemUrl":"http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528"}' \
  http://127.0.0.1:5678/webhook/zabbix/problem/status
```

Ожидаемый результат для активной проблемы:

```json
{
  "status": "problem",
  "source": "event"
}
```

`resolved` и `ok` сценарии зависят от наличия подходящих исторических events на стенде. Если таких URL нет, покрытие этих веток подтверждается `node scripts/test-contracts.mjs`.

## Rollback

Деактивируйте workflow `Zabbix: статус problem по URL`. Existing Zabbix objects не изменяются, потому что workflow read-only.
