# Send Email Webhook Deployment

## Предусловия

- n8n UI доступен по `http://127.0.0.1:5678`.
- В окружении контейнера n8n задан `N8N_WEBHOOK_TOKEN`.
- Для node `Отправка email` создан SMTP credential.
- Для локального теста поднят GreenMail из `docker-compose.mailtest.yml`.
- Workflow `Contracts: OpenAPI discovery` импортирован и активирован, чтобы внешние приложения могли получить контракт по `GET /webhook/contracts/openapi.json`.
- Для отправки по шаблонам отдельно импортируются `workflows/email-template-catalog-webhook.json` и `workflows/send-templated-email-webhook.json`; direct-send workflow не хранит template catalog.

## Импорт

1. Откройте n8n UI: `http://127.0.0.1:5678`.
2. Импортируйте `workflows/send-email-webhook.json`.
3. Откройте node `Отправка email`.
4. Выберите SMTP credential.
5. Активируйте workflow.

Текущий локальный импорт:

- Workflow ID: `IZL94y092Lk9Yius`
- Active version: `1991bb76-6c9b-41d6-be1f-42a90697852e`
- Credential: `GreenMail SMTP (local test)`

Machine-readable contract:

```text
GET http://127.0.0.1:5678/webhook/contracts/openapi.json
```

OpenAPI operationId для этого workflow: `sendEmail`.

## SMTP для локального стенда

GreenMail SMTP:

```text
host: mailtest
port: 3025
secure: false
disableStartTls: true
user: automation-test@local.test
password: automation-pass
```

На хосте SMTP доступен как `127.0.0.1:3025`, но n8n должен использовать Docker DNS имя `mailtest`.

## SMTP у заказчика

Для проверки с инфраструктурой заказчика не нужен mailbox заказчика, но нужен один из вариантов:

- отдельный тестовый SMTP relay/connector, разрешающий отправку с тестового адреса;
- тестовый mailbox, созданный заказчиком специально для интеграции;
- временный allowlist на SMTP relay для адреса отправителя интеграции.

Без доступа к SMTP relay заказчика локальный стенд проверяет только контракт webhook, валидацию, SMTP/IMAP механику и автоответы. Доставку через Exchange заказчика он не подтверждает.

## Smoke

```bash
N8N_WEBHOOK_TOKEN=replace_with_dev_webhook_token \
N8N_MAIL_DEBUG=Basic \
N8N_MAIL_LOG_FILE=/tmp/n8n-send-email-smoke.ndjson \
node scripts/send-email-via-n8n.mjs \
  --to automation-test@local.test \
  --cc cc@local.test \
  --bcc bcc@local.test \
  --subject "n8n webhook send smoke" \
  --body "Webhook send smoke via GreenMail" \
  --reply-to sender@local.test
```

Ожидаемый результат:

```json
{
  "status": "ok",
  "n8n": {
    "status": "sent"
  }
}
```

## Rollback

1. Деактивируйте workflow `Email: отправка письма через webhook`.
2. Удалите или отвяжите SMTP credential, если он был создан только для теста.
3. Если GreenMail больше не нужен, остановите тестовый стенд:

```bash
docker compose -f docker-compose.mailtest.yml down
```
