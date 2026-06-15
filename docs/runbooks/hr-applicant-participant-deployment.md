# HR Applicant Participant Deployment

## Import And Activation

1. Regenerate the workflow export after changing applicant matching logic:

```bash
node scripts/build-hr-applicant-participant-workflow.mjs
node scripts/build-contract-workflow.mjs
```

2. Import `workflows/hr-applicant-participant-webhook.json` into n8n.
3. Confirm the workflow name is `HR: проверка заявителя среди участников`.
4. Activate or publish the workflow.
5. Restart n8n if webhook registration or environment variables changed.

## Runtime Requirements

- `N8N_WEBHOOK_TOKEN` is required. Callers pass it in `X-ServiceDesk-Token`.
- No HR, AD, database or mail credentials are required.
- `N8N_WORKFLOW_DEBUG=off` by default. Use `Basic` temporarily for safe diagnostics; use `Verbose` only during isolated troubleshooting.
- Production HTTP exposure should use HTTPS through the administrator-selected n8n webhook base URL.
- Logs must go through the standard n8n structured logging/runtime pipeline: stdout/stderr plus the operational second sink accepted for the project or customer contour.

## Smoke Checks

Static checks:

```bash
node --check scripts/build-hr-applicant-participant-workflow.mjs
node scripts/build-hr-applicant-participant-workflow.mjs --check
node scripts/build-contract-workflow.mjs --check
node scripts/apply-workflow-inline-documentation.mjs --check
node scripts/test-contracts.mjs
jq empty workflows/hr-applicant-participant-webhook.json contracts/n8n-openapi.json contracts/n8n-openapi.locales.json contracts/n8n-workflow-catalog.json
```

Runtime auth-negative check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/hr/verify-applicant-participant \
  -H 'Content-Type: application/json' \
  -d '{"applicant_full_name":"Иванов Иван Иванович","employee_full_name":"Иванов Иван Иванович","manager_full_name":"Петров Петр Петрович"}'
```

Expected result: HTTP `401` with `unauthorized`.

Runtime OK check where applicant is employee:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/hr/verify-applicant-participant \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"applicant_full_name":"  Иванов   Иван Иванович  ","employee_full_name":"иванов иван иванович","manager_full_name":"Петров Петр Петрович"}' | jq .
```

Expected result: HTTP `200`, `status: OK`, `matched_role: employee`.

Runtime OK check where applicant is manager:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/hr/verify-applicant-participant \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"applicantFullName":"Петров Петр Петрович","employeeFullName":"Иванов Иван Иванович","managerFullName":"Петров Петр Петрович"}' | jq .
```

Expected result: HTTP `200`, `status: OK`, `matched_role: manager`.

Runtime business-negative check:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/hr/verify-applicant-participant \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"applicant_full_name":"Сидоров Сидор Сидорович","employee_full_name":"Иванов Иван Иванович","manager_full_name":"Петров Петр Петрович"}' | jq .
```

Expected result: HTTP `200`, `status: ERROR`, `error_code: applicant_not_participant`.

## Debugging

1. Run auth-negative smoke first to prove the webhook is registered and token protection works.
2. Run missing-field smoke to prove validation branch works.
3. Run both OK branches and the business-negative branch.
4. Temporarily set `N8N_WORKFLOW_DEBUG=Basic` and restart n8n. Diagnostics intentionally mask full names and tokens.
5. If callers expect fuzzy matching, initials, transliteration or source-system identity checks, route the case to HR/AD lookup workflows instead of changing this runbook silently.

## Rollback

Deactivate `HR: проверка заявителя среди участников` in n8n. The workflow is read-only and has no persistent side effects.
