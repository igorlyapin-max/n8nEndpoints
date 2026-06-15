# AD User Login Lookup Usage

## Purpose

Workflow `AD: поиск login и email пользователя` ищет пользователя MS AD по ФИО и табельному номеру и возвращает login и email.

Ранбук read-only: он не меняет AD, не создает учетные записи и не сбрасывает пароли. `OK` возвращается только когда найден ровно один AD user, выбранный login attribute заполнен и выбранный email attribute заполнен.

## Contract

- Workflow export: `workflows/ad-user-login-lookup-webhook.json`
- Endpoint: `POST http://127.0.0.1:5678/webhook/ad/user/login-lookup`
- OpenAPI operationId: `lookupAdUserLogin`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`

Request with defaults:

```json
{
  "full_name": "Иванов Иван Иванович",
  "employee_id": "1001"
}
```

Request with explicit AD settings:

```json
{
  "full_name": "Иванов Иван Иванович",
  "employee_id": "1001",
  "full_name_attribute": "displayName",
  "employee_id_attribute": "employeeID",
  "login_attribute": "sAMAccountName",
  "email_attribute": "mail",
  "base_dn": "OU=Users,DC=example,DC=local"
}
```

Accepted aliases:

- `fullName` for `full_name`
- `employeeId` for `employee_id`
- `fullNameAttribute` for `full_name_attribute`
- `employeeIdAttribute` for `employee_id_attribute`
- `loginAttribute` for `login_attribute`
- `emailAttribute` for `email_attribute`
- `baseDN` for `base_dn`

Default AD attributes:

- `full_name_attribute`: `displayName`
- `employee_id_attribute`: `employeeID`
- `login_attribute`: `sAMAccountName`
- `email_attribute`: `mail`

If `base_dn` is omitted, the workflow uses `AD_BASE_DN` from the n8n runtime.

## Response

Successful lookup:

```json
{
  "status": "OK",
  "login": "iivanov",
  "email": "iivanov@example.ru",
  "full_name": "Иванов Иван Иванович",
  "employee_id": "1001",
  "matched_by": {
    "full_name_attribute": "displayName",
    "employee_id_attribute": "employeeID",
    "login_attribute": "sAMAccountName",
    "email_attribute": "mail"
  }
}
```

Business errors are returned with HTTP `200` and `status: ERROR`:

```json
{
  "status": "ERROR",
  "error_code": "ad_user_not_found",
  "message": "Пользователь AD не найден по ФИО и табельному номеру.",
  "full_name": "Иванов Иван Иванович",
  "employee_id": "1001",
  "match_count": 0
}
```

Duplicate result example:

```json
{
  "status": "ERROR",
  "error_code": "ad_user_not_unique",
  "message": "По ФИО и табельному номеру найдено несколько пользователей AD.",
  "match_count": 2,
  "candidates": [
    {
      "login": "iivanov",
      "email": "iivanov@example.ru",
      "full_name": "Иванов Иван Иванович",
      "employee_id": "1001"
    }
  ]
}
```

## Common Errors

- `401 unauthorized` - absent or invalid `X-ServiceDesk-Token`.
- `400 missing_full_name` - request does not contain `full_name` or `fullName`.
- `400 missing_employee_id` - request does not contain `employee_id` or `employeeId`.
- `400 invalid_ad_attribute` - AD attribute name does not match the safe attribute-name pattern.
- `400 invalid_base_dn` - `base_dn` contains control characters or is too long.
- `500 missing_ad_base_dn` - neither request `base_dn` nor runtime `AD_BASE_DN` is configured.
- `502 ad_lookup_failed` - LDAP credential, TLS, network, bind or search failed.
- `ad_user_not_found` - no AD user matched full name and employee id.
- `ad_user_not_unique` - several AD users matched full name and employee id.
- `ad_login_not_found` - user matched, but selected `login_attribute` is empty.
- `ad_email_not_found` - user matched, but selected `email_attribute` is empty.

## Matching Rules

The workflow builds an LDAP filter with exact equality on two attributes:

```ldap
(&(objectClass=user)(!(objectClass=computer))(<full_name_attribute>=<full_name>)(<employee_id_attribute>=<employee_id>))
```

Search values are escaped for LDAP filter syntax. Attribute names are not interpolated unless they match `^[A-Za-z][A-Za-z0-9.-]*$`.

Use `base_dn` only when the caller must restrict lookup to a specific OU. In normal operation prefer administrator-controlled `AD_BASE_DN`.
