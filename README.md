# n8n Integration Adapter

n8n является первым реальным integration adapter. Orchestrator не должен вызывать n8n напрямую; он вызывает Tool Registry и Integration Dispatcher, которые выбирают endpoint binding из данных каталога.

## Начальные контракты workflow

Диагностический workflow без изменения состояния:

- Tool name: `check_zabbix_status`
- Тип n8n: webhook workflow
- Поведение на этапах 0/1: mock или статический ответ
- Выход: нормализованный JSON

Action workflow:

- Tool name: `start_systemcenter_runbook`
- Тип n8n: webhook workflow
- Поведение на этапах 0/1: mock или только непроизводственный ранбук
- Обязательная policy: согласование оператора перед вызовом webhook
- Выход: нормализованный JSON

## Шаблон workflow

Machine-readable contract для внешних приложений:

- OpenAPI source: `contracts/n8n-openapi.json`
- n8n contract workflow: `workflows/contracts-openapi-webhook.json`
- Contract URL: `http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Usage: `docs/runbooks/contract-discovery-usage.md`
- Deployment: `docs/runbooks/contract-discovery-deployment.md`

Шаблон webhook для ранбука этапа 4:

- `workflows/stage4-runbook-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/servicedesk/runbook/start`
- OpenAPI operationId: `startRunbook`
- Usage: `docs/runbooks/stage4-runbook-usage.md`
- Deployment: `docs/runbooks/stage4-runbook-deployment.md`

Этот runbook dual-use: внешние приложения вызывают тот же HTTP endpoint напрямую, а `serviceDeskAgents` использует Kafka/worker wrapper и передает `invocation.extensions.async_callback`. Финальный результат long-running runbook возвращается как canonical ServiceDesk `ExternalEvent` через `callback_url`, Kafka `result_topic` или оба транспорта; отдельный бизнес-контракт для Kafka не создается.

Текущий stage4 workflow является безопасным stub: для async request он сразу публикует terminal `ExternalEvent` со статусом `success`. Реальная production-логика должна сохранить тот же contract, но отправлять результат после фактического завершения runbook.

Шаблон webhook для отправки email из приложения:

- `workflows/send-email-webhook.json`
- Usage: `docs/runbooks/send-email-webhook-usage.md`
- Deployment: `docs/runbooks/send-email-webhook-deployment.md`

Каталог email-шаблонов:

- Source of truth: `contracts/email-template-catalog.json`
- Schema: `contracts/email-template-catalog.schema.json`
- Workflow: `workflows/email-template-catalog-webhook.json`
- Contract URL: `http://127.0.0.1:5678/webhook/contracts/email-templates.json`
- Usage: `docs/runbooks/email-template-catalog-usage.md`
- Deployment: `docs/runbooks/email-template-catalog-deployment.md`

Шаблон webhook для отправки email по template catalog:

- `workflows/send-templated-email-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/email/send-template`
- OpenAPI operationId: `sendTemplatedEmail`
- Usage: `docs/runbooks/send-templated-email-usage.md`
- Deployment: `docs/runbooks/send-templated-email-deployment.md`

Шаблон webhook для добавления сообщения в Zabbix problem:

- `workflows/update-zabbix-problem-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/zabbix/problem/update`
- OpenAPI operationId: `updateZabbixProblem`
- Usage: `docs/runbooks/update-zabbix-problem-usage.md`
- Deployment: `docs/runbooks/update-zabbix-problem-deployment.md`

Локальный стенд для проверки получения и автоответов без mailbox заказчика:

- Compose: `docker-compose.mailtest.yml`
- Webmail: `http://127.0.0.1:8087/`
- GreenMail API: `http://127.0.0.1:8086/`
- Workflow: `workflows/mailtest-auto-reply.json`
- Usage: `docs/runbooks/mailtest-auto-reply-usage.md`
- Deployment: `docs/runbooks/mailtest-auto-reply-deployment.md`
- Smoke: `node scripts/mailtest-smoke.mjs`

Тестовые mailbox для webmail:

- n8n mailbox: `automation-test@local.test` / `automation-pass`
- sender/reply mailbox: `sender@local.test` / `automation-pass`

Контракт отправки email:

