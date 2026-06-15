# Contract Discovery Deployment

## Import And Activation

1. Update `contracts/n8n-openapi.json` when public webhook parameters, paths, auth, request schemas, or response schemas change.
   For runbooks, this includes changes to `invocation.extensions.async_callback`, result transport semantics, and response correlation fields.
   Update `contracts/n8n-openapi.locales.json` when OpenAPI `summary`, `description`, `title`, response descriptions, or example summaries change.
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

If the Zabbix problem status workflow changed, regenerate it too:

```bash
node scripts/build-zabbix-problem-status-workflow.mjs
```

If the Zabbix problem wait workflow changed, regenerate it too:

```bash
node scripts/build-zabbix-problem-wait-workflow.mjs
```

If the stage4 runbook async delivery changed, regenerate it too:

```bash
node scripts/build-stage4-runbook-workflow.mjs
```

If the CMDBuild provider context workflow changed, regenerate it too:

```bash
node scripts/build-cmdbuild-provider-context-workflow.mjs
```

If the HR manager verification workflow changed, regenerate it too:

```bash
node scripts/build-hr-verify-manager-workflow.mjs
```

If the AD password reset workflow changed, regenerate it too:

```bash
node scripts/build-ad-password-reset-workflow.mjs
```

If the AD password reset process workflow changed, regenerate it too:

```bash
node scripts/build-ad-password-reset-process-workflow.mjs
```

If the provider channel repair monitor workflow changed, regenerate it too:

```bash
node scripts/build-provider-channel-repair-monitor-workflow.mjs
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
- Contract discovery supports `?lang=en` and `?lang=ru`; omitted `lang` defaults to `en`.
- Action endpoints described in the contract still require `X-ServiceDesk-Token`.
- `contracts/n8n-openapi.json` publishes `x-transport-security`: administrators choose the concrete HTTP URLs through runtime configuration; production HTTP webhook/callback URLs should be HTTPS.
- Kafka result delivery is secured through Kafka credentials and broker controls, not HTTPS. Production Kafka credentials must use `SASL_SSL` or `SSL` with mTLS unless the customer security policy explicitly approves another transport.

## Smoke Checks

Static checks:

```bash
node --check scripts/build-contract-workflow.mjs
node --check scripts/build-stage4-runbook-workflow.mjs
node --check scripts/build-email-template-workflows.mjs
node --check scripts/build-email-wait-runbook-workflows.mjs
node --check scripts/build-cmdbuild-provider-context-workflow.mjs
node --check scripts/build-hr-verify-manager-workflow.mjs
node --check scripts/build-ad-password-reset-workflow.mjs
node --check scripts/build-ad-password-reset-process-workflow.mjs
node --check scripts/build-zabbix-problem-workflow.mjs
node --check scripts/build-zabbix-problem-status-workflow.mjs
node --check scripts/build-zabbix-problem-wait-workflow.mjs
node --check scripts/build-provider-channel-repair-monitor-workflow.mjs
node --check scripts/apply-workflow-inline-documentation.mjs
node scripts/build-contract-workflow.mjs --check
node scripts/build-stage4-runbook-workflow.mjs --check
node scripts/build-email-template-workflows.mjs --check
node scripts/build-email-wait-runbook-workflows.mjs --check
node scripts/build-cmdbuild-provider-context-workflow.mjs --check
node scripts/build-hr-verify-manager-workflow.mjs --check
node scripts/build-ad-password-reset-workflow.mjs --check
node scripts/build-ad-password-reset-process-workflow.mjs --check
node scripts/build-zabbix-problem-workflow.mjs --check
node scripts/build-zabbix-problem-status-workflow.mjs --check
node scripts/build-zabbix-problem-wait-workflow.mjs --check
node scripts/build-provider-channel-repair-monitor-workflow.mjs --check
node scripts/apply-workflow-inline-documentation.mjs --check
node scripts/test-contracts.mjs
jq empty contracts/n8n-openapi.json contracts/n8n-openapi.locales.json workflows/contracts-openapi-webhook.json contracts/n8n-workflow-catalog.json contracts/email-template-catalog.json contracts/email-template-catalog.schema.json workflows/stage4-runbook-webhook.json workflows/send-templated-email-webhook.json workflows/email-ticket-mailbox-collector.json workflows/wait-for-email-ticket-webhook.json workflows/cmdbuild-provider-email-context-webhook.json workflows/hr-find-manager.json workflows/ad-password-reset-webhook.json workflows/ad-password-reset-process-webhook.json workflows/update-zabbix-problem-webhook.json workflows/get-zabbix-problem-status-webhook.json workflows/wait-zabbix-problem-status-webhook.json workflows/provider-channel-repair-monitor-webhook.json
```

Runtime checks:

```bash
curl -fsS http://127.0.0.1:5678/healthz
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json | jq '.openapi,.paths'
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json?lang=en | jq '.info.description'
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json?lang=ru | jq '.info.description'
curl -i http://127.0.0.1:5678/webhook/contracts/openapi.json?lang=de
```

Source-of-truth drift check:

```bash
curl -fsS http://127.0.0.1:5678/webhook/contracts/openapi.json -o /tmp/n8n-openapi-live.json
jq -S . contracts/n8n-openapi.json > /tmp/n8n-openapi-local.sorted.json
jq -S . /tmp/n8n-openapi-live.json > /tmp/n8n-openapi-live.sorted.json
diff -u /tmp/n8n-openapi-local.sorted.json /tmp/n8n-openapi-live.sorted.json
```

The drift check intentionally uses the default English response. The Russian response is generated from `contracts/n8n-openapi.locales.json` and should be validated through `node scripts/test-contracts.mjs` plus the `?lang=ru` runtime smoke.

## Rollback

Deactivate `Contracts: OpenAPI discovery` in n8n. Existing execution webhooks continue to work, but external applications will no longer be able to discover the machine-readable contract through n8n.
