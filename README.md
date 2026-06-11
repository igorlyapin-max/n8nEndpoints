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
- Usage: `docs/runbooks/stage4-runbook-usage.md`
- Deployment: `docs/runbooks/stage4-runbook-deployment.md`

Шаблон webhook для отправки email из приложения:

- `workflows/send-email-webhook.json`
- Usage: `docs/runbooks/send-email-webhook-usage.md`
- Deployment: `docs/runbooks/send-email-webhook-deployment.md`

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

Локальный integration profile по умолчанию: `mock`. Используйте `INTEGRATION_ENDPOINT_PROFILE=n8n` только после импорта и активации n8n workflow.

Workflow проверяет заголовок `X-ServiceDesk-Token` по `N8N_WEBHOOK_TOKEN` из окружения контейнера n8n и возвращает `401`, если токен отсутствует или некорректен.

## Правило безопасности

LLM никогда не должна вызывать n8n напрямую. Все вызовы проходят через:

```text
LangGraph -> Tool Registry -> Integration Dispatcher -> n8n_webhook adapter
```

Action tools требуют запись согласования до того, как adapter вызовет n8n.
