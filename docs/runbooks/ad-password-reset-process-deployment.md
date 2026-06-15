# AD Password Reset Process Deployment

## Import And Activation

1. Regenerate the workflow export after changing orchestration logic:

```bash
node scripts/build-ad-password-reset-process-workflow.mjs
node scripts/build-contract-workflow.mjs
```

2. Import `workflows/ad-password-reset-process-webhook.json` into n8n.
3. Confirm the workflow name is `AD: обработка заявки на смену пароля`.
4. Confirm that success, error and manual execution data saving is disabled.
5. Confirm dependency workflows are imported, configured and active.
6. Activate or publish this workflow.
7. Restart n8n if webhook registration or environment variables changed.

## Runtime Requirements

- `N8N_WEBHOOK_TOKEN` is required. Callers pass it in `X-ServiceDesk-Token`.
- `N8N_INTERNAL_RUNBOOK_TOKEN` is required for the internal call to `AD: смена пароля пользователя`.
- `N8N_INTERNAL_WEBHOOK_BASE_URL` should point to the internal n8n webhook base URL, for example `http://127.0.0.1:5678/webhook` in local/dev or `https://n8n.example.ru/webhook` in production.
- `N8N_WEBHOOK_BASE_URL` is accepted as fallback when `N8N_INTERNAL_WEBHOOK_BASE_URL` is absent.
- `N8N_WORKFLOW_DEBUG=off` by default. Use `Basic` temporarily for safe diagnostics; use `Verbose` only during isolated troubleshooting.
- Logs must go through stdout/stderr plus the customer-approved second sink.

Dependency workflows:

- `HR: проверка заявителя среди участников`
- `HR: проверка заявленного руководителя`
- `AD: поиск login и email пользователя`
- `AD: смена пароля пользователя`
- `Email: отправка письма по шаблону`
- `Contracts: OpenAPI discovery`
- `Contracts: Email template catalog`

Dependency credentials/env:

- HR API credential `HR API Header Auth` and `HR_API_BASE_URL`.
- LDAP credential `MS AD LDAPS`, `AD_BASE_DN`, and optional AD attribute env vars.
- SMTP credential on `Email: отправка письма по шаблону`.
- Template `ad_password_reset_notification` in `contracts/email-template-catalog.json`.

## Security Controls

- This workflow must be called only after ServiceDesk/orchestrator approval policy allows password reset.
- The request must include `approval_id`, `approved_by`, and `idempotency_key`; retries must reuse the same `idempotency_key`.
- The generated password is used only as local runtime data for the `sendTemplatedEmail` internal call.
- This workflow must not return `password` in OK or ERROR responses.
- `Email: отправка письма по шаблону` must also disable saved execution data because it receives the password in template params.
- If notification fails after password reset, rollback is not attempted. The workflow returns `ERROR`, `password_changed: true`, and `notification_sent: false`.

## Smoke Checks

Static checks:

```bash
node --check scripts/build-ad-password-reset-process-workflow.mjs
node scripts/build-ad-password-reset-process-workflow.mjs --check
node scripts/build-contract-workflow.mjs --check
node scripts/apply-workflow-inline-documentation.mjs --check
node scripts/test-contracts.mjs
jq empty workflows/ad-password-reset-process-webhook.json contracts/n8n-openapi.json contracts/n8n-openapi.locales.json contracts/n8n-workflow-catalog.json
```

Runtime auth-negative check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/ad/password-reset/process \
  -H 'Content-Type: application/json' \
  -d '{"service_request":"12345678"}'
```

Expected result: HTTP `401` with `unauthorized`.

Runtime validation check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/ad/password-reset/process \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"service_request":"12345678"}'
```

Expected result: HTTP `400` with one of the missing full-name errors.

Happy-path smoke requires coordinated HR, AD and SMTP test data:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/ad/password-reset/process \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "service_request": "12345678",
    "applicant_full_name": "<applicant full name>",
    "employee_full_name": "<employee full name>",
    "claimed_manager_full_name": "<manager full name>",
    "approval_id": "<approval id>",
    "approved_by": "<approver login or name>",
    "idempotency_key": "<stable retry key>"
  }' | jq .
```

Expected result: `status: OK`, `password_changed: true`, `notification_sent: true`, no `password` field anywhere in response, and a delivered email to the manager test mailbox.

## Debugging

1. Run auth-negative smoke first to prove webhook registration and token protection.
2. Confirm `N8N_INTERNAL_WEBHOOK_BASE_URL` and `N8N_INTERNAL_RUNBOOK_TOKEN` from inside n8n runtime.
3. Smoke each dependency workflow independently before testing the composite workflow.
4. If the response is `ERROR`, inspect `failed_step` and `steps`; do not search execution history for the password.
5. If `password_changed: true` and `notification_sent: false`, handle notification manually through the customer-approved password delivery process.

## Rollback

Deactivate `AD: обработка заявки на смену пароля` in n8n. Already changed passwords are not rolled back by workflow deactivation.
