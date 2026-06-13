# Contract Discovery Deployment

## Import And Activation

1. Update `contracts/n8n-openapi.json` when public webhook parameters, paths, auth, request schemas, or response schemas change.
   For runbooks, this includes changes to `invocation.extensions.async_callback`, result transport semantics, and response correlation fields.
2. Regenerate the n8n workflow export:

```bash
node scripts/build-contract-workflow.mjs
```

If the email template catalog changed, regenerate template workflows too:

```bash
node scripts/build-email-template-workflows.mjs
```

If the Zabbix problem update workflow changed, regenerate it too:

```bash
node scripts/build-zabbix-problem-workflow.mjs
```

If the stage4 runbook async delivery changed, regenerate it too:

```bash
node scripts/build-stage4-runbook-workflow.mjs
```

3. Import `workflows/contracts-openapi-webhook.json` into n8n.
4. Confirm the workflow name is `Contracts: OpenAPI discovery`.
5. Activate or publish the workflow.
6. Update `contracts/n8n-workflow-catalog.json` when endpoint, operation, result delivery, or discoverability metadata changes.
7. Update usage/deployment runbook docs for the changed endpoint.
8. Restart n8n if the CLI reports that webhook registration changes require restart.

Production contract path:

```text
http://127.0.0.1:5678/webhook/contracts/openapi.json
```

## Runtime Requirements

- n8n must expose the production webhook base `http://127.0.0.1:5678/webhook`.
- Contract discovery does not require `N8N_WEBHOOK_TOKEN`.
- Action endpoints described in the contract still require `X-ServiceDesk-Token`.

## Smoke Checks

Static checks:

```bash
node --check scripts/build-contract-workflow.mjs
node --check scripts/build-stage4-runbook-workflow.mjs
node --check scripts/build-email-template-workflows.mjs
node --check scripts/build-zabbix-problem-workflow.mjs
node scripts/build-contract-workflow.mjs --check
node scripts/build-stage4-runbook-workflow.mjs --check
node scripts/build-email-template-workflows.mjs --check
node scripts/build-zabbix-problem-workflow.mjs --check
node scripts/test-contracts.mjs
jq empty contracts/n8n-openapi.json workflows/contracts-openapi-webhook.json contracts/n8n-workflow-catalog.json contracts/email-template-catalog.json contracts/email-template-catalog.schema.json workflows/stage4-runbook-webhook.json workflows/send-templated-email-webhook.json workflows/update-zabbix-problem-webhook.json
```

Runtime checks:

```bash
curl -fsS http://127.0.0.1:5678/healthz
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json | jq '.openapi,.paths'
```

Source-of-truth drift check:

```bash
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json -o /tmp/n8n-openapi-live.json
jq -S . contracts/n8n-openapi.json > /tmp/n8n-openapi-local.sorted.json
jq -S . /tmp/n8n-openapi-live.json > /tmp/n8n-openapi-live.sorted.json
diff -u /tmp/n8n-openapi-local.sorted.json /tmp/n8n-openapi-live.sorted.json
```

## Rollback

Deactivate `Contracts: OpenAPI discovery` in n8n. Existing execution webhooks continue to work, but external applications will no longer be able to discover the machine-readable contract through n8n.
