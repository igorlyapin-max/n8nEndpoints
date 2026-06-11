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

## Caller Flow

1. Внешнее приложение вызывает `GET /webhook/contracts/openapi.json`.
2. По `operationId` выбирает нужную операцию, например `sendEmail` или `startRunbook`.
3. Для action endpoint берет path, schema и security scheme из OpenAPI.
4. При выполнении action endpoint передает `X-ServiceDesk-Token`.

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

Execution endpoints из контракта остаются отдельными от discovery endpoint и требуют token, если выполняют действие.
