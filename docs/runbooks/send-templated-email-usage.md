# Send Templated Email Usage

## Назначение

Workflow `Email: отправка письма по шаблону` принимает HTTP-запрос от приложения, рендерит `subject` и `body` по `templateId` из repo-backed каталога и отправляет текстовое письмо через n8n `Send Email` node.

Production webhook:

```text
POST http://127.0.0.1:5678/webhook/email/send-template
```

Machine-readable contract:

```text
GET http://127.0.0.1:5678/webhook/contracts/openapi.json
GET http://127.0.0.1:5678/webhook/contracts/email-templates.json
```

OpenAPI operationId: `sendTemplatedEmail`.

## Вход

Headers:

- `Content-Type: application/json`
- `X-ServiceDesk-Token: <N8N_WEBHOOK_TOKEN>`

Body:

```json
{
  "to": ["provider@example.com"],
  "cc": ["manager@example.com"],
  "bcc": ["audit@example.com"],
  "replyTo": "support@example.com",
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
}
```

`to`, `cc` и `bcc` можно передавать строкой, строкой с разделителями `,` или `;`, либо массивом строк. `cc`, `bcc` и `replyTo` необязательны.

`params` должен содержать все поля из `required_params` выбранного шаблона. Плейсхолдеры в `subject_template` и `body_template` имеют вид `{{paramName}}`.

Runtime validation:

- required params не могут быть пустыми;
- для описанных params проверяется primitive `type`: `string`, `number` или `boolean`;
- если в catalog задан `pattern`, значение должно ему соответствовать;
- каждый параметр не может быть длиннее 2000 символов;
- control characters, `CR` и `LF` внутри параметров запрещены, чтобы параметры не могли сломать subject/header;
- rendered subject должен быть непустой одной строкой и не длиннее 500 символов;
- rendered body должен быть непустой и не длиннее 20000 символов.

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
- `400 missing_template_id` - не указан `templateId`.
- `400 missing_params` - не указан объект `params`.
- `400 unknown_template_id` - шаблон не найден в каталоге.
- `400 missing_template_params` - отсутствуют обязательные параметры шаблона.
- `400 invalid_template_param` - параметр не прошел проверку `type`, `pattern`, длины или control characters.
- `400 invalid_email` - некорректный адрес в `to`, `cc`, `bcc` или `replyTo`.
- `400 attachments_not_supported` - передан attachment.
- `400 empty_rendered_subject` - после подстановки тема пустая.
- `400 invalid_rendered_subject` - после подстановки тема содержит `CR`, `LF` или control characters.
- `400 rendered_subject_too_long` - после подстановки тема длиннее 500 символов.
- `400 empty_rendered_body` - после подстановки тело письма пустое.
- `400 rendered_body_too_long` - после подстановки тело письма длиннее 20000 символов.
- `502 email_send_failed` - SMTP node не смог отправить письмо.

## Caller Flow

1. Получите OpenAPI contract через `GET /webhook/contracts/openapi.json`.
2. Получите catalog через `GET /webhook/contracts/email-templates.json`.
3. Выберите `templateId`.
4. Заполните `params` по `required_params`.
5. Вызовите `POST /webhook/email/send-template` с `X-ServiceDesk-Token`.

Для корреляции ответов провайдера шаблон `provider_line_repair_request` требует `localTicketNumber` вида `ГКМ########` и вставляет его в тело письма.

## Тестовый шаблон пропадания канала

`provider_channel_outage_test` использует шаблонизированную тему:

```text
Пропадание связи по каналу {{city}}
```

Пример payload:

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

После рендера тема будет выглядеть как `Пропадание связи по каналу Москва`.
