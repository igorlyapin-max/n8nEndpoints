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
- OpenAPI localized descriptions: `contracts/n8n-openapi.locales.json`
- n8n contract workflow: `workflows/contracts-openapi-webhook.json`
- Contract URL: `http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Optional language selector: `http://127.0.0.1:5678/webhook/contracts/openapi.json?lang=ru`
- Язык по умолчанию: `ru`; при развертывании можно задать `N8N_OPENAPI_DEFAULT_LOCALE=ru|en`.
- Usage: `docs/runbooks/contract-discovery-usage.md`
- Deployment: `docs/runbooks/contract-discovery-deployment.md`

`lang=ru|en` changes only OpenAPI human-readable metadata and has priority over deployment default. Paths, `operationId`, payload fields, enum values, error codes and auth headers stay identical.

Transport security публикуется в OpenAPI как `x-transport-security`. HTTP URL для n8n и callback выбирает администратор через `N8N_WEBHOOK_BASE_URL` и `ORCHESTRATOR_PUBLIC_URL`; для HTTP callback вне local/dev `ORCHESTRATOR_PUBLIC_URL` обязателен. Local/dev может использовать `http://127.0.0.1`, production должен публиковаться через `https://`. Kafka не использует HTTPS: production delivery настраивается через Kafka credential/ACL с `SASL_SSL` или `SSL`/mTLS.

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

Ранбук ожидания входящего письма по номеру заявки:

- Collector workflow: `workflows/email-ticket-mailbox-collector.json`
- Webhook workflow: `workflows/wait-for-email-ticket-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/email/wait-for-ticket`
- OpenAPI operationId: `waitForEmailByTicket`
- Usage: `docs/runbooks/wait-for-email-by-ticket-usage.md`
- Deployment: `docs/runbooks/wait-for-email-by-ticket-deployment.md`

Workflow dual-use: direct HTTP режим предназначен для короткого smoke/manual wait и ограничен `timeout_minutes <= 5`; 60-минутное ожидание для агента выполняется через `invocation.extensions.async_callback` и возвращает terminal `ExternalEvent` в callback/Kafka. Поиск выполняется по Postgres индексу входящих писем за вчера и сегодня. Terminal status: `OK`, `MULTI_MAIL`, `DELIVERY_FAILED`, `NOT_FOUND`.

Ранбук получения параметров письма провайдеру из CMDBuild:

- `workflows/cmdbuild-provider-email-context-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/cmdbuild/provider-email-context`
- OpenAPI operationId: `getProviderEmailContext`
- Usage: `docs/runbooks/cmdbuild-provider-email-context-usage.md`
- Deployment: `docs/runbooks/cmdbuild-provider-email-context-deployment.md`

Workflow read-only: по `hostname` ищет активный `routerG`, где `Description == hostname`, и возвращает `city`, `location`, `ip_address`, `contract`, `provider_email` для последующей отправки письма по шаблону отдельной оберткой.

Ранбук проверки заявленного руководителя по кадровой выгрузке:

- `workflows/hr-find-manager.json`
- URL: `http://127.0.0.1:5678/webhook/hr/verify-manager`
- OpenAPI operationId: `verifyEmployeeManager`
- Usage: `docs/runbooks/hr-verify-manager-usage.md`
- Deployment: `docs/runbooks/hr-verify-manager-deployment.md`

Workflow read-only: по ФИО сотрудника и ФИО заявленного руководителя проверяет административную, управленческую или обе HR-связи. `OK` возвращается только для единственной подтвержденной пары и содержит top-level `employee_id` и `manager_id` с табельными номерами сотрудника и руководителя; при дублях, неподтвержденной связи или отсутствии любого табельного номера возвращается business `ERROR` с найденными кандидатами.

Ранбук проверки заявителя среди сотрудника и руководителя:

- `workflows/hr-applicant-participant-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/hr/verify-applicant-participant`
- OpenAPI operationId: `verifyApplicantParticipant`
- Usage: `docs/runbooks/hr-applicant-participant-usage.md`
- Deployment: `docs/runbooks/hr-applicant-participant-deployment.md`

