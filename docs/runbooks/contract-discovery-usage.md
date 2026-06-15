# Contract Discovery Usage

## Назначение

Workflow `Contracts: OpenAPI discovery` отдает OpenAPI 3.1 контракт для внешних приложений, которые должны машинночитаемо получить доступные n8n webhook endpoints и затем подставить только `X-ServiceDesk-Token` при вызове action endpoints.

## Caller Contract

- Workflow export: `workflows/contracts-openapi-webhook.json`
- Source-of-truth contract: `contracts/n8n-openapi.json`
- Endpoint: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Auth: не требуется.
- Content type: `application/json`
- OpenAPI operationId: `getN8nOpenApiContract`
- Optional language selector: `?lang=en` или `?lang=ru`
- Язык по умолчанию: `ru`, если при развертывании не задан `N8N_OPENAPI_DEFAULT_LOCALE=ru|en`.

## Caller Flow

1. Внешнее приложение вызывает `GET /webhook/contracts/openapi.json`.
   Если caller-у нужны английские описания OpenAPI, он вызывает `GET /webhook/contracts/openapi.json?lang=en`.
   Если `lang` не указан, workflow возвращает значение по умолчанию развертывания: `N8N_OPENAPI_DEFAULT_LOCALE` или `ru`.
2. По `operationId` выбирает нужную операцию, например `sendEmail`, `sendTemplatedEmail`, `waitForEmailByTicket`, `getProviderEmailContext`, `monitorProviderChannelRepair`, `processAdPasswordResetRequest`, `getEmailTemplateCatalog`, `updateZabbixProblem`, `getZabbixProblemStatus`, `waitZabbixProblemStatus` или `startRunbook`.
3. Для action endpoint берет path, schema и security scheme из OpenAPI.
4. При выполнении action endpoint передает `X-ServiceDesk-Token`.

Для отправки по шаблону caller сначала вызывает `getEmailTemplateCatalog`, затем передает выбранный `templateId` и `params` в `sendTemplatedEmail`.

Для async runbook caller использует тот же `startRunbook`, но добавляет `invocation.extensions.async_callback`. Этот блок описывает, куда вернуть итоговый ServiceDesk `ExternalEvent`: через `callback_url`, через Kafka `result_topic` или через оба транспорта. Никакой отдельный n8n endpoint для Kafka-обертки не публикуется.

OpenAPI публикует transport policy в `x-transport-security`. HTTP URL остаются admin-configured: local/dev может использовать `http://127.0.0.1`, а shared/staging/production должны использовать HTTPS reverse proxy или другой утвержденный HTTPS endpoint. Kafka delivery не является HTTPS-вызовом; production безопасность Kafka задается broker credentials/ACL через `SASL_SSL` или `SSL`/mTLS.

Для ожидания входящего письма caller использует `waitForEmailByTicket`. Direct режим предназначен для короткого smoke, а ожидание 60 минут должно передавать `invocation.extensions.async_callback`.

Для подготовки письма провайдеру caller использует `getProviderEmailContext`: получает из CMDBuild `city`, `location`, `ip_address`, `contract`, `provider_email`, затем передает эти поля в отдельный endpoint отправки письма по шаблону.

Локализация OpenAPI меняет только human-readable metadata: `summary`, `description`, `title` и descriptions response/example. Paths, `operationId`, schema names, payload fields, enum/const values, error codes и auth headers одинаковы для всех языков.

## Response

Успешный ответ является OpenAPI 3.1 документом:

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "n8n Integration Adapter API",
    "version": "1.0.0"
  },
  "paths": {}
}
```

Выбор языка:

```bash
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json | jq '.info.description'
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json?lang=en | jq '.info.description'
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json?lang=ru | jq '.info.description'
```

Если `lang` не входит в supported locales, workflow возвращает `400 unsupported_locale`.
Если `N8N_OPENAPI_DEFAULT_LOCALE` задан и не входит в supported locales, workflow возвращает `500 invalid_default_locale`.

Execution endpoints из контракта остаются отдельными от discovery endpoint и требуют token, если выполняют действие.
