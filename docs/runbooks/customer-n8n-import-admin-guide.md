# Customer n8n Runbook Import Admin Guide

## Назначение

Инструкция предназначена для администратора, который переносит подготовленные runbook workflows в n8n заказчика и проверяет, что они готовы к вызову из ServiceDesk integration adapter.

Этот документ не заменяет подробные инструкции по каждому workflow. Перед импортом сверяйте его с файлами:

- `docs/runbooks/*-deployment.md`
- `docs/runbooks/*-usage.md`
- `contracts/n8n-openapi.json`
- `contracts/n8n-openapi.locales.json`
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
- `workflows/email-ticket-mailbox-collector.json`, если включается ожидание входящих писем
- `workflows/wait-for-email-ticket-webhook.json`, если включается ожидание входящих писем
- `workflows/cmdbuild-provider-email-context-webhook.json`, если включается подготовка писем провайдеру из CMDBuild
- `workflows/hr-find-manager.json`, если включается проверка заявленного руководителя по кадровой выгрузке
- `workflows/hr-applicant-participant-webhook.json`, если включается проверка заявителя среди сотрудника и руководителя
- `workflows/ad-user-login-lookup-webhook.json`, если включается поиск login/email пользователя в MS AD
- `workflows/ad-password-reset-webhook.json`, если включается смена пароля пользователя в MS AD
- `workflows/ad-password-reset-process-webhook.json`, если включается end-to-end обработка заявки на смену пароля пользователя в MS AD
- `workflows/provider-channel-repair-monitor-webhook.json`, если включается составной сценарий письма провайдеру и мониторинга ремонта
- `workflows/update-zabbix-problem-webhook.json`
- `workflows/get-zabbix-problem-status-webhook.json`
- `workflows/wait-zabbix-problem-status-webhook.json`, если включается ожидание восстановления Zabbix problem
- `workflows/stage4-runbook-webhook.json`, если включается action runbook этапа 4
- `workflows/mailtest-auto-reply.json`, только для локального или demo smoke test без mailbox заказчика
- `contracts/n8n-openapi.json`
- `contracts/n8n-openapi.locales.json`
- `contracts/n8n-workflow-catalog.json`
- `contracts/email-template-catalog.json`
- `contracts/email-template-catalog.schema.json`
- все файлы `docs/runbooks/*-usage.md` и `docs/runbooks/*-deployment.md`

Импортируйте только workflow, для которых есть usage и deployment инструкция. Черновые или legacy exports без таких документов не включайте в production до оформления контракта, реквизитов и smoke checks.

## Доступы и реквизиты до импорта

Администратору нужны:

