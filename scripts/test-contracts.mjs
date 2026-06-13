#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function codeNode(workflowPath, nodeId) {
  const workflow = readJson(workflowPath);
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  assert.ok(node, `${nodeId} not found in ${workflowPath}`);
  assert.equal(node.type, 'n8n-nodes-base.code');
  assert.equal(typeof node.parameters?.jsCode, 'string');
  return node.parameters.jsCode;
}

function workflowNode(workflowPath, nodeId) {
  const workflow = readJson(workflowPath);
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  assert.ok(node, `${nodeId} not found in ${workflowPath}`);
  return node;
}

function runner(jsCode, context = {}) {
  const fn = new Function(
    '$input',
    '$env',
    'process',
    `return (async function () {\n${jsCode}\n}).call(this);`,
  );
  return async function run(json, env = {}) {
    const input = {
      first() {
        return { json };
      },
    };
    return fn.call(context, input, env, { env });
  };
}

function request(body, token = 'test-token') {
  return {
    headers: token ? { 'x-servicedesk-token': token } : {},
    body,
  };
}

function responseOf(items) {
  assert.ok(Array.isArray(items), 'Code node must return item array');
  assert.ok(items.length > 0, 'Code node returned no items');
  return items[0].json;
}

function stage4Async(resultTransport, overrides = {}) {
  return {
    invocation_id: 'cmd-123',
    action_id: 'start_systemcenter_runbook',
    extensions: {
      async_callback: {
        source: 'n8n',
        case_id: 'case-000000000001',
        ticket_id: 'ticket-000000000001',
        run_id: 'run-000000000001',
        wait_id: 'wait-000000000001',
        correlation_id: 'case-000000000001:tool_command:cmd-123',
        event_type: 'start_systemcenter_runbook_completed',
        idempotency_key_base: 'case-000000000001:tool_command:cmd-123',
        result_transport: resultTransport,
        ...overrides,
      },
    },
  };
}

async function testStage4() {
  const prepareCode = codeNode('workflows/stage4-runbook-webhook.json', 'stage4-runbook-prepare');
  const run = runner(prepareCode);

  const direct = responseOf(
    await run(
      request({
        invocation: { invocation_id: 'direct-1', action_id: 'start_systemcenter_runbook' },
        parameters: { source: 'smoke' },
      }),
      { N8N_WEBHOOK_TOKEN: 'test-token' },
    ),
  );
  assert.equal(direct.statusCode, 200);
  assert.equal(direct.shouldPublishKafka, false);
  assert.equal(direct.response.async_delivery, false);

  const missingAction = responseOf(
    await run(request({ invocation: { invocation_id: 'missing-action' } }), {
      N8N_WEBHOOK_TOKEN: 'test-token',
    }),
  );
  assert.equal(missingAction.statusCode, 400);
  assert.equal(missingAction.response.error.code, 'missing_action_id');

  const kafka = responseOf(
    await run(
      request({
        invocation: stage4Async('kafka_event', { result_topic: 'external.events' }),
        parameters: { channelName: 'provider-link-1' },
      }),
      { N8N_WEBHOOK_TOKEN: 'test-token' },
    ),
  );
  assert.equal(kafka.statusCode, 200);
  assert.equal(kafka.shouldPublishKafka, true);
  assert.equal(kafka.kafkaTopic, 'external.events');
  assert.equal(kafka.externalEvent.status, 'success');
  assert.equal(kafka.externalEvent.case_id, 'case-000000000001');
  assert.equal(kafka.externalEvent.wait_id, 'wait-000000000001');
  assert.equal(kafka.externalEvent.idempotency_key, 'case-000000000001:tool_command:cmd-123:stage4_success');
  assert.equal(kafka.response.has_callback_url, false);
  assert.equal(Object.hasOwn(kafka.response, 'callback_url'), false);

  const missingTopic = responseOf(
    await run(
      request({
        invocation: stage4Async('kafka_event'),
      }),
      { N8N_WEBHOOK_TOKEN: 'test-token' },
    ),
  );
  assert.equal(missingTopic.statusCode, 400);
  assert.equal(missingTopic.response.error.code, 'missing_result_topic');

  const callbackCalls = [];
  const runWithCallback = runner(prepareCode, {
    helpers: {
      async httpRequest(options) {
        callbackCalls.push(options);
        return { ok: true };
      },
    },
  });
  const callback = responseOf(
    await runWithCallback(
      request({
        invocation: stage4Async('http_callback', {
          callback_url: 'http://127.0.0.1:18088/external-events/n8n',
        }),
      }),
      {
        N8N_WEBHOOK_TOKEN: 'test-token',
        INTEGRATION_CALLBACK_TOKEN__N8N: 'callback-token',
      },
    ),
  );
  assert.equal(callback.statusCode, 200);
  assert.equal(callback.shouldPublishKafka, false);
  assert.equal(callback.response.has_callback_url, true);
  assert.equal(callbackCalls.length, 1);
  assert.equal(callbackCalls[0].headers['X-ServiceDesk-Callback-Token'], 'callback-token');
  assert.equal(callbackCalls[0].body.status, 'success');

  const missingCallback = responseOf(
    await run(
      request({
        invocation: stage4Async('http_callback'),
      }),
      { N8N_WEBHOOK_TOKEN: 'test-token' },
    ),
  );
  assert.equal(missingCallback.statusCode, 400);
  assert.equal(missingCallback.response.error.code, 'missing_callback_url');

  const kafkaNode = workflowNode('workflows/stage4-runbook-webhook.json', 'stage4-runbook-kafka-publish');
  assert.equal(kafkaNode.type, 'n8n-nodes-base.kafka');
  assert.equal(kafkaNode.parameters.topic, '={{ $json.kafkaTopic }}');
  assert.equal(kafkaNode.credentials.kafka.name, 'Local Redpanda Kafka');
}

