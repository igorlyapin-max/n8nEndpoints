# CMDBuild Provider Email Context Usage

## Purpose

Workflow `CMDBuild: параметры письма провайдеру` получает из CMDBuild данные, которые нужны обертке отправки письма провайдеру.

Ранбук read-only: он не отправляет email и не изменяет CMDBuild. Отправка выполняется отдельным вызовом `sendTemplatedEmail`.

## Contract

- Workflow export: `workflows/cmdbuild-provider-email-context-webhook.json`
- Endpoint: `POST http://127.0.0.1:5678/webhook/cmdbuild/provider-email-context`
- OpenAPI operationId: `getProviderEmailContext`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`

Request:

```json
{
  "hostname": "Router for NTbook group 000 (OFF01 Office 01 - Headquarters)"
}
```

Accepted alias: `hostName`.

`hostname` must exactly match `Description`, `hostname` or `Code` of one active CMDBuild card in class `routerG`.

## Response

```json
{
  "status": "OK",
  "hostname": "Router for NTbook group 000 (OFF01 Office 01 - Headquarters)",
  "router_id": 1308541,
  "city": "City01",
  "location": "Office Building A - Floor 1 - Room 001",
  "ip_address": "192.168.202.35",
  "contract": "Договор № 33333-1111 и так далее",
  "provider_email": "provider@example.test"
}
```

Field mapping:

- `provider_email` <- `routerG.email`
- `contract` <- `routerG.contract`
- `ip_address` <- referenced `IpAddress.Description` from `routerG.ipaddress`
- `location` <- referenced `Room.Description` from `routerG.Location`
- `city` <- `Room.Floor -> Floor.Building -> Building.City`

All fields above are mandatory for `OK`. Empty CMDBuild attributes return `422 missing_cmdbuild_field`.

## Common Errors

- `401 unauthorized` - absent or invalid `X-ServiceDesk-Token`.
- `400 missing_hostname` - request does not contain `hostname`.
- `404 router_not_found` - no active `routerG` card matched exact `Description`, `hostname` or `Code`.
- `409 router_not_unique` - more than one `routerG` matched.
- `422 missing_cmdbuild_field` - required router/reference attribute is empty.
- `502 cmdbuild_auth_failed` - CMDBuild credentials are invalid or denied.
- `502 cmdbuild_lookup_failed` - CMDBuild REST lookup failed.

## Caller Flow

1. Call `getProviderEmailContext` with the router hostname.
2. Use returned `provider_email` as `to`.
3. Use returned `city`, `location`, `ip_address`, `contract` plus ServiceDesk `service_request` as template params for `provider_channel_outage_test` or a production provider template.
4. Call `sendTemplatedEmail`.