- URL n8n UI заказчика и учетная запись с правом импортировать, редактировать credentials, активировать workflows и смотреть executions.
- Production webhook base URL n8n, доступный вызывающей системе, например `https://n8n.example.ru/webhook`.
- Internal webhook base URL n8n, доступный из самого n8n для вызова зависимых workflows, например `https://n8n.example.ru/webhook`.
- Production ServiceDesk callback URL, доступный из n8n, например `https://servicedesk.example.ru/external-events/n8n`. Local/dev может использовать `http://`, но в shared/staging/production администратор должен выбрать HTTPS endpoint.
- `ORCHESTRATOR_PUBLIC_URL` с origin/path разрешенного ServiceDesk callback endpoint. Для HTTP callback вне local/dev переменная обязательна; любой `callback_url` должен иметь тот же origin и тот же или вложенный path.
- Production runtime marker `NODE_ENV=production`, `N8N_ENVIRONMENT=production` или `ENVIRONMENT=production`, чтобы workflows отклоняли не-HTTPS callback URL вне local/dev исключений.
- Возможность задать environment variables для процесса n8n и перезапустить n8n после изменения env или webhook registrations.
- Секрет `N8N_WEBHOOK_TOKEN`. Этот же секрет вызывающая система передает в header `X-ServiceDesk-Token`.
- Для Code nodes, читающих env, значение `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, если это требуется политикой установленной версии n8n.
- SMTP relay реквизиты для email workflows: host, port, TLS/STARTTLS mode, auth type, username/password или service account, разрешенный `from` address, allowlist источника n8n на SMTP relay.
- IMAP mailbox реквизиты для workflow ожидания писем: host, port, TLS mode, username/password или service account, mailbox name, retention и правила доступа к входящим письмам.
- Postgres credential для индекса входящих писем. Таблица `n8n_mail_index` создается workflow автоматически; база должна быть доступна из n8n.
- CMDBuild REST URL, доступный из контейнера n8n, и HTTP Basic credential для read-only lookup. Для test стенда используется `Local CMDBuild Admin Test`; production credential должен быть сервисным и ограниченным по правам чтения нужных классов.
- HR OpenAPI base URL, доступный из контейнера n8n, и HTTP Header Auth credential `HR API Header Auth` для read-only кадровой выгрузки.
- MS AD LDAPS endpoint, Base DN и LDAP credential `MS AD LDAPS` для read-only поиска login по ФИО и табельному номеру.
- Для смены пароля в MS AD: прямой reset workflow internal-only, нужен `N8N_INTERNAL_RUNBOOK_TOKEN`, право service account на reset password и force change on first login, а также disposable test account для smoke. Пароль из response считается секретом и не должен попадать в логи, tickets, screenshots, callback payloads или Kafka events.
- Для end-to-end обработки заявки на смену пароля: активные dependency workflows HR applicant participant, HR manager verification, AD login lookup, AD password reset и templated email; `N8N_INTERNAL_WEBHOOK_BASE_URL` должен указывать на внутренний webhook base URL n8n; caller обязан передать `approval_id`, `approved_by`, `idempotency_key`.
- Опциональный `N8N_MAIL_FROM`. Если он не задан, email workflows используют fallback `noreply@local.dev`.
- Тестовый recipient mailbox, куда можно отправить smoke email без риска для production пользователей.
- Для Zabbix workflow: список Zabbix UI origins, API URLs из сети n8n, API tokens, права на `problem.get` и добавление сообщения через `event.acknowledge`.
- Для multi-Zabbix: JSON registry `ZABBIX_API_TOKENS_BY_ORIGIN` и, если UI origin не равен API URL из контейнера n8n, `ZABBIX_API_URLS_BY_ORIGIN`.
- Для async/action runbooks: callback URL, callback token, Kafka broker/credential, result topic, correlation/idempotency policy и список разрешенных операций.
- Для HTTP callback delivery: `INTEGRATION_CALLBACK_TOKEN` или source-specific `INTEGRATION_CALLBACK_TOKEN__<NORMALIZED_SOURCE>`.
- Для Kafka delivery: Kafka credential с `SASL_SSL` или `SSL`/mTLS, broker ACL и infrastructure control, разрешающие n8n publish только в согласованный result topic. Kafka не настраивается как HTTPS.
- Опциональный `N8N_WORKFLOW_DEBUG=Basic` для безопасных workflow diagnostics; `Verbose` только временно.
- Доступ к логам n8n через основной operational logging pipeline заказчика: stdout/stderr контейнера или сервиса и минимум один второй sink, принятый в контуре заказчика: collector, sidecar, ELK/OpenSearch, syslog или аналог. Docker `json-file` без второго sink допустим только на локальном стенде.

Секреты не хранятся в workflow JSON, contracts, docs или payload examples. Храните их в n8n credentials, environment variables или в корпоративном PAM/AAPM.

Некоторые workflow exports могут содержать локальные dev credential references по имени/id, например GreenMail или Redpanda. При импорте в контур заказчика такие ссылки нужно проверить и перепривязать на production credentials.

## Реквизиты по workflow

| Workflow export | Workflow name в n8n | Endpoint | Credentials/env |
| --- | --- | --- | --- |
| `workflows/contracts-openapi-webhook.json` | `Contracts: OpenAPI discovery` | `GET /webhook/contracts/openapi.json` | Credentials не нужны. Token не нужен. |
| `workflows/email-template-catalog-webhook.json` | `Contracts: Email template catalog` | `GET /webhook/contracts/email-templates.json` | Credentials не нужны. Token не нужен. |
| `workflows/send-email-webhook.json` | `Email: отправка письма через webhook` | `POST /webhook/email/send` | `N8N_WEBHOOK_TOKEN`; SMTP credential на node `Отправка email`; опционально `N8N_MAIL_FROM`. |
| `workflows/send-templated-email-webhook.json` | `Email: отправка письма по шаблону` | `POST /webhook/email/send-template` | `N8N_WEBHOOK_TOKEN`; SMTP credential на node `Отправка email`; `contracts/email-template-catalog.json` как source of truth. |
| `workflows/email-ticket-mailbox-collector.json` | `Email: индекс входящих писем` | IMAP trigger, без external webhook | IMAP credential на node `Получение входящего письма`; Postgres credential на node `Запись письма в индекс`. |
| `workflows/wait-for-email-ticket-webhook.json` | `Email: ожидание письма по номеру заявки` | `POST /webhook/email/wait-for-ticket` | `N8N_WEBHOOK_TOKEN`; Postgres credential на node `Поиск письма в индексе`; callback token env/Kafka credential для async delivery. |
| `workflows/cmdbuild-provider-email-context-webhook.json` | `CMDBuild: параметры письма провайдеру` | `POST /webhook/cmdbuild/provider-email-context` | `N8N_WEBHOOK_TOKEN`; `CMDBUILD_BASE_URL`; HTTP Basic credential `Local CMDBuild Admin Test` или production equivalent на CMDBuild HTTP nodes. |
| `workflows/hr-find-manager.json` | `HR: проверка заявленного руководителя` | `POST /webhook/hr/verify-manager` | `N8N_WEBHOOK_TOKEN`; `HR_API_BASE_URL`; HTTP Header Auth credential `HR API Header Auth` на HR HTTP nodes. |
| `workflows/hr-applicant-participant-webhook.json` | `HR: проверка заявителя среди участников` | `POST /webhook/hr/verify-applicant-participant` | `N8N_WEBHOOK_TOKEN`; credentials не нужны. |
| `workflows/ad-user-login-lookup-webhook.json` | `AD: поиск login и email пользователя` | `POST /webhook/ad/user/login-lookup` | `N8N_WEBHOOK_TOKEN`; `AD_BASE_DN`; LDAP credential `MS AD LDAPS` на node `LDAP поиск пользователя`; optional `AD_FULL_NAME_ATTRIBUTE`, `AD_EMPLOYEE_ID_ATTRIBUTE`, `AD_LOGIN_ATTRIBUTE`, `AD_EMAIL_ATTRIBUTE`. |
| `workflows/ad-password-reset-webhook.json` | `AD: смена пароля пользователя` | `POST /webhook/ad/user/reset-password` | Internal-only; `N8N_WEBHOOK_TOKEN`; `N8N_INTERNAL_RUNBOOK_TOKEN`; `AD_PASSWORD_RESET_BASE_DN` или `AD_BASE_DN`; LDAP credential `MS AD LDAPS` на nodes `LDAP поиск пользователя` и `LDAP смена пароля`; optional `AD_PASSWORD_RESET_LOGIN_ATTRIBUTE`/`AD_LOGIN_ATTRIBUTE`, `AD_PASSWORD_ALLOWED_CHARS`; service account rights reset password + force change on first login. |
| `workflows/ad-password-reset-process-webhook.json` | `AD: обработка заявки на смену пароля` | `POST /webhook/ad/password-reset/process` | `N8N_WEBHOOK_TOKEN`; `N8N_INTERNAL_RUNBOOK_TOKEN`; `N8N_INTERNAL_WEBHOOK_BASE_URL` или `N8N_WEBHOOK_BASE_URL`; активные dependency workflows HR/AD/email; execution data saving disabled; external approval policy required with `approval_id`, `approved_by`, `idempotency_key`. |
| `workflows/provider-channel-repair-monitor-webhook.json` | `Provider: письмо и мониторинг ремонта канала` | `POST /webhook/provider/channel-repair/monitor` | `N8N_WEBHOOK_TOKEN`; `N8N_INTERNAL_WEBHOOK_BASE_URL` или `N8N_WEBHOOK_BASE_URL`; Postgres credential на node `Поиск письма в индексе`; Kafka credential на node `Публикация ExternalEvent в Kafka`; активные CMDBuild/email-template/Zabbix/email collector dependencies. |
| `workflows/update-zabbix-problem-webhook.json` | `Zabbix: обновление problem по URL` | `POST /webhook/zabbix/problem/update` | `N8N_WEBHOOK_TOKEN`; `ZABBIX_API_TOKENS_BY_ORIGIN`; опционально `ZABBIX_API_URLS_BY_ORIGIN`; `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`. |
| `workflows/get-zabbix-problem-status-webhook.json` | `Zabbix: статус problem по URL` | `POST /webhook/zabbix/problem/status` | `N8N_WEBHOOK_TOKEN`; `ZABBIX_API_TOKENS_BY_ORIGIN`; опционально `ZABBIX_API_URLS_BY_ORIGIN`; `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`. |
| `workflows/wait-zabbix-problem-status-webhook.json` | `Zabbix: ожидание статуса problem` | `POST /webhook/zabbix/problem/wait` | `N8N_WEBHOOK_TOKEN`; `N8N_INTERNAL_WEBHOOK_BASE_URL` или `N8N_WEBHOOK_BASE_URL`; активный `Zabbix: статус problem по URL`; callback token env/Kafka credential для async delivery. |
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
N8N_WEBHOOK_BASE_URL=https://n8n.example.ru/webhook
N8N_INTERNAL_WEBHOOK_BASE_URL=https://n8n.example.ru/webhook
N8N_INTERNAL_RUNBOOK_TOKEN=<long-random-internal-token>
ORCHESTRATOR_PUBLIC_URL=https://servicedesk.example.ru/external-events/n8n
N8N_ENVIRONMENT=production
CMDBUILD_BASE_URL=https://cmdbuild.example.ru/cmdbuild
HR_API_BASE_URL=https://hr-api.example.ru
AD_BASE_DN=OU=Users,DC=example,DC=local
AD_PASSWORD_RESET_BASE_DN=OU=Users,DC=example,DC=local
AD_FULL_NAME_ATTRIBUTE=displayName
AD_EMPLOYEE_ID_ATTRIBUTE=employeeID
AD_LOGIN_ATTRIBUTE=sAMAccountName
AD_PASSWORD_RESET_LOGIN_ATTRIBUTE=sAMAccountName
AD_PASSWORD_ALLOWED_CHARS=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789
AD_EMAIL_ATTRIBUTE=mail
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
- `workflows/email-ticket-mailbox-collector.json`, если включается ожидание входящих писем
- `workflows/wait-for-email-ticket-webhook.json`, если включается ожидание входящих писем
- `workflows/cmdbuild-provider-email-context-webhook.json`, если включается подготовка писем провайдеру из CMDBuild
- `workflows/hr-find-manager.json`, если включается проверка заявленного руководителя по кадровой выгрузке
- `workflows/hr-applicant-participant-webhook.json`, если включается проверка заявителя среди сотрудника и руководителя
- `workflows/ad-user-login-lookup-webhook.json`, если включается поиск login/email пользователя в MS AD
- `workflows/ad-password-reset-webhook.json`, если включается смена пароля пользователя в MS AD
- `workflows/ad-password-reset-process-webhook.json`, если включается end-to-end обработка заявки на смену пароля пользователя в MS AD
- `workflows/provider-channel-repair-monitor-webhook.json`, если включается составной сценарий письма провайдеру и мониторинга ремонта
- `workflows/update-zabbix-problem-webhook.json`
- `workflows/get-zabbix-problem-status-webhook.json`
- `workflows/wait-zabbix-problem-status-webhook.json`, если включается ожидание восстановления Zabbix problem
- `workflows/stage4-runbook-webhook.json`, если он согласован к включению

7. В email workflows привяжите SMTP credential к node `Отправка email`.

8. Для ожидания входящих писем привяжите IMAP credential к collector node `Получение входящего письма`, Postgres credential к nodes `Запись письма в индекс` и `Поиск письма в индексе`, Kafka credential к node `Публикация ExternalEvent в Kafka`, если используется `kafka_event` или `both`.

9. Для CMDBuild lookup привяжите HTTP Basic credential к nodes `Поиск routerG`, `Чтение IpAddress`, `Чтение Room`, `Чтение Floor`, `Чтение Building`.

10. Для HR lookup привяжите HTTP Header Auth credential `HR API Header Auth` к nodes `Загрузка активных назначений`, `Загрузка административной оргструктуры`, `Загрузка управленческой оргструктуры`, `Загрузка административных подчиненных`, `Загрузка управленческих подчиненных`.

11. Для AD lookup привяжите LDAP credential `MS AD LDAPS` к node `LDAP поиск пользователя`.

12. Для AD password reset привяжите LDAP credential `MS AD LDAPS` к nodes `LDAP поиск пользователя` и `LDAP смена пароля`. Проверьте, что workflow execution data saving выключен, `N8N_INTERNAL_RUNBOOK_TOKEN` задан только внутри n8n, а service account имеет права reset password и force change on first login.

13. Для AD password reset process проверьте, что dependency workflows HR applicant participant, HR manager verification, AD login lookup, AD password reset и templated email активны, а `N8N_INTERNAL_WEBHOOK_BASE_URL` и `N8N_INTERNAL_RUNBOOK_TOKEN` доступны из n8n runtime.

14. Для составного provider monitor workflow привяжите Postgres credential к node `Поиск письма в индексе` и Kafka credential к node `Публикация ExternalEvent в Kafka`, если используется `kafka_event` или `both`. Проверьте, что dependency workflows CMDBuild/email-template/Zabbix status/email collector активны.

15. Для Zabbix wait workflow привяжите Kafka credential к node `Публикация ExternalEvent в Kafka`, если используется `kafka_event` или `both`. Проверьте, что workflow `Zabbix: статус problem по URL` активен.

16. Для stage4 Kafka delivery привяжите Kafka credential к node `Публикация ExternalEvent в Kafka`. В production credential должен указывать на broker заказчика, а не на local Redpanda, и использовать выбранный администратором режим `SASL_SSL` или `SSL`/mTLS.

17. Активируйте workflows.

18. После import/publish и после любого изменения env перезапустите n8n, если менялись webhook registrations или runtime мог остаться stale.

19. В executions убедитесь, что после активации нет ошибок credentials, disabled nodes или незаполненных параметров.

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
- `waitForEmailByTicket`, если включено ожидание входящих писем
- `getProviderEmailContext`, если включена подготовка писем провайдеру из CMDBuild
- `verifyEmployeeManager`, если включена проверка заявленного руководителя по кадровой выгрузке
- `verifyApplicantParticipant`, если включена проверка заявителя среди сотрудника и руководителя
- `lookupAdUserLogin`, если включен поиск login/email пользователя в MS AD
- `resetAdUserPassword`, если включена смена пароля пользователя в MS AD
- `processAdPasswordResetRequest`, если включена end-to-end обработка заявки на смену пароля пользователя в MS AD
- `monitorProviderChannelRepair`, если включен составной сценарий письма провайдеру и мониторинга ремонта
- `updateZabbixProblem`
- `getZabbixProblemStatus`
- `waitZabbixProblemStatus`, если включено ожидание восстановления Zabbix problem
- `startRunbook`, если включен stage4 runbook

Auth-negative smoke для каждого protected endpoint должен вернуть `401 unauthorized` без header `X-ServiceDesk-Token`:

```bash
curl -i -X POST https://n8n.example.ru/webhook/email/send \
  -H 'Content-Type: application/json' \
  -d '{"to":["smoke@example.ru"],"subject":"smoke","body":"smoke"}'
