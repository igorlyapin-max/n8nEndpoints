import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export class McpManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpManifestError';
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadMcpToolManifest(options = {}) {
  const cwd = options.cwd || process.cwd();
  const manifestPath = resolve(
    cwd,
    options.manifestPath || process.env.MCP_PROVIDER_OPS_MANIFEST_PATH || 'contracts/mcp-tool-manifest.json',
  );
  const manifest = readJson(manifestPath);
  const openapiPath = resolve(
    cwd,
    options.openapiPath
      || process.env.MCP_PROVIDER_OPS_OPENAPI_PATH
      || manifest.source_contracts?.openapi
      || 'contracts/n8n-openapi.json',
  );
  const workflowCatalogPath = resolve(
    cwd,
    options.workflowCatalogPath
      || process.env.MCP_PROVIDER_OPS_WORKFLOW_CATALOG_PATH
      || manifest.source_contracts?.workflow_catalog
      || 'contracts/n8n-workflow-catalog.json',
  );
  const openapi = readJson(openapiPath);
  const workflowCatalog = readJson(workflowCatalogPath);
  validateMcpToolManifest(manifest, { openapi, workflowCatalog });
  return {
    manifest: {
      ...manifest,
      tools: manifest.tools.map(normalizeTool),
    },
    paths: {
      manifest: manifestPath,
      openapi: openapiPath,
      workflowCatalog: workflowCatalogPath,
    },
  };
}

export function normalizeTool(tool) {
  const inputAliases = tool.input_aliases && typeof tool.input_aliases === 'object' ? tool.input_aliases : {};
  const normalizedAliases = {};
  for (const [canonical, aliases] of Object.entries(inputAliases)) {
    normalizedAliases[canonical] = Array.from(new Set([canonical, ...(Array.isArray(aliases) ? aliases : [])]));
  }
  for (const field of Object.keys(tool.input_schema?.properties || {})) {
    normalizedAliases[field] = Array.from(new Set([field, ...(normalizedAliases[field] || [])]));
  }
  return {
    ...tool,
    input_aliases: normalizedAliases,
    required_inputs: Array.isArray(tool.required_inputs) ? tool.required_inputs : tool.input_schema?.required || [],
  };
}

