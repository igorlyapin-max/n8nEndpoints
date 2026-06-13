# Customer n8n Runbook Import Admin Guide

## Назначение

Инструкция предназначена для администратора, который переносит подготовленные runbook workflows в n8n заказчика и проверяет, что они готовы к вызову из ServiceDesk integration adapter.

Этот документ не заменяет подробные инструкции по каждому workflow. Перед импортом сверяйте его с файлами:

- `docs/runbooks/*-deployment.md`
- `docs/runbooks/*-usage.md`
- `contracts/n8n-openapi.json`
- `contracts/n8n-workflow-catalog.json`
- `contracts/email-template-catalog.json`
- `workflows/*.json`

В production источником поставки должен быть GitLab artifact или release package. n8n UI не должен становиться ручным хранилищем бизнес-шаблонов, контрактов или исправлений.

## Что передать администратору

Минимальный комплект поставки:

- `workflows/contracts-openapi-webhook.json`
- `workflows/email-template-catalog-webhook.json`
- `workflows/send-email-webhook.json`
- `workflows/send-templated-email-webhook.json`
- `workflows/update-zabbix-problem-webhook.json`
- `workflows/stage4-runbook-webhook.json`, если включается action runbook этапа 4
- `workflows/mailtest-auto-reply.json`, только для локального или demo smoke test без mailbox заказчика
- `contracts/n8n-openapi.json`
- `contracts/n8n-workflow-catalog.json`
- `contracts/email-template-catalog.json`
- `contracts/email-template-catalog.schema.json`
- все файлы `docs/runbooks/*-usage.md` и `docs/runbooks/*-deployment.md`

Импортируйте только workflow, для которых есть usage и deployment инструкция. Черновые или legacy exports без таких документов не включайте в production до оформления контракта, реквизитов и smoke checks.

## Доступы и реквизиты до импорта

Администратору нужны:

