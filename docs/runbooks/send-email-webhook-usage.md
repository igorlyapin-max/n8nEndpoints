# Send Email Webhook Usage

## Назначение

Workflow `Email: отправка письма через webhook` принимает HTTP-запрос от приложения и отправляет текстовое письмо через n8n `Send Email` node.

Production webhook:

```text
POST http://127.0.0.1:5678/webhook/email/send
```

Machine-readable contract:

```text
GET http://127.0.0.1:5678/webhook/contracts/openapi.json
```

OpenAPI operationId: `sendEmail`.

## Вход

Headers:

- `Content-Type: application/json`
- `X-ServiceDesk-Token: <N8N_WEBHOOK_TOKEN>`

Body:

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

`to`, `cc` и `bcc` можно передавать строкой, строкой с разделителями `,` или `;`, либо массивом строк. `cc`, `bcc` и `replyTo` необязательны.

Attachments в версии v1 не поддерживаются. Если запрос содержит `attachment`, `attachments` или `files`, workflow возвращает `400 attachments_not_supported`.

## Ответы

Успешная отправка:

```json
{
  "status": "sent"
}
```

Ошибки:

- `401 unauthorized` - отсутствует или неверен `X-ServiceDesk-Token`.
- `400 missing_to` - не указан получатель.
- `400 missing_subject` - не указана тема.
- `400 missing_body` - не указано тело письма.
- `400 invalid_email` - некорректный адрес в `to`, `cc`, `bcc` или `replyTo`.
- `400 attachments_not_supported` - передан attachment.
- `502 email_send_failed` - SMTP node не смог отправить письмо.

## CLI

Локальный вызов через скрипт:

```bash
N8N_WEBHOOK_TOKEN=replace_with_dev_webhook_token \
node scripts/send-email-via-n8n.mjs \
  --to automation-test@local.test \
  --cc cc@local.test \
  --bcc bcc@local.test \
  --subject "Проверка n8n email" \
  --body "Тестовое письмо через n8n" \
  --reply-to sender@local.test
```

Diagnostic режим:

- `N8N_MAIL_DEBUG=Basic` пишет безопасные structured JSON события в `stderr`.
- `N8N_MAIL_DEBUG=Verbose` добавляет маскированные адреса и технические детали без webhook token и без тела письма.
- `N8N_MAIL_LOG_FILE=/path/to/mail-dispatch.ndjson` включает дополнительный NDJSON sink для collector, agent или sidecar.

## Ожидаемая проверка

Для тестового стенда с GreenMail письмо должно попасть в mailbox получателя. Если активен workflow `Mailtest: IMAP автоответ`, письмо на `automation-test@local.test` дополнительно инициирует автоответ.