- URL: `http://127.0.0.1:5678/webhook/email/send`
- Метод: `POST`
- Header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`
- Body: `application/json`

```json
{
  "to": ["user@example.com"],
  "cc": ["manager@example.com"],
  "bcc": ["audit@example.com"],
  "replyTo": "support@example.com",
  "subject": "Тема письма",
  "body": "Текст письма"
}
```

`to`, `cc` и `bcc` можно передавать строкой или массивом строк. `cc`, `bcc` и `replyTo` необязательны. Attachment в версии v1 не поддерживается.

Контракт отправки email по шаблону:

- URL: `http://127.0.0.1:5678/webhook/email/send-template`
- Метод: `POST`
- Header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`
- Body: `application/json`

```json
{
  "to": ["provider@example.com"],
  "replyTo": "support@example.com",
  "templateId": "provider_line_repair_request",
  "params": {
    "localTicketNumber": "ГКМ12345678",
    "lineId": "L-100500",
    "serviceAddress": "Москва, ул. Тестовая, д. 1",
    "problemDescription": "Нет связи",
    "contactName": "Иван Иванов",
    "contactPhone": "+7 999 000-00-00"
  }
}
```

Тестовый шаблон пропадания канала:

```json
{
  "to": ["provider@example.com"],
  "replyTo": "support@example.com",
  "templateId": "provider_channel_outage_test",
  "params": {
    "city": "Москва",
    "location": "Москва, ул. Тестовая, д. 1",
    "ip_address": "192.0.2.10",
    "contract": "CNT-100500",
    "service_request": "12345678"
  }
}
```

В этом шаблоне тема тоже рендерится из параметров: `Пропадание связи по каналу {{city}}`.

Runtime validation для шаблонов проверяет required params, primitive type, optional `pattern`, лимит 2000 символов на параметр, запрет control characters/CRLF, rendered subject до 500 символов и rendered body до 20000 символов.

Для текущей разработки шаблоны живут в GitHub repository проекта. Для production тот же набор `contracts/`, `workflows/` и `docs/runbooks/` должен поставляться из GitLab; n8n UI не используется как ручное хранилище бизнес-шаблонов.

Контракт добавления сообщения в Zabbix problem:

- URL: `http://127.0.0.1:5678/webhook/zabbix/problem/update`
- Метод: `POST`
- Header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`
- Body: `application/json`

```json
{
  "problemUrl": "http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528",
  "message": "Создано обращение провайдеру: ГКМ Наряд № 12345678"
}
```

Workflow парсит `eventid` и `triggerid`, проверяет problem через Zabbix `problem.get` и добавляет новое сообщение через `event.acknowledge`. n8n передает текст `message` без собственного префикса даты/времени; timestamp операции показывает Zabbix.

Этот endpoint не идемпотентный: каждый успешный вызов добавляет новую запись в Zabbix history. `problem_url` принимается как alias для `problemUrl`; URL должен быть `http/https` без embedded credentials.

Для нескольких Zabbix настройте token registry в окружении n8n:

```text
ZABBIX_API_TOKENS_BY_ORIGIN={"http://localhost:8081":"<zabbix-api-token>"}
ZABBIX_API_URLS_BY_ORIGIN={"http://localhost:8081":"http://zabbix-web:8080/api_jsonrpc.php"}
```

После импорта `workflows/send-email-webhook.json` в n8n нужно:

1. Открыть workflow в UI: `http://127.0.0.1:5678`.
2. В node `Отправка email` выбрать или создать SMTP credentials для стандартного `Send Email` node.
3. Убедиться, что в окружении n8n задан `N8N_WEBHOOK_TOKEN`.
4. Опционально задать `N8N_MAIL_FROM`, иначе workflow использует `noreply@local.dev`.
5. Активировать workflow.

Пример вызова из CLI:

```bash
N8N_WEBHOOK_TOKEN=replace_with_dev_webhook_token \
node scripts/send-email-via-n8n.mjs \
  --to user@example.com \
  --cc manager@example.com \
  --bcc audit@example.com \
  --subject "Проверка n8n email" \
  --body "Тестовое письмо через n8n" \
  --reply-to support@example.com
```

Diagnostic режим CLI:

- `N8N_MAIL_DEBUG=Basic` пишет безопасные structured JSON события в `stderr`.
- `N8N_MAIL_DEBUG=Verbose` добавляет маскированные адреса и технические детали без токена и тела письма.
- `N8N_MAIL_LOG_FILE=/path/to/mail-dispatch.ndjson` включает дополнительный NDJSON sink для collector/agent/sidecar.

Diagnostic режим n8n workflows:

- `N8N_WORKFLOW_DEBUG=Basic` пишет безопасные structured JSON события в основной лог n8n.
- `N8N_WORKFLOW_DEBUG=Verbose` используйте только временно; workflow code маскирует token/password/secret, callback URL и полные тела писем.

Локальный integration profile по умолчанию: `mock`. Используйте `INTEGRATION_ENDPOINT_PROFILE=n8n` только после импорта и активации n8n workflow.

Workflow проверяет заголовок `X-ServiceDesk-Token` по `N8N_WEBHOOK_TOKEN` из окружения контейнера n8n и возвращает `401`, если токен отсутствует или некорректен.

После изменения `contracts/email-template-catalog.json` нужно обновить workflow exports:

```bash
node scripts/build-email-template-workflows.mjs
node scripts/build-contract-workflow.mjs
```

После изменения stage4 runbook generator или async delivery нужно обновить workflow export и OpenAPI discovery:

```bash
node scripts/build-stage4-runbook-workflow.mjs
node scripts/build-contract-workflow.mjs
```

После изменения `scripts/build-zabbix-problem-workflow.mjs` нужно обновить workflow export:

```bash
node scripts/build-zabbix-problem-workflow.mjs
node scripts/build-contract-workflow.mjs
```

Перед импортом в n8n запускайте contract/static gate:

```bash
node scripts/test-contracts.mjs
```

## Правило безопасности

LLM никогда не должна вызывать n8n напрямую. Все вызовы проходят через:

```text
LangGraph -> Tool Registry -> Integration Dispatcher -> n8n_webhook adapter
```

Action tools требуют запись согласования до того, как adapter вызовет n8n.