```

Повторите тот же принцип для:

- `POST /webhook/email/send-template`
- `POST /webhook/email/wait-for-ticket`, если включено ожидание входящих писем
- `POST /webhook/cmdbuild/provider-email-context`, если включена подготовка писем провайдеру из CMDBuild
- `POST /webhook/hr/verify-manager`, если включена проверка заявленного руководителя по кадровой выгрузке
- `POST /webhook/hr/verify-applicant-participant`, если включена проверка заявителя среди сотрудника и руководителя
- `POST /webhook/ad/user/login-lookup`, если включен поиск login/email пользователя в MS AD
- `POST /webhook/ad/user/reset-password`, если включена смена пароля пользователя в MS AD
- `POST /webhook/ad/password-reset/process`, если включена end-to-end обработка заявки на смену пароля пользователя в MS AD
- `POST /webhook/provider/channel-repair/monitor`, если включен составной сценарий письма провайдеру и мониторинга ремонта
- `POST /webhook/zabbix/problem/update`
- `POST /webhook/zabbix/problem/status`
- `POST /webhook/zabbix/problem/wait`, если включено ожидание восстановления Zabbix problem
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

Happy-path smoke для HR verify manager выполняйте на согласованной тестовой паре из кадровой выгрузки:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/hr/verify-manager \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"employee_full_name":"<employee full name>","claimed_manager_full_name":"<manager full name>","relation_type":"both"}' | jq .
```