async function testTemplatedEmail() {
  const validateCode = codeNode('workflows/send-templated-email-webhook.json', 'send-templated-email-validate-request');
  const run = runner(validateCode);
  const env = { N8N_WEBHOOK_TOKEN: 'test-token' };

  const invalidPattern = responseOf(
    await run(
      request({
        to: ['automation-test@local.test'],
        templateId: 'provider_line_repair_request',
        params: {
          localTicketNumber: 'BAD',
          lineId: 'L-100500',
          serviceAddress: 'Москва, ул. Тестовая, д. 1',
          problemDescription: 'Нет связи',
          contactName: 'Иван Иванов',
          contactPhone: '+7 999 000-00-00',
        },
      }),
      env,
    ),
  );
  assert.equal(invalidPattern.statusCode, 400);
  assert.equal(invalidPattern.response.error.code, 'invalid_template_param');
  assert.equal(invalidPattern.response.error.reason, 'pattern_mismatch');

  const crlfParam = responseOf(
    await run(
      request({
        to: ['automation-test@local.test'],
        templateId: 'provider_channel_outage_test',
        params: {
          city: 'Москва\nBCC: victim@example.com',
          location: 'Москва, ул. Тестовая, д. 1',
          ip_address: '192.0.2.10',
          contract: 'CNT-100500',
          service_request: '12345678',
        },
      }),
      env,
    ),
  );
  assert.equal(crlfParam.statusCode, 400);
  assert.equal(crlfParam.response.error.code, 'invalid_template_param');
  assert.equal(crlfParam.response.error.reason, 'control_chars_not_allowed');

  const ok = responseOf(
    await run(
      request({
        to: 'automation-test@local.test',
        cc: 'cc@local.test; second-cc@local.test',
        bcc: ['audit@local.test'],
        templateId: 'provider_channel_outage_test',
        params: {
          city: 'Москва',
          location: 'Москва, ул. Тестовая, д. 1',
          ip_address: '192.0.2.10',
          contract: 'CNT-100500',
          service_request: '12345678',
        },
      }),
      env,
    ),
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.shouldSend, true);
  assert.equal(ok.subject, 'Пропадание связи по каналу Москва');
  assert.equal(ok.ccEmail, 'cc@local.test, second-cc@local.test');
  assert.equal(ok.bccEmail, 'audit@local.test');
}

