const REQUIRED_STICKY_SECTIONS = ['Делает:', 'Опирается на:', 'Ошибки/ветки:'];

const WORKFLOW_DOCUMENTATION = {
  contractsOpenApi: {
    description: [
      'Логика работы: публикует machine-readable OpenAPI contract для всех внешне вызываемых n8n endpoints этого проекта.',
      'Workflow принимает GET /webhook/contracts/openapi.json, применяет optional lang=en|ru к человекочитаемым метаданным и возвращает контракт без авторизации; язык по умолчанию ru можно переопределить через N8N_OPENAPI_DEFAULT_LOCALE.',
      'Отладка: после изменения contracts/n8n-openapi.json или contracts/n8n-openapi.locales.json выполнить node scripts/build-contract-workflow.mjs, затем node scripts/build-contract-workflow.mjs --check и curl /webhook/contracts/openapi.json.',
    ],
    nodes: {
      'Webhook контракта OpenAPI': {
        does: 'Принимает GET-запрос discovery endpoint /webhook/contracts/openapi.json с optional query lang=en|ru; без lang используется ru или N8N_OPENAPI_DEFAULT_LOCALE.',
        reliesOn: 'n8n production webhook registration и активный workflow Contracts: OpenAPI discovery.',
        errors: 'До импорта или activation production webhook вернет 404; неподдерживаемый lang вернет 400; некорректный N8N_OPENAPI_DEFAULT_LOCALE вернет 500; endpoint не требует X-ServiceDesk-Token.',
      },
      'Подготовка OpenAPI контракта': {
        does: 'Возвращает OpenAPI JSON, встроенный generator script из contracts/n8n-openapi.json и locale overlays.',
        reliesOn: 'Source of truth contracts/n8n-openapi.json, contracts/n8n-openapi.locales.json и актуальный запуск scripts/build-contract-workflow.mjs.',
        errors: 'Drift между contract/locale files и workflow export ловится node scripts/build-contract-workflow.mjs --check; неизвестный lang возвращает unsupported_locale, некорректный язык развертывания по умолчанию возвращает invalid_default_locale.',
      },
      'Ответ OpenAPI контракта': {
        does: 'Отдает caller JSON response со statusCode из предыдущего Code node.',
        reliesOn: 'Поле response/statusCode, сформированное узлом подготовки контракта.',
        errors: 'Некорректная response shape проявится как неверный JSON discovery endpoint.',
      },
    },
  },
  emailTemplateCatalog: {
    description: [
      'Логика работы: публикует repo-backed каталог email-шаблонов для внешних приложений.',
      'Workflow принимает GET /webhook/contracts/email-templates.json и возвращает contracts/email-template-catalog.json без авторизации.',
      'Отладка: после изменения каталога выполнить node scripts/build-email-template-workflows.mjs, затем --check и сравнить live endpoint с contracts/email-template-catalog.json.',
    ],
    nodes: {
      'Webhook каталога email-шаблонов': {
        does: 'Принимает GET-запрос discovery endpoint /webhook/contracts/email-templates.json.',
        reliesOn: 'Активный n8n workflow и production webhook registration.',
        errors: 'До импорта или activation endpoint вернет 404; авторизация не требуется.',
      },
      'Подготовка каталога email-шаблонов': {
        does: 'Возвращает статический email template catalog, встроенный из contracts/email-template-catalog.json.',
        reliesOn: 'Source of truth contracts/email-template-catalog.json и generator scripts/build-email-template-workflows.mjs.',
        errors: 'Catalog schema/drift ловятся build-email-template-workflows.mjs --check и scripts/test-contracts.mjs.',
      },
      'Ответ каталога email-шаблонов': {
        does: 'Отдает caller JSON response со statusCode из Code node.',
        reliesOn: 'Поле response/statusCode из узла подготовки каталога.',
        errors: 'Неверная response shape ломает discovery для send-templated-email callers.',
      },
    },
  },
  getZabbixProblemStatus: {
    description: [
      'Логика работы: read-only определяет статус Zabbix problem по UI URL и возвращает problem, resolved или ok.',
      'Workflow валидирует X-ServiceDesk-Token, парсит eventid/triggerid, читает event.get, а если event недоступен, делает trigger.get fallback.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic, проверить ZABBIX_API_TOKENS_BY_ORIGIN/ZABBIX_API_URLS_BY_ORIGIN, затем выполнить auth-negative, invalid-url и happy-path smoke из deployment doc.',
    ],
    nodes: {
      'Webhook статуса Zabbix problem': {
        does: 'Принимает POST /webhook/zabbix/problem/status с problemUrl или problem_url.',
        reliesOn: 'Header X-ServiceDesk-Token и production webhook registration.',
        errors: 'Без token workflow возвращает 401; malformed body обрабатывается Code node.',
      },
      'Получение статуса Zabbix problem': {
        does: 'Валидирует token и URL, ищет Zabbix registry по origin, вызывает event.get и при необходимости trigger.get.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, N8N_BLOCK_ENV_ACCESS_IN_NODE=false, ZABBIX_API_TOKENS_BY_ORIGIN, optional ZABBIX_API_URLS_BY_ORIGIN и this.helpers.httpRequest.',
        errors: 'Возвращает 400 для URL/registry/origin ошибок, 409 для trigger mismatch, 404 если trigger не найден, 502 для Zabbix RPC failures.',
      },
      'Нормализованный ответ': {
        does: 'Возвращает JSON status problem/resolved/ok или structured error.',
        reliesOn: 'statusCode и response, сформированные Code node.',
        errors: 'Если response shape нарушена, caller получит некорректный контрактный ответ.',
      },
    },
  },
  waitZabbixProblemStatus: {
    description: [
      'Логика работы: асинхронно ожидает, пока Zabbix problem по UI URL перейдет в ok или resolved, либо пока истечет timeout.',
      'Workflow валидирует token и async_callback, сразу возвращает accepted, затем в цикле вызывает internal getZabbixProblemStatus endpoint и доставляет terminal ExternalEvent.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic, проверить активный workflow getZabbixProblemStatus, Zabbix registry env, Kafka/callback delivery и выполнить auth-negative, validation-negative, short-timeout smoke.',
    ],
    nodes: {
      'Webhook ожидания Zabbix problem': {
        does: 'Принимает POST /webhook/zabbix/problem/wait с problemUrl, poll_interval_minutes, timeout_minutes и async_callback.',
        reliesOn: 'Production webhook registration и caller, который передает X-ServiceDesk-Token.',
        errors: 'До activation endpoint вернет 404; malformed body валидирует следующий Code node.',
      },
      'Подготовка запроса ожидания Zabbix': {
        does: 'Валидирует auth, problemUrl, polling/timeout, async_callback, result_transport и internal webhook base URL.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, optional N8N_INTERNAL_WEBHOOK_BASE_URL/N8N_WEBHOOK_BASE_URL и ServiceDesk async callback contract.',
        errors: 'Возвращает 400/401/500 для missing problemUrl, invalid poll/timeout, missing callback/topic или invalid internal URL.',
      },
      'Запрос валиден?': {
        does: 'Маршрутизирует валидный async request в accepted response или возвращает validation/auth error.',
        reliesOn: 'Boolean valid из узла подготовки запроса.',
        errors: 'False branch завершает HTTP request structured error без запуска polling.',
      },
      'Ответ ошибки валидации': {
        does: 'Возвращает caller-у validation/auth error.',
        reliesOn: 'statusCode/response из узла подготовки запроса.',
        errors: 'Неверная response shape нарушит OpenAPI error contract.',
      },
      'Ответ accepted': {
        does: 'Сразу отвечает caller-у accepted и освобождает HTTP request.',
        reliesOn: 'Accepted response с correlation_id, wait_id и result_transport из async_callback.',
        errors: 'После этого terminal result доставляется только через callback/Kafka.',
      },
      'Проверка статуса Zabbix': {
        does: 'Вызывает internal Zabbix problem status endpoint и определяет terminal или wait состояние.',
        reliesOn: 'Активный workflow getZabbixProblemStatus, N8N_WEBHOOK_TOKEN, Zabbix registry env и problemUrl из запроса.',
        errors: 'Zabbix status failure или неожиданный status превращается в terminal ERROR ExternalEvent.',
      },
      'Zabbix ожидание завершено?': {
        does: 'Разделяет terminal result ok/resolved/problem-timeout/ERROR и повторный polling.',
        reliesOn: 'Boolean terminal из узла проверки статуса Zabbix.',
        errors: 'False branch уходит в Wait loop; true branch доставляет ExternalEvent.',
      },
      'Ожидание следующего опроса': {
        does: 'Приостанавливает execution до следующего опроса Zabbix.',
        reliesOn: 'next_wait_at ISO timestamp из узла проверки статуса Zabbix; next_wait_seconds остается диагностическим полем.',
        errors: 'Если n8n wait/resume runtime некорректен, long-running execution может не продолжиться.',
      },
      'Доставка async результата': {
        does: 'Формирует canonical ExternalEvent, при необходимости отправляет HTTP callback и заполняет delivery_status.',
        reliesOn: 'async_callback, INTEGRATION_CALLBACK_TOKEN env и this.helpers.httpRequest для callback.',
        errors: 'Для result_transport=both callback failure не блокирует Kafka publish; для чистого http_callback missing_callback_token/callback_delivery_failed приводят к failed execution.',
      },
      'Нужна Kafka delivery?': {
        does: 'Проверяет, нужен ли publish ExternalEvent в Kafka.',
        reliesOn: 'shouldPublishKafka из узла доставки async результата.',
        errors: 'False branch завершает workflow после HTTP callback или no-Kafka delivery.',
      },
      'Публикация ExternalEvent в Kafka': {
        does: 'Публикует canonical ExternalEvent в result_topic с correlation headers.',
        reliesOn: 'Kafka credential Local Redpanda Kafka и result_topic из async_callback.',
        errors: 'Kafka broker/credential/topic ошибки приведут к failed execution и отсутствию Kafka event.',
      },
      'Завершение async ветки': {
        does: 'Завершает execution после успешной callback/Kafka delivery.',
        reliesOn: 'Успешную доставку ExternalEvent или отсутствие выбранной Kafka ветки.',
        errors: 'Не выполняется при failed callback или Kafka publish.',
      },
    },
  },
  updateZabbixProblem: {
    description: [
      'Логика работы: добавляет message в Zabbix problem event по UI URL без собственного timestamp.',
      'Workflow валидирует X-ServiceDesk-Token, парсит eventid/triggerid, проверяет problem.get и выполняет event.acknowledge action=4.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic, проверить Zabbix registry env, выполнить auth-negative/invalid-url smoke; happy path мутирует Zabbix history.',
    ],
    nodes: {
      'Webhook обновления Zabbix problem': {
        does: 'Принимает POST /webhook/zabbix/problem/update с problemUrl/problem_url и message.',
        reliesOn: 'Header X-ServiceDesk-Token и production webhook registration.',
        errors: 'Без token workflow возвращает 401; отсутствие URL/message обрабатывает Code node.',
      },
      'Обновление Zabbix problem': {
        does: 'Валидирует вход, ищет Zabbix token по origin, проверяет problem.get и добавляет message через event.acknowledge.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, env access, ZABBIX_API_TOKENS_BY_ORIGIN, optional ZABBIX_API_URLS_BY_ORIGIN и this.helpers.httpRequest.',
        errors: '400 для validation/registry/origin, 404 problem not found, 409 trigger mismatch, 502 для problem.get или event.acknowledge failures.',
      },
      'Нормализованный ответ': {
        does: 'Возвращает JSON результата update или structured error caller-у.',
        reliesOn: 'statusCode и response из Code node.',
        errors: 'Неверная response shape нарушает OpenAPI contract updateZabbixProblem.',
      },
    },
  },
  sendTemplatedEmail: {
    description: [
      'Логика работы: рендерит subject/body из repo-backed email template catalog и отправляет письмо через SMTP credential n8n.',
      'Workflow валидирует token, recipients, templateId, params, type/pattern/length/CRLF, затем отправляет через Email Send node.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic, проверить SMTP credential GreenMail/production, выполнить invalid-param smoke и проверить доставку в mailbox.',
    ],
    nodes: {
      'Webhook отправки письма по шаблону': {
        does: 'Принимает POST /webhook/email/send-template с recipients, templateId и params.',
        reliesOn: 'Header X-ServiceDesk-Token и production webhook registration.',
        errors: 'Без token возвращается 401; формат body валидирует следующий Code node.',
      },
      'Подготовка шаблонного письма': {
        does: 'Проверяет auth, recipients, template params, рендерит subject и text body.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, встроенный catalog из contracts/email-template-catalog.json и validation rules каталога.',
        errors: '400 для missing/invalid params, unsupported attachments, invalid email, CRLF/control chars, too long rendered subject/body.',
      },
      'Запрос валиден?': {
        does: 'Маршрутизирует валидный запрос в Email Send node, а ошибку сразу в error response.',
        reliesOn: 'Boolean shouldSend из узла подготовки письма.',
        errors: 'Если shouldSend=false, письмо не отправляется и caller получает structured validation error.',
      },
      'Отправка email': {
        does: 'Отправляет text email через SMTP credential, включая optional cc/bcc/replyTo.',
        reliesOn: 'SMTP credential, N8N_MAIL_FROM или fallback noreply@local.dev, toEmail/subject/body из Code node.',
        errors: 'SMTP failure не бросает workflow благодаря continueOnFail и обрабатывается узлом результата отправки.',
      },
      'Результат отправки': {
        does: 'Нормализует результат Email Send node в status sent или email_send_failed.',
        reliesOn: 'Output/error поля Email Send node.',
        errors: 'Возвращает 502 email_send_failed без раскрытия секретов SMTP.',
      },
      'Ответ отправки': {
        does: 'Возвращает successful JSON response caller-у.',
        reliesOn: 'statusCode/response из узла результата отправки.',
        errors: 'Неверная response shape нарушит OpenAPI contract sendTemplatedEmail.',
      },
      'Ответ ошибки': {
        does: 'Возвращает validation/auth error без вызова SMTP.',
        reliesOn: 'statusCode/response из узла подготовки шаблонного письма.',
        errors: 'Используется для 400/401 ошибок до Email Send node.',
      },
    },
  },
  A6GKOMxwTBH5Q4kg: {
    description: [
      'Логика работы: принимает approved ServiceDesk stage4 runbook command и возвращает accepted response; async mode доставляет canonical ExternalEvent.',
      'Workflow валидирует token/action, опционально отправляет HTTP callback и/или публикует ExternalEvent в Kafka external.events.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic, проверить Kafka credential Local Redpanda Kafka и callback token env, выполнить direct, validation-negative и kafka smoke.',
    ],
    nodes: {
      'Webhook ранбука': {
        does: 'Принимает POST /webhook/servicedesk/runbook/start с invocation и parameters.',
        reliesOn: 'Header X-ServiceDesk-Token и production webhook registration.',
        errors: 'Без token возвращается 401; отсутствие invocation.action_id обрабатывается Code node.',
      },
      'Подготовка ответа и ExternalEvent': {
        does: 'Валидирует request, строит accepted response, canonical ExternalEvent и delivery_status для async_callback.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, optional INTEGRATION_CALLBACK_TOKEN, async_callback fields и this.helpers.httpRequest для HTTP callback.',
        errors: '400 для missing async fields/transport URL/topic; для result_transport=both callback failure не блокирует Kafka publish, для чистого http_callback возвращает delivery failure.',
      },
      'Нужна Kafka delivery?': {
        does: 'Разделяет поток: Kafka publish нужен для result_transport kafka_event или both.',
        reliesOn: 'Boolean shouldPublishKafka из Code node.',
        errors: 'False branch сразу возвращает response; true branch требует Kafka credential.',
      },
      'Публикация ExternalEvent в Kafka': {
        does: 'Публикует canonical ExternalEvent в result_topic с key=case_id и headers correlation/idempotency.',
        reliesOn: 'Kafka credential Local Redpanda Kafka, kafkaTopic, externalEvent и kafkaHeaders из Code node.',
        errors: 'Kafka broker/credential/topic ошибки приведут к failed execution и отсутствию delivery.',
      },
      'Ответ после Kafka delivery': {
        does: 'Формирует normalized success response после успешной Kafka публикации.',
        reliesOn: 'Успешное завершение Kafka node.',
        errors: 'Не выполняется, если Kafka publish failed.',
      },
      'Нормализованный ответ': {
        does: 'Возвращает HTTP response caller-у для direct или async workflow веток.',
        reliesOn: 'statusCode/response из предыдущего Code node.',
        errors: 'Неверная response shape нарушит OpenAPI contract startRunbook.',
      },
    },
  },
  IZL94y092Lk9Yius: {
    description: [
      'Логика работы: отправляет plain text email по прямому webhook без шаблонов.',
      'Workflow валидирует token, recipients, subject/body и optional cc/bcc/replyTo, затем отправляет через SMTP credential.',
      'Отладка: проверить N8N_WEBHOOK_TOKEN, SMTP credential GreenMail/production, выполнить auth-negative и happy-path smoke, затем проверить mailbox.',
    ],
    nodes: {
      'Webhook отправки письма': {
        does: 'Принимает POST /webhook/email/send с to, subject, body и optional cc/bcc/replyTo.',
        reliesOn: 'Header X-ServiceDesk-Token и production webhook registration.',
        errors: 'Без token возвращается 401; формат body валидирует Code node.',
      },
      'Подготовка письма': {
        does: 'Валидирует auth, recipients, subject/body, attachments unsupported и подготавливает поля для Email Send node.',
        reliesOn: 'N8N_WEBHOOK_TOKEN и request body.',
        errors: '400 для missing fields, invalid email или unsupported attachments; 401 для invalid token.',
      },
      'Запрос валиден?': {
        does: 'Отправляет валидный запрос в SMTP ветку или ошибку в error response.',
        reliesOn: 'Boolean shouldSend из узла подготовки письма.',
        errors: 'False branch не вызывает SMTP и возвращает validation/auth error.',
      },
      'Отправка email': {
        does: 'Отправляет plain text email через SMTP credential.',
        reliesOn: 'SMTP credential, N8N_MAIL_FROM или fallback noreply@local.dev, prepared toEmail/subject/body.',
        errors: 'SMTP failures передаются в result node благодаря continueOnFail.',
      },
      'Результат отправки': {
        does: 'Преобразует output Email Send node в status sent или email_send_failed.',
        reliesOn: 'Output/error поля Email Send node.',
        errors: 'Возвращает 502 при SMTP failure.',
      },
      'Ответ отправки': {
        does: 'Возвращает successful JSON response caller-у.',
        reliesOn: 'statusCode/response из узла результата отправки.',
        errors: 'Неверная response shape нарушит direct email contract.',
      },
      'Ответ ошибки': {
        does: 'Возвращает validation/auth error без SMTP.',
        reliesOn: 'statusCode/response из узла подготовки письма.',
        errors: 'Используется для 400/401 ошибок до Email Send node.',
      },
    },
  },
  emailTicketMailboxCollector: {
    description: [
      'Логика работы: индексирует входящие письма из IMAP mailbox в Postgres для последующего поиска по номеру заявки.',
      'Workflow получает новые письма через IMAP trigger, нормализует subject/body/from/received_at, определяет best-effort delivery failure и делает upsert в n8n_mail_index.',
      'Отладка: проверить IMAP credential, Postgres credential Local ServiceDesk Postgres, таблицу n8n_mail_index и executions узлов подготовки/записи письма.',
    ],
    nodes: {
      'Получение входящего письма': {
        does: 'Получает новые письма из IMAP mailbox без изменения read state и передает их в индексатор.',
        reliesOn: 'IMAP credential, mailbox INBOX, customEmailConfig ["ALL"] и trackLastMessageId.',
        errors: 'IMAP credential/network/mailbox ошибки остановят trigger; конфликт с другими readers снижает полноту индекса.',
      },
      'Подготовка индекса письма': {
        does: 'Нормализует поля письма, ограничивает body, определяет delivery failure и строит SQL upsert.',
        reliesOn: 'Parsed email fields from IMAP trigger и локальные правила NDR/bounce detection.',
        errors: 'Пустой message_id получает fallback id; огромный body обрезается с body_truncated=true.',
      },
      'Запись письма в индекс': {
        does: 'Создает таблицу n8n_mail_index при необходимости и записывает/обновляет письмо в Postgres.',
        reliesOn: 'Postgres credential Local ServiceDesk Postgres и доступность servicedesk-agents-postgres.',
        errors: 'Postgres credential/network/schema ошибки приводят к failed execution и письмо не попадает в индекс.',
      },
    },
  },
  waitForEmailByTicket: {
    description: [
      'Логика работы: ожидает письмо с заданным номером заявки в indexed mailbox и возвращает OK, MULTI_MAIL, DELIVERY_FAILED или NOT_FOUND.',
      'Workflow валидирует token и параметры ожидания, опрашивает Postgres индекс за вчера/сегодня, в direct режиме возвращает terminal response, а в async режиме доставляет ExternalEvent через callback/Kafka.',
      'Отладка: проверить N8N_WEBHOOK_TOKEN, таблицу n8n_mail_index, collector executions, Postgres/Kafka credentials, direct short smoke и async ExternalEvent delivery.',
    ],
    nodes: {
      'Webhook ожидания письма': {
        does: 'Принимает POST /webhook/email/wait-for-ticket с ticket_number, poll_interval_minutes и timeout_minutes.',
        reliesOn: 'Header X-ServiceDesk-Token и production webhook registration.',
        errors: 'До activation endpoint вернет 404; без token следующий Code node возвращает 401.',
      },
      'Подготовка запроса ожидания': {
        does: 'Валидирует auth, polling/timeout, direct cap и optional async_callback.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, request body и ServiceDesk async callback contract.',
        errors: 'Возвращает 400/401 для invalid token, missing ticket, invalid interval/timeout, direct_timeout_too_long или async field errors.',
      },
      'Запрос валиден?': {
        does: 'Отправляет валидный запрос в direct/async ветку или возвращает validation error.',
        reliesOn: 'Boolean valid из узла подготовки запроса.',
        errors: 'False branch завершает workflow structured error response без Postgres query.',
      },
      'Ответ ошибки валидации': {
        does: 'Возвращает caller-у validation/auth error.',
        reliesOn: 'statusCode/response из узла подготовки запроса.',
        errors: 'Неверная response shape нарушит OpenAPI error contract.',
      },
      'Async режим?': {
        does: 'Разделяет direct wait и async wait.',
        reliesOn: 'Boolean async_delivery из узла подготовки запроса.',
        errors: 'Ошибочная классификация приведет к неправильному delivery mode.',
      },
      'Ответ accepted': {
        does: 'Сразу отвечает ServiceDesk caller-у accepted для async ожидания.',
        reliesOn: 'Accepted response, correlation_id/wait_id/result_transport из async_callback.',
        errors: 'После ответа terminal result доставляется только через callback/Kafka.',
      },
      'Подготовка SQL поиска': {
        does: 'Строит SQL для поиска ticket_number в n8n_mail_index за вчера/сегодня.',
        reliesOn: 'Validated state, window_start_at и SQL literal escaping в Code node.',
        errors: 'Некорректный SQL или отсутствующая таблица будут обработаны Postgres node; таблица создается автоматически.',
      },
      'Поиск письма в индексе': {
        does: 'Выполняет SQL поиска и возвращает count, earliest match и earliest delivery failure.',
        reliesOn: 'Postgres credential Local ServiceDesk Postgres и таблицу n8n_mail_index.',
        errors: 'Postgres failures приводят к failed execution; direct caller не получит terminal response.',
      },
      'Оценка результата поиска': {
        does: 'Определяет terminal status или время следующего опроса.',
        reliesOn: 'match_count, delivery_failure_count, deadline_at и poll_seconds из SQL result.',
        errors: 'Если deadline не достигнут и matches нет, workflow уходит в Wait loop.',
      },
      'Результат терминальный?': {
        does: 'Разделяет terminal result и повторный polling.',
        reliesOn: 'Boolean terminal из узла оценки результата.',
        errors: 'False branch продолжает ожидание до deadline.',
      },
      'Терминал async?': {
        does: 'Маршрутизирует terminal result в direct response или async delivery.',
        reliesOn: 'Boolean async_delivery из состояния workflow.',
        errors: 'Неверная ветка приведет к потере terminal result для caller-а.',
      },
      'Ответ terminal direct': {
        does: 'Возвращает OK/MULTI_MAIL/DELIVERY_FAILED/NOT_FOUND direct caller-у.',
        reliesOn: 'statusCode/response из узла оценки результата.',
        errors: 'Direct mode ограничен коротким timeout; long waits должны идти async.',
      },
      'Ожидание следующего опроса': {
        does: 'Приостанавливает execution до следующей проверки индекса.',
        reliesOn: 'next_wait_at ISO timestamp из узла оценки результата; next_wait_seconds остается диагностическим полем.',
        errors: 'Если n8n restart/queue mode некорректен, long wait может не продолжиться.',
      },
      'Доставка async результата': {
        does: 'Формирует canonical ExternalEvent, при необходимости отправляет HTTP callback и заполняет delivery_status.',
        reliesOn: 'async_callback, INTEGRATION_CALLBACK_TOKEN env и this.helpers.httpRequest для callback.',
        errors: 'Для result_transport=both callback failure не блокирует Kafka publish; для чистого http_callback missing_callback_token/callback_delivery_failed приводят к failed execution.',
      },
      'Нужна Kafka delivery?': {
        does: 'Проверяет, нужен ли publish ExternalEvent в Kafka.',
        reliesOn: 'shouldPublishKafka из узла доставки async результата.',
        errors: 'False branch завершает workflow после HTTP callback или no-Kafka delivery.',
      },
      'Публикация ExternalEvent в Kafka': {
        does: 'Публикует canonical ExternalEvent в result_topic с correlation headers.',
        reliesOn: 'Kafka credential Local Redpanda Kafka и topic из async_callback.',
        errors: 'Kafka broker/credential/topic ошибки приведут к failed execution и отсутствию event.',
      },
      'Завершение async ветки': {
        does: 'Завершает async execution после callback/Kafka delivery.',
        reliesOn: 'Успешную доставку ExternalEvent или отсутствие выбранной Kafka ветки.',
        errors: 'Не выполняется при failed callback или Kafka publish.',
      },
    },
  },
  getCmdbuildProviderEmailContext: {
    description: [
      'Логика работы: read-only получает из CMDBuild параметры для письма провайдеру по hostname routerG.',
      'Workflow валидирует token/hostname, ищет активный routerG по точному Description, читает IpAddress, Room, Floor и Building через CMDBuild REST и возвращает city/location/ip_address/contract/provider_email.',
      'Отладка: проверить N8N_WEBHOOK_TOKEN, CMDBUILD_BASE_URL, credential Local CMDBuild Admin Test, затем выполнить auth-negative, missing-hostname, missing-field и happy-path smoke.',
    ],
    nodes: {
      'Webhook контекста провайдера': {
        does: 'Принимает POST /webhook/cmdbuild/provider-email-context с hostname.',
        reliesOn: 'Header X-ServiceDesk-Token и production webhook registration.',
        errors: 'До activation endpoint вернет 404; без token следующий Code node возвращает 401.',
      },
      'Подготовка запроса CMDBuild': {
        does: 'Валидирует token/hostname, вычисляет CMDBuild base URL и строит search URL для routerG.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, optional CMDBUILD_BASE_URL и request body.',
        errors: 'Возвращает 400/401/500 для missing или invalid input/base URL до обращения к CMDBuild.',
      },
      'Запрос валиден?': {
        does: 'Маршрутизирует валидный запрос в CMDBuild lookup или сразу возвращает validation/auth error.',
        reliesOn: 'Boolean valid из узла подготовки запроса.',
        errors: 'False branch завершает workflow structured error response без CMDBuild REST calls.',
      },
      'Поиск routerG': {
        does: 'Ищет routerG cards по exact Description через CMDBuild REST.',
        reliesOn: 'HTTP Basic credential Local CMDBuild Admin Test и router_search_url.',
        errors: 'HTTP status не роняет workflow; следующий Code node нормализует auth/lookup/not found/not unique.',
      },
      'Разбор routerG': {
        does: 'Проверяет результат поиска, обязательные routerG поля и строит reference URLs для IpAddress и Room.',
        reliesOn: 'CMDBuild response, hostname и CMDBuild base URL из узла подготовки.',
        errors: 'Возвращает 404 router_not_found, 409 router_not_unique или 422 missing_cmdbuild_field.',
      },
      'Ответ уже готов?': {
        does: 'Разделяет terminal error response и дальнейшее чтение reference chain.',
        reliesOn: 'Boolean done из узла разбора routerG.',
        errors: 'False branch требует валидные ip_url и room_url.',
      },
      'Чтение IpAddress': {
        does: 'Читает referenced IpAddress card для получения Description как ip_address.',
        reliesOn: 'ip_url и HTTP Basic credential Local CMDBuild Admin Test.',
        errors: 'HTTP/auth/schema ошибки нормализуются финальным Code node.',
      },
      'Чтение Room': {
        does: 'Читает referenced Room card для location и Floor reference.',
        reliesOn: 'room_url и HTTP Basic credential Local CMDBuild Admin Test.',
        errors: 'HTTP/auth/schema ошибки нормализуются финальным Code node.',
      },
      'Чтение Floor': {
        does: 'Читает referenced Floor card для Building reference.',
        reliesOn: 'Room.Floor из ответа CMDBuild и HTTP Basic credential.',
        errors: 'Отсутствующий Room.Floor приводит к missing_cmdbuild_field в финальном ответе.',
      },
      'Чтение Building': {
        does: 'Читает referenced Building card для поля City.',
        reliesOn: 'Floor.Building из ответа CMDBuild и HTTP Basic credential.',
        errors: 'Отсутствующий Building.City приводит к missing_cmdbuild_field.',
      },
      'Нормализация ответа': {
        does: 'Собирает итоговый OK response или structured error по reference chain.',
        reliesOn: 'Результаты чтения IpAddress, Room, Floor, Building и state из routerG.',
        errors: 'Возвращает 502 для CMDBuild REST failures и 422 для пустых обязательных reference атрибутов.',
      },
      'Нормализованный ответ': {
        does: 'Возвращает JSON response caller-у.',
        reliesOn: 'statusCode/response из validation, router parse или final normalization.',
        errors: 'Неверная response shape нарушит OpenAPI contract getProviderEmailContext.',
      },
    },
  },
  providerChannelRepairMonitor: {
    description: [
      'Логика работы: отправляет провайдеру письмо о пропадании канала и асинхронно мониторит восстановление через Zabbix и входящую почту.',
      'Workflow валидирует token и async_callback, возвращает accepted, получает параметры письма из CMDBuild, отправляет шаблон provider_channel_outage_test, затем в цикле сначала проверяет Zabbix status, а потом ищет ответ провайдера в n8n_mail_index.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic, проверить dependent workflows CMDBuild/email-template/Zabbix status, Postgres/Kafka credentials и выполнить auth-negative, validation-negative, short-timeout и mocked/provider mailbox smoke.',
    ],
    nodes: {
      'Webhook мониторинга ремонта канала': {
        does: 'Принимает POST /webhook/provider/channel-repair/monitor с host, problemUrl, service_request, polling/timeout и async_callback.',
        reliesOn: 'Production webhook registration и вызывающий dispatcher, который передает X-ServiceDesk-Token.',
        errors: 'До activation endpoint вернет 404; malformed body валидирует следующий Code node.',
      },
      'Подготовка запроса мониторинга': {
        does: 'Валидирует auth, входные параметры, async_callback, result_transport и internal webhook base URL.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, optional N8N_INTERNAL_WEBHOOK_BASE_URL/N8N_WEBHOOK_BASE_URL и ServiceDesk async callback contract.',
        errors: 'Возвращает 400/401/500 для missing host/problemUrl/service_request, invalid poll/timeout, missing callback/topic или invalid internal URL.',
      },
      'Запрос валиден?': {
        does: 'Маршрутизирует валидный async request в accepted response или возвращает validation/auth error.',
        reliesOn: 'Boolean valid из узла подготовки запроса.',
        errors: 'False branch завершает HTTP request structured error без запуска письма и polling.',
      },
      'Ответ ошибки валидации': {
        does: 'Возвращает caller-у validation/auth error.',
        reliesOn: 'statusCode/response из узла подготовки запроса.',
        errors: 'Неверная response shape нарушит OpenAPI error contract.',
      },
      'Ответ accepted': {
        does: 'Сразу отвечает ServiceDesk caller-у accepted и освобождает HTTP request.',
        reliesOn: 'Accepted response с correlation_id, wait_id и result_transport из async_callback.',
        errors: 'После этого terminal result доставляется только через callback/Kafka.',
      },
      'Получение контекста и отправка письма': {
        does: 'Вызывает internal CMDBuild provider context endpoint и internal templated email endpoint для отправки письма провайдеру.',
        reliesOn: 'Активные workflows getProviderEmailContext/sendTemplatedEmail, N8N_WEBHOOK_TOKEN, CMDBuild/SMTP credentials в зависимых workflows.',
        errors: 'CMDBuild lookup или email send failure превращаются в terminal ERROR ExternalEvent.',
      },
      'Начальный этап терминальный?': {
        does: 'Разделяет ошибку начального этапа и переход к polling loop.',
        reliesOn: 'Boolean terminal из узла получения контекста и отправки письма.',
        errors: 'True branch доставляет ERROR, false branch продолжает мониторинг.',
      },
      'Проверка статуса Zabbix': {
        does: 'Вызывает internal Zabbix problem status endpoint и проверяет problem/resolved/ok.',
        reliesOn: 'Активный workflow getZabbixProblemStatus, Zabbix registry env и problemUrl из запроса.',
        errors: 'Zabbix status failure превращается в terminal ERROR ExternalEvent.',
      },
      'Zabbix завершил ранбук?': {
        does: 'Останавливает ранбук, если Zabbix уже ok или resolved.',
        reliesOn: 'Boolean terminal из узла проверки Zabbix.',
        errors: 'False branch идет к проверке почты; true branch доставляет RESOLVED.',
      },
      'Подготовка SQL поиска письма': {
        does: 'Строит SQL поиска service_request в subject/body индекса n8n_mail_index за вчера/сегодня.',
        reliesOn: 'Validated state, service_request, window_start_at и SQL escaping в Code node.',
        errors: 'Некорректный SQL или недоступная таблица проявятся в Postgres node; таблица создается автоматически.',
      },
      'Поиск письма в индексе': {
        does: 'Выполняет поиск ответа провайдера и delivery failure по n8n_mail_index.',
        reliesOn: 'Postgres credential Local ServiceDesk Postgres и активный mailbox collector.',
        errors: 'Postgres credential/network/schema ошибки приводят к failed execution и не доставляют terminal result.',
      },
      'Оценка ответа провайдера': {
        does: 'Определяет OK, MULTI_MAIL, DELIVERY_FAILED, NOT_FOUND или время следующего опроса.',
        reliesOn: 'match_count, delivery_failure_count, first match rows, deadline_at и poll_seconds.',
        errors: 'Если результата нет и deadline не достигнут, workflow уходит в Wait loop.',
      },
      'Email завершил ранбук?': {
        does: 'Разделяет terminal email/timeout result и повторный polling.',
        reliesOn: 'Boolean terminal из узла оценки ответа провайдера.',
        errors: 'False branch продолжает ожидание; true branch доставляет ExternalEvent.',
      },
      'Ожидание следующего опроса': {
        does: 'Приостанавливает execution до следующей итерации polling.',
        reliesOn: 'next_wait_at ISO timestamp из оценки ответа провайдера; next_wait_seconds остается диагностическим полем.',
        errors: 'Если n8n wait/resume runtime некорректен, long-running execution может не продолжиться.',
      },
      'Доставка async результата': {
        does: 'Формирует canonical ExternalEvent, при необходимости отправляет HTTP callback и заполняет delivery_status.',
        reliesOn: 'async_callback, INTEGRATION_CALLBACK_TOKEN env и this.helpers.httpRequest для callback.',
        errors: 'Для result_transport=both callback failure не блокирует Kafka publish; для чистого http_callback missing_callback_token/callback_delivery_failed приводят к failed execution.',
      },
      'Нужна Kafka delivery?': {
        does: 'Проверяет, нужен ли publish ExternalEvent в Kafka.',
        reliesOn: 'shouldPublishKafka из узла доставки async результата.',
        errors: 'False branch завершает workflow после HTTP callback или no-Kafka delivery.',
      },
      'Публикация ExternalEvent в Kafka': {
        does: 'Публикует canonical ExternalEvent в result_topic с correlation headers.',
        reliesOn: 'Kafka credential Local Redpanda Kafka и result_topic из async_callback.',
        errors: 'Kafka broker/credential/topic ошибки приведут к failed execution и отсутствию Kafka event.',
      },
      'Завершение async ветки': {
        does: 'Завершает execution после успешной callback/Kafka delivery.',
        reliesOn: 'Успешную доставку ExternalEvent или отсутствие выбранной Kafka ветки.',
        errors: 'Не выполняется при failed callback или Kafka publish.',
      },
    },
  },
  verifyEmployeeManager: {
    description: [
      'Логика работы: проверяет, подтверждает ли кадровая выгрузка заявленную пару сотрудник-руководитель по ФИО.',
      'Workflow валидирует token и входные ФИО, загружает активные назначения, административную и управленческую структуры HR, находит всех тезок и возвращает OK только для единственной подтвержденной пары с найденными табельными номерами сотрудника и руководителя.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic, проверить HR_API_BASE_URL, credential HR API Header Auth, затем выполнить auth-negative, not-found, duplicate-name и happy-path smoke.',
    ],
    nodes: {
      'Webhook проверки руководителя': {
        does: 'Принимает POST /webhook/hr/verify-manager с ФИО сотрудника, ФИО заявленного руководителя и optional relation_type.',
        reliesOn: 'Production webhook registration и caller, который передает JSON body.',
        errors: 'До import/activation endpoint вернет 404; malformed body валидирует следующий Code node.',
      },
      'Подготовка запроса HR': {
        does: 'Валидирует X-ServiceDesk-Token, ФИО, relation_type, legal_entities и HR_API_BASE_URL.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, HR_API_BASE_URL и request body caller-а.',
        errors: 'Возвращает 400 для validation errors, 401 для token errors и 500 для отсутствующего HR_API_BASE_URL.',
      },
      'Запрос валиден?': {
        does: 'Маршрутизирует валидный запрос к HR API, а validation/auth/config error сразу в response.',
        reliesOn: 'Boolean valid из узла подготовки запроса.',
        errors: 'False branch завершает HTTP request structured error без вызова HR API.',
      },
      'Загрузка активных назначений': {
        does: 'Запрашивает /Positions.Hired для построения active employee/person/position snapshot.',
        reliesOn: 'HR API Header Auth credential, HR_API_BASE_URL и request body legalEntities/onlyFullDefined/withDuplicateEmployees.',
        errors: 'HTTP/network/API failure сохраняется как fullResponse и превращается в 502 в следующем Code node.',
      },
      'Подготовка набора кандидатов': {
        does: 'Нормализует active HR snapshot, группирует людей по EmployeeGID/PersonGID, ищет всех тезок сотрудника и заявленного руководителя.',
        reliesOn: 'Ответ /Positions.Hired и правила HR export: PersonInfo optional, EmployeeID может отсутствовать.',
        errors: 'Возвращает 502, если /Positions.Hired недоступен; иначе передает найденных кандидатов и список manager EmployeeGID дальше.',
      },
      'Ответ уже готов?': {
        does: 'Завершает workflow, если ошибка /Positions.Hired уже сформировала response.',
        reliesOn: 'Boolean done из узла подготовки кандидатов.',
        errors: 'False branch продолжает загрузку оргструктур и subordinate endpoints.',
      },
      'Загрузка административной оргструктуры': {
        does: 'Запрашивает /Orgstructure.Administrative для проверки administrative relation через ManagerPositionGID.',
        reliesOn: 'HR API Header Auth credential и HR_API_BASE_URL.',
        errors: 'Для relation_type administrative или both HTTP/API failure превращается в 502 в финальной проверке.',
      },
      'Загрузка управленческой оргструктуры': {
        does: 'Запрашивает /Orgstructure.Managerial для проверки managerial relation по ближайшей занятой parent-position.',
        reliesOn: 'HR API Header Auth credential и HR_API_BASE_URL.',
        errors: 'Для relation_type managerial или both HTTP/API failure превращается в 502 в финальной проверке.',
      },
      'Загрузка административных подчиненных': {
        does: 'Запрашивает /Employee.Subordinates.Administrative для best-effort обогащения табельных номеров.',
        reliesOn: 'Manager EmployeeGIDs из набора кандидатов и HR API Header Auth credential.',
        errors: 'Failure не прерывает workflow как technical error; если после обогащения не найден ТН сотрудника или руководителя, финальная проверка вернет business ERROR.',
      },
      'Загрузка управленческих подчиненных': {
        does: 'Запрашивает /Employee.Subordinates.Managerial для best-effort обогащения табельных номеров.',
        reliesOn: 'Manager EmployeeGIDs из набора кандидатов и HR API Header Auth credential.',
        errors: 'Failure не прерывает workflow как technical error; если после обогащения не найден ТН сотрудника или руководителя, финальная проверка вернет business ERROR.',
      },
      'Проверка пары руководитель-сотрудник': {
        does: 'Проверяет unique employee/manager candidates, administrative/managerial relation evidence и наличие employee_id/manager_id для OK.',
        reliesOn: 'Active assignments, HR org structures, subordinate enrichment и relation_type administrative/managerial/both.',
        errors: 'Возвращает business ERROR при not found/duplicates/no confirmed relation/employee_id_not_found/manager_id_not_found; возвращает 502 при required HR org endpoint failure.',
      },
      'Нормализованный ответ': {
        does: 'Возвращает caller-у JSON response с OK/ERROR или structured technical error.',
        reliesOn: 'statusCode/response из validation или финального Code node.',
        errors: 'Неверная response shape ломает OpenAPI contract verifyEmployeeManager.',
      },
    },
  },
  lookupAdUserLogin: {
    description: [
      'Логика работы: read-only ищет пользователя MS AD по точному ФИО и табельному номеру и возвращает login и email из настраиваемых AD атрибутов.',
      'Workflow валидирует token, входные значения и имена LDAP атрибутов, строит безопасный LDAP filter, выполняет LDAPS search через credential n8n и возвращает OK только при единственном найденном пользователе.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic, проверить AD_BASE_DN и credential MS AD LDAPS, выполнить auth-negative, validation-negative и happy-path smoke на согласованной AD тестовой учетной записи.',
    ],
    nodes: {
      'Webhook поиска login AD': {
        does: 'Принимает POST /webhook/ad/user/login-lookup с full_name, employee_id и optional LDAP attribute overrides.',
        reliesOn: 'Production webhook registration и caller, который передает X-ServiceDesk-Token.',
        errors: 'До import/activation endpoint вернет 404; malformed body валидирует следующий Code node.',
      },
      'Подготовка AD запроса': {
        does: 'Валидирует token, обязательные поля, base DN, LDAP attribute names и строит escaped LDAP search filter.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, optional AD_BASE_DN/AD_FULL_NAME_ATTRIBUTE/AD_EMPLOYEE_ID_ATTRIBUTE/AD_LOGIN_ATTRIBUTE/AD_EMAIL_ATTRIBUTE и request body caller-а.',
        errors: 'Возвращает 400 для validation errors, 401 для token errors и 500 для отсутствующего AD_BASE_DN/base_dn.',
      },
      'Запрос валиден?': {
        does: 'Маршрутизирует валидный запрос в LDAP search или сразу возвращает validation/auth/config error.',
        reliesOn: 'Boolean valid из узла подготовки AD запроса.',
        errors: 'False branch завершает HTTP request structured error без обращения к AD.',
      },
      'LDAP поиск пользователя': {
        does: 'Выполняет LDAP search с limit=2 по фильтру ФИО + табельный номер и возвращает login/email/full-name/employee-id attributes.',
        reliesOn: 'n8n LDAP credential MS AD LDAPS, base_dn, ldap_filter и ldap_attributes из подготовленного state.',
        errors: 'LDAP credential/network/TLS/search failures не роняют workflow благодаря continueOnFail и нормализуются следующим Code node.',
      },
      'Нормализация AD ответа': {
        does: 'Преобразует LDAP entries в OK response или business ERROR not_found/not_unique/login_not_found/email_not_found.',
        reliesOn: 'Результаты LDAP node и исходные matched_by атрибуты из узла подготовки запроса.',
        errors: 'Возвращает 502 для LDAP failures и HTTP 200 status ERROR для бизнес-исходов поиска.',
      },
      'Нормализованный ответ': {
        does: 'Возвращает caller-у JSON response с OK/login/email, business ERROR или structured technical error.',
        reliesOn: 'statusCode/response из validation или нормализации LDAP результата.',
        errors: 'Неверная response shape ломает OpenAPI contract lookupAdUserLogin.',
      },
    },
  },
  resetAdUserPassword: {
    description: [
      'Логика работы: меняет пароль пользователя MS AD по login и включает Change on first login через pwdLastSet=0.',
      'Workflow валидирует внешний webhook token и внутренний N8N_INTERNAL_RUNBOOK_TOKEN, принимает только login/password_length, берет LDAP настройки из env, ищет единственного AD user, генерирует пароль криптографическим RNG и выполняет LDAPS update unicodePwd/pwdLastSet через credential n8n.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic или Verbose, проверить AD_PASSWORD_RESET_BASE_DN/AD_BASE_DN, N8N_INTERNAL_RUNBOOK_TOKEN, credential MS AD LDAPS и запускать happy-path smoke только на disposable/customer-approved AD test account; пароль не логировать и не сохранять вне защищенного канала.',
    ],
    nodes: {
      'Webhook смены пароля AD': {
        does: 'Принимает internal POST /webhook/ad/user/reset-password с login и optional password_length.',
        reliesOn: 'Production webhook registration, X-ServiceDesk-Token и X-ServiceDesk-Internal-Token от доверенного internal workflow.',
        errors: 'До import/activation endpoint вернет 404; malformed body валидирует следующий Code node.',
      },
      'Подготовка AD reset запроса': {
        does: 'Валидирует внешний и внутренний токены, login, password_length, env-настройки Base DN/LDAP attribute/allowed chars, генерирует пароль и LDAP search filter.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, N8N_INTERNAL_RUNBOOK_TOKEN, AD_PASSWORD_RESET_BASE_DN/AD_BASE_DN, AD_PASSWORD_RESET_LOGIN_ATTRIBUTE/AD_LOGIN_ATTRIBUTE, optional AD_PASSWORD_ALLOWED_CHARS и crypto.getRandomValues.',
        errors: 'Возвращает 400 для request validation, 401/403 для token errors, 500 для missing/invalid AD config или недоступного crypto RNG.',
      },
      'Запрос валиден?': {
        does: 'Маршрутизирует валидный reset-запрос в LDAP search или сразу возвращает validation/auth/config error.',
        reliesOn: 'Boolean valid из узла подготовки AD reset запроса.',
        errors: 'False branch завершает HTTP request structured error без обращения к AD.',
      },
      'LDAP поиск пользователя': {
        does: 'Выполняет LDAP search с limit=2 по login attribute и возвращает DN найденного user.',
        reliesOn: 'n8n LDAP credential MS AD LDAPS, base_dn, ldap_filter и ldap_attributes из подготовленного state.',
        errors: 'LDAP credential/network/TLS/search failures не роняют workflow благодаря continueOnFail и нормализуются следующим Code node.',
      },
      'Подготовка смены пароля': {
        does: 'Проверяет, что найден ровно один AD user с DN, и готовит state для LDAP update unicodePwd/pwdLastSet.',
        reliesOn: 'Результаты LDAP search и сохраненный password state из узла подготовки запроса.',
        errors: 'Возвращает business ERROR для lookup failure/not found/not unique/missing DN без попытки смены пароля.',
      },
      'Нужно менять пароль?': {
        does: 'Маршрутизирует найденного AD user в LDAP update, а business ERROR сразу в response.',
        reliesOn: 'Boolean update_required из узла подготовки смены пароля.',
        errors: 'False branch завершает HTTP request нормализованным status ERROR.',
      },
      'LDAP смена пароля': {
        does: 'Выполняет LDAP update: replace unicodePwd новым паролем и pwdLastSet=0 для Change on first login.',
        reliesOn: 'MS AD LDAPS credential с правом reset password, LDAPS/TLS и DN найденного user.',
        errors: 'AD policy/permission/TLS/encoding failures не роняют workflow благодаря continueOnFail и нормализуются следующим Code node.',
      },
      'Нормализация смены пароля': {
        does: 'Возвращает OK с login/password/change_on_first_login или status ERROR с redacted reason.',
        reliesOn: 'Результат LDAP update и password state из узла подготовки смены пароля.',
        errors: 'Возвращает ad_password_update_failed при LDAP update failure и ad_password_update_unconfirmed, если LDAP node не вернул явный success marker.',
      },
      'Нормализованный ответ': {
        does: 'Возвращает caller-у JSON response с OK/password, status ERROR или structured technical error.',
        reliesOn: 'statusCode/response из validation, business checks или нормализации LDAP update.',
        errors: 'Неверная response shape ломает OpenAPI contract resetAdUserPassword.',
      },
    },
  },
  processAdPasswordResetRequest: {
    description: [
      'Логика работы: обрабатывает заявку ServiceDesk на смену пароля сотрудника через проверку заявителя, проверку руководителя, AD lookup, AD password reset и отправку уведомления руководителю.',
      'Workflow валидирует token, approval/idempotency поля и входные ФИО/номер заявки, последовательно вызывает internal n8n endpoints, останавливается на первой ошибке и возвращает результаты всех пройденных шагов без сгенерированного пароля.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic или Verbose, проверить N8N_INTERNAL_WEBHOOK_BASE_URL/N8N_WEBHOOK_TOKEN/N8N_INTERNAL_RUNBOOK_TOKEN, активность dependent workflows, затем выполнить auth-negative, validation-negative и mocked/internal-call contract tests; happy path требует HR/AD/SMTP test data.',
    ],
    nodes: {
      'Webhook обработки заявки смены пароля': {
        does: 'Принимает POST /webhook/ad/password-reset/process с service_request, applicant_full_name, employee_full_name, claimed_manager_full_name, approval_id, approved_by и idempotency_key.',
        reliesOn: 'Production webhook registration и caller, который передает X-ServiceDesk-Token после внешней approval policy.',
        errors: 'До import/activation endpoint вернет 404; malformed body валидирует следующий Code node.',
      },
      'Обработка заявки смены пароля AD': {
        does: 'Валидирует запрос, approval/idempotency поля и последовательно вызывает verifyApplicantParticipant, verifyEmployeeManager, lookupAdUserLogin для сотрудника/руководителя, resetAdUserPassword и sendTemplatedEmail.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, N8N_INTERNAL_RUNBOOK_TOKEN, N8N_INTERNAL_WEBHOOK_BASE_URL или N8N_WEBHOOK_BASE_URL, this.helpers.httpRequest и активные dependent workflows.',
        errors: 'Возвращает 400/401/500 для auth/validation/config errors; business ERROR на первом failed step с password_changed/notification_sent flags и sanitized steps без password.',
      },
      'Нормализованный ответ': {
        does: 'Возвращает caller-у OK или ERROR с результатами пройденных операций без сгенерированного пароля.',
        reliesOn: 'statusCode/response из orchestration Code node.',
        errors: 'Неверная response shape ломает OpenAPI contract processAdPasswordResetRequest.',
      },
    },
  },
  verifyApplicantParticipant: {
    description: [
      'Логика работы: read-only проверяет, что ФИО заявителя совпадает с ФИО сотрудника или ФИО руководителя из входных параметров.',
      'Workflow валидирует token и три ФИО, нормализует пробелы и регистр через ru-RU locale, затем возвращает OK с matched_role employee, manager или both либо business ERROR.',
      'Отладка: включить N8N_WORKFLOW_DEBUG=Basic, выполнить auth-negative, missing-field, applicant=employee, applicant=manager, applicant=both и applicant_not_participant smoke.',
    ],
    nodes: {
      'Webhook проверки заявителя': {
        does: 'Принимает POST /webhook/hr/verify-applicant-participant с applicant_full_name, employee_full_name и manager_full_name.',
        reliesOn: 'Production webhook registration и caller, который передает X-ServiceDesk-Token.',
        errors: 'До import/activation endpoint вернет 404; malformed body валидирует следующий Code node.',
      },
      'Проверка заявителя': {
        does: 'Валидирует token и ФИО, нормализует значения, сравнивает заявителя с сотрудником и руководителем.',
        reliesOn: 'N8N_WEBHOOK_TOKEN, request body и выбранное правило нормализации ФИО без HR/AD lookup.',
        errors: 'Возвращает 400/401 для validation/auth errors и HTTP 200 status ERROR applicant_not_participant для бизнес-несовпадения.',
      },
      'Нормализованный ответ': {
        does: 'Возвращает caller-у JSON response с OK/matched_role, business ERROR или structured validation/auth error.',
        reliesOn: 'statusCode/response из Code node проверки заявителя.',
        errors: 'Неверная response shape ломает OpenAPI contract verifyApplicantParticipant.',
      },
    },
  },
  'Mailtest: IMAP автоответ': {
    description: [
      'Логика работы: локальный demo workflow читает письма из GreenMail IMAP и отправляет автоответ через GreenMail SMTP.',
      'Workflow получает unread mail, строит reply, проверяет нужна ли отправка, затем отправляет ответ sender-у.',
      'Отладка: проверить GreenMail webmail/API, IMAP/SMTP credentials, executions IMAP trigger и node Подготовка автоответа.',
    ],
    nodes: {
      'Получение письма': {
        does: 'Следит за IMAP mailbox automation-test@local.test и получает входящие письма.',
        reliesOn: 'GreenMail IMAP credential, host mailtest:3143 и unread messages.',
        errors: 'IMAP credential/network/mailbox ошибки остановят trigger или execution.',
      },
      'Подготовка автоответа': {
        does: 'Формирует subject/body автоответа и определяет получателя.',
        reliesOn: 'Parsed email fields from IMAP trigger.',
        errors: 'Если sender отсутствует или письмо уже похоже на автоответ, выставляет флаг не отвечать.',
      },
      'Нужен ответ?': {
        does: 'Пропускает дальше только письма, для которых нужен автоответ.',
        reliesOn: 'Boolean shouldReply из Code node.',
        errors: 'False branch завершает workflow без SMTP отправки.',
      },
      'Отправка автоответа': {
        does: 'Отправляет reply через GreenMail SMTP.',
        reliesOn: 'SMTP credential, prepared recipient/subject/body.',
        errors: 'SMTP credential/network ошибки приводят к failed execution.',
      },
    },
  },
};

