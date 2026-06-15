# AGENTS.md

## Project-Local Knowledge

- Use `.agents/skills` as private project-local knowledge for n8n API, workflow contracts, and runbook documentation.
- Do not treat `.agents/` as an application repository artifact: do not stage, commit, or push it from this repository. Preserve or share local skills only through the separate skills/knowledge preservation procedure.
- Do not read all skills, references, memories, or knowledge files at startup.
- First choose the smallest relevant skill by `name` and `description`.
- Read only the selected `SKILL.md`, then only directly referenced `references/*.md` needed for the task.
- Keep required project rules in this tracked `AGENTS.md` or tracked repository docs; keep long API, workflow, runbook, and payload details in local skill references only when they are agent-private.

## Skill Routing

- Use `$n8n-api` for n8n API, workflow contracts, source-of-truth mapping, and contract knowledge management.
- Use `$runbook-documentation` for runbook docs, workflow inline documentation, and public contract synchronization.
- Use `$runbook-description-editing` when changing runbook names, summaries, descriptions, workflow catalog display names, or human-readable OpenAPI metadata; show the current runbook card and ask the description questions for each runbook.
- Use `$n8n-runbook-conventions` for portable n8n runbook workflow conventions, async n8n webhooks, OpenAPI webhook contracts, and callback/external-event wiring for ServiceDesk-style orchestration.
