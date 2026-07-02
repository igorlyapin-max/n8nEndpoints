#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const [workflowPath, workflowIdArg] = process.argv.slice(2);

if (!workflowPath) {
  console.error('Usage: node scripts/publish-generated-workflow.mjs <workflow-json-path> [workflow-id]');
  process.exit(2);
}

const postgresContainer = process.env.N8N_POSTGRES_CONTAINER || 'servicedesk-agents-postgres';
const postgresUser = process.env.N8N_DB_USER || 'n8n';
const postgresDb = process.env.N8N_DB_NAME || 'n8n';
const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
const workflowId = workflowIdArg || workflow.id;

if (!workflowId) {
  console.error('Workflow id is required: pass it as the second argument or include id in workflow JSON.');
  process.exit(2);
}
if (!Array.isArray(workflow.nodes) || !workflow.connections || typeof workflow.connections !== 'object') {
  console.error(`${workflowPath} does not look like an n8n workflow export with nodes/connections.`);
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || '';
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

const escapedWorkflowId = workflowId.replace(/'/g, "''");
const payload = JSON.stringify({
  nodes: workflow.nodes,
  connections: workflow.connections,
  active: Boolean(workflow.active),
}).replace(/'/g, "''");
const sql = `
do $$
declare
  workflow_updates integer := 0;
  history_updates integer := 0;
  active_version_id text := null;
begin
  with payload as (
    select '${payload}'::jsonb as value
  )
  update workflow_entity
  set
    nodes = (select value->'nodes' from payload)::json,
    connections = (select value->'connections' from payload)::json,
    active = coalesce((select (value->>'active')::boolean from payload), active),
    "updatedAt" = now()
  where id = '${escapedWorkflowId}'
  returning "activeVersionId"::text into active_version_id;

  get diagnostics workflow_updates = row_count;
  if workflow_updates <> 1 then
    raise exception 'Expected exactly one workflow_entity row for %, updated %', '${escapedWorkflowId}', workflow_updates;
  end if;
  if active_version_id is null or active_version_id = '' then
    raise exception 'Workflow % does not have activeVersionId', '${escapedWorkflowId}';
  end if;

  with payload as (
    select '${payload}'::jsonb as value
  )
  update workflow_history
  set
    nodes = (select value->'nodes' from payload)::json,
    connections = (select value->'connections' from payload)::json,
    "updatedAt" = now()
  where "versionId"::text = active_version_id;

  get diagnostics history_updates = row_count;
  if history_updates <> 1 then
    raise exception 'Expected exactly one workflow_history row for activeVersionId %, updated %', active_version_id, history_updates;
  end if;
end $$;

select json_build_object(
  'workflow_id', '${escapedWorkflowId}',
  'workflow_updates', 1,
  'history_updates', 1,
  'active_version_id', (select "activeVersionId" from workflow_entity where id = '${escapedWorkflowId}')
)::text;
`;

const output = run(
  'docker',
  [
    'exec',
    '-i',
    postgresContainer,
    'psql',
    '-U',
    postgresUser,
    '-d',
    postgresDb,
    '-v',
    'ON_ERROR_STOP=1',
  ],
  { input: sql },
);
process.stdout.write(output);
