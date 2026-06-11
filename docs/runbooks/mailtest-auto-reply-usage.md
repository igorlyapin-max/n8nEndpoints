# Mailtest Auto Reply Usage

## Purpose

This workflow verifies the customer-independent email loop:

```text
SMTP test message -> GreenMail mailbox -> n8n IMAP trigger -> SMTP auto reply
```

It is intended for local and demo-stand validation when the customer does not provide an Exchange mailbox.

## Mailbox Contract

- Test mailbox: `automation-test@local.test`
- Sender/reply mailbox: `sender@local.test`
- SMTP from host: `127.0.0.1:3025`
- IMAP from host: `127.0.0.1:3143`
- Webmail from host: `http://127.0.0.1:8087/`
- SMTP/IMAP from n8n container: `mailtest:3025` and `mailtest:3143`
- Credentials for local testing: any username/password are accepted because GreenMail auth is disabled; use `automation-test@local.test` / `automation-pass` consistently.

## Webmail

Open:

```text
http://127.0.0.1:8087/
```

Use these test accounts:

- n8n mailbox: `automation-test@local.test` / `automation-pass`
- sender/reply mailbox: `sender@local.test` / `automation-pass`

The n8n mailbox receives test messages and is read by the IMAP trigger. The sender/reply mailbox is used by smoke checks to confirm that an auto reply was sent back.

## Caller Flow

1. Send any test email to `automation-test@local.test`.
2. n8n reads unread messages from `INBOX`.
3. n8n sends an auto reply to the original sender.

The workflow is not proof of Exchange mailbox access. It proves parsing, n8n routing, SMTP send, IMAP receive, and auto-reply behavior without customer credentials.

## Local Smoke

```bash
node scripts/mailtest-smoke.mjs
```

Expected result:

```json
{"status":"ok"}
```

Use `MAILTEST_DEBUG=Basic` or `MAILTEST_DEBUG=Verbose` for structured diagnostic logs. Use `MAILTEST_LOG_FILE=/tmp/mailtest-smoke.ndjson` as an additional NDJSON sink.