export function validateMcpToolManifest(manifest, sources = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') errors.push('manifest must be an object');
  if (manifest?.schema_version !== '1.0') errors.push('schema_version must be 1.0');
  if (!nonEmptyString(manifest?.manifest_id)) errors.push('manifest_id is required');
  if (!nonEmptyString(manifest?.contract_version)) errors.push('contract_version is required');
  if (!Array.isArray(manifest?.tools) || manifest.tools.length === 0) errors.push('tools must be a non-empty array');

  const toolNames = new Set();
  const capabilityIds = new Set();
  for (const [index, rawTool] of (manifest?.tools || []).entries()) {
    const prefix = `tools[${index}]`;
    const tool = normalizeTool(rawTool || {});
    requireString(errors, tool.tool_name, `${prefix}.tool_name`);
    requireString(errors, tool.capability_id, `${prefix}.capability_id`);
    requireString(errors, tool.workflow_id, `${prefix}.workflow_id`);
    requireString(errors, tool.operation_id, `${prefix}.operation_id`);
    requireString(errors, tool.webhook_path, `${prefix}.webhook_path`);
    requireString(errors, tool.description, `${prefix}.description`);
    if (toolNames.has(tool.tool_name)) errors.push(`${prefix}.tool_name duplicates ${tool.tool_name}`);
    if (capabilityIds.has(tool.capability_id)) errors.push(`${prefix}.capability_id duplicates ${tool.capability_id}`);
    toolNames.add(tool.tool_name);
    capabilityIds.add(tool.capability_id);
    if (!['sync', 'async'].includes(tool.execution_mode)) errors.push(`${prefix}.execution_mode must be sync or async`);
    validateObjectSchema(errors, tool.input_schema, `${prefix}.input_schema`);
    validateObjectSchema(errors, tool.output_schema, `${prefix}.output_schema`);
    if (!tool.input_mapping || typeof tool.input_mapping !== 'object' || Array.isArray(tool.input_mapping)) {
      errors.push(`${prefix}.input_mapping must be an object`);
    }
    for (const required of tool.required_inputs || []) {
      if (!Array.isArray(tool.input_aliases?.[required]) || tool.input_aliases[required].length === 0) {
        errors.push(`${prefix}.input_aliases.${required} is required for required input`);
      }
      if (!tool.input_schema?.properties?.[required]) {
        errors.push(`${prefix}.input_schema.properties.${required} is required for required input`);
      }
    }
    if (tool.execution_mode === 'async') {
      requireString(errors, tool.action_id, `${prefix}.action_id`);
      requireString(errors, tool.expected_event_type, `${prefix}.expected_event_type`);
      if (tool.async_context_required !== true) errors.push(`${prefix}.async_context_required must be true for async tools`);
      if (tool.result_mapping?.type !== 'accepted_ack') errors.push(`${prefix}.result_mapping.type must be accepted_ack for async tools`);
      if (!Object.values(tool.input_mapping || {}).some((entry) => entry?.async_invocation === true)) {
        errors.push(`${prefix}.input_mapping must include an async_invocation mapping`);
      }
    }
    if (tool.execution_mode === 'sync' && tool.result_mapping?.type !== 'sync_result') {
      errors.push(`${prefix}.result_mapping.type must be sync_result for sync tools`);
    }
    if (sources.openapi) {
      const operation = findOpenApiOperation(sources.openapi, tool.operation_id);
      if (!operation) {
        errors.push(`${prefix}.operation_id ${tool.operation_id} not found in OpenAPI`);
      } else {
        if (operation.method !== 'post') errors.push(`${prefix}.operation_id ${tool.operation_id} must be POST in OpenAPI`);
        if (operation.path !== tool.webhook_path) {
          errors.push(`${prefix}.webhook_path ${tool.webhook_path} does not match OpenAPI path ${operation.path}`);
        }
      }
    }
    if (sources.workflowCatalog) {
      const workflow = findWorkflow(sources.workflowCatalog, tool.workflow_id);
      if (!workflow) {
        errors.push(`${prefix}.workflow_id ${tool.workflow_id} not found in workflow catalog`);
      } else {
        if (workflow.openapi_operation_id !== tool.operation_id) {
          errors.push(`${prefix}.operation_id ${tool.operation_id} does not match workflow catalog ${workflow.openapi_operation_id}`);
        }
        if (workflow.enabled === false) errors.push(`${prefix}.workflow_id ${tool.workflow_id} is disabled in workflow catalog`);
      }
    }
  }
  if (errors.length) {
    throw new McpManifestError(`Invalid MCP tool manifest:\n- ${errors.join('\n- ')}`);
  }
}

export function findOpenApiOperation(openapi, operationId) {
  for (const [path, pathItem] of Object.entries(openapi?.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (operation?.operationId === operationId) {
        return { path, method: method.toLowerCase(), operation };
      }
    }
  }
  return null;
}

function findWorkflow(catalog, workflowId) {
  return (catalog?.workflows || []).find((workflow) => workflow.workflow_id === workflowId) || null;
}

function validateObjectSchema(errors, schema, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${path} must be an object schema`);
    return;
  }
  if (schema.type !== 'object') errors.push(`${path}.type must be object`);
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    errors.push(`${path}.properties must be an object`);
    return;
  }
  for (const [property, definition] of Object.entries(schema.properties)) {
    if (!nonEmptyString(definition?.description)) {
      errors.push(`${path}.properties.${property}.description is required`);
    }
  }
}

function requireString(errors, value, path) {
  if (!nonEmptyString(value)) errors.push(`${path} is required`);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
