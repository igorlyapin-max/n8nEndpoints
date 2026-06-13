# Update Zabbix Problem Deployment

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
node scripts/build-zabbix-problem-workflow.mjs
node scripts/build-contract-workflow.mjs
```

Проверка drift:

```bash
node scripts/build-zabbix-problem-workflow.mjs --check
node scripts/build-contract-workflow.mjs --check
node scripts/test-contracts.mjs
```

## Импорт

1. Откройте n8n UI: `http://127.0.0.1:5678`.
2. Импортируйте `workflows/update-zabbix-problem-webhook.json`.
3. Убедитесь, что workflow называется `Zabbix: обновление problem по URL`.
4. Активируйте workflow.
5. Если import/publish сообщает о необходимости обновить webhook registration, перезапустите n8n.

OpenAPI operationId: `updateZabbixProblem`.

## Smoke

Health:

```bash
curl -fsS http://127.0.0.1:5678/healthz
```

Auth-negative:

```bash
curl -sS -o /tmp/n8n-zabbix-update-unauthorized.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -d '{"problemUrl":"http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528","message":"smoke"}' \
  http://127.0.0.1:5678/webhook/zabbix/problem/update
```

Expected HTTP status: `401`.

Validation-negative:

```bash
curl -sS -o /tmp/n8n-zabbix-update-missing-eventid.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{"problemUrl":"http://localhost:8081/tr_events.php?triggerid=61119","message":"smoke"}' \
  http://127.0.0.1:5678/webhook/zabbix/problem/update
```

Expected HTTP status: `400`.

Invalid URL negative:

```bash
curl -sS -o /tmp/n8n-zabbix-update-invalid-url.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{"problem_url":"file:///tmp/problem?triggerid=61119&eventid=90528","message":"smoke"}' \
  http://127.0.0.1:5678/webhook/zabbix/problem/update
```

Expected HTTP status: `400`, body contains `error.code: invalid_problem_url`.

Happy path requires a real active Zabbix problem URL and API token:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{"problemUrl":"http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528","message":"Создано обращение провайдеру: ГКМ Наряд № 12345678"}' \
  http://127.0.0.1:5678/webhook/zabbix/problem/update
```

Ожидаемый результат:

```json
{
  "status": "updated"
}
```

Проверяйте добавленное сообщение через Zabbix UI или `problem.get` с `selectAcknowledges`. n8n отправляет `message` без собственной даты/времени; дату и время изменения показывает Zabbix.

Повтор того же запроса добавит вторую запись в Zabbix history. Этот workflow intentionally non-idempotent.

## Rollback

Деактивируйте workflow `Zabbix: обновление problem по URL`. Existing Zabbix problems не изменяются при rollback; уже добавленные event update messages остаются в истории Zabbix.
