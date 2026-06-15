# Get Zabbix Problem Status Usage

## Назначение

Workflow `Zabbix: статус problem по URL` возвращает read-only статус Zabbix problem по URL из веб-интерфейса Zabbix.

Он не меняет Zabbix. Workflow парсит `eventid` и `triggerid` из URL, пытается прочитать исходный event через `event.get`, а если event уже недоступен, читает текущий trigger через `trigger.get`.

Статусы:

- `problem` - исходный event активен или текущий trigger все еще в problem state.
- `resolved` - исходный event доступен и содержит recovery evidence.
- `ok` - исходный event уже недоступен, но текущий trigger находится в OK state.

## Caller Contract

- Workflow export: `workflows/get-zabbix-problem-status-webhook.json`
- Production endpoint: `POST http://127.0.0.1:5678/webhook/zabbix/problem/status`
- Machine-readable contract: `GET http://127.0.0.1:5678/webhook/contracts/openapi.json`
- OpenAPI operationId: `getZabbixProblemStatus`
- Required header: `X-ServiceDesk-Token: $N8N_WEBHOOK_TOKEN`
- Content type: `application/json`

Body:

```json
{
  "problemUrl": "http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528"
}
```

`problem_url` принимается как alias для `problemUrl`. URL должен использовать только `http` или `https` и не должен содержать username/password.

## Поведение

1. Workflow извлекает `zabbix_origin`, `eventid` и `triggerid` из `problemUrl`.
2. По `zabbix_origin` ищет API token в `ZABBIX_API_TOKENS_BY_ORIGIN`.
3. Опционально по `zabbix_origin` ищет override API URL в `ZABBIX_API_URLS_BY_ORIGIN`.
4. Вызывает Zabbix `event.get` по `eventid`.
5. Если event найден, проверяет `event.objectid === triggerid`.
6. Если event содержит `r_eventid` или `event.value === "0"`, возвращает `resolved`; иначе возвращает `problem`.
7. Если event не найден, вызывает `trigger.get` по `triggerid`.
8. Если `trigger.value === "1"`, возвращает `problem`; иначе возвращает `ok`.

## Ответы

Active problem:

```json
{
  "status": "problem",
  "eventid": "90528",
  "triggerid": "61119",
  "zabbix_origin": "http://localhost:8081",
  "source": "event",
  "problem": {
    "name": "ICMP Ping: Unavailable by ICMP ping",
    "severity": "4",
    "acknowledged": "0",
    "event_value": "1",
    "recovery_eventid": "0",
    "recovery_clock": "0"
  }
}
```

Resolved event:

```json
{
  "status": "resolved",
  "eventid": "90528",
  "triggerid": "61119",
  "zabbix_origin": "http://localhost:8081",
  "source": "event",
  "problem": {
    "event_value": "1",
    "recovery_eventid": "90599",
    "recovery_clock": "1781327999"
  }
}
```

OK fallback:

```json
{
  "status": "ok",
  "eventid": "90528",
  "triggerid": "61119",
  "zabbix_origin": "http://localhost:8081",
  "source": "trigger_fallback",
  "problem": {
    "trigger_value": "0"
  }
}
```

Ошибки:

- `401 unauthorized` - отсутствует или неверен `X-ServiceDesk-Token`.
- `400 missing_problem_url` - не указан `problemUrl`.
- `400 invalid_problem_url` - `problemUrl` не является корректным URL, использует не `http/https` или содержит credentials.
- `400 missing_eventid` - в URL нет `eventid`.
- `400 missing_triggerid` - в URL нет `triggerid`.
- `400 invalid_zabbix_registry` - `ZABBIX_API_TOKENS_BY_ORIGIN` или `ZABBIX_API_URLS_BY_ORIGIN` не являются JSON object.
- `400 unknown_zabbix_origin` - нет token для `zabbix_origin`.
- `404 zabbix_trigger_not_found` - исходный event не найден, и trigger тоже не найден по `triggerid`.
- `409 trigger_mismatch` - event найден, но не относится к `triggerid` из URL.
- `502 zabbix_event_get_failed` - не удалось выполнить `event.get`; детали upstream Zabbix ошибки наружу не возвращаются.
- `502 zabbix_trigger_get_failed` - не удалось выполнить `trigger.get`; детали upstream Zabbix ошибки наружу не возвращаются.

## Safety Policy

Workflow только читает состояние Zabbix. Он не закрывает problem, не добавляет сообщения, не меняет severity и не suppress-ит событие.