function workflowKey(workflow) {
  return workflow.id && WORKFLOW_DOCUMENTATION[workflow.id] ? workflow.id : workflow.name;
}

function descriptionText(doc) {
  return doc.description.join('\n\n');
}

function stickyContent(nodeName, note) {
  return [`### ${nodeName}`, '', `Делает: ${note.does}`, '', `Опирается на: ${note.reliesOn}`, '', `Ошибки/ветки: ${note.errors}`].join('\n');
}

function stickyFor(node, index, note) {
  const position = Array.isArray(node.position) ? node.position : [240 + index * 280, 300];
  return {
    parameters: {
      content: stickyContent(node.name, note),
      height: 180,
      width: 360,
      color: 7,
    },
    id: `${node.id}-note`,
    name: `Note: ${node.name}`,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [position[0], position[1] + 170],
  };
}

export function applyWorkflowInlineDocumentation(workflow) {
  const key = workflowKey(workflow);
  const doc = WORKFLOW_DOCUMENTATION[key];
  if (!doc) {
    throw new Error(`Missing workflow documentation for ${workflow.id || workflow.name}`);
  }

  const functionalNodes = (workflow.nodes || []).filter((node) => node.type !== 'n8n-nodes-base.stickyNote');
  const missing = functionalNodes.map((node) => node.name).filter((name) => !doc.nodes[name]);
  if (missing.length > 0) {
    throw new Error(`Missing sticky note documentation for ${workflow.id || workflow.name}: ${missing.join(', ')}`);
  }

  workflow.description = descriptionText(doc);
  workflow.nodes = [
    ...functionalNodes,
    ...functionalNodes.map((node, index) => stickyFor(node, index, doc.nodes[node.name])),
  ];

  return workflow;
}

