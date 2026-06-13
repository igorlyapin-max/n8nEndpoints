# Update Zabbix Problem Usage

## Назначение

Workflow `Zabbix: обновление problem по URL` добавляет сообщение в Zabbix problem event по URL из веб-интерфейса Zabbix.

Он не ищет проблему по имени и не замещает старые комментарии. Workflow парсит `eventid` и `triggerid` из URL, проверяет problem через `problem.get`, затем добавляет новое сообщение через `event.acknowledge`.

Endpoint не идемпотентный: каждый успешный вызов добавляет новую запись в историю Zabbix problem.

## Caller Contract

- Workflow export: `workflows/update-zabbix-problem-webhook.json`
- Production endpoint: `POST http://127.0.0.1:5678/webhook/zabbix/problem/update`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- OpenAPI operationId: `updateZabbixProblem`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`
- Content type: `application/json`

Body:

```json
{
  "problemUrl": "http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528",
  "message": "Создано обращение провайдеру: ГКМ Наряд № 12345678"
}
```

`problem_url` принимается как alias для `problemUrl`. URL должен использовать только `http` или `https` и не должен содержать username/password.

`message` обязателен, не может быть пустым и не может быть длиннее 2000 символов. `request_id` и `requestId` не входят в контракт: deduplication выполняется на стороне вызывающего процесса, если он повторяет вызов.

## Поведение

1. Workflow извлекает `zabbix_origin`, `eventid` и `triggerid` из `problemUrl`.
2. По `zabbix_origin` ищет API token в `ZABBIX_API_TOKENS_BY_ORIGIN`.
3. Опционально по `zabbix_origin` ищет override API URL в `ZABBIX_API_URLS_BY_ORIGIN`.
4. Вызывает Zabbix `problem.get` по `eventid`.
5. Проверяет, что `problem.objectid` совпадает с `triggerid`.
6. Формирует сообщение без собственного префикса даты/времени:

```text
{{Message}}
```

7. Вызывает `event.acknowledge` с `action: 4`, чтобы добавить message. Дату и время операции отображает Zabbix.

## Ответы

Successful update:

```json
{
  "status": "updated",
  "eventid": "90528",
  "triggerid": "61119",
  "zabbix_origin": "http://localhost:8081",
  "message": "Создано обращение провайдеру: ГКМ Наряд № 12345678\n"
}
```

Ошибки:

- `401 unauthorized` - отсутствует или неверен `X-ServiceDesk-Token`.
- `400 missing_problem_url` - не указан `problemUrl`.
- `400 invalid_problem_url` - `problemUrl` не является корректным URL, использует не `http/https` или содержит credentials.
- `400 missing_eventid` - в URL нет `eventid`.
- `400 missing_triggerid` - в URL нет `triggerid`.
- `400 missing_message` - не указан текст сообщения.
- `400 message_too_long` - `message` длиннее 2000 символов.
- `400 invalid_zabbix_registry` - `ZABBIX_API_TOKENS_BY_ORIGIN` или `ZABBIX_API_URLS_BY_ORIGIN` не являются JSON object.
- `400 unknown_zabbix_origin` - нет token для `zabbix_origin`.
- `404 zabbix_problem_not_found` - Zabbix не нашел problem по `eventid`.
- `409 trigger_mismatch` - problem найден, но не относится к `triggerid` из URL.
- `502 zabbix_problem_get_failed` - не удалось выполнить `problem.get`; детали upstream Zabbix ошибки наружу не возвращаются.
- `502 zabbix_event_acknowledge_failed` - не удалось выполнить `event.acknowledge`; детали upstream Zabbix ошибки наружу не возвращаются.

## Safety Policy

Workflow только добавляет message к problem event. Он не закрывает problem, не меняет severity и не suppress-ит событие.