- URL n8n UI заказчика и учетная запись с правом импортировать, редактировать credentials, активировать workflows и смотреть executions.
- Production webhook base URL n8n, доступный вызывающей системе, например `https://n8n.example.ru/webhook`.
- Возможность задать environment variables для процесса n8n и перезапустить n8n после изменения env или webhook registrations.
- Секрет `N8N_WEBHOOK_TOKEN`. Этот же секрет вызывающая система передает в header `X-ServiceDesk-Token`.
- Для Code nodes, читающих env, значение `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, если это требуется политикой установленной версии n8n.
- SMTP relay реквизиты для email workflows: host, port, TLS/STARTTLS mode, auth type, username/password или service account, разрешенный `from` address, allowlist источника n8n на SMTP relay.
- Опциональный `N8N_MAIL_FROM`. Если он не задан, email workflows используют fallback `noreply@local.dev`.
- Тестовый recipient mailbox, куда можно отправить smoke email без риска для production пользователей.
- Для Zabbix workflow: список Zabbix UI origins, API URLs из сети n8n, API tokens, права на `problem.get` и добавление сообщения через `event.acknowledge`.
- Для multi-Zabbix: JSON registry `ZABBIX_API_TOKENS_BY_ORIGIN` и, если UI origin не равен API URL из контейнера n8n, `ZABBIX_API_URLS_BY_ORIGIN`.
- Для async/action runbooks: callback URL, callback token, Kafka broker/credential, result topic, correlation/idempotency policy и список разрешенных операций.
- Для HTTP callback delivery: `INTEGRATION_CALLBACK_TOKEN` или source-specific `INTEGRATION_CALLBACK_TOKEN__<NORMALIZED_SOURCE>`.
- Для Kafka delivery: broker ACL/SASL/mTLS или иной infrastructure control, разрешающий n8n publish только в согласованный result topic.
- Опциональный `N8N_WORKFLOW_DEBUG=Basic` для безопасных workflow diagnostics; `Verbose` только временно.
- Доступ к логам n8n через основной operational logging pipeline заказчика: stdout/stderr контейнера или сервиса и принятый в контуре collector, sidecar, ELK/OpenSearch, syslog или аналог.

Секреты не хранятся в workflow JSON, contracts, docs или payload examples. Храните их в n8n credentials, environment variables или в корпоративном PAM/AAPM.

## Реквизиты по workflow

| Workflow export | Workflow name в n8n | Endpoint | Credentials/env |
| --- | --- | --- | --- |
| `workflows/contracts-openapi-webhook.json` | `Contracts: OpenAPI discovery` | `GET /webhook/contracts/openapi.json` | Credentials не нужны. Token не нужен. |
| `workflows/email-template-catalog-webhook.json` | `Contracts: Email template catalog` | `GET /webhook/contracts/email-templates.json` | Credentials не нужны. Token не нужен. |
| `workflows/send-email-webhook.json` | `Email: отправка письма через webhook` | `POST /webhook/email/send` | `N8N_WEBHOOK_TOKEN`; SMTP credential на node `Отправка email`; опционально `N8N_MAIL_FROM`. |
| `workflows/send-templated-email-webhook.json` | `Email: отправка письма по шаблону` | `POST /webhook/email/send-template` | `N8N_WEBHOOK_TOKEN`; SMTP credential на node `Отправка email`; `contracts/email-template-catalog.json` как source of truth. |
| `workflows/update-zabbix-problem-webhook.json` | `Zabbix: обновление problem по URL` | `POST /webhook/zabbix/problem/update` | `N8N_WEBHOOK_TOKEN`; `ZABBIX_API_TOKENS_BY_ORIGIN`; опционально `ZABBIX_API_URLS_BY_ORIGIN`; `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`. |
| `workflows/stage4-runbook-webhook.json` | `Webhook ранбука этапа 4` | `POST /webhook/servicedesk/runbook/start` | `N8N_WEBHOOK_TOKEN`; `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`; callback token env для `http_callback`; Kafka credential `Local Redpanda Kafka` или production equivalent для `kafka_event`; перед вызовом требуется approval policy на стороне ServiceDesk. |
| `workflows/mailtest-auto-reply.json` | `Mailtest: IMAP автоответ` | IMAP trigger, без external webhook | Только для test/demo: IMAP credential на node `Получение письма`; SMTP credential на node `Отправка автоответа`. |

## Порядок импорта

1. Проверьте, что n8n запущен и отвечает:

```bash
curl -fsS https://n8n.example.ru/healthz
```

2. Настройте env процесса n8n до импорта protected workflows:

```text
N8N_WEBHOOK_TOKEN=<generated-secret>
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
N8N_WORKFLOW_DEBUG=off
N8N_MAIL_FROM=<approved-from-address>
INTEGRATION_CALLBACK_TOKEN=<callback-secret>
ZABBIX_API_TOKENS_BY_ORIGIN={"https://zabbix.example.ru":"<zabbix-api-token>"}
ZABBIX_API_URLS_BY_ORIGIN={"https://zabbix.example.ru":"https://zabbix-api.example.ru/api_jsonrpc.php"}
```

3. Перезапустите n8n после изменения env.

4. В n8n UI импортируйте discovery workflows:

- `workflows/contracts-openapi-webhook.json`
- `workflows/email-template-catalog-webhook.json`

5. Активируйте discovery workflows и проверьте, что endpoints отдают контракты.

6. Импортируйте action workflows, которые входят в поставку:

- `workflows/send-email-webhook.json`
- `workflows/send-templated-email-webhook.json`
- `workflows/update-zabbix-problem-webhook.json`
- `workflows/stage4-runbook-webhook.json`, если он согласован к включению

7. В email workflows привяжите SMTP credential к node `Отправка email`.

8. Для stage4 Kafka delivery привяжите Kafka credential к node `Публикация ExternalEvent в Kafka`. В production credential должен указывать на broker заказчика, а не на local Redpanda.

9. Активируйте workflows.

10. После import/publish и после любого изменения env перезапустите n8n, если менялись webhook registrations или runtime мог остаться stale.

11. В executions убедитесь, что после активации нет ошибок credentials, disabled nodes или незаполненных параметров.

## Проверки после импорта

Базовые проверки:

```bash
curl -fsS https://n8n.example.ru/healthz
curl -fsS https://n8n.example.ru/webhook/contracts/openapi.json | jq '.openapi,.paths'
curl -fsS https://n8n.example.ru/webhook/contracts/email-templates.json | jq '.schema_version,.templates[].template_id'
```

Проверьте, что live OpenAPI содержит импортированные operationId:

- `getN8nOpenApiContract`
- `getEmailTemplateCatalog`
- `sendEmail`
- `sendTemplatedEmail`
- `updateZabbixProblem`
- `startRunbook`, если включен stage4 runbook

Auth-negative smoke для каждого protected endpoint должен вернуть `401 unauthorized` без header `X-ServiceDesk-Token`:

```bash
curl -i -X POST https://n8n.example.ru/webhook/email/send \
  -H 'Content-Type: application/json' \
  -d '{"to":["smoke@example.ru"],"subject":"smoke","body":"smoke"}'
