# Email Template Catalog Deployment

## Предусловия

- n8n UI доступен по `http://127.0.0.1:5678`.
- Каталог шаблонов обновлен в `contracts/email-template-catalog.json`.
- OpenAPI contract обновлен в `contracts/n8n-openapi.json`.
- Workflow catalog обновлен в `contracts/n8n-workflow-catalog.json`.

## Генерация

После изменения каталога шаблонов выполните:

```bash
node scripts/build-email-template-workflows.mjs
node scripts/build-contract-workflow.mjs
```

Проверка drift перед импортом:

```bash
node scripts/build-email-template-workflows.mjs --check
node scripts/build-contract-workflow.mjs --check
jq empty contracts/email-template-catalog.json contracts/email-template-catalog.schema.json contracts/n8n-openapi.json contracts/n8n-workflow-catalog.json
```

## Импорт

1. Откройте n8n UI: `http://127.0.0.1:5678`.
2. Импортируйте `workflows/email-template-catalog-webhook.json`.
3. Убедитесь, что workflow называется `Contracts: Email template catalog`.
4. Активируйте workflow.
5. Если import/publish сообщает о необходимости обновить webhook registration, перезапустите n8n.

Workflow не требует credentials и не требует `N8N_WEBHOOK_TOKEN`, потому что он только публикует контрактный каталог.

## Smoke

```bash
curl -fsS http://127.0.0.1:5678/healthz
curl -fsS http://127.0.0.1:5678/webhook/contracts/email-templates.json | jq '.schema_version,.templates[].template_id'
```

Ожидаемый результат:

```text
"1.0"
"provider_line_repair_request"
```

## GitHub Dev / GitLab Prod

- Dev: каталог меняется через текущий GitHub repository проекта.
- Production: каталог, schema, workflow exports и OpenAPI contract должны поставляться из GitLab.
- n8n production импортирует workflow exports из GitLab artifact/release, а не из ручных изменений в UI.

## Rollback

Деактивируйте workflow `Contracts: Email template catalog`. Отправка по шаблону продолжит работать с каталогом, встроенным в workflow export, но внешние приложения не смогут discover-ить актуальный список шаблонов через n8n.
