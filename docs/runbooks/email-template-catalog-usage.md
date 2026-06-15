# Email Template Catalog Usage

## Назначение

Workflow `Contracts: Email template catalog` отдает машинночитаемый каталог email-шаблонов, которые доступны для отправки через n8n templated email endpoint.

Каталог нужен внешней агентской среде, чтобы до вызова отправки узнать:

- доступные `template_id`;
- обязательные и опциональные параметры;
- текстовые `subject_template` и `body_template`;
- описание параметров для UI, валидации или автозаполнения.

## Caller Contract

- Workflow export: `workflows/email-template-catalog-webhook.json`
- Source-of-truth catalog: `contracts/email-template-catalog.json`
- Catalog schema: `contracts/email-template-catalog.schema.json`
- Endpoint: `GET http://127.0.0.1:5678/webhook/contracts/email-templates.json`
- Auth: не требуется.
- Content type: `application/json`
- OpenAPI operationId: `getEmailTemplateCatalog`

## Caller Flow

1. Внешнее приложение вызывает `GET /webhook/contracts/openapi.json`.
2. Находит operationId `getEmailTemplateCatalog`.
3. Вызывает `GET /webhook/contracts/email-templates.json`.
4. По `template_id` выбирает шаблон.
5. Перед вызовом `sendTemplatedEmail` заполняет все поля из `required_params`.

## Response

Успешный ответ:

```json
{
  "schema_version": "1.0",
  "templates": [
    {
      "template_id": "provider_line_repair_request",
      "display_name": "Запрос провайдеру на ремонт линии",
      "required_params": [
        "localTicketNumber",
        "lineId",
        "serviceAddress",
        "problemDescription",
        "contactName",
        "contactPhone"
      ],
      "optional_params": [
        "impact",
        "preferredContactHours"
      ]
    },
    {
      "template_id": "provider_channel_outage_test",
      "display_name": "Тестовый шаблон: пропадание канала",
      "subject_template": "Пропадание связи по каналу {{city}}",
      "required_params": [
        "city",
        "location",
        "ip_address",
        "contract",
        "service_request"
      ],
      "optional_params": []
    },
    {
      "template_id": "ad_password_reset_notification",
      "display_name": "Уведомление о смене пароля AD",
      "subject_template": "Смена пароля по заявке № {{service_request}}",
      "required_params": [
        "service_request",
        "employee_full_name",
        "password"
      ],
      "optional_params": [],
      "params": [
        {
          "name": "password",
          "type": "string",
          "required": true,
          "sensitive": true
        }
      ]
    }
  ]
}
```

Если параметр в catalog помечен `sensitive: true`, caller и UI должны считать его секретом: не писать значение в логи, comments, screenshots, callback payloads, Kafka events или долговременное хранилище.

## Repository Mode

Для текущей разработки source of truth находится в текущем GitHub repository. Для production тот же набор файлов должен жить в GitLab; n8n UI не является местом ручного редактирования шаблонов.