Ожидаемый business response содержит `status: OK`, top-level `employee_id` и top-level `manager_id`. Если пара не подтверждена, ФИО неоднозначны или HR не вернул один из табельных номеров, endpoint возвращает HTTP `200` с `status: ERROR` и диагностикой найденных кандидатов.

Smoke для HR applicant participant не требует HR API и выполняется на synthetic ФИО:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/hr/verify-applicant-participant \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"applicant_full_name":"Иванов Иван Иванович","employee_full_name":"Иванов Иван Иванович","manager_full_name":"Петров Петр Петрович"}' | jq .
```

Ожидаемый business response содержит `status: OK` и `matched_role: employee`. Дополнительно проверьте отрицательный сценарий, где заявитель не совпадает ни с сотрудником, ни с руководителем: endpoint должен вернуть HTTP `200`, `status: ERROR`, `error_code: applicant_not_participant`.

Happy-path smoke для AD login/email lookup выполняйте на согласованной тестовой учетной записи AD:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/ad/user/login-lookup \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"<employee full name>","employee_id":"<employee tabular number>"}' | jq .
```

Ожидаемый business response содержит `status: OK`, `login` и `email`. Если dev/staging AD недоступен, проверьте auth-negative и validation-negative сценарии, а happy path зафиксируйте как отложенный до выдачи тестовой учетной записи AD.

