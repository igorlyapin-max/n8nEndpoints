# Send Templated Email Deployment

## Предусловия

- n8n UI доступен по `http://127.0.0.1:5678`.
- В окружении контейнера n8n задан `N8N_WEBHOOK_TOKEN`.
- В окружении контейнера n8n задан `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, если установленная версия n8n блокирует чтение env в Code nodes.
- Опционально задан `N8N_WORKFLOW_DEBUG=Basic` для безопасных structured diagnostics; `Verbose` используйте только временно.
- Опционально задан `N8N_MAIL_FROM`, иначе workflow использует `noreply@local.dev`.
- Для node `Отправка email` создан SMTP credential.
- Workflow `Contracts: OpenAPI discovery` импортирован и активирован.
- Workflow `Contracts: Email template catalog` импортирован и активирован.

## Генерация

После изменения `contracts/email-template-catalog.json` выполните:

```bash
node scripts/build-email-template-workflows.mjs
node scripts/build-contract-workflow.mjs
```

Проверка drift:

```bash
node scripts/build-email-template-workflows.mjs --check
node scripts/build-contract-workflow.mjs --check
node scripts/test-contracts.mjs
```

## Импорт

1. Откройте n8n UI: `http://127.0.0.1:5678`.
2. Импортируйте `workflows/send-templated-email-webhook.json`.
3. Откройте node `Отправка email`.
4. Проверьте или выберите SMTP credential.
5. Проверьте, что workflow execution data saving выключен для success, error и manual executions. Это обязательно, потому что шаблон `ad_password_reset_notification` передает параметр `password`.
6. Активируйте workflow.
7. Если import/publish сообщает о необходимости обновить webhook registration, перезапустите n8n.

OpenAPI operationId для этого workflow: `sendTemplatedEmail`.

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

## Smoke

Auth-negative:

```bash
curl -sS -o /tmp/n8n-send-template-unauthorized.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -d '{"to":["automation-test@local.test"],"templateId":"provider_line_repair_request","params":{}}' \
  http://127.0.0.1:5678/webhook/email/send-template
```

Expected HTTP status: `401`.

Validation-negative:

```bash
curl -sS -o /tmp/n8n-send-template-invalid-param.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{
    "to": ["automation-test@local.test"],
    "templateId": "provider_line_repair_request",
    "params": {
      "localTicketNumber": "BAD",
      "lineId": "L-100500",
      "serviceAddress": "Москва, ул. Тестовая, д. 1",
      "problemDescription": "Нет связи",
      "contactName": "Иван Иванов",
      "contactPhone": "+7 999 000-00-00"
    }
  }' \
  http://127.0.0.1:5678/webhook/email/send-template
```

Expected HTTP status: `400`, body contains `error.code: invalid_template_param`.

Happy path:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{
    "to": ["automation-test@local.test"],
    "replyTo": "sender@local.test",
    "templateId": "provider_line_repair_request",
    "params": {
      "localTicketNumber": "ГКМ12345678",
      "lineId": "L-100500",
      "serviceAddress": "Москва, ул. Тестовая, д. 1",
      "problemDescription": "Нет связи на линии с 10:15 МСК",
      "contactName": "Иван Иванов",
      "contactPhone": "+7 999 000-00-00",
      "impact": "Полная недоступность сервиса",
      "preferredContactHours": "09:00-18:00 МСК"
    }
  }' \
  http://127.0.0.1:5678/webhook/email/send-template
```

Ожидаемый ответ:

```json
{
  "status": "sent"
}
```

Password notification render smoke выполняйте только на локальном mailbox или согласованном тестовом получателе. Не вставляйте реальный пароль в shell history, tickets или screenshots:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -d '{
    "to": ["automation-test@local.test"],
    "templateId": "ad_password_reset_notification",
    "params": {
      "service_request": "12345678",
      "employee_full_name": "Иванов Иван Иванович",
      "password": "<generated-password>"
    }
  }' \
  http://127.0.0.1:5678/webhook/email/send-template
```

После happy path проверьте webmail `http://127.0.0.1:8087/`:

- n8n mailbox: `automation-test@local.test` / `automation-pass`
- sender/reply mailbox: `sender@local.test` / `automation-pass`

## GitHub Dev / GitLab Prod

- Dev: изменения шаблонов, contracts и workflow exports фиксируются в текущем GitHub repository.
- Production: те же файлы должны поставляться из GitLab repository или GitLab artifact/release.
- В production не редактируйте шаблоны вручную внутри n8n UI.

## Rollback

1. Деактивируйте workflow `Email: отправка письма по шаблону`.
2. Если нужно убрать discovery шаблонов, деактивируйте `Contracts: Email template catalog`.
3. Оставьте direct-send workflow `Email: отправка письма через webhook` активным, если он используется внешними приложениями.