export function assertWorkflowInlineDocumentation(workflow) {
  const functionalNodes = (workflow.nodes || []).filter((node) => node.type !== 'n8n-nodes-base.stickyNote');
  const stickyNodes = (workflow.nodes || []).filter((node) => node.type === 'n8n-nodes-base.stickyNote');

  if (!workflow.description || !String(workflow.description).trim()) {
    throw new Error(`${workflow.name}: workflow.description is required`);
  }
  if (!workflow.description.includes('Логика работы:') || !workflow.description.includes('Отладка:')) {
    throw new Error(`${workflow.name}: workflow.description must explain logic and debugging`);
  }

  for (const node of functionalNodes) {
    const matches = stickyNodes.filter((sticky) => sticky.name === `Note: ${node.name}`);
    if (matches.length !== 1) {
      throw new Error(`${workflow.name}: expected one sticky note for node ${node.name}, got ${matches.length}`);
    }
    const content = String(matches[0].parameters?.content || '');
    for (const section of REQUIRED_STICKY_SECTIONS) {
      if (!content.includes(section)) {
        throw new Error(`${workflow.name}: sticky note for ${node.name} misses section ${section}`);
      }
    }
  }
}

export function documentedWorkflow(workflow) {
  return applyWorkflowInlineDocumentation(workflow);
}