Happy-path smoke для AD password reset выполняйте только на disposable test account, согласованном заказчиком. Не используйте реальную учетную запись сотрудника для первого теста:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/ad/user/reset-password \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H "X-ServiceDesk-Internal-Token: ${N8N_INTERNAL_RUNBOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"login":"<disposable-test-login>","password_length":12}' | jq '{status,login,password_length,change_on_first_login,matched_by}'
```

Ожидаемый business response содержит `status: OK`, `password` в raw response и `change_on_first_login: true`. Пароль из response не вставляйте в logs, tickets, screenshots, callback payloads или Kafka events. Если dev/staging AD недоступен или нет disposable account, проверьте auth-negative и validation-negative сценарии, а happy path зафиксируйте как отложенный.

Happy-path smoke для end-to-end AD password reset process выполняйте только на согласованной HR/AD/SMTP тестовой связке заявитель-сотрудник-руководитель:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/ad/password-reset/process \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "service_request":"12345678",
    "applicant_full_name":"<applicant full name>",
    "employee_full_name":"<employee full name>",
    "claimed_manager_full_name":"<manager full name>",
    "approval_id":"<approval id>",
    "approved_by":"<approver login or name>",
    "idempotency_key":"<stable retry key>"
  }' | jq .
```

Ожидаемый business response содержит `status: OK`, `password_changed: true`, `notification_sent: true`, результаты шагов HR/AD/email и не содержит поля `password`. Если письмо руководителю не отправилось после reset, endpoint возвращает `status: ERROR`, `password_changed: true`, `notification_sent: false`; это требует ручной обработки по согласованному процессу доставки пароля.

