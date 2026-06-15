# AD Password Reset Process Usage

## Purpose

Workflow `AD: обработка заявки на смену пароля` обрабатывает заявку ServiceDesk на смену пароля сотрудника end-to-end.

Ранбук mutating: он проверяет заявителя, подтверждает руководителя по кадровой выгрузке, находит сотрудника и руководителя в AD, меняет пароль сотруднику, отправляет новый пароль руководителю по шаблону `ad_password_reset_notification` и возвращает результаты всех завершенных шагов без самого пароля.

## Contract

- Workflow export: `workflows/ad-password-reset-process-webhook.json`
- Endpoint: `POST http://127.0.0.1:5678/webhook/ad/password-reset/process`
- OpenAPI operationId: `processAdPasswordResetRequest`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`

Request:

```json
{
  "service_request": "12345678",
  "applicant_full_name": "Петров Петр Петрович",
  "employee_full_name": "Иванов Иван Иванович",
  "claimed_manager_full_name": "Петров Петр Петрович",
  "approval_id": "approval-123",
  "approved_by": "service-desk-supervisor",
  "idempotency_key": "case-123:password-reset"
}
```

Accepted aliases:

- `serviceRequest` for `service_request`
- `applicantFullName` for `applicant_full_name`
- `employeeFullName` for `employee_full_name`
- `claimedManagerFullName` for `claimed_manager_full_name`
- `approvalId` for `approval_id`
- `approvedBy` for `approved_by`
- `idempotencyKey` for `idempotency_key`

## Response

Successful processing:

```json
{
  "status": "OK",
  "service_request": "12345678",
  "approval_id": "approval-123",
  "approved_by": "service-desk-supervisor",
  "idempotency_key": "case-123:password-reset",
  "password_changed": true,
  "notification_sent": true,
  "steps": {
    "applicant_participant": {
      "status": "OK",
      "matched_role": "manager"
    },
    "manager_verification": {
      "status": "OK",
      "employee_id": "1001",
      "manager_id": "2001"
    },
    "employee_ad_lookup": {
      "status": "OK",
      "login": "iivanov",
      "email": "iivanov@example.ru"
    },
    "manager_ad_lookup": {
      "status": "OK",
      "login": "ppetrov",
      "email": "ppetrov@example.ru"
    },
    "password_reset": {
      "status": "OK",
      "login": "iivanov",
      "password_length": 12,
      "change_on_first_login": true
    },
    "notification": {
      "status": "sent",
      "to": "ppetrov@example.ru",
      "templateId": "ad_password_reset_notification"
    }
  }
}
```

The generated password is intentionally absent from the response.

Business or dependency error:

```json
{
  "status": "ERROR",
  "service_request": "12345678",
  "approval_id": "approval-123",
  "approved_by": "service-desk-supervisor",
  "idempotency_key": "case-123:password-reset",
  "error_code": "notification_email_send_failed",
  "failed_step": "notification",
  "message": "Пароль изменен, но endpoint отправки письма не подтвердил отправку.",
  "password_changed": true,
  "notification_sent": false,
  "steps": {
    "password_reset": {
      "status": "OK",
      "login": "iivanov",
      "password_length": 12,
      "change_on_first_login": true
    }
  }
}
```

If the workflow fails after password reset, it does not roll back the old password. It returns `ERROR`, `password_changed: true`, `notification_sent: false`, and sanitized completed step results.

## Common Errors

- `401 unauthorized` - absent or invalid `X-ServiceDesk-Token`.
- `400 missing_service_request` - request does not contain `service_request` or `serviceRequest`.
- `400 missing_applicant_full_name` - request does not contain applicant full name.
- `400 missing_employee_full_name` - request does not contain employee full name.
- `400 missing_claimed_manager_full_name` - request does not contain claimed manager full name.
- `400 missing_approval_id` - request does not contain upstream approval identifier.
- `400 missing_approved_by` - request does not contain approver identity.
- `400 missing_idempotency_key` - request does not contain caller idempotency key.
- `500 invalid_internal_webhook_base_url` - internal n8n webhook base URL is not configured as an `http/https` URL.
- `500 missing_internal_runbook_token` - `N8N_INTERNAL_RUNBOOK_TOKEN` is not configured for the internal AD reset call.
- `applicant_participant_*` - applicant did not match employee or manager, or applicant check failed.
- `manager_verification_*` - HR data did not confirm the manager or did not return tabular numbers.
- `employee_ad_lookup_*` - employee AD lookup failed or did not return login.
- `manager_ad_lookup_*` - manager AD lookup failed or did not return email.
- `password_reset_*` - employee password reset failed.
- `notification_*` - password was changed but email notification to manager failed.

## Dependency Chain

1. `verifyApplicantParticipant`
2. `verifyEmployeeManager`
3. `lookupAdUserLogin` for employee
4. `lookupAdUserLogin` for manager
5. `resetAdUserPassword` for employee login
6. `sendTemplatedEmail` to manager email with template `ad_password_reset_notification`

All internal calls use `N8N_WEBHOOK_TOKEN` from the n8n runtime and the administrator-configured internal webhook base URL. The AD reset step additionally uses `N8N_INTERNAL_RUNBOOK_TOKEN` in `X-ServiceDesk-Internal-Token`. The workflow propagates `idempotency_key` to internal calls as an `Idempotency-Key` header; the upstream caller must still treat the key as the stable identifier for retries.