```

Повторите тот же принцип для:

- `POST /webhook/email/send-template`
- `POST /webhook/zabbix/problem/update`
- `POST /webhook/servicedesk/runbook/start`, если stage4 включен

Happy-path smoke для direct email:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/email/send \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"to":["test-recipient@example.ru"],"subject":"n8n direct email smoke","body":"Проверка отправки через n8n."}'
```

Happy-path smoke для templated email:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/email/send-template \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "to":["test-recipient@example.ru"],
    "templateId":"provider_channel_outage_test",
    "params":{
      "city":"Москва",
      "location":"Москва, ул. Тестовая, д. 1",
      "ip_address":"192.0.2.10",
      "contract":"CNT-100500",
      "service_request":"12345678"
    }
  }'
```

Happy-path smoke для Zabbix выполняйте только на согласованном тестовом problem URL. После вызова проверьте, что в Zabbix появилась запись с текстом из `message`; дату и время операции показывает сам Zabbix:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/zabbix/problem/update \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"problemUrl":"https://zabbix.example.ru/tr_events.php?triggerid=61119&eventid=90528","message":"n8n smoke update"}'
```

Smoke для stage4 runbook:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/servicedesk/runbook/start \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"invocation":{"invocation_id":"smoke-stage4","action_id":"start_systemcenter_runbook"},"parameters":{"source":"smoke"}}'
```

Kafka stage4 smoke:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/servicedesk/runbook/start \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"invocation":{"invocation_id":"cmd-123","action_id":"start_systemcenter_runbook","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000001","ticket_id":"ticket-000000000001","run_id":"run-000000000001","wait_id":"wait-000000000001","correlation_id":"case-000000000001:tool_command:cmd-123","event_type":"start_systemcenter_runbook_completed","idempotency_key_base":"case-000000000001:tool_command:cmd-123","result_transport":"kafka_event","result_topic":"external.events"}}},"parameters":{"source":"smoke","channelName":"provider-link-1"}}'
```

После вызова проверьте, что в result topic появилось canonical `ExternalEvent` с тем же `case_id`, `wait_id`, `correlation_id` и `idempotency_key`.

Для каждого smoke проверьте:

- HTTP status соответствует deployment doc.
- Response shape совпадает с `contracts/n8n-openapi.json`.
- В n8n executions нет ошибок node credentials, SMTP, Zabbix API или Code node env access.
- В логах нет webhook token, SMTP password, Zabbix token, полного тела письма и других чувствительных данных.
- У вызывающей системы настроен тот же webhook base URL и тот же `N8N_WEBHOOK_TOKEN`.

## Приемочный чеклист

- Все импортированные workflows активны.
- Discovery endpoints доступны без token и отдают актуальные contracts.
- Protected endpoints без token возвращают `401`.
- Protected endpoints с корректным token проходят smoke.
- Email smoke подтвержден фактической доставкой в тестовый mailbox.
- Templated email smoke подтверждает, что template catalog совпадает с поставленным `contracts/email-template-catalog.json`.
- Zabbix smoke выполнен на тестовом problem или явно отложен до предоставления тестового eventid.
- n8n executions не содержат ошибок после smoke.
- Администратор подтвердил, что secrets находятся в env/credentials/PAM, а не в workflow JSON.
- После import/publish и изменения env выполнен restart n8n, если это требовалось для обновления webhook registrations или runtime мог остаться stale.
- ServiceDesk integration dispatcher переключается на n8n только после успешных smoke checks.

## Rollback

Если import или smoke не прошел:

1. Деактивируйте проблемный workflow в n8n UI.
2. Верните предыдущий workflow export из последнего принятого GitLab artifact.
3. Перезапустите n8n, если менялись webhook registrations или env.
4. Повторите discovery и auth-negative smoke.
5. Если webhook token мог попасть в логи, payload или screenshots, ротируйте `N8N_WEBHOOK_TOKEN` и обновите caller configuration.

Уже отправленные email и уже добавленные сообщения в Zabbix не откатываются деактивацией workflow. Для таких действий нужен отдельный бизнес-процесс исправления в системе-получателе.
