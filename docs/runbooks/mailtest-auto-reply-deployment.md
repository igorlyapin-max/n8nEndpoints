# Mailtest Auto Reply Deployment

## Start GreenMail

From `/home/lsk/projects/n8n`:

```bash
docker compose -f docker-compose.mailtest.yml up -d
```

This starts `n8n-mailtest` on the existing `servicedesk-agents_default` Docker network so the n8n container can reach it as `mailtest`.

The same compose file also starts `n8n-mailtest-webmail`:

```text
http://127.0.0.1:8087/
```

Webmail test accounts:

- n8n mailbox: `automation-test@local.test` / `automation-pass`
- sender/reply mailbox: `sender@local.test` / `automation-pass`

GreenMail auth is disabled in this local stack, but these credentials are used consistently by n8n, smoke checks, and the runbook docs.

## n8n Credentials

Create two n8n credentials:

IMAP:

- Type: `IMAP`
- Host: `mailtest`
- Port: `3143`
- SSL/TLS: disabled
- User: `automation-test@local.test`
- Password: `automation-pass`

SMTP:

- Type: `SMTP`
- Host: `mailtest`
- Port: `3025`
- SSL/TLS: disabled
- Disable STARTTLS: enabled
- User: `automation-test@local.test`
- Password: `automation-pass`

## Import And Activation

1. Import `workflows/mailtest-auto-reply.json`.
2. Check or bind the IMAP credential on node `Получение письма`.
3. Check or bind the SMTP credential on node `Отправка автоответа`.
4. Activate the workflow.
5. Send a test message and confirm an auto reply is generated.

## Smoke Checks

Host-level SMTP/IMAP smoke:

```bash
node scripts/mailtest-smoke.mjs
```

n8n runtime:

```bash
curl -fsS http://127.0.0.1:5678/healthz
```

GreenMail API is exposed for local inspection:

```text
http://127.0.0.1:8086/
```

Roundcube webmail is exposed for browser inspection:

```text
http://127.0.0.1:8087/
```

## Rollback

Deactivate `Mailtest: IMAP автоответ` in n8n and stop GreenMail:

```bash
docker compose -f docker-compose.mailtest.yml down
```
