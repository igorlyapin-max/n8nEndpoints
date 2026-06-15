# AD User Login Lookup Deployment

## Import And Activation

1. Regenerate the workflow export after changing AD lookup logic:

```bash
node scripts/build-ad-user-login-lookup-workflow.mjs
node scripts/build-contract-workflow.mjs
```

2. Import `workflows/ad-user-login-lookup-webhook.json` into n8n.
3. Confirm the workflow name is `AD: поиск login и email пользователя`.
4. Configure credential `MS AD LDAPS` on node `LDAP поиск пользователя`.
5. Activate or publish the workflow.
6. Restart n8n if webhook registration or environment variables changed.

## Runtime Requirements

- `N8N_WEBHOOK_TOKEN` is required. Callers pass it in `X-ServiceDesk-Token`.
- `AD_BASE_DN` is required unless every caller passes `base_dn`.
- Optional default attribute env vars:
  - `AD_FULL_NAME_ATTRIBUTE=displayName`
  - `AD_EMPLOYEE_ID_ATTRIBUTE=employeeID`
  - `AD_LOGIN_ATTRIBUTE=sAMAccountName`
  - `AD_EMAIL_ATTRIBUTE=mail`
- `N8N_WORKFLOW_DEBUG=off` by default. Use `Basic` temporarily for safe diagnostics; use `Verbose` only during isolated troubleshooting.
- n8n must have network access to the AD domain controller over LDAPS/TLS.
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

After import, verify and rebind it to the production credential if n8n marks the node unresolved.

## Smoke Checks

Static checks:

```bash
node --check scripts/build-ad-user-login-lookup-workflow.mjs
node scripts/build-ad-user-login-lookup-workflow.mjs --check
node scripts/build-contract-workflow.mjs --check
node scripts/apply-workflow-inline-documentation.mjs --check
node scripts/test-contracts.mjs
jq empty workflows/ad-user-login-lookup-webhook.json contracts/n8n-openapi.json contracts/n8n-openapi.locales.json contracts/n8n-workflow-catalog.json
```

Runtime auth-negative check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/ad/user/login-lookup \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"Иванов Иван Иванович","employee_id":"1001"}'
```

Expected result: HTTP `401` with `unauthorized`.

Runtime validation check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/ad/user/login-lookup \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"Иванов Иван Иванович","employee_id":"1001","email_attribute":"mail)(uid=*"}'
```

Expected result: HTTP `400` with `invalid_ad_attribute`.

Runtime configuration check when no dev AD exists:

```bash
curl -i -X POST https://n8n.example.ru/webhook/ad/user/login-lookup \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"Иванов Иван Иванович","employee_id":"1001"}'
```

If `AD_BASE_DN` is not configured, expected result is HTTP `500` with `missing_ad_base_dn`. If AD is configured but unavailable, expected result is HTTP `502` with `ad_lookup_failed`.

Runtime happy-path check must use a known test AD user:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/ad/user/login-lookup \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"<employee full name>","employee_id":"<employee tabular number>"}' | jq .
```

Expected business result: `status: OK`, `login` populated from `sAMAccountName` or the configured `login_attribute`, and `email` populated from `mail` or the configured `email_attribute`.

## Debugging

1. Confirm `AD_BASE_DN` from inside the n8n runtime container or service.
2. Test the `MS AD LDAPS` credential in the n8n UI before activating the workflow.
3. Run auth-negative smoke first to prove the webhook is registered and token protection works.
4. Run validation smoke to prove Code node env access and attribute validation work.
5. In n8n executions, inspect the `LDAP поиск пользователя` node output count and any normalized `ad_lookup_failed` response.
6. Temporarily set `N8N_WORKFLOW_DEBUG=Basic` and restart n8n. Diagnostics intentionally mask tokens, base DN, LDAP filter, full names and tabular numbers.
7. If `ad_user_not_unique` appears, tighten `base_dn` or choose more specific customer AD attributes.

## Rollback

Deactivate `AD: поиск login и email пользователя` in n8n. The workflow is read-only and has no persistent side effects in AD.
