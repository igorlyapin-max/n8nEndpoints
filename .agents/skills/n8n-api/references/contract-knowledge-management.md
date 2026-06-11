# Contract Knowledge Management

Use this reference when changing any public n8n adapter contract in `/home/lsk/projects/n8n`.

## What Counts As A Contract

- n8n webhook path or method.
- Required auth header or token semantics.
- Request payload fields, required fields, accepted aliases, validation rules, and unsupported fields.
- Response body shape and HTTP status codes.
- JSON Schema, OpenAPI, workflow catalog, or any file consumed by external applications.
- Human-facing usage/deployment docs that external integrators or operators use to call the workflow.

## Required Parallel Updates

For every contract change, update all applicable homes in the same delivery slice:

- Workflow export under `workflows/`.
- Machine-readable contract under `contracts/` when an external application must discover parameters.
- `contracts/n8n-openapi.json` is the source of truth for externally callable n8n webhook discovery.
- `workflows/contracts-openapi-webhook.json` must be regenerated with `node scripts/build-contract-workflow.mjs` after `contracts/n8n-openapi.json` changes.
- Workflow catalog under `contracts/n8n-workflow-catalog.json` when capability, operation, endpoint, or discoverability changes.
- Usage/deployment docs under `docs/runbooks/`.
- Project-local skill or reference when the change affects future Codex behavior, repeated commands, source-of-truth mapping, runtime ports, or webhook conventions.

## Source-Of-Truth Rules

- Use machine-readable contracts for external application discovery.
- External applications discover the contract at `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`.
- Execution endpoints stay separate from the discovery endpoint and remain protected by `X-ServiceDesk-Token` when they perform actions.
- Use runbook docs for operators and human integrators.
- Use workflow exports for n8n import/runtime behavior.
- Use project-local skills only for agent behavior and project-specific working rules.
- Avoid copying large schemas into `SKILL.md`; link to repository files or summarize the rule here.

## Readiness Checklist

- Contract URL or file is documented.
- Execution URL is separate from contract/discovery URL.
- Auth header and token source are explicit.
- Request and response examples match the workflow implementation.
- Negative cases are documented when the workflow returns structured errors.
- Smoke checks cover unauthorized and happy-path behavior when auth is involved.
