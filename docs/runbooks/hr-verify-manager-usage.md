# HR Verify Manager Usage

## Purpose

Workflow `HR: проверка заявленного руководителя` проверяет заявленную пару сотрудник-руководитель по кадровой выгрузке HR OpenAPI.

Ранбук read-only: он не меняет HR данные и возвращает `OK` только когда найден ровно один активный сотрудник, ровно один активный заявленный руководитель, кадровая структура подтверждает прямую связь между ними и найдены табельные номера обоих участников.

## Contract

- Workflow export: `workflows/hr-find-manager.json`
- Endpoint: `POST http://127.0.0.1:5678/webhook/hr/verify-manager`
- OpenAPI operationId: `verifyEmployeeManager`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`

Request:

```json
{
  "employee_full_name": "Иванов Иван Иванович",
  "claimed_manager_full_name": "Петров Петр Петрович",
  "relation_type": "both"
}
```

Accepted aliases:

- `employeeFullName` for `employee_full_name`
- `claimedManagerFullName` for `claimed_manager_full_name`
- `relationType` for `relation_type`
- `legalEntities` for `legal_entities`

`relation_type` is optional and defaults to `both`.

Supported values:

- `administrative` - check direct administrative manager through `/Orgstructure.Administrative`.
- `managerial` - check direct managerial parent position through `/Orgstructure.Managerial`.
- `both` - accept either administrative or managerial confirmation.

`legal_entities` is optional. When omitted, the workflow requests all legal entities allowed by the HR API credential.

## Response

Successful confirmation:

```json
{
  "status": "OK",
  "message": "Проверка OK: Иванов Иван Иванович (ТН 1001) подчиняется Петров Петр Петрович (ТН 2001) по кадровой выгрузке.",
  "employee_id": "1001",
  "manager_id": "2001",
  "relation_type_requested": "both",
  "matched_relation_types": ["managerial"],
  "employee": {
    "full_name": "Иванов Иван Иванович",
    "employee_gid": "employee-1",
    "employee_id": "1001",
    "employee_id_found": true
  },
  "manager": {
    "full_name": "Петров Петр Петрович",
    "employee_gid": "manager-1",
    "employee_id": "2001",
    "employee_id_found": true
  },
  "matched_pairs": [],
  "checked_pairs": []
}
```

`employee_id` is the top-level tabular number of the verified employee and `manager_id` is the top-level tabular number of the verified manager. Both are mandatory for `OK`.

If the HR export confirms the pair but cannot provide the employee tabular number, the endpoint returns business `ERROR`:

```json
{
  "status": "ERROR",
  "error_code": "employee_id_not_found",
  "message": "Табельный номер сотрудника не найден в кадровой выгрузке.",
  "relation_type_requested": "both",
  "matched_relation_types": ["managerial"],
  "employee": {
    "full_name": "Иванов Иван Иванович",
    "employee_gid": "employee-1",
    "employee_id": null,
    "employee_id_found": false
  },
  "manager": {
    "full_name": "Петров Петр Петрович",
    "employee_gid": "manager-1",
    "employee_id": "2001",
    "employee_id_found": true
  },
  "matched_pairs": [],
  "checked_pairs": []
}
```

If the HR export confirms the pair but cannot provide the manager tabular number, the endpoint returns business `ERROR`:

```json
{
  "status": "ERROR",
  "error_code": "manager_id_not_found",
  "message": "Табельный номер руководителя не найден в кадровой выгрузке.",
  "relation_type_requested": "both",
  "matched_relation_types": ["managerial"],
  "employee": {
    "full_name": "Иванов Иван Иванович",
    "employee_gid": "employee-1",
    "employee_id": "1001",
    "employee_id_found": true
  },
  "manager": {
    "full_name": "Петров Петр Петрович",
    "employee_gid": "manager-1",
    "employee_id": null,
    "employee_id_found": false
  },
  "matched_pairs": [],
  "checked_pairs": []
}
```

Business errors are returned with HTTP `200` and `status: ERROR`:

```json
{
  "status": "ERROR",
  "error_code": "employee_not_unique",
  "message": "По ФИО сотрудника найдено несколько активных сотрудников.",
  "relation_type_requested": "both",
  "employee_matches": [],
  "manager_matches": [],
  "checked_pairs": []
}
```

## Common Errors

- `401 unauthorized` - absent or invalid `X-ServiceDesk-Token`.
- `400 missing_employee_full_name` - request does not contain employee full name.
- `400 missing_claimed_manager_full_name` - request does not contain claimed manager full name.
- `400 invalid_relation_type` - `relation_type` is not `administrative`, `managerial`, or `both`.
- `500 missing_hr_api_base_url` - n8n process does not have valid `HR_API_BASE_URL`.
- `502 hr_positions_hired_failed` - HR API `/Positions.Hired` failed.
- `502 hr_orgstructure_administrative_failed` - HR API `/Orgstructure.Administrative` failed while administrative check was requested.
- `502 hr_orgstructure_managerial_failed` - HR API `/Orgstructure.Managerial` failed while managerial check was requested.
- `employee_not_found` - no active employee matched the input full name.
- `employee_not_unique` - several active employees matched the employee full name.
- `manager_not_found` - no active manager candidate matched the input full name.
- `manager_not_unique` - several active people matched the manager full name.
- `confirmed_relation_not_found` - employee and manager exist, but the requested relation is not confirmed.
- `employee_id_not_found` - the pair is confirmed, but HR responses did not provide the verified employee tabular number.
- `manager_id_not_found` - the pair is confirmed, but HR responses did not provide the verified manager tabular number.

## Matching Rules

Full names are compared after trimming spaces, collapsing repeated whitespace and lowercasing with Russian locale. The workflow does not do fuzzy matching, transliteration, initials expansion or manual conflict resolution.

When full names are duplicated, the workflow returns `ERROR` with all found candidates and their available identifiers so the caller can escalate or collect a more precise identifier outside this runbook.
