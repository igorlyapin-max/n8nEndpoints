# HR Applicant Participant Usage

## Purpose

Workflow `HR: проверка заявителя среди участников` проверяет, что ФИО заявителя совпадает с ФИО сотрудника или ФИО руководителя, переданными в том же запросе.

Ранбук read-only и не обращается к HR, AD или другим внешним системам. Он предназначен для быстрой проверки права заявителя выступать от имени пары сотрудник-руководитель, когда сами ФИО уже известны вызывающей системе.

## Contract

- Workflow export: `workflows/hr-applicant-participant-webhook.json`
- Endpoint: `POST http://127.0.0.1:5678/webhook/hr/verify-applicant-participant`
- OpenAPI operationId: `verifyApplicantParticipant`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`

Request:

```json
{
  "applicant_full_name": "Иванов Иван Иванович",
  "employee_full_name": "Иванов Иван Иванович",
  "manager_full_name": "Петров Петр Петрович"
}
```

Accepted aliases:

- `applicantFullName` for `applicant_full_name`
- `employeeFullName` for `employee_full_name`
- `managerFullName` for `manager_full_name`

## Response

Applicant is employee:

```json
{
  "status": "OK",
  "matched_role": "employee",
  "applicant_full_name": "Иванов Иван Иванович",
  "employee_full_name": "Иванов Иван Иванович",
  "manager_full_name": "Петров Петр Петрович"
}
```

Applicant is manager:

```json
{
  "status": "OK",
  "matched_role": "manager",
  "applicant_full_name": "Петров Петр Петрович",
  "employee_full_name": "Иванов Иван Иванович",
  "manager_full_name": "Петров Петр Петрович"
}
```

If all three normalized names are the same, the response is `OK` with `matched_role: "both"`.

Business errors are returned with HTTP `200` and `status: ERROR`:

```json
{
  "status": "ERROR",
  "error_code": "applicant_not_participant",
  "message": "Заявитель не совпадает ни с сотрудником, ни с руководителем.",
  "applicant_full_name": "Сидоров Сидор Сидорович",
  "employee_full_name": "Иванов Иван Иванович",
  "manager_full_name": "Петров Петр Петрович"
}
```

## Common Errors

- `401 unauthorized` - absent or invalid `X-ServiceDesk-Token`.
- `400 missing_applicant_full_name` - request does not contain applicant full name.
- `400 missing_employee_full_name` - request does not contain employee full name.
- `400 missing_manager_full_name` - request does not contain manager full name.
- `400 full_name_too_long` - one of the full-name fields is longer than 300 characters.
- `400 invalid_full_name` - one of the full-name fields contains control characters.
- `applicant_not_participant` - applicant does not match employee or manager after normalization.

## Matching Rules

Each full name is normalized by trimming leading/trailing spaces, collapsing repeated whitespace and lowercasing with Russian locale.

The workflow does not do fuzzy matching, transliteration, initials expansion, person lookup, duplicate-name handling or employee-id comparison. Use `verifyEmployeeManager` or HR/AD lookup workflows before this runbook when the caller must prove that the names exist in source systems.