Workflow read-only: принимает ФИО заявителя, ФИО сотрудника и ФИО руководителя, нормализует пробелы/регистр и возвращает `OK`, если заявитель совпал с сотрудником или руководителем. HR/AD не вызываются; это только проверка трех входных строк.

Ранбук поиска login и email пользователя в MS AD:

- `workflows/ad-user-login-lookup-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/ad/user/login-lookup`
- OpenAPI operationId: `lookupAdUserLogin`
- Usage: `docs/runbooks/ad-user-login-lookup-usage.md`
- Deployment: `docs/runbooks/ad-user-login-lookup-deployment.md`

Workflow read-only: по ФИО и табельному номеру ищет единственного пользователя AD через LDAP credential n8n и возвращает `login` из `sAMAccountName` и `email` из `mail` по умолчанию. Атрибуты поиска и возвращаемых login/email можно переопределить параметрами запроса; production подключение выполняется через LDAPS/TLS credential `MS AD LDAPS`.

Ранбук смены пароля пользователя в MS AD:

- `workflows/ad-password-reset-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/ad/user/reset-password`
- OpenAPI operationId: `resetAdUserPassword`
- Usage: `docs/runbooks/ad-password-reset-usage.md`
- Deployment: `docs/runbooks/ad-password-reset-deployment.md`

Workflow mutating internal-only: по `login` находит единственного пользователя AD через LDAP credential n8n, генерирует новый пароль, обновляет `unicodePwd`, ставит `pwdLastSet=0` для требования смены пароля при первом входе и возвращает пароль только доверенному internal caller-у. Прямой endpoint требует `X-ServiceDesk-Internal-Token`; внешние приложения должны вызывать composite process после approval policy. Production подключение обязательно через LDAPS/TLS credential `MS AD LDAPS`, пароль не логировать и не хранить в execution history.

Ранбук обработки заявки на смену пароля пользователя в MS AD:

- `workflows/ad-password-reset-process-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/ad/password-reset/process`
- OpenAPI operationId: `processAdPasswordResetRequest`
- Usage: `docs/runbooks/ad-password-reset-process-usage.md`
- Deployment: `docs/runbooks/ad-password-reset-process-deployment.md`

Workflow mutating: принимает номер заявки, ФИО заявителя, ФИО сотрудника, ФИО заявленного руководителя, `approval_id`, `approved_by` и `idempotency_key`; проверяет заявителя и руководителя, получает AD login/email, меняет пароль сотруднику и отправляет пароль руководителю по шаблону `ad_password_reset_notification`. Возвращает результаты всех пройденных операций без сгенерированного пароля; если письмо не отправилось после reset, возвращает `ERROR` с `password_changed: true`.

Шаблон webhook для добавления сообщения в Zabbix problem:

- `workflows/update-zabbix-problem-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/zabbix/problem/update`
- OpenAPI operationId: `updateZabbixProblem`
- Usage: `docs/runbooks/update-zabbix-problem-usage.md`
- Deployment: `docs/runbooks/update-zabbix-problem-deployment.md`

Шаблон webhook для чтения статуса Zabbix problem:

- `workflows/get-zabbix-problem-status-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/zabbix/problem/status`
- OpenAPI operationId: `getZabbixProblemStatus`
- Usage: `docs/runbooks/get-zabbix-problem-status-usage.md`
- Deployment: `docs/runbooks/get-zabbix-problem-status-deployment.md`

Ранбук ожидания восстановления Zabbix problem:

- `workflows/wait-zabbix-problem-status-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/zabbix/problem/wait`
- OpenAPI operationId: `waitZabbixProblemStatus`
- Usage: `docs/runbooks/wait-zabbix-problem-status-usage.md`
- Deployment: `docs/runbooks/wait-zabbix-problem-status-deployment.md`

Workflow async-only: принимает `problemUrl`, `poll_interval_minutes`, `timeout_minutes` и `invocation.extensions.async_callback`; до timeout опрашивает `getZabbixProblemStatus` и завершает при `ok` или `resolved`. Если timeout истек, возвращает фактическое состояние `problem` с `timed_out: true`.

Составной ранбук письма провайдеру и мониторинга ремонта канала:

