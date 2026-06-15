# Wait For Email By Ticket Usage

## Purpose

Workflow `Email: ожидание письма по номеру заявки` ожидает входящее письмо, в subject или body которого есть номер заявки, например `ГКМ123456`.

Основной production режим - async: агент вызывает webhook с `invocation.extensions.async_callback`, n8n сразу возвращает `accepted`, а terminal result возвращается тому же ожидающему агенту через canonical ServiceDesk `ExternalEvent`.

Direct HTTP режим оставлен для короткого smoke/manual теста и ограничен `timeout_minutes <= 5`.

## Contract

- Collector workflow: `workflows/email-ticket-mailbox-collector.json`
- Wait workflow: `workflows/wait-for-email-ticket-webhook.json`
- Endpoint: `POST http://127.0.0.1:5678/webhook/email/wait-for-ticket`
- OpenAPI operationId: `waitForEmailByTicket`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`

Request fields:

```json
{
  "ticket_number": "ГКМ123456",
  "poll_interval_minutes": 15,
  "timeout_minutes": 60
}
```

Accepted aliases: `ticketNumber`, `pollIntervalMinutes`, `timeoutMinutes`.

Async request:

```json
{
  "ticket_number": "ГКМ123456",
  "poll_interval_minutes": 15,
  "timeout_minutes": 60,
  "invocation": {
    "invocation_id": "cmd-123",
    "action_id": "wait_for_email_by_ticket",
    "extensions": {
      "async_callback": {
        "source": "n8n",
        "case_id": "case-000000000001",
        "wait_id": "wait-000000000001",
        "correlation_id": "case-000000000001:tool_command:cmd-123",
        "event_type": "wait_for_email_by_ticket_completed",
        "idempotency_key_base": "case-000000000001:tool_command:cmd-123",
        "result_transport": "kafka_event",
        "result_topic": "external.events"
      }
    }
  }
}
```

## Result Statuses

- `OK` - найдено ровно одно письмо.
- `MULTI_MAIL` - найдено несколько писем; в ответе возвращается первое по `received_at`, плюс `match_count`.
- `DELIVERY_FAILED` - best-effort найдено bounce/NDR/undelivered письмо по тому же номеру заявки.
- `NOT_FOUND` - письмо не найдено до `timeout_minutes`.

`DELIVERY_FAILED` не является строгой кросс-системной гарантией. Разные почтовые системы по-разному оформляют NDR/DSN, поэтому v1 использует эвристики по subject/body/from. Для строгой проверки нужен отдельный Exchange/Graph/SMTP DSN contract заказчика.

## Direct Response

```json
{
  "status": "OK",
  "ticket_number": "ГКМ123456",
  "subject": "Re: заявка ГКМ123456",
  "body": "Ваше обращение зарегистрировано.",
  "body_truncated": false,
  "from": "provider@example.test",
  "received_at": "2026-06-13T10:05:00.000Z",
  "message_id": "<provider-1@example.test>",
  "mailbox": "INBOX",
  "is_delivery_failure": false,
  "delivery_failure_reason": null,
  "match_count": 1,
  "delivery_failure_count": 0,
  "poll_interval_minutes": 15,
  "timeout_minutes": 60,
  "started_at": "2026-06-13T10:00:00.000Z",
  "finished_at": "2026-06-13T10:05:00.000Z"
}
```

Async `ExternalEvent.result` содержит тот же business payload.

## Transport Security

- Direct HTTP and HTTP callback URLs are selected by the administrator. Local/dev may use `http://127.0.0.1`; production should publish n8n and ServiceDesk callback URLs through HTTPS.
- `callback_url` must use `http` or `https`, must not contain user/password credentials, and when `ORCHESTRATOR_PUBLIC_URL` is configured it must have the same origin and the same or nested path.
- In production mode (`NODE_ENV`, `N8N_ENVIRONMENT` or `ENVIRONMENT` is `production`/`prod`), non-HTTPS callback URLs are rejected outside local/dev loopback or compose-host exceptions.
- Kafka result delivery is configured through Kafka credential and broker ACL. Production should use `SASL_SSL` or `SSL`/mTLS; Kafka is not an HTTPS transport.

## Search Semantics

- Поиск выполняется по индексу `n8n_mail_index`, который заполняет collector workflow.
- Окно поиска: с начала вчерашнего дня по runtime timezone до текущего момента.
- Match: exact substring `ticket_number` в subject или body.
- Очень большие body обрезаются collector-ом, в ответе будет `body_truncated: true`.

## Common Errors

- `401 unauthorized` - отсутствует или неверен `X-ServiceDesk-Token`.
- `400 missing_ticket_number` - не указан `ticket_number`.
- `400 invalid_poll_interval_minutes` - частота опроса не целое число от 1 до 60.
- `400 invalid_timeout_minutes` - timeout не целое число от 1 до 240.
- `400 direct_timeout_too_long` - direct HTTP вызов запросил timeout больше 5 минут.
- `400 missing_async_callback_fields` - в async request отсутствуют обязательные correlation поля.
- `400 missing_result_topic` - выбран `kafka_event`, но не указан `result_topic`.
- `400 missing_callback_url` - выбран `http_callback`, но не указан `callback_url`.
- `400 invalid_callback_url` - `callback_url` нарушает policy по схеме, credentials, HTTPS или `ORCHESTRATOR_PUBLIC_URL`.
