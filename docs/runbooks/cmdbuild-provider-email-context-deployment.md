# CMDBuild Provider Email Context Deployment

## Предусловия

- n8n UI доступен по `http://127.0.0.1:5678`.
- В окружении контейнера n8n задан `N8N_WEBHOOK_TOKEN`.
- CMDBuild REST v3 доступен из контейнера n8n.
- В n8n создан credential `Local CMDBuild Admin Test` типа `HTTP Basic Auth`.
- Для локального тестового стенда credential содержит user `admin`, password `admin`.
- Workflow `Contracts: OpenAPI discovery` импортирован и активирован.

Secrets не хранятся в workflow JSON или repository.

## Environment

Workflow читает `CMDBUILD_BASE_URL` из окружения n8n, если переменная задана.

Пример production/development override:

```text
CMDBUILD_BASE_URL=http://cmdbuild-host:8080/cmdbuild
```

URL задается с точки зрения контейнера n8n. На текущем локальном стенде hostname `cmdbuild_app` дает некорректный Tomcat `400` из-за underscore в Host header, поэтому для smoke используйте доступный container/network URL или задайте корректный alias/env.

## Генерация

После изменения workflow generator выполните:

```bash
node scripts/build-cmdbuild-provider-context-workflow.mjs
node scripts/build-contract-workflow.mjs
```

Проверка drift:

```bash
node scripts/build-cmdbuild-provider-context-workflow.mjs --check
node scripts/build-contract-workflow.mjs --check
node scripts/apply-workflow-inline-documentation.mjs --check
node scripts/test-contracts.mjs
```

## Импорт

1. Откройте n8n UI: `http://127.0.0.1:5678`.
2. Импортируйте `workflows/cmdbuild-provider-email-context-webhook.json`.
3. Убедитесь, что workflow называется `CMDBuild: параметры письма провайдеру`.
4. В узлах `Поиск routerG`, `Чтение IpAddress`, `Чтение Room`, `Чтение Floor`, `Чтение Building` выберите credential `Local CMDBuild Admin Test`.
5. Активируйте workflow.
6. Если import/publish сообщает о необходимости обновить webhook registration, перезапустите n8n.

OpenAPI operationId: `getProviderEmailContext`.

## Smoke

Health:

```bash
curl -fsS http://127.0.0.1:5678/healthz
```

Auth-negative:

```bash
curl -sS -o /tmp/n8n-cmdbuild-context-unauthorized.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -d '{"hostname":"Router for NTbook group 000 (OFF01 Office 01 - Headquarters)"}' \
  http://127.0.0.1:5678/webhook/cmdbuild/provider-email-context
```

Expected HTTP status: `401`.

Missing hostname:

```bash
curl -sS -o /tmp/n8n-cmdbuild-context-missing-hostname.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{}' \
  http://127.0.0.1:5678/webhook/cmdbuild/provider-email-context
```

Expected HTTP status: `400`, body contains `error.code: missing_hostname`.

Happy path requires one active `routerG` card whose `Description`, `hostname` or `Code` matches the request and whose `email`, `contract`, `ipaddress`, `Location`, `Room.Floor`, `Floor.Building`, and `Building.City` are filled:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{"hostname":"Router for NTbook group 000 (OFF01 Office 01 - Headquarters)"}' \
  http://127.0.0.1:5678/webhook/cmdbuild/provider-email-context
```

Expected response:

```json
{
  "status": "OK",
  "provider_email": "provider@example.test",
  "city": "City01",
  "location": "Office Building A - Floor 1 - Room 001",
  "ip_address": "192.168.202.35",
  "contract": "Договор № 33333-1111 и так далее"
}
```

## Rollback

Деактивируйте workflow `CMDBuild: параметры письма провайдеру`. CMDBuild data не изменяются, потому что workflow read-only.
