# AD Password Reset Usage

## Purpose

Workflow `AD: смена пароля пользователя` меняет пароль существующего пользователя MS AD по login. Это internal-only endpoint для composite workflow `AD: обработка заявки на смену пароля`; внешние приложения должны вызывать `POST /webhook/ad/password-reset/process`.

Ранбук mutating: он находит ровно одного AD user через LDAP, генерирует новый пароль, обновляет `unicodePwd`, ставит `pwdLastSet=0` для требования смены пароля при первом входе и возвращает сгенерированный пароль доверенному internal caller-у. Вызов должен выполняться только после внешней approval policy в orchestrator или ServiceDesk.

## Contract

- Workflow export: `workflows/ad-password-reset-webhook.json`
- Endpoint: `POST http://127.0.0.1:5678/webhook/ad/user/reset-password`
- OpenAPI operationId: `resetAdUserPassword`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Required headers: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`, `X-ServiceDesk-Internal-Token: $N8N_INTERNAL_RUNBOOK_TOKEN`

Request with defaults:

```json
{
  "login": "iivanov"
}
```

Request with explicit password length:

```json
{
  "login": "iivanov",
  "password_length": 16
}
```

Accepted aliases:

- `passwordLength` for `password_length`

Defaults:

- `password_length`: `12`
- allowed chars: `AD_PASSWORD_ALLOWED_CHARS`, otherwise `A-Z`, `a-z`, `0-9`
- login attribute: `AD_PASSWORD_RESET_LOGIN_ATTRIBUTE`, then `AD_LOGIN_ATTRIBUTE`, otherwise `sAMAccountName`
- base DN: `AD_PASSWORD_RESET_BASE_DN`, then `AD_BASE_DN`

## Response

Successful reset:

```json
{
  "status": "OK",
  "login": "iivanov",
  "password": "<generated-password>",
  "password_length": 12,
  "change_on_first_login": true,
  "matched_by": {
    "login_attribute": "sAMAccountName"
  }
}
```

`password` is a secret. The caller must show or transfer it only through the approved customer process and must not put it into logs, tickets, screenshots, callback payloads, Kafka events, or long-term storage.

Business errors are returned with HTTP `200` and `status: ERROR`:

```json
{
  "status": "ERROR",
  "error_code": "ad_user_not_found",
  "message": "Пользователь AD не найден по login.",
  "login": "iivanov",
  "match_count": 0,
  "matched_by": {
    "login_attribute": "sAMAccountName"
  }
}
```

Update failure example:

```json
{
  "status": "ERROR",
  "error_code": "ad_password_update_failed",
  "message": "Не удалось сменить пароль пользователя AD.",
  "login": "iivanov",
  "reason": "[redacted]"
}
```

## Common Errors

- `401 unauthorized` - absent or invalid `X-ServiceDesk-Token`.
- `403 forbidden_internal_runbook_token` - absent or invalid `X-ServiceDesk-Internal-Token`.
- `400 missing_login` - request does not contain `login`.
- `400 invalid_login` - `login` contains control characters or is longer than 256 characters.
- `400 invalid_password_length` - `password_length` is not an integer from 8 to 128.
- `500 missing_internal_runbook_token` - runtime `N8N_INTERNAL_RUNBOOK_TOKEN` is not configured.
- `500 invalid_allowed_chars_config` - runtime `AD_PASSWORD_ALLOWED_CHARS` is too short, too long or contains control characters.
- `500 invalid_ad_attribute_config` - configured AD login attribute does not match the safe attribute-name pattern.
- `500 invalid_base_dn_config` - configured base DN contains control characters or is too long.
- `500 missing_ad_base_dn` - neither `AD_PASSWORD_RESET_BASE_DN` nor `AD_BASE_DN` is configured.
- `500 password_generation_failed` - n8n runtime did not provide crypto RNG.
- `ad_user_lookup_failed` - LDAP credential, TLS, network, bind or search failed before reset.
- `ad_user_not_found` - no AD user matched login.
- `ad_user_not_unique` - several AD users matched login.
- `ad_user_dn_not_found` - user matched, but LDAP search did not return DN.
- `ad_password_update_failed` - LDAP update failed because of permissions, AD password policy, TLS, encoding or directory errors.
- `ad_password_update_unconfirmed` - LDAP update did not return an explicit success marker; do not treat the generated password as applied.

## Matching And Update Rules

The workflow builds an LDAP filter with exact equality on one login attribute:

```ldap
(&(objectClass=user)(!(objectClass=computer))(<login_attribute>=<login>))
```

Search values are escaped for LDAP filter syntax. Attribute names are not interpolated unless they match `^[A-Za-z][A-Za-z0-9.-]*$`.

The LDAP update replaces:

- `unicodePwd` with the generated password wrapped in quotes.
- `pwdLastSet` with `0` so AD requires password change at first login.

MS AD requires LDAPS/TLS for password modification. Verify the workflow against the customer's AD version and n8n LDAP node behavior on a disposable test account before enabling production use.
