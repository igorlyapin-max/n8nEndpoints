# AD Password Reset Deployment

## Import And Activation

1. Regenerate the workflow export after changing AD password reset logic:

```bash
node scripts/build-ad-password-reset-workflow.mjs
node scripts/build-contract-workflow.mjs
```

2. Import `workflows/ad-password-reset-webhook.json` into n8n.
3. Confirm the workflow name is `AD: смена пароля пользователя`.
4. Configure credential `MS AD LDAPS` on nodes `LDAP поиск пользователя` and `LDAP смена пароля`.
5. Confirm that execution data saving is disabled for success, error and manual executions in workflow settings.
6. Activate or publish the workflow only after the ServiceDesk/orchestrator approval policy is configured.
7. Restart n8n if webhook registration or environment variables changed.

## Runtime Requirements

- `N8N_WEBHOOK_TOKEN` is required. Internal callers pass it in `X-ServiceDesk-Token`.
- `N8N_INTERNAL_RUNBOOK_TOKEN` is required. Internal callers pass it in `X-ServiceDesk-Internal-Token`; external applications must not receive this token.
- `AD_PASSWORD_RESET_BASE_DN` or `AD_BASE_DN` is required.
- Optional AD lookup attribute env vars: `AD_PASSWORD_RESET_LOGIN_ATTRIBUTE=sAMAccountName`, or fallback `AD_LOGIN_ATTRIBUTE=sAMAccountName`.
- Optional password alphabet env var: `AD_PASSWORD_ALLOWED_CHARS`. When omitted, the workflow uses `A-Z`, `a-z`, `0-9`.
- `N8N_WORKFLOW_DEBUG=off` by default. Use `Basic` temporarily for safe diagnostics; use `Verbose` only during isolated troubleshooting.
- n8n must have network access to the AD domain controller over LDAPS/TLS.
- The LDAP service account must have delegated rights to reset password and force password change on first login for the target OU.
- Production HTTP exposure should use HTTPS through the administrator-selected n8n webhook base URL.
- Logs must go through the standard n8n structured logging/runtime pipeline: stdout/stderr plus the operational second sink accepted for the project or customer contour.

## Credential

Create or bind an n8n `LDAP` credential:

```text
Credential type: LDAP
Credential name: MS AD LDAPS
LDAP Server Address: <domain-controller-fqdn>
LDAP Server Port: 636
Binding DN: <service-account-dn-or-upn>
Binding Password: <secret>
Connection Security: TLS
Ignore SSL/TLS Issues: false
CA Certificate: <customer CA certificate when required>
```

Store the bind password and TLS materials only in n8n credentials or the customer secret system. Do not put them in workflow JSON, contract files, docs, logs or payload examples.

The workflow export contains local credential reference:

```json
{
  "id": "msAdLdap",
  "name": "MS AD LDAPS"
}
```

After import, verify and rebind it to the production credential if n8n marks the nodes unresolved.

## Security Controls

- Treat the `password` field in a successful response as a secret.
- Do not log request/response payloads for this endpoint in ServiceDesk, API gateway, reverse proxy, n8n executions, callback payloads or Kafka events.
- The workflow does not store successful/error/manual execution data. Verify this setting after import because n8n UI or import behavior can differ by version.
- Keep `N8N_WORKFLOW_DEBUG=off` in production. Diagnostic logging masks password/token/credential-related fields, but endpoint payload logging outside n8n must still be disabled.
- Keep `resetAdUserPassword` internal-only. External applications call `processAdPasswordResetRequest`, which checks approval/idempotency context and then calls this endpoint with `X-ServiceDesk-Internal-Token`.

## Smoke Checks

Static checks:

```bash
node --check scripts/build-ad-password-reset-workflow.mjs
node scripts/build-ad-password-reset-workflow.mjs --check
node scripts/build-contract-workflow.mjs --check
node scripts/apply-workflow-inline-documentation.mjs --check
node scripts/test-contracts.mjs
jq empty workflows/ad-password-reset-webhook.json contracts/n8n-openapi.json contracts/n8n-openapi.locales.json contracts/n8n-workflow-catalog.json
```

Runtime auth-negative check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/ad/user/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"login":"iivanov"}'
```

Expected result: HTTP `401` with `unauthorized`.

Runtime internal-token-negative check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/ad/user/reset-password \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"login":"iivanov"}'
```

Expected result: HTTP `403` with `forbidden_internal_runbook_token`.

Runtime validation check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/ad/user/reset-password \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H "X-ServiceDesk-Internal-Token: ${N8N_INTERNAL_RUNBOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"login":"iivanov","password_length":4}'
```

Expected result: HTTP `400` with `invalid_password_length`.

Runtime configuration check when no dev AD exists:

```bash
curl -i -X POST https://n8n.example.ru/webhook/ad/user/reset-password \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H "X-ServiceDesk-Internal-Token: ${N8N_INTERNAL_RUNBOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"login":"iivanov"}'
```

If neither `AD_PASSWORD_RESET_BASE_DN` nor `AD_BASE_DN` is configured, expected result is HTTP `500` with `missing_ad_base_dn`. If AD is configured but unavailable, expected business result is HTTP `200`, `status: ERROR`, `error_code: ad_user_lookup_failed`, `ad_password_update_failed`, or `ad_password_update_unconfirmed`.

Runtime happy-path check must use a disposable test AD user approved by the customer:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/ad/user/reset-password \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H "X-ServiceDesk-Internal-Token: ${N8N_INTERNAL_RUNBOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"login":"<disposable-test-login>","password_length":12}' | jq '{status,login,password_length,change_on_first_login,matched_by}'
```

Expected business result: `status: OK`, `change_on_first_login: true`, and a generated `password` in the raw response. Do not paste the password into logs, tickets or screenshots. Confirm separately that the user must change the password on first interactive login.

## Debugging

1. Confirm `N8N_INTERNAL_RUNBOOK_TOKEN` and `AD_PASSWORD_RESET_BASE_DN`/`AD_BASE_DN` from inside the n8n runtime container or service.
2. Test the `MS AD LDAPS` credential in the n8n UI before activating the workflow.
3. Run auth-negative smoke first to prove the webhook is registered and token protection works.
4. Run validation smoke to prove Code node env access and request validation work.
5. Run happy-path smoke only against a disposable AD account. Never use a real employee account for a first test.
6. If LDAP search returns duplicate users, tighten `base_dn` or use a more specific `login_attribute`.
7. If `ad_password_update_failed` appears, check LDAPS/TLS, service account delegation, AD password policy, and whether the n8n LDAP node/version encodes `unicodePwd` as required by the customer's AD. If `ad_password_update_unconfirmed` appears, check what the n8n LDAP update node returns on successful update and add an explicit success/read-back confirmation before production use.
8. Temporarily set `N8N_WORKFLOW_DEBUG=Basic` and restart n8n. Diagnostics intentionally mask tokens, passwords, base DN and LDAP filters.

## Rollback

Deactivate `AD: смена пароля пользователя` in n8n. Already reset AD passwords are not rolled back by workflow deactivation; handle them through the customer's password reset process.
