---
name: n8n-api
description: "Project-local n8n API and webhook workflow rules for /home/lsk/projects/n8n. Use when Codex works with local n8n UI/API access, webhook workflow exports, n8n REST inspection, workflow catalog entries, webhook tokens, SMTP credentials in n8n, smoke checks, or public contract changes for this repository."
---

# n8n API

## Runtime

- Treat n8n as the local integration adapter for this repository.
- Default UI: `http://127.0.0.1:5678`.
- Default production webhook base: `http://127.0.0.1:5678/webhook`.
- Use `/healthz` for the lightweight runtime check.
- Expect a production webhook to return `404` until the workflow is imported and activated.

## Authentication

- Use owner credentials only for local UI or local REST inspection when the user has provided them.
- Do not put owner credentials into application scripts, workflow payloads, or repo docs beyond local setup notes already requested by the user.
- Webhook calls use `X-ServiceDesk-Token` and validate against `N8N_WEBHOOK_TOKEN` in the n8n runtime.
- Application-side scripts pass only the webhook token and payload. Service credentials such as SMTP stay in n8n credentials.

## Workflow Lifecycle

- Store workflow exports under `workflows/`.
- Register workflow capabilities in `contracts/n8n-workflow-catalog.json` when they are part of the adapter contract.
- Keep large payload examples and human-facing setup details in repository docs, not in this skill.
- After importing a workflow into n8n, bind required node credentials in the UI, set required environment variables, activate the workflow, and run a smoke test.

## Contract Knowledge Gate

- Treat webhook paths, auth headers, request/response payloads, JSON Schemas, workflow catalog entries, and externally consumed docs as public contracts.
- When any public contract changes, use `knowledge-management` in parallel with this skill and update the smallest useful project-local knowledge source.
- Keep `SKILL.md` concise; place contract rules, source-of-truth mapping, and longer examples in `references/contract-knowledge-management.md`.
- Do not consider a public contract change ready until workflow JSON, machine-readable contract files, human docs, and project-local skill/reference guidance agree.

## Webhook Smoke Checks

- Verify n8n is up with `curl -fsS http://127.0.0.1:5678/healthz`.
- Verify unauthorized webhook calls return `401` when a workflow performs token checks.
- Verify activated happy paths return the workflow's normalized `200` response.
- If a local Node.js process cannot connect to `127.0.0.1` with `EPERM` inside sandbox, rerun the same smoke command with approval outside sandbox rather than changing the implementation.

## Safety Rules

- Do not let the LLM/orchestrator call n8n directly in production flows; preserve the project boundary through Tool Registry and Integration Dispatcher unless the user explicitly asks for a local diagnostic call.
- Do not move secrets from n8n credentials into scripts or workflow JSON.
- Keep debug/diagnostic logging safe: no tokens, passwords, full message bodies, or unmasked sensitive values in logs.
