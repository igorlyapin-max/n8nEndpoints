# HR Verify Manager Deployment

## Import And Activation

1. Regenerate the workflow export after changing HR matching logic:

```bash
node scripts/build-hr-verify-manager-workflow.mjs
```

2. Import `workflows/hr-find-manager.json` into n8n.
3. Confirm the workflow name is `HR: проверка заявленного руководителя`.
4. Configure credential `HR API Header Auth` on every HR HTTP Request node.
5. Activate or publish the workflow.
6. Restart n8n if webhook registration or environment variables changed.

## Runtime Requirements

- `N8N_WEBHOOK_TOKEN` is required. Callers pass it in `X-ServiceDesk-Token`.
- `HR_API_BASE_URL` is required and must be the base URL of HR OpenAPI without trailing query or fragment, for example `https://hr-api.example.ru`.
- `N8N_WORKFLOW_DEBUG=off` by default. Use `Basic` temporarily for safe diagnostics; use `Verbose` only during isolated troubleshooting.
- n8n must be allowed to execute Code nodes that read environment variables.
- n8n must have network access to:
  - `POST $HR_API_BASE_URL/Positions.Hired`
  - `POST $HR_API_BASE_URL/Orgstructure.Administrative`
  - `GET $HR_API_BASE_URL/Orgstructure.Managerial`
  - `POST $HR_API_BASE_URL/Employee.Subordinates.Administrative`
  - `POST $HR_API_BASE_URL/Employee.Subordinates.Managerial`
- Production HTTP exposure should use HTTPS through the administrator-selected n8n webhook base URL.
- Logs must go through the standard n8n structured logging/runtime pipeline: stdout/stderr plus the operational second sink accepted for the project or customer contour.

## Credential

Create or bind an n8n HTTP Header Auth credential:

```text
Credential type: HTTP Header Auth
Credential name: HR API Header Auth
```

Header name/value depends on the customer HR API gateway. Store the secret only in n8n credentials or a corporate secret system. Do not put it in workflow JSON, contract files or examples.

The workflow export contains local credential reference:

```json
{
  "id": "hrApiHeaderAuth",
  "name": "HR API Header Auth"
}
```

After import, verify and rebind it to the production credential if n8n marks the nodes unresolved.

## Smoke Checks

Static checks:

```bash
node --check scripts/build-hr-verify-manager-workflow.mjs
node scripts/build-hr-verify-manager-workflow.mjs --check
node scripts/test-contracts.mjs
jq empty workflows/hr-find-manager.json contracts/n8n-openapi.json contracts/n8n-openapi.locales.json contracts/n8n-workflow-catalog.json
```

Runtime auth-negative check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/hr/verify-manager \
  -H 'Content-Type: application/json' \
  -d '{"employee_full_name":"Иванов Иван Иванович","claimed_manager_full_name":"Петров Петр Петрович"}'
```

Expected result: HTTP `401` with `unauthorized`.

Runtime validation check:

```bash
curl -i -X POST https://n8n.example.ru/webhook/hr/verify-manager \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"employee_full_name":"Иванов Иван Иванович","claimed_manager_full_name":"Петров Петр Петрович","relation_type":"invalid"}'
```

Expected result: HTTP `400` with `invalid_relation_type`.

Runtime happy-path check must use a known test pair from the HR export:

```bash
curl -fsS -X POST https://n8n.example.ru/webhook/hr/verify-manager \
  -H "X-ServiceDesk-Token: ${N8N_WEBHOOK_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"employee_full_name":"<employee full name>","claimed_manager_full_name":"<manager full name>","relation_type":"both"}' | jq .
```

Expected business result: `status: OK`, top-level `employee_id` with the verified employee tabular number, and top-level `manager_id` with the verified manager tabular number. If HR confirms the pair but cannot provide one of the tabular numbers, the response is business `ERROR` with `error_code: employee_id_not_found` or `manager_id_not_found`.

## Debugging

1. Confirm `HR_API_BASE_URL` from inside the n8n runtime container or service.
2. Run auth-negative smoke first to prove the webhook is registered and token protection works.
3. Run validation smoke to prove Code node env access and request validation work.
4. In n8n executions, inspect HTTP status codes for each HR endpoint.
5. Temporarily set `N8N_WORKFLOW_DEBUG=Basic` and restart n8n. Diagnostics intentionally mask tokens and person names.
6. If a duplicate-name response appears, use `employee_matches` and `manager_matches` to identify all active candidates and handle the ambiguity upstream.

## Rollback

Deactivate `HR: проверка заявленного руководителя` in n8n. The workflow is read-only and has no persistent side effects in HR.
