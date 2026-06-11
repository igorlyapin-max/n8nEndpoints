# Stage 4 Runbook Usage

## Purpose

This n8n webhook accepts an approved ServiceDesk action request for `start_systemcenter_runbook` and returns a normalized acknowledgement.

## Caller Contract

- Workflow export: `workflows/stage4-runbook-webhook.json`
- Production endpoint: `POST http://127.0.0.1:5678/webhook/servicedesk/runbook/start`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- OpenAPI operationId: `startRunbook`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`
- Content type: `application/json`

```json
{
  "invocation": {
    "invocation_id": "example-invocation",
    "action_id": "start_systemcenter_runbook"
  },
  "parameters": {
    "source": "servicedesk"
  }
}
```

## Responses

Successful authorized call:

```json
{
  "runbook_status": "accepted",
  "message": "n8n webhook ранбука этапа 4 получил авторизованный запрос.",
  "invocation_id": "example-invocation",
  "action_id": "start_systemcenter_runbook",
  "parameters": {
    "source": "servicedesk"
  }
}
```

Unauthorized call:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Токен webhook отсутствует или некорректен."
  }
}
```

## Safety Policy

Do not call this webhook directly from LLM code paths. Production calls must go through:

```text
LangGraph -> Tool Registry -> Integration Dispatcher -> n8n_webhook adapter
```

Action tools require operator approval before dispatch.