Happy-path smoke для Zabbix выполняйте только на согласованном тестовом problem URL. После вызова проверьте, что в Zabbix появилась запись с текстом из `message`; дату и время операции показывает сам Zabbix:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/zabbix/problem/update \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"problemUrl":"https://zabbix.example.ru/tr_events.php?triggerid=61119&eventid=90528","message":"n8n smoke update"}'
```

Happy-path smoke для read-only Zabbix status:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/zabbix/problem/status \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"problemUrl":"https://zabbix.example.ru/tr_events.php?triggerid=61119&eventid=90528"}'
```

Ожидаемый ответ содержит `status: problem`, `resolved` или `ok`.

Async accepted smoke для Zabbix wait выполняйте только на согласованном тестовом problem URL. Полный ok/resolved happy path зависит от изменения состояния Zabbix в пределах timeout:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/zabbix/problem/wait \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"problemUrl":"https://zabbix.example.ru/tr_events.php?triggerid=61119&eventid=90528","poll_interval_minutes":1,"timeout_minutes":1,"invocation":{"invocation_id":"cmd-zabbix-wait-123","action_id":"wait_zabbix_problem_status","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000001","wait_id":"wait-000000000001","correlation_id":"case-000000000001:tool_command:cmd-zabbix-wait-123","event_type":"wait_zabbix_problem_status_completed","idempotency_key_base":"case-000000000001:tool_command:cmd-zabbix-wait-123","result_transport":"kafka_event","result_topic":"external.events"}}}}'
```

Ожидаемый immediate response содержит `runbook_status: accepted`; terminal `ExternalEvent.result.status` должен быть `ok`, `resolved`, `problem` или `ERROR`. При timeout ожидается `status: problem` и `timed_out: true`.

Async accepted smoke для составного provider monitor выполняйте только на согласованном тестовом routerG host и Zabbix problem URL. Полный happy path дополнительно требует working SMTP/IMAP и test provider mailbox:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/provider/channel-repair/monitor \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"host":"Router for NTbook group 000 (OFF01 Office 01 - Headquarters)","problemUrl":"https://zabbix.example.ru/tr_events.php?triggerid=61119&eventid=90528","service_request":"12345678","poll_interval_minutes":1,"timeout_minutes":1,"invocation":{"invocation_id":"cmd-provider-monitor-123","action_id":"monitor_provider_channel_repair","extensions":{"async_callback":{"source":"n8n","case_id":"case-000000000001","wait_id":"wait-000000000001","correlation_id":"case-000000000001:tool_command:cmd-provider-monitor-123","event_type":"monitor_provider_channel_repair_completed","idempotency_key_base":"case-000000000001:tool_command:cmd-provider-monitor-123","result_transport":"kafka_event","result_topic":"external.events"}}}}'
```

