---
name: runbook-documentation
description: "Project-local documentation rule for /home/lsk/projects/n8n. Use when Codex creates, changes, reviews, or plans any runbook, n8n workflow, webhook action, operational automation, or workflow catalog entry so every runbook has both usage and deployment instructions."
---

# Runbook Documentation

## Readiness Rule

- Do not consider a runbook or operational workflow ready if its workflow JSON exists but usage and deployment instructions are missing.
- Do not consider a runbook or operational workflow ready if its workflow JSON lacks inline workflow documentation: top-level `description` plus one Sticky Note for every functional node.
- Apply this to new runbooks, changed runbooks, webhook workflows, action workflows, and workflow catalog additions.
- Keep README as overview when documentation grows. Put operator procedures in dedicated runbook docs.
- When a runbook change modifies public parameters, payload schemas, endpoint paths, auth headers, response shapes, or workflow catalog entries, use `knowledge-management` in parallel and update the project-local n8n contract reference.
- For workflow inline documentation details, read `references/workflow-inline-documentation.md`.

## Usage Instruction

For each runbook, document how a caller uses it:

- purpose and audience;
- tool name or webhook endpoint;
- required headers and auth model;
- request payload and required fields;
- normal response shape;
- common error responses;
- safety or approval policy before execution.

## Deployment Instruction

For each runbook, document how an operator deploys it:

- workflow export path and import steps;
- required environment variables;
- required n8n credentials and where to bind them in the workflow;
- activation steps;
- smoke checks, including auth-negative and happy-path checks;
- rollback or deactivation steps.

## Documentation Placement

- Prefer `docs/runbooks/<runbook-id>-usage.md` and `docs/runbooks/<runbook-id>-deployment.md` once there is more than one runbook or the instructions exceed a short README section.
- A short README section is acceptable only for a small single-runbook setup.
- Do not duplicate full workflow JSON, large schemas, or secrets in docs. Link to workflow exports and catalog entries instead.

## Review Checklist

- Confirm usage and deployment instructions exist for every changed runbook.
- Confirm workflow exports contain a workflow-level `description` that explains the runbook logic and debugging path.
- Confirm every non-Sticky-Note node has exactly one Sticky Note explaining what it does, what it relies on, and expected error/branch behavior.
- Confirm instructions name the exact workflow path, endpoint/tool name, env vars, credential binding, and smoke checks.
- Confirm any changed public contract is synchronized with `workflows/`, `contracts/`, runbook docs, and `.agents/skills/n8n-api/references/contract-knowledge-management.md` when the agent working rule changes.
- Treat missing instructions as a P0 delivery blocker for runbook work in this repository.
- Treat missing workflow `description` or node Sticky Notes as a P0 delivery blocker for runbook work in this repository.