- `workflows/provider-channel-repair-monitor-webhook.json`
- URL: `http://127.0.0.1:5678/webhook/provider/channel-repair/monitor`
- OpenAPI operationId: `monitorProviderChannelRepair`
- Usage: `docs/runbooks/provider-channel-repair-monitor-usage.md`
- Deployment: `docs/runbooks/provider-channel-repair-monitor-deployment.md`

Workflow async-only: по `host` получает параметры письма из CMDBuild, отправляет провайдеру шаблон `provider_channel_outage_test`, затем до `timeout_minutes` сначала проверяет Zabbix problem status, а после этого ищет письмо провайдера по `service_request` в индексе входящих писем. Terminal result возвращается через canonical `ExternalEvent` в callback/Kafka тому же ожидающему агенту.

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

Шаблон уведомления о смене пароля AD:

```json
{
  "to": ["manager@example.com"],
  "templateId": "ad_password_reset_notification",
  "params": {
    "service_request": "12345678",
    "employee_full_name": "Иванов Иван Иванович",
    "password": "<generated-password>"
  }
}
```

Параметр `password` помечен в catalog как `sensitive: true`; его нельзя логировать, сохранять в ticket/comments/screenshots или передавать вне согласованного процесса.

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

Контракт чтения статуса Zabbix problem:

- URL: `http://127.0.0.1:5678/webhook/zabbix/problem/status`
- Метод: `POST`
- Header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`
- Body: `application/json`

```json
{
  "problemUrl": "http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528"
}
```

Workflow возвращает `status: problem`, `resolved` или `ok`. `resolved` означает, что исходный event еще доступен и содержит recovery evidence. `ok` означает, что исходный event уже недоступен, но текущий trigger находится в OK state.

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
- Для production лог stdout/stderr должен уходить не только в local Docker `json-file`, но и во второй operational sink: syslog, collector/agent/sidecar, ELK/OpenSearch или платформенный log collector.
- Быстрая проверка local sink: `docker inspect servicedesk-agents-n8n --format '{{json .HostConfig.LogConfig}}'`. `{"Type":"json-file"}` допустим только для локального стенда и не закрывает production logging gate.

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

После изменения `scripts/build-zabbix-problem-status-workflow.mjs` нужно обновить workflow export:

```bash
node scripts/build-zabbix-problem-status-workflow.mjs
node scripts/build-contract-workflow.mjs
```

После изменения `scripts/build-zabbix-problem-wait-workflow.mjs` нужно обновить workflow export:

```bash
node scripts/build-zabbix-problem-wait-workflow.mjs
node scripts/build-contract-workflow.mjs
```

После изменения email wait runbook generator нужно обновить workflow exports и OpenAPI discovery:

```bash
node scripts/build-email-wait-runbook-workflows.mjs
node scripts/build-contract-workflow.mjs
```

После изменения CMDBuild provider context generator нужно обновить workflow export и OpenAPI discovery:

```bash
node scripts/build-cmdbuild-provider-context-workflow.mjs
node scripts/build-contract-workflow.mjs
```

После изменения AD password reset generator нужно обновить workflow export и OpenAPI discovery:

```bash
node scripts/build-ad-password-reset-workflow.mjs
node scripts/build-contract-workflow.mjs
```

После изменения AD password reset process generator нужно обновить workflow export и OpenAPI discovery:

```bash
node scripts/build-ad-password-reset-process-workflow.mjs
node scripts/build-contract-workflow.mjs
```

После изменения составного provider channel repair monitor generator нужно обновить workflow export и OpenAPI discovery:

```bash
node scripts/build-provider-channel-repair-monitor-workflow.mjs
node scripts/build-contract-workflow.mjs
```

Перед импортом в n8n запускайте contract/static gate:

```bash
node scripts/apply-workflow-inline-documentation.mjs --check
node scripts/test-contracts.mjs
```

Каждый n8n workflow export должен содержать top-level `description` с логикой работы и отладкой, а каждый функциональный node должен иметь Sticky Note. Для generated workflows source of truth находится в `scripts/workflow-inline-documentation.mjs`; не исправляйте generated JSON вручную.

## Правило безопасности

LLM никогда не должна вызывать n8n напрямую. Все вызовы проходят через:

```text
LangGraph -> Tool Registry -> Integration Dispatcher -> n8n_webhook adapter
```

Action tools требуют запись согласования до того, как adapter вызовет n8n.