Ожидаемый immediate response содержит `runbook_status: accepted`; terminal `ExternalEvent.result.runbook_status` должен быть одним из `RESOLVED`, `OK`, `MULTI_MAIL`, `DELIVERY_FAILED`, `NOT_FOUND`, `ERROR`.

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
- У вызывающей системы настроен production HTTPS URL для n8n и, если используется HTTP callback, production HTTPS `ORCHESTRATOR_PUBLIC_URL`; Kafka delivery настроен через Kafka TLS/SASL/mTLS credential, не через HTTP/HTTPS.
- Callback smoke с `callback_url`, содержащим userinfo credentials или выходящим за `ORCHESTRATOR_PUBLIC_URL`, возвращает `400 invalid_callback_url`.
- Логи n8n уходят в stdout/stderr и второй production sink. Для local Docker можно проверить текущий драйвер командой `docker inspect servicedesk-agents-n8n --format '{{json .HostConfig.LogConfig}}'`; `json-file` без collector/sidecar/syslog является локальным ограничением, а не production-ready конфигурацией.

## Приемочный чеклист

- Все импортированные workflows активны.
- Discovery endpoints доступны без token и отдают актуальные contracts.
- Protected endpoints без token возвращают `401`.
- Protected endpoints с корректным token проходят smoke.
- Email smoke подтвержден фактической доставкой в тестовый mailbox.
- Templated email smoke подтверждает, что template catalog совпадает с поставленным `contracts/email-template-catalog.json`.
- Если включен template `ad_password_reset_notification`, workflow `Email: отправка письма по шаблону` не сохраняет success/error/manual execution data, а параметр `password` не попадает в logs/tickets/screenshots/callback/Kafka.
- HR applicant participant smoke возвращает `matched_role` для заявителя-сотрудника или заявителя-руководителя и `applicant_not_participant` для отрицательного сценария.
- AD smoke возвращает `status: OK`, `login` и `email` на согласованной тестовой учетной записи или явно отложен до предоставления dev/staging AD.
- AD password reset smoke возвращает `status: OK`, `password` и `change_on_first_login: true` на disposable test account или явно отложен; execution data saving для workflow проверен, а пароль не попал в logs/tickets/screenshots/callback/Kafka.
- AD password reset process smoke возвращает `status: OK`, `password_changed: true`, `notification_sent: true`, не содержит `password` в response и подтверждает доставку письма руководителю; если happy path отложен, auth/validation smoke выполнены, а dependency readiness зафиксирована.
- Provider monitor smoke подтверждает `accepted` и доставку terminal `ExternalEvent`, если включен составной сценарий.
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