async function testZabbixProblem() {
  const updateCode = codeNode('workflows/update-zabbix-problem-webhook.json', 'update-zabbix-problem-run');
  const run = runner(updateCode, {
    helpers: {
      async httpRequest() {
        throw new Error('unexpected live request from contract test');
      },
    },
  });
  const env = { N8N_WEBHOOK_TOKEN: 'test-token' };

  const alias = responseOf(
    await run(
      request({
        problem_url: 'http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528',
        message: 'smoke',
      }),
      env,
    ),
  );
  assert.equal(alias.statusCode, 400);
  assert.equal(alias.response.error.code, 'unknown_zabbix_origin');
  assert.equal(alias.response.error.zabbix_origin, 'http://localhost:8081');

  const invalidScheme = responseOf(
    await run(
      request({
        problemUrl: 'file:///tmp/problem?triggerid=61119&eventid=90528',
        message: 'smoke',
      }),
      env,
    ),
  );
  assert.equal(invalidScheme.statusCode, 400);
  assert.equal(invalidScheme.response.error.code, 'invalid_problem_url');

  const credentialsInUrl = responseOf(
    await run(
      request({
        problemUrl: 'http://user:pass@localhost:8081/tr_events.php?triggerid=61119&eventid=90528',
        message: 'smoke',
      }),
      env,
    ),
  );
  assert.equal(credentialsInUrl.statusCode, 400);
  assert.equal(credentialsInUrl.response.error.code, 'invalid_problem_url');

  const invalidRegistry = responseOf(
    await run(
      request({
        problemUrl: 'http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528',
        message: 'smoke',
      }),
      { ...env, ZABBIX_API_TOKENS_BY_ORIGIN: '{not-json' },
    ),
  );
  assert.equal(invalidRegistry.statusCode, 400);
  assert.equal(invalidRegistry.response.error.code, 'invalid_zabbix_registry');

  const tooLong = responseOf(
    await run(
      request({
        problemUrl: 'http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528',
        message: 'x'.repeat(2001),
      }),
      env,
    ),
  );
  assert.equal(tooLong.statusCode, 400);
  assert.equal(tooLong.response.error.code, 'message_too_long');
}

function testOpenApiAndCatalog() {
  const openapi = readJson('contracts/n8n-openapi.json');
  const asyncSchema = openapi.components.schemas.AsyncCallbackPackage;
  assert.equal(asyncSchema.allOf.length, 3);
  assert.equal(asyncSchema.allOf[0].then.required[0], 'callback_url');
  assert.deepEqual(asyncSchema.allOf[1].then.required, ['result_topic']);
  assert.deepEqual(asyncSchema.allOf[2].then.required, ['callback_url', 'result_topic']);

  const startResponse = openapi.components.schemas.StartRunbookResponse;
  assert.equal(Object.hasOwn(startResponse.properties, 'callback_url'), false);
  assert.equal(startResponse.properties.has_callback_url.type, 'boolean');

  const zabbixRequest = openapi.components.schemas.UpdateZabbixProblemRequest;
  assert.deepEqual(zabbixRequest.required, ['message']);
  assert.deepEqual(zabbixRequest.anyOf, [{ required: ['problemUrl'] }, { required: ['problem_url'] }]);
  assert.equal(Object.hasOwn(zabbixRequest.properties, 'request_id'), false);
  assert.equal(Object.hasOwn(zabbixRequest.properties, 'requestId'), false);
  assert.equal(zabbixRequest.properties.message.maxLength, 2000);

  const sendTemplate400 = openapi.paths['/webhook/email/send-template'].post.responses['400'].content['application/json'].examples;
  assert.ok(sendTemplate400.invalidTemplateParam);
  assert.ok(sendTemplate400.invalidRenderedSubject);
  assert.ok(sendTemplate400.renderedSubjectTooLong);
  assert.ok(sendTemplate400.renderedBodyTooLong);

  const catalog = readJson('contracts/n8n-workflow-catalog.json');
  const provider = catalog.workflows.find((workflow) => workflow.workflow_id === 'provider_channel_failure');
  assert.equal(provider.result_delivery.default_result_topic, 'external.events');
  assert.deepEqual(provider.result_delivery.supported_transports, ['http_callback', 'kafka_event', 'both']);

  const placeholder = catalog.workflows.find((workflow) => workflow.workflow_id === 'zabbix_problem_processing');
  assert.equal(placeholder.enabled, false);
  assert.equal(placeholder.lifecycle, 'internal_placeholder');
}

async function main() {
  await testStage4();
  await testTemplatedEmail();
  await testZabbixProblem();
  testOpenApiAndCatalog();
  process.stdout.write('contract tests passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
