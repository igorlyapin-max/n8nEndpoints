#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { assertWorkflowInlineDocumentation } from './workflow-inline-documentation.mjs';
import { loadMcpToolManifest } from './mcp-tool-manifest.mjs';

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

function assertMainConnectionIncludes(workflowPath, fromNode, outputIndex, toNode) {
  const workflow = readJson(workflowPath);
  const output = workflow.connections?.[fromNode]?.main?.[outputIndex] || [];
  assert.ok(
    output.some((connection) => connection.node === toNode),
    `${workflowPath}: expected ${fromNode} output ${outputIndex} to include ${toNode}`,
  );
}

function assertNoMainConnectionFrom(workflowPath, fromNode) {
  const workflow = readJson(workflowPath);
  const mainConnections = workflow.connections?.[fromNode]?.main || [];
  assert.equal(mainConnections.flat().length, 0, `${workflowPath}: ${fromNode} must not have downstream work`);
}

function assertRequiredAlternatives(schema, expectedGroups) {
  const groups = (schema.allOf || []).map((entry) =>
    (entry.anyOf || []).map((alternative) => alternative.required || []),
  );
  assert.deepEqual(groups, expectedGroups);
}

function runner(jsCode, context = {}) {
  const fn = new Function(
    '$input',
    '$env',
    'process',
    '$',
    `return (async function () {\n${jsCode}\n}).call(this);`,
  );
  return async function run(json, env = {}) {
    const items = (Array.isArray(json) ? json : [json]).map((entry) => ({ json: entry }));
    const input = {
      first() {
        return items[0] || { json: {} };
      },
      all() {
        return items;
      },
    };
    return fn.call(context, input, env, { env }, context.$);
  };
}

function request(body, token = 'test-token') {
  return {
    headers: token ? { 'x-servicedesk-token': token } : {},
    body,
  };
}

function internalRequest(body, token = 'test-token', internalToken = 'internal-token') {
  const value = request(body, token);
  if (internalToken) value.headers['x-servicedesk-internal-token'] = internalToken;
  return value;
}

const LOCAL_CALLBACK_URL = 'http://hostmachine:18088/external-events/n8n';
const LOCAL_CALLBACK_ENV_WITH_NODE_PRODUCTION = {
  NODE_ENV: 'production',
  N8N_ENVIRONMENT: 'local',
  SERVICE_DESK_ENV: 'local',
  ORCHESTRATOR_PUBLIC_URL: 'http://hostmachine:18088',
};

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

function emailWaitAsync(resultTransport, overrides = {}) {
  return {
    invocation_id: 'cmd-email-123',
    action_id: 'wait_for_email_by_ticket',
    extensions: {
      async_callback: {
        source: 'n8n',
        case_id: 'case-000000000001',
        ticket_id: 'ticket-000000000001',
        run_id: 'run-000000000001',
        wait_id: 'wait-000000000001',
        correlation_id: 'case-000000000001:tool_command:cmd-email-123',
        event_type: 'wait_for_email_by_ticket_completed',
        idempotency_key_base: 'case-000000000001:tool_command:cmd-email-123',
        result_transport: resultTransport,
        ...overrides,
      },
    },
  };
}

function providerMonitorAsync(resultTransport, overrides = {}) {
  return {
    invocation_id: 'cmd-provider-monitor-123',
    action_id: 'monitor_provider_channel_repair',
    extensions: {
      async_callback: {
        source: 'n8n',
        case_id: 'case-000000000001',
        ticket_id: 'ticket-000000000001',
        run_id: 'run-000000000001',
        wait_id: 'wait-000000000001',
        correlation_id: 'case-000000000001:tool_command:cmd-provider-monitor-123',
        event_type: 'monitor_provider_channel_repair_completed',
        idempotency_key_base: 'case-000000000001:tool_command:cmd-provider-monitor-123',
        result_transport: resultTransport,
        ...overrides,
      },
    },
  };
}

function zabbixWaitAsync(resultTransport, overrides = {}) {
  return {
    invocation_id: 'cmd-zabbix-wait-123',
    action_id: 'wait_zabbix_problem_status',
    extensions: {
      async_callback: {
        source: 'n8n',
        case_id: 'case-000000000001',
        ticket_id: 'ticket-000000000001',
        run_id: 'run-000000000001',
        wait_id: 'wait-000000000001',
        correlation_id: 'case-000000000001:tool_command:cmd-zabbix-wait-123',
        event_type: 'wait_zabbix_problem_status_completed',
        idempotency_key_base: 'case-000000000001:tool_command:cmd-zabbix-wait-123',
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
  assert.equal(callback.response.delivery_status.http_callback, 'sent');

  const failedCallbackBoth = responseOf(
    await runner(prepareCode, {
      helpers: {
        async httpRequest() {
          throw new Error('callback is down');
        },
      },
    })(
      request({
        invocation: stage4Async('both', {
          callback_url: 'http://127.0.0.1:18088/external-events/n8n',
          result_topic: 'external.events',
        }),
      }),
      {
        N8N_WEBHOOK_TOKEN: 'test-token',
        INTEGRATION_CALLBACK_TOKEN__N8N: 'callback-token',
      },
    ),
  );
  assert.equal(failedCallbackBoth.statusCode, 200);
  assert.equal(failedCallbackBoth.shouldPublishKafka, true);
  assert.equal(failedCallbackBoth.delivery_status.http_callback, 'failed');
  assert.equal(failedCallbackBoth.delivery_status.http_callback_error, 'callback_delivery_failed');
  assert.equal(failedCallbackBoth.delivery_status.kafka_event, 'pending');
  assert.equal(failedCallbackBoth.externalEvent.metadata.delivery_status.http_callback, 'failed');

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

  const invalidCallback = responseOf(
    await run(
      request({
        invocation: stage4Async('http_callback', {
          callback_url: 'http://evil.example/external-events/n8n',
        }),
      }),
      { N8N_WEBHOOK_TOKEN: 'test-token', NODE_ENV: 'production' },
    ),
  );
  assert.equal(invalidCallback.statusCode, 400);
  assert.equal(invalidCallback.response.error.code, 'invalid_callback_url');

  const localCallbackWithNodeProduction = responseOf(
    await run(
      request({
        invocation: stage4Async('both', {
          callback_url: LOCAL_CALLBACK_URL,
          result_topic: 'external.events',
        }),
        parameters: { source: 'smoke' },
      }),
      {
        N8N_WEBHOOK_TOKEN: 'test-token',
        ...LOCAL_CALLBACK_ENV_WITH_NODE_PRODUCTION,
      },
    ),
  );
  assert.equal(localCallbackWithNodeProduction.statusCode, 200);
  assert.notEqual(localCallbackWithNodeProduction.response.error?.code, 'invalid_callback_url');

  const kafkaNode = workflowNode('workflows/stage4-runbook-webhook.json', 'stage4-runbook-kafka-publish');
  assert.equal(kafkaNode.type, 'n8n-nodes-base.kafka');
  assert.equal(kafkaNode.parameters.topic, '={{ $json.kafkaTopic }}');
  assert.equal(kafkaNode.credentials.kafka.name, 'Local Redpanda Kafka');
}

async function testWaitForEmailByTicket() {
  const prepareCode = codeNode('workflows/wait-for-email-ticket-webhook.json', 'wait-email-prepare-request');
  const buildSqlCode = codeNode('workflows/wait-for-email-ticket-webhook.json', 'wait-email-build-search-sql');
  const evaluateCode = codeNode('workflows/wait-for-email-ticket-webhook.json', 'wait-email-evaluate-result');
  const deliverCode = codeNode('workflows/wait-for-email-ticket-webhook.json', 'wait-email-deliver-async-result');
  const collectorCode = codeNode('workflows/email-ticket-mailbox-collector.json', 'email-ticket-collector-prepare');
  const runPrepare = runner(prepareCode);
  const env = { N8N_WEBHOOK_TOKEN: 'test-token' };

  const directTooLong = responseOf(
    await runPrepare(
      request({
        ticket_number: 'ГКМ123456',
        poll_interval_minutes: 15,
        timeout_minutes: 60,
      }),
      env,
    ),
  );
  assert.equal(directTooLong.statusCode, 400);
  assert.equal(directTooLong.response.error.code, 'direct_timeout_too_long');

  const asyncAccepted = responseOf(
    await runPrepare(
      request({
        ticket_number: 'ГКМ123456',
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        invocation: emailWaitAsync('kafka_event', { result_topic: 'external.events' }),
      }),
      env,
    ),
  );
  assert.equal(asyncAccepted.statusCode, 200);
  assert.equal(asyncAccepted.async_delivery, true);
  assert.equal(asyncAccepted.response.runbook_status, 'accepted');
  assert.equal(asyncAccepted.response.result_topic, 'external.events');
  assertMainConnectionIncludes('workflows/wait-for-email-ticket-webhook.json', 'Async режим?', 0, 'Ответ accepted');
  assertMainConnectionIncludes('workflows/wait-for-email-ticket-webhook.json', 'Async режим?', 0, 'Подготовка SQL поиска');
  assertNoMainConnectionFrom('workflows/wait-for-email-ticket-webhook.json', 'Ответ accepted');

  const missingTopic = responseOf(
    await runPrepare(
      request({
        ticket_number: 'ГКМ123456',
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        invocation: emailWaitAsync('kafka_event'),
      }),
      env,
    ),
  );
  assert.equal(missingTopic.statusCode, 400);
  assert.equal(missingTopic.response.error.code, 'missing_result_topic');

  const invalidCallback = responseOf(
    await runPrepare(
      request({
        ticket_number: 'ГКМ123456',
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        invocation: emailWaitAsync('http_callback', {
          callback_url: 'http://evil.example/external-events/n8n',
        }),
      }),
      { ...env, NODE_ENV: 'production' },
    ),
  );
  assert.equal(invalidCallback.statusCode, 400);
  assert.equal(invalidCallback.response.error.code, 'invalid_callback_url');

  const localCallbackWithNodeProduction = responseOf(
    await runPrepare(
      request({
        ticket_number: 'ГКМ123456',
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        invocation: emailWaitAsync('http_callback', {
          callback_url: LOCAL_CALLBACK_URL,
        }),
      }),
      { ...env, ...LOCAL_CALLBACK_ENV_WITH_NODE_PRODUCTION },
    ),
  );
  assert.equal(localCallbackWithNodeProduction.statusCode, 200);
  assert.equal(localCallbackWithNodeProduction.response.runbook_status, 'accepted');

  const collector = responseOf(
    await runner(collectorCode)({
      subject: "Undeliverable: заявка ГКМ123456",
      from: 'MAILER-DAEMON@example.test',
      text: "Delivery has failed for ГКМ123456, O'Hara, comma, test",
      date: '2026-06-13T10:05:00.000Z',
      messageId: '<ndr-1@example.test>',
    }),
  );
  assert.equal(collector.is_delivery_failure, true);
  assert.ok(collector.sql.includes("O''Hara"));
  assert.ok(collector.sql.includes('n8n_mail_index'));

  const sqlState = responseOf(await runner(buildSqlCode)(asyncAccepted));
  assert.ok(sqlState.sql.includes('WITH matches AS'));
  assert.ok(sqlState.sql.includes('ГКМ123456'));

  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 1_000).toISOString();
  const baseRow = {
    ticket_number: 'ГКМ123456',
    invocation_id: 'cmd-email-123',
    action_id: 'wait_for_email_by_ticket',
    started_at: '2026-06-13T10:00:00.000Z',
    deadline_at: future,
    window_start_at: '2026-06-12T00:00:00.000Z',
    poll_interval_minutes: 15,
    timeout_minutes: 60,
    poll_seconds: 900,
    async_delivery: true,
    async_callback_json: JSON.stringify(emailWaitAsync('kafka_event', { result_topic: 'external.events' }).extensions.async_callback),
  };
  const firstMatch = {
    message_id: '<provider-1@example.test>',
    mailbox: 'INBOX',
    mailbox_address: 'automation-test@local.test',
    from_email: 'provider@example.test',
    subject: 'Re: заявка ГКМ123456',
    body_text: 'Ваше обращение зарегистрировано.',
    body_truncated: false,
    received_at: '2026-06-13T10:05:00.000Z',
    is_delivery_failure: false,
    delivery_failure_reason: null,
  };

  const ok = responseOf(
    await runner(evaluateCode)({
      ...baseRow,
      match_count: 1,
      mailbox_indexed_count: 1,
      delivery_failure_count: 0,
      first_match_json: JSON.stringify(firstMatch),
    }),
  );
  assert.equal(ok.terminal, true);
  assert.equal(ok.response.status, 'OK');
  assert.equal(ok.response.subject, 'Re: заявка ГКМ123456');

  const multi = responseOf(
    await runner(evaluateCode)({
      ...baseRow,
      match_count: 2,
      mailbox_indexed_count: 1,
      delivery_failure_count: 0,
      first_match_json: JSON.stringify(firstMatch),
    }),
  );
  assert.equal(multi.response.status, 'MULTI_MAIL');
  assert.equal(multi.response.match_count, 2);

  const deliveryFailed = responseOf(
    await runner(evaluateCode)({
      ...baseRow,
      match_count: 1,
      delivery_failure_count: 1,
      delivery_failure_match_json: JSON.stringify({
        ...firstMatch,
        subject: 'Undeliverable: заявка ГКМ123456',
        is_delivery_failure: true,
        delivery_failure_reason: 'undeliverable',
      }),
    }),
  );
  assert.equal(deliveryFailed.response.status, 'DELIVERY_FAILED');
  assert.equal(deliveryFailed.response.is_delivery_failure, true);

  const notFound = responseOf(
    await runner(evaluateCode)({
      ...baseRow,
      deadline_at: past,
      match_count: 0,
      mailbox_indexed_count: 1,
      delivery_failure_count: 0,
    }),
  );
  assert.equal(notFound.response.status, 'NOT_FOUND');

  const waiting = responseOf(
    await runner(evaluateCode)({
      ...baseRow,
      match_count: 0,
      mailbox_indexed_count: 1,
      delivery_failure_count: 0,
    }),
  );
  assert.equal(waiting.terminal, false);
  assert.ok(waiting.next_wait_seconds > 0);
  assert.ok(Date.parse(waiting.next_wait_at) > Date.now());

  const callbackCalls = [];
  const delivered = responseOf(
    await runner(deliverCode, {
      helpers: {
        async httpRequest(options) {
          callbackCalls.push(options);
          return { ok: true };
        },
      },
    })(
      {
        ...ok,
        async_callback_json: JSON.stringify(
          emailWaitAsync('http_callback', {
            callback_url: 'http://127.0.0.1:18088/external-events/n8n',
          }).extensions.async_callback,
        ),
      },
      { INTEGRATION_CALLBACK_TOKEN__N8N: 'callback-token' },
    ),
  );
  assert.equal(callbackCalls.length, 1);
  assert.equal(callbackCalls[0].headers['X-ServiceDesk-Callback-Token'], 'callback-token');
  assert.equal(delivered.externalEvent.status, 'success');
  assert.equal(delivered.externalEvent.result.runbook_status, 'OK');
  assert.equal(delivered.shouldPublishKafka, false);
  assert.equal(delivered.delivery_status.http_callback, 'sent');

  const failedCallbackBoth = responseOf(
    await runner(deliverCode, {
      helpers: {
        async httpRequest() {
          throw new Error('callback is down');
        },
      },
    })(
      {
        ...ok,
        async_callback_json: JSON.stringify(
          emailWaitAsync('both', {
            callback_url: 'http://127.0.0.1:18088/external-events/n8n',
            result_topic: 'external.events',
          }).extensions.async_callback,
        ),
      },
      { INTEGRATION_CALLBACK_TOKEN__N8N: 'callback-token' },
    ),
  );
  assert.equal(failedCallbackBoth.shouldPublishKafka, true);
  assert.equal(failedCallbackBoth.kafkaTopic, 'external.events');
  assert.equal(failedCallbackBoth.delivery_status.http_callback, 'failed');
  assert.equal(failedCallbackBoth.delivery_status.http_callback_error, 'callback_delivery_failed');
  assert.equal(failedCallbackBoth.externalEvent.result.delivery_status.http_callback, 'failed');
}

async function testTemplatedEmail() {
  const validateCode = codeNode('workflows/send-templated-email-webhook.json', 'send-templated-email-validate-request');
  const run = runner(validateCode);
  const env = { N8N_WEBHOOK_TOKEN: 'test-token' };
  const emailEnvelope = { from: 'automation-test@local.test', replyTo: 'automation-test@local.test' };
  const bodyWithEnvelope = (payload) => request({ ...emailEnvelope, ...payload });

  const invalidPattern = responseOf(
    await run(
      bodyWithEnvelope({
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
      bodyWithEnvelope({
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
      bodyWithEnvelope({
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
  assert.equal(ok.from_email, 'automation-test@local.test');
  assert.equal(ok.reply_to, 'automation-test@local.test');

  const passwordNotice = responseOf(
    await run(
      bodyWithEnvelope({
        to: 'manager@local.test',
        templateId: 'ad_password_reset_notification',
        params: {
          service_request: '12345678',
          employee_full_name: 'Иванов Иван Иванович',
          password: 'Abc123XYZ',
        },
      }),
      env,
    ),
  );
  assert.equal(passwordNotice.statusCode, 200);
  assert.equal(passwordNotice.shouldSend, true);
  assert.equal(passwordNotice.subject, 'Смена пароля по заявке № 12345678');
  assert.equal(
    passwordNotice.body,
    'Добрый день!\nПо заявке № 12345678 для вашего сотрудника Иванов Иван Иванович был изменен пароль.\nНовый пароль: Abc123XYZ\nВнимание, требуется поменять пароль при первом входе.',
  );

  const catalog = readJson('contracts/email-template-catalog.json');
  const passwordTemplate = catalog.templates.find(
    (template) => template.template_id === 'ad_password_reset_notification',
  );
  assert.ok(passwordTemplate, 'ad_password_reset_notification template must exist');
  assert.deepEqual(passwordTemplate.required_params, ['service_request', 'employee_full_name', 'password']);
  assert.equal(passwordTemplate.params.find((param) => param.name === 'password')?.sensitive, true);

  const workflow = readJson('workflows/send-templated-email-webhook.json');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveManualExecutions, false);
  const sendNode = workflowNode('workflows/send-templated-email-webhook.json', 'send-templated-email-node');
  assert.equal(sendNode.parameters.fromEmail, '={{ $json.from_email }}');
  assert.equal(sendNode.parameters.options.replyTo, '={{ $json.reply_to }}');
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

async function testZabbixProblemStatus() {
  const statusCode = codeNode('workflows/get-zabbix-problem-status-webhook.json', 'get-zabbix-problem-status-run');
  const env = {
    N8N_WEBHOOK_TOKEN: 'test-token',
    ZABBIX_API_TOKENS_BY_ORIGIN: JSON.stringify({ 'http://localhost:8081': 'zabbix-token' }),
  };
  const body = {
    problemUrl: 'http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528',
  };

  const runWithRpc = (handler) =>
    runner(statusCode, {
      helpers: {
        async httpRequest(options) {
          return handler(options.body.method, options.body.params, options);
        },
      },
    });

  const active = responseOf(
    await runWithRpc((method) => {
      assert.equal(method, 'event.get');
      return {
        result: [
          {
            eventid: '90528',
            objectid: '61119',
            value: '1',
            r_eventid: '0',
            r_clock: '0',
            name: 'ICMP Ping: Unavailable by ICMP ping',
            severity: '4',
            acknowledged: '0',
          },
        ],
      };
    })(request(body), env),
  );
  assert.equal(active.statusCode, 200);
  assert.equal(active.response.status, 'problem');
  assert.equal(active.response.source, 'event');

  const resolved = responseOf(
    await runWithRpc(() => ({
      result: [
        {
          eventid: '90528',
          objectid: '61119',
          value: '1',
          r_eventid: '90599',
          r_clock: '1781327999',
          name: 'ICMP Ping: Unavailable by ICMP ping',
          severity: '4',
          acknowledged: '1',
        },
      ],
    }))(request(body), env),
  );
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.response.status, 'resolved');
  assert.equal(resolved.response.source, 'event');
  assert.equal(resolved.response.problem.recovery_eventid, '90599');

  const fallbackOk = responseOf(
    await runWithRpc((method) => {
      if (method === 'event.get') return { result: [] };
      assert.equal(method, 'trigger.get');
      return {
        result: [
          {
            triggerid: '61119',
            value: '0',
            description: 'ICMP Ping: Unavailable by ICMP ping',
            priority: '4',
          },
        ],
      };
    })(request({ problem_url: body.problemUrl }), env),
  );
  assert.equal(fallbackOk.statusCode, 200);
  assert.equal(fallbackOk.response.status, 'ok');
  assert.equal(fallbackOk.response.source, 'trigger_fallback');
  assert.equal(fallbackOk.response.problem.trigger_value, '0');

  const fallbackProblem = responseOf(
    await runWithRpc((method) => {
      if (method === 'event.get') return { result: [] };
      return {
        result: [
          {
            triggerid: '61119',
            value: '1',
            description: 'ICMP Ping: Unavailable by ICMP ping',
            priority: '4',
          },
        ],
      };
    })(request(body), env),
  );
  assert.equal(fallbackProblem.statusCode, 200);
  assert.equal(fallbackProblem.response.status, 'problem');
  assert.equal(fallbackProblem.response.source, 'trigger_fallback');

  const mismatch = responseOf(
    await runWithRpc(() => ({
      result: [{ eventid: '90528', objectid: '99999', value: '1', r_eventid: '0' }],
    }))(request(body), env),
  );
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.response.error.code, 'trigger_mismatch');

  const triggerMissing = responseOf(
    await runWithRpc((method) => (method === 'event.get' ? { result: [] } : { result: [] }))(request(body), env),
  );
  assert.equal(triggerMissing.statusCode, 404);
  assert.equal(triggerMissing.response.error.code, 'zabbix_trigger_not_found');

  const unknownOrigin = responseOf(await runWithRpc(() => ({ result: [] }))(request(body), { N8N_WEBHOOK_TOKEN: 'test-token' }));
  assert.equal(unknownOrigin.statusCode, 400);
  assert.equal(unknownOrigin.response.error.code, 'unknown_zabbix_origin');

  const invalidUrl = responseOf(
    await runWithRpc(() => ({ result: [] }))(
      request({ problemUrl: 'http://user:pass@localhost:8081/tr_events.php?triggerid=61119&eventid=90528' }),
      env,
    ),
  );
  assert.equal(invalidUrl.statusCode, 400);
  assert.equal(invalidUrl.response.error.code, 'invalid_problem_url');

  const workflow = workflowNode('workflows/get-zabbix-problem-status-webhook.json', 'get-zabbix-problem-status-webhook');
  assert.equal(workflow.type, 'n8n-nodes-base.webhook');
  assert.equal(workflow.parameters.path, 'zabbix/problem/status');
}

async function testWaitZabbixProblemStatus() {
  const prepareCode = codeNode(
    'workflows/wait-zabbix-problem-status-webhook.json',
    'wait-zabbix-problem-prepare',
  );
  const checkCode = codeNode(
    'workflows/wait-zabbix-problem-status-webhook.json',
    'wait-zabbix-problem-check',
  );
  const deliverCode = codeNode(
    'workflows/wait-zabbix-problem-status-webhook.json',
    'wait-zabbix-problem-deliver-result',
  );
  const env = {
    N8N_WEBHOOK_TOKEN: 'test-token',
    N8N_INTERNAL_WEBHOOK_BASE_URL: 'http://127.0.0.1:5678/webhook',
  };
  const body = {
    problemUrl: 'http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528',
    poll_interval_minutes: 15,
    timeout_minutes: 60,
    invocation: zabbixWaitAsync('kafka_event', { result_topic: 'external.events' }),
  };

  const unauthorized = responseOf(await runner(prepareCode)(request(body, ''), env));
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.response.error.code, 'unauthorized');

  const missingAsync = responseOf(
    await runner(prepareCode)(
      request({
        problemUrl: body.problemUrl,
        poll_interval_minutes: 15,
        timeout_minutes: 60,
      }),
      env,
    ),
  );
  assert.equal(missingAsync.statusCode, 400);
  assert.equal(missingAsync.response.error.code, 'missing_async_callback');

  const accepted = responseOf(await runner(prepareCode)(request(body), env));
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.response.runbook_status, 'accepted');
  assert.equal(accepted.response.async_delivery, true);
  assert.equal(accepted.response.result_topic, 'external.events');
  assert.equal(accepted.internal_webhook_base_url, 'http://127.0.0.1:5678/webhook');
  assert.equal(Object.hasOwn(accepted, 'webhook_token'), false);
  assertMainConnectionIncludes('workflows/wait-zabbix-problem-status-webhook.json', 'Запрос валиден?', 0, 'Ответ accepted');
  assertMainConnectionIncludes(
    'workflows/wait-zabbix-problem-status-webhook.json',
    'Запрос валиден?',
    0,
    'Проверка статуса Zabbix',
  );
  assertNoMainConnectionFrom('workflows/wait-zabbix-problem-status-webhook.json', 'Ответ accepted');

  const aliasAccepted = responseOf(
    await runner(prepareCode)(
      request({
        problem_url: body.problemUrl,
        pollIntervalMinutes: 15,
        timeoutMinutes: 60,
        invocation: zabbixWaitAsync('kafka_event', { result_topic: 'external.events' }),
      }),
      env,
    ),
  );
  assert.equal(aliasAccepted.statusCode, 200);
  assert.equal(aliasAccepted.problemUrl, body.problemUrl);
  assert.equal(aliasAccepted.poll_interval_minutes, 15);

  const invalidCallback = responseOf(
    await runner(prepareCode)(
      request({
        problemUrl: body.problemUrl,
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        invocation: zabbixWaitAsync('http_callback', {
          callback_url: 'http://evil.example/external-events/n8n',
        }),
      }),
      { ...env, NODE_ENV: 'production' },
    ),
  );
  assert.equal(invalidCallback.statusCode, 400);
  assert.equal(invalidCallback.response.error.code, 'invalid_callback_url');

  const localCallbackWithNodeProduction = responseOf(
    await runner(prepareCode)(
      request({
        problemUrl: body.problemUrl,
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        invocation: zabbixWaitAsync('http_callback', {
          callback_url: LOCAL_CALLBACK_URL,
        }),
      }),
      { ...env, ...LOCAL_CALLBACK_ENV_WITH_NODE_PRODUCTION },
    ),
  );
  assert.equal(localCallbackWithNodeProduction.statusCode, 200);
  assert.equal(localCallbackWithNodeProduction.response.runbook_status, 'accepted');

  const runWithZabbixStatus = (zabbixStatus) =>
    async (json) => runner(checkCode, {
      helpers: {
        async httpRequest(options) {
          assert.equal(options.url, 'http://127.0.0.1:5678/webhook/zabbix/problem/status');
          assert.equal(options.headers['X-ServiceDesk-Token'], 'test-token');
          return zabbixStatus;
        },
      },
    })(json, env);

  const ok = responseOf(
    await runWithZabbixStatus({
      status: 'ok',
      eventid: '90528',
      triggerid: '61119',
      zabbix_origin: 'http://localhost:8081',
      source: 'trigger_fallback',
      problem: { trigger_value: '0' },
    })(accepted),
  );
  assert.equal(ok.terminal, true);
  assert.equal(ok.response.status, 'ok');
  assert.equal(ok.response.timed_out, false);

  const resolved = responseOf(
    await runWithZabbixStatus({
      status: 'resolved',
      eventid: '90528',
      triggerid: '61119',
      zabbix_origin: 'http://localhost:8081',
      source: 'event',
      problem: { recovery_eventid: '90599' },
    })(accepted),
  );
  assert.equal(resolved.terminal, true);
  assert.equal(resolved.response.status, 'resolved');
  assert.equal(resolved.response.timed_out, false);

  const waiting = responseOf(
    await runWithZabbixStatus({
      status: 'problem',
      eventid: '90528',
      triggerid: '61119',
      zabbix_origin: 'http://localhost:8081',
      source: 'event',
      problem: { event_value: '1' },
    })({
      ...accepted,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  assert.equal(waiting.terminal, false);
  assert.ok(waiting.next_wait_seconds > 0);
  assert.ok(Date.parse(waiting.next_wait_at) > Date.now());

  const timedOut = responseOf(
    await runWithZabbixStatus({
      status: 'problem',
      eventid: '90528',
      triggerid: '61119',
      zabbix_origin: 'http://localhost:8081',
      source: 'event',
      problem: { event_value: '1' },
    })({
      ...accepted,
      deadline_at: new Date(Date.now() - 1000).toISOString(),
    }),
  );
  assert.equal(timedOut.terminal, true);
  assert.equal(timedOut.response.status, 'problem');
  assert.equal(timedOut.response.timed_out, true);

  const invalidStatus = responseOf(await runWithZabbixStatus({ status: 'unknown' })(accepted));
  assert.equal(invalidStatus.terminal, true);
  assert.equal(invalidStatus.response.status, 'ERROR');
  assert.equal(invalidStatus.response.error.code, 'invalid_zabbix_status_response');

  const failed = responseOf(
    await runner(checkCode, {
      helpers: {
        async httpRequest() {
          throw new Error('zabbix token secret failure');
        },
      },
    })(accepted, env),
  );
  assert.equal(failed.terminal, true);
  assert.equal(failed.response.status, 'ERROR');
  assert.equal(failed.response.error.code, 'zabbix_status_failed');
  assert.ok(!failed.response.error.reason.includes('token'));

  const callbackCalls = [];
  const delivered = responseOf(
    await runner(deliverCode, {
      helpers: {
        async httpRequest(options) {
          callbackCalls.push(options);
          return { ok: true };
        },
      },
    })(
      {
        ...ok,
        async_callback: zabbixWaitAsync('http_callback', {
          callback_url: 'http://127.0.0.1:18088/external-events/n8n',
        }).extensions.async_callback,
      },
      { INTEGRATION_CALLBACK_TOKEN__N8N: 'callback-token' },
    ),
  );
  assert.equal(callbackCalls.length, 1);
  assert.equal(callbackCalls[0].headers['X-ServiceDesk-Callback-Token'], 'callback-token');
  assert.equal(callbackCalls[0].body.status, 'success');
  assert.equal(delivered.externalEvent.result.status, 'ok');
  assert.equal(
    delivered.externalEvent.idempotency_key,
    'case-000000000001:tool_command:cmd-zabbix-wait-123:zabbix_problem_wait_ok',
  );
  assert.equal(delivered.shouldPublishKafka, false);
  assert.equal(delivered.delivery_status.http_callback, 'sent');

  const failedCallbackBoth = responseOf(
    await runner(deliverCode, {
      helpers: {
        async httpRequest() {
          throw new Error('callback is down');
        },
      },
    })(
      {
        ...ok,
        async_callback: zabbixWaitAsync('both', {
          callback_url: 'http://127.0.0.1:18088/external-events/n8n',
          result_topic: 'external.events',
        }).extensions.async_callback,
      },
      { INTEGRATION_CALLBACK_TOKEN__N8N: 'callback-token' },
    ),
  );
  assert.equal(failedCallbackBoth.shouldPublishKafka, true);
  assert.equal(failedCallbackBoth.kafkaTopic, 'external.events');
  assert.equal(failedCallbackBoth.delivery_status.http_callback, 'failed');
  assert.equal(failedCallbackBoth.delivery_status.http_callback_error, 'callback_delivery_failed');
  assert.equal(failedCallbackBoth.externalEvent.result.delivery_status.http_callback, 'failed');

  const timeoutEvent = responseOf(
    await runner(deliverCode)({
      ...timedOut,
      async_callback: zabbixWaitAsync('kafka_event', { result_topic: 'external.events' }).extensions.async_callback,
    }),
  );
  assert.equal(timeoutEvent.externalEvent.status, 'timeout');
  assert.equal(
    timeoutEvent.externalEvent.idempotency_key,
    'case-000000000001:tool_command:cmd-zabbix-wait-123:zabbix_problem_wait_problem_timeout',
  );
  assert.equal(timeoutEvent.shouldPublishKafka, true);
  assert.equal(timeoutEvent.kafkaTopic, 'external.events');

  const workflow = workflowNode('workflows/wait-zabbix-problem-status-webhook.json', 'wait-zabbix-problem-webhook');
  assert.equal(workflow.type, 'n8n-nodes-base.webhook');
  assert.equal(workflow.parameters.path, 'zabbix/problem/wait');
}

function nodeLookup(valuesByName) {
  return (name) => ({
    first() {
      assert.ok(Object.hasOwn(valuesByName, name), `Missing mocked node output for ${name}`);
      return { json: valuesByName[name] };
    },
  });
}

function hrPositionsResponse(extraPositions = []) {
  return {
    statusCode: 200,
    body: [
      {
        LegalEntity: 'LE1',
        Positions: [
          {
            PositionGID: 'pos-employee',
            PositionName: 'Инженер связи',
            OrgUnitGID: 'unit-employee',
            OrgUnitName: 'Группа эксплуатации',
            Employees: [
              {
                EmployeeGID: 'emp-gid-1',
                EmployeeInfo: {
                  State: 'Working',
                  PersonInfo: {
                    PersonGID: 'person-1',
                    Last_name: 'Иванов',
                    First_name: 'Иван',
                    Middle_name: 'Иванович',
                  },
                },
              },
            ],
          },
          {
            PositionGID: 'pos-manager',
            PositionName: 'Руководитель группы',
            OrgUnitGID: 'unit-manager',
            OrgUnitName: 'Эксплуатация',
            Employees: [
              {
                EmployeeGID: 'mgr-gid-1',
                EmployeeInfo: {
                  EmployeeID: '2001',
                  State: 'Working',
                  PersonInfo: {
                    PersonGID: 'person-2',
                    Last_name: 'Петров',
                    First_name: 'Петр',
                    Middle_name: 'Петрович',
                  },
                },
              },
            ],
          },
          ...extraPositions,
        ],
      },
    ],
  };
}

function hrManagerialOrgResponse(parentGid = 'pos-manager') {
  return {
    statusCode: 200,
    body: [
      {
        LegalEntity: 'LE1',
        OrgUnits: [],
        Positions: [
          { PositionGID: 'pos-employee', ParentGID: parentGid },
          { PositionGID: 'pos-manager', ParentGID: '' },
        ],
      },
    ],
  };
}

function hrAdministrativeOrgResponse(managerPositionGid = 'pos-manager') {
  return {
    statusCode: 200,
    body: [
      {
        LegalEntity: 'LE1',
        OrgUnits: [
          {
            OrgUnitGID: 'unit-employee',
            Name: 'Группа эксплуатации',
            ManagerPositionGID: managerPositionGid,
          },
        ],
      },
    ],
  };
}

const hrSubordinatesResponse = {
  statusCode: 200,
  body: [
    {
      Positions: [
        {
          Subordinates: [
            {
              Employees: [
                {
                  EmployeeGID: 'emp-gid-1',
                  EmployeeID: '1001',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function hrPrepared(bodyOverrides = {}) {
  const prepareCode = codeNode('workflows/hr-find-manager.json', 'hr-verify-manager-prepare');
  return responseOf(
    await runner(prepareCode)(
      request({
        employee_full_name: 'Иванов Иван Иванович',
        claimed_manager_full_name: 'Петров Петр Петрович',
        relation_type: 'managerial',
        ...bodyOverrides,
      }),
      {
        N8N_WEBHOOK_TOKEN: 'test-token',
        HR_API_BASE_URL: 'http://hr.local/api',
      },
    ),
  );
}

async function hrState(prepared, positionsResponse = hrPositionsResponse()) {
  const buildStateCode = codeNode('workflows/hr-find-manager.json', 'hr-verify-manager-build-state');
  return responseOf(
    await runner(buildStateCode, {
      $: nodeLookup({ 'Подготовка запроса HR': prepared }),
    })(positionsResponse),
  );
}

async function hrEvaluate(state, overrides = {}) {
  const evaluateCode = codeNode('workflows/hr-find-manager.json', 'hr-verify-manager-evaluate');
  const inputState = JSON.parse(JSON.stringify(state));
  return responseOf(
    await runner(evaluateCode, {
      $: nodeLookup({
        'Подготовка набора кандидатов': inputState,
        'Загрузка административной оргструктуры': overrides.adminOrg || hrAdministrativeOrgResponse(),
        'Загрузка управленческой оргструктуры': overrides.managerialOrg || hrManagerialOrgResponse(),
        'Загрузка административных подчиненных': overrides.adminSubordinates || { statusCode: 200, body: [] },
        'Загрузка управленческих подчиненных': overrides.managerialSubordinates || hrSubordinatesResponse,
      }),
    })({}),
  );
}

async function testHrVerifyManager() {
  const prepareCode = codeNode('workflows/hr-find-manager.json', 'hr-verify-manager-prepare');
  const env = {
    N8N_WEBHOOK_TOKEN: 'test-token',
    HR_API_BASE_URL: 'http://hr.local/api',
  };

  const unauthorized = responseOf(
    await runner(prepareCode)(
      request({
        employee_full_name: 'Иванов Иван Иванович',
        claimed_manager_full_name: 'Петров Петр Петрович',
      }, ''),
      env,
    ),
  );
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.response.error.code, 'unauthorized');

  const missingEmployee = responseOf(
    await runner(prepareCode)(
      request({
        claimed_manager_full_name: 'Петров Петр Петрович',
      }),
      env,
    ),
  );
  assert.equal(missingEmployee.statusCode, 400);
  assert.equal(missingEmployee.response.error.code, 'missing_employee_full_name');

  const invalidRelation = responseOf(
    await runner(prepareCode)(
      request({
        employeeFullName: 'Иванов Иван Иванович',
        claimedManagerFullName: 'Петров Петр Петрович',
        relationType: 'functional',
      }),
      env,
    ),
  );
  assert.equal(invalidRelation.statusCode, 400);
  assert.equal(invalidRelation.response.error.code, 'invalid_relation_type');

  const prepared = await hrPrepared({ relation_type: undefined, relationType: undefined });
  assert.equal(prepared.statusCode, 200);
  assert.equal(prepared.relation_type, 'both');
  assert.deepEqual(prepared.positions_hired_body.legalEntities, []);
  assert.equal(prepared.hr_api_base_url, 'http://hr.local/api');

  const managerialPrepared = await hrPrepared();
  const state = await hrState(managerialPrepared);
  assert.equal(state.done, false);
  assert.equal(state.employee_matches.length, 1);
  assert.equal(state.manager_matches.length, 1);
  assert.deepEqual(state.manager_employee_gids, ['mgr-gid-1']);

  const ok = await hrEvaluate(state);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.response.status, 'OK');
  assert.deepEqual(ok.response.matched_relation_types, ['managerial']);
  assert.equal(ok.response.employee_id, '1001');
  assert.equal(ok.response.manager_id, '2001');
  assert.equal(ok.response.employee.employee_id, '1001');
  assert.equal(ok.response.manager.employee_id, '2001');
  assert.equal(ok.response.manager.employee_id_found, true);

  const managerIdMissingState = JSON.parse(JSON.stringify(state));
  for (const person of Object.values(managerIdMissingState.people_by_key)) {
    if (person.employee_gid === 'mgr-gid-1') {
      person.employee_id = null;
      person.employee_id_found = false;
    }
  }
  managerIdMissingState.manager_matches = managerIdMissingState.manager_matches.map((person) => {
    if (person.employee_gid !== 'mgr-gid-1') return person;
    return { ...person, employee_id: null, employee_id_found: false };
  });
  const managerIdMissing = await hrEvaluate(managerIdMissingState);
  assert.equal(managerIdMissing.statusCode, 200);
  assert.equal(managerIdMissing.response.status, 'ERROR');
  assert.equal(managerIdMissing.response.error_code, 'manager_id_not_found');
  assert.equal(managerIdMissing.response.manager.employee_id_found, false);
  assert.deepEqual(managerIdMissing.response.matched_relation_types, ['managerial']);

  const employeeIdMissing = await hrEvaluate(state, {
    managerialSubordinates: { statusCode: 200, body: [] },
  });
  assert.equal(employeeIdMissing.statusCode, 200);
  assert.equal(employeeIdMissing.response.status, 'ERROR');
  assert.equal(employeeIdMissing.response.error_code, 'employee_id_not_found');
  assert.equal(employeeIdMissing.response.employee.employee_id_found, false);
  assert.deepEqual(employeeIdMissing.response.matched_relation_types, ['managerial']);

  const employeeNotFoundState = await hrState(
    await hrPrepared({ employee_full_name: 'Сидоров Сидор Сидорович' }),
  );
  const employeeNotFound = await hrEvaluate(employeeNotFoundState);
  assert.equal(employeeNotFound.response.status, 'ERROR');
  assert.equal(employeeNotFound.response.error_code, 'employee_not_found');

  const duplicatePosition = {
    PositionGID: 'pos-employee-duplicate',
    PositionName: 'Инженер связи 2',
    OrgUnitGID: 'unit-employee',
    OrgUnitName: 'Группа эксплуатации',
    Employees: [
      {
        EmployeeGID: 'emp-gid-duplicate',
        EmployeeInfo: {
          State: 'Working',
          PersonInfo: {
            PersonGID: 'person-duplicate',
            Last_name: 'Иванов',
            First_name: 'Иван',
            Middle_name: 'Иванович',
          },
        },
      },
    ],
  };
  const duplicateState = await hrState(managerialPrepared, hrPositionsResponse([duplicatePosition]));
  const duplicate = await hrEvaluate(duplicateState);
  assert.equal(duplicate.response.status, 'ERROR');
  assert.equal(duplicate.response.error_code, 'employee_not_unique');
  assert.equal(duplicate.response.employee_matches.length, 2);

  const noRelation = await hrEvaluate(state, {
    managerialOrg: hrManagerialOrgResponse(''),
  });
  assert.equal(noRelation.response.status, 'ERROR');
  assert.equal(noRelation.response.error_code, 'confirmed_relation_not_found');
  assert.ok(noRelation.response.checked_pairs.length > 0);
}

async function testHrApplicantParticipant() {
  const verifyCode = codeNode(
    'workflows/hr-applicant-participant-webhook.json',
    'hr-applicant-participant-verify',
  );
  const run = runner(verifyCode);
  const env = { N8N_WEBHOOK_TOKEN: 'test-token' };

  const unauthorized = responseOf(
    await run(
      request(
        {
          applicant_full_name: 'Иванов Иван Иванович',
          employee_full_name: 'Иванов Иван Иванович',
          manager_full_name: 'Петров Петр Петрович',
        },
        '',
      ),
      env,
    ),
  );
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.response.error.code, 'unauthorized');

  const missingApplicant = responseOf(
    await run(
      request({
        employee_full_name: 'Иванов Иван Иванович',
        manager_full_name: 'Петров Петр Петрович',
      }),
      env,
    ),
  );
  assert.equal(missingApplicant.statusCode, 400);
  assert.equal(missingApplicant.response.error.code, 'missing_applicant_full_name');

  const employee = responseOf(
    await run(
      request({
        applicant_full_name: '  Иванов   Иван Иванович  ',
        employee_full_name: 'иванов иван иванович',
        manager_full_name: 'Петров Петр Петрович',
      }),
      env,
    ),
  );
  assert.equal(employee.statusCode, 200);
  assert.equal(employee.response.status, 'OK');
  assert.equal(employee.response.matched_role, 'employee');
  assert.equal(employee.response.applicant_full_name, 'Иванов Иван Иванович');

  const manager = responseOf(
    await run(
      request({
        applicantFullName: 'Петров Петр Петрович',
        employeeFullName: 'Иванов Иван Иванович',
        managerFullName: 'петров   петр   петрович',
      }),
      env,
    ),
  );
  assert.equal(manager.statusCode, 200);
  assert.equal(manager.response.status, 'OK');
  assert.equal(manager.response.matched_role, 'manager');

  const both = responseOf(
    await run(
      request({
        applicant_full_name: 'Иванов Иван Иванович',
        employee_full_name: 'Иванов Иван Иванович',
        manager_full_name: 'иванов иван иванович',
      }),
      env,
    ),
  );
  assert.equal(both.statusCode, 200);
  assert.equal(both.response.status, 'OK');
  assert.equal(both.response.matched_role, 'both');

  const notParticipant = responseOf(
    await run(
      request({
        applicant_full_name: 'Сидоров Сидор Сидорович',
        employee_full_name: 'Иванов Иван Иванович',
        manager_full_name: 'Петров Петр Петрович',
      }),
      env,
    ),
  );
  assert.equal(notParticipant.statusCode, 200);
  assert.equal(notParticipant.response.status, 'ERROR');
  assert.equal(notParticipant.response.error_code, 'applicant_not_participant');

  const workflow = workflowNode(
    'workflows/hr-applicant-participant-webhook.json',
    'hr-applicant-participant-webhook',
  );
  assert.equal(workflow.type, 'n8n-nodes-base.webhook');
  assert.equal(workflow.parameters.path, 'hr/verify-applicant-participant');
}

async function testAdUserLoginLookup() {
  const prepareCode = codeNode('workflows/ad-user-login-lookup-webhook.json', 'ad-login-lookup-prepare');
  const normalizeCode = codeNode('workflows/ad-user-login-lookup-webhook.json', 'ad-login-lookup-normalize');
  const env = {
    N8N_WEBHOOK_TOKEN: 'test-token',
    AD_BASE_DN: 'OU=Users,DC=example,DC=local',
  };

  const unauthorized = responseOf(
    await runner(prepareCode)(
      request({
        full_name: 'Иванов Иван Иванович',
        employee_id: '1001',
      }, ''),
      env,
    ),
  );
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.response.error.code, 'unauthorized');

  const missingFullName = responseOf(
    await runner(prepareCode)(
      request({
        employee_id: '1001',
      }),
      env,
    ),
  );
  assert.equal(missingFullName.statusCode, 400);
  assert.equal(missingFullName.response.error.code, 'missing_full_name');

  const missingBaseDn = responseOf(
    await runner(prepareCode)(
      request({
        full_name: 'Иванов Иван Иванович',
        employee_id: '1001',
      }),
      { N8N_WEBHOOK_TOKEN: 'test-token' },
    ),
  );
  assert.equal(missingBaseDn.statusCode, 500);
  assert.equal(missingBaseDn.response.error.code, 'missing_ad_base_dn');

  const invalidAttribute = responseOf(
    await runner(prepareCode)(
      request({
        full_name: 'Иванов Иван Иванович',
        employee_id: '1001',
        full_name_attribute: 'displayName)(uid=*',
      }),
      env,
    ),
  );
  assert.equal(invalidAttribute.statusCode, 400);
  assert.equal(invalidAttribute.response.error.code, 'invalid_ad_attribute');

  const invalidEmailAttribute = responseOf(
    await runner(prepareCode)(
      request({
        full_name: 'Иванов Иван Иванович',
        employee_id: '1001',
        email_attribute: 'mail)(uid=*',
      }),
      env,
    ),
  );
  assert.equal(invalidEmailAttribute.statusCode, 400);
  assert.equal(invalidEmailAttribute.response.error.code, 'invalid_ad_attribute');

  const prepared = responseOf(
    await runner(prepareCode)(
      request({
        fullName: 'Иванов (тест)* \\\\',
        employeeId: '1001',
        loginAttribute: 'userPrincipalName',
        emailAttribute: 'mail',
        baseDN: 'OU=Contractors,DC=example,DC=local',
      }),
      {
        N8N_WEBHOOK_TOKEN: 'test-token',
        AD_FULL_NAME_ATTRIBUTE: 'cn',
        AD_EMPLOYEE_ID_ATTRIBUTE: 'employeeNumber',
      },
    ),
  );
  assert.equal(prepared.valid, true);
  assert.equal(prepared.base_dn, 'OU=Contractors,DC=example,DC=local');
  assert.equal(prepared.full_name_attribute, 'cn');
  assert.equal(prepared.employee_id_attribute, 'employeeNumber');
  assert.equal(prepared.login_attribute, 'userPrincipalName');
  assert.equal(prepared.email_attribute, 'mail');
  assert.ok(prepared.ldap_filter.includes('(cn=Иванов \\28тест\\29\\2a '));
  assert.ok(prepared.ldap_filter.includes('\\5c'));
  assert.ok(prepared.ldap_filter.includes('(employeeNumber=1001)'));
  assert.deepEqual(prepared.ldap_attributes, [
    'userPrincipalName',
    'mail',
    'cn',
    'employeeNumber',
    'distinguishedName',
  ]);

  const normalize = async (ldapItems) =>
    responseOf(
      await runner(normalizeCode, {
        $: nodeLookup({ 'Подготовка AD запроса': prepared }),
      })(ldapItems),
    );

  const ok = await normalize([
    {
      userPrincipalName: 'iivanov@example.local',
      mail: 'iivanov@example.ru',
      cn: 'Иванов Иван Иванович',
      employeeNumber: '1001',
    },
  ]);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.response.status, 'OK');
  assert.equal(ok.response.login, 'iivanov@example.local');
  assert.equal(ok.response.email, 'iivanov@example.ru');
  assert.equal(ok.response.matched_by.login_attribute, 'userPrincipalName');
  assert.equal(ok.response.matched_by.email_attribute, 'mail');

  const notFound = await normalize([{}]);
  assert.equal(notFound.statusCode, 200);
  assert.equal(notFound.response.status, 'ERROR');
  assert.equal(notFound.response.error_code, 'ad_user_not_found');
  assert.equal(notFound.response.match_count, 0);

  const duplicate = await normalize([
    {
      userPrincipalName: 'iivanov@example.local',
      mail: 'iivanov@example.ru',
      cn: 'Иванов Иван Иванович',
      employeeNumber: '1001',
    },
    {
      userPrincipalName: 'iivanov2@example.local',
      mail: 'iivanov2@example.ru',
      cn: 'Иванов Иван Иванович',
      employeeNumber: '1001',
    },
  ]);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.response.status, 'ERROR');
  assert.equal(duplicate.response.error_code, 'ad_user_not_unique');
  assert.equal(duplicate.response.match_count, 2);
  assert.equal(duplicate.response.candidates[0].email, 'iivanov@example.ru');

  const loginMissing = await normalize([
    {
      mail: 'iivanov@example.ru',
      cn: 'Иванов Иван Иванович',
      employeeNumber: '1001',
      distinguishedName: 'CN=Ivanov,OU=Users,DC=example,DC=local',
    },
  ]);
  assert.equal(loginMissing.statusCode, 200);
  assert.equal(loginMissing.response.status, 'ERROR');
  assert.equal(loginMissing.response.error_code, 'ad_login_not_found');

  const emailMissing = await normalize([
    {
      userPrincipalName: 'iivanov@example.local',
      cn: 'Иванов Иван Иванович',
      employeeNumber: '1001',
      distinguishedName: 'CN=Ivanov,OU=Users,DC=example,DC=local',
    },
  ]);
  assert.equal(emailMissing.statusCode, 200);
  assert.equal(emailMissing.response.status, 'ERROR');
  assert.equal(emailMissing.response.error_code, 'ad_email_not_found');

  const ldapFailed = await normalize([{ error: 'bind password token secret failure' }]);
  assert.equal(ldapFailed.statusCode, 502);
  assert.equal(ldapFailed.response.error.code, 'ad_lookup_failed');
  assert.ok(!ldapFailed.response.error.reason.includes('token'));
  assert.ok(!ldapFailed.response.error.reason.includes('password'));

  const workflow = workflowNode('workflows/ad-user-login-lookup-webhook.json', 'ad-login-lookup-webhook');
  assert.equal(workflow.type, 'n8n-nodes-base.webhook');
  assert.equal(workflow.parameters.path, 'ad/user/login-lookup');
}

async function testAdPasswordReset() {
  const workflowPath = 'workflows/ad-password-reset-webhook.json';
  const prepareCode = codeNode(workflowPath, 'ad-password-reset-prepare');
  const buildUpdateCode = codeNode(workflowPath, 'ad-password-reset-build-update');
  const normalizeCode = codeNode(workflowPath, 'ad-password-reset-normalize');
  const env = {
    N8N_WEBHOOK_TOKEN: 'test-token',
    N8N_INTERNAL_RUNBOOK_TOKEN: 'internal-token',
    AD_BASE_DN: 'OU=Users,DC=example,DC=local',
  };

  const unauthorized = responseOf(await runner(prepareCode)(request({ login: 'iivanov' }, ''), env));
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.response.error.code, 'unauthorized');

  const missingInternalToken = responseOf(
    await runner(prepareCode)(request({ login: 'iivanov' }), {
      N8N_WEBHOOK_TOKEN: 'test-token',
      N8N_INTERNAL_RUNBOOK_TOKEN: 'internal-token',
      AD_BASE_DN: 'OU=Users,DC=example,DC=local',
    }),
  );
  assert.equal(missingInternalToken.statusCode, 403);
  assert.equal(missingInternalToken.response.error.code, 'forbidden_internal_runbook_token');

  const missingInternalConfig = responseOf(
    await runner(prepareCode)(internalRequest({ login: 'iivanov' }), {
      N8N_WEBHOOK_TOKEN: 'test-token',
      AD_BASE_DN: 'OU=Users,DC=example,DC=local',
    }),
  );
  assert.equal(missingInternalConfig.statusCode, 500);
  assert.equal(missingInternalConfig.response.error.code, 'missing_internal_runbook_token');

  const missingLogin = responseOf(await runner(prepareCode)(internalRequest({}), env));
  assert.equal(missingLogin.statusCode, 400);
  assert.equal(missingLogin.response.error.code, 'missing_login');

  const invalidLength = responseOf(
    await runner(prepareCode)(internalRequest({ login: 'iivanov', password_length: 4 }), env),
  );
  assert.equal(invalidLength.statusCode, 400);
  assert.equal(invalidLength.response.error.code, 'invalid_password_length');

  const invalidAllowedChars = responseOf(
    await runner(prepareCode)(internalRequest({ login: 'iivanov' }), { ...env, AD_PASSWORD_ALLOWED_CHARS: 'A' }),
  );
  assert.equal(invalidAllowedChars.statusCode, 500);
  assert.equal(invalidAllowedChars.response.error.code, 'invalid_allowed_chars_config');

  const invalidAttribute = responseOf(
    await runner(prepareCode)(internalRequest({ login: 'iivanov' }), {
      ...env,
      AD_PASSWORD_RESET_LOGIN_ATTRIBUTE: 'sAMAccountName)(uid=*',
    }),
  );
  assert.equal(invalidAttribute.statusCode, 500);
  assert.equal(invalidAttribute.response.error.code, 'invalid_ad_attribute_config');

  const missingBaseDn = responseOf(
    await runner(prepareCode)(internalRequest({ login: 'iivanov' }), {
      N8N_WEBHOOK_TOKEN: 'test-token',
      N8N_INTERNAL_RUNBOOK_TOKEN: 'internal-token',
    }),
  );
  assert.equal(missingBaseDn.statusCode, 500);
  assert.equal(missingBaseDn.response.error.code, 'missing_ad_base_dn');

  const prepared = responseOf(
    await runner(prepareCode)(
      internalRequest({
        login: 'iivanov',
        passwordLength: 12,
      }),
      {
        ...env,
        AD_PASSWORD_ALLOWED_CHARS: 'ABCabc123',
        AD_PASSWORD_RESET_LOGIN_ATTRIBUTE: 'userPrincipalName',
        AD_PASSWORD_RESET_BASE_DN: 'OU=Contractors,DC=example,DC=local',
      },
    ),
  );
  assert.equal(prepared.valid, true);
  assert.equal(prepared.login, 'iivanov');
  assert.equal(prepared.base_dn, 'OU=Contractors,DC=example,DC=local');
  assert.equal(prepared.login_attribute, 'userPrincipalName');
  assert.equal(prepared.password_length, 12);
  assert.equal(prepared.password.length, 12);
  assert.match(prepared.password, /^[ABCabc123]+$/);
  assert.match(prepared.password, /[ABC]/);
  assert.match(prepared.password, /[abc]/);
  assert.match(prepared.password, /[123]/);
  assert.equal(prepared.unicode_pwd, `"${prepared.password}"`);
  assert.equal(prepared.pwd_last_set, '0');
  assert.ok(prepared.ldap_filter.includes('(userPrincipalName=iivanov)'));
  assert.deepEqual(prepared.ldap_attributes, ['userPrincipalName', 'distinguishedName', 'dn']);
  assert.deepEqual(prepared.matched_by, { login_attribute: 'userPrincipalName' });

  const buildUpdate = async (ldapItems) =>
    responseOf(
      await runner(buildUpdateCode, {
        $: nodeLookup({ 'Подготовка AD reset запроса': prepared }),
      })(ldapItems),
    );

  const lookupFailed = await buildUpdate([{ error: `bind password token secret ${prepared.password}` }]);
  assert.equal(lookupFailed.statusCode, 200);
  assert.equal(lookupFailed.response.status, 'ERROR');
  assert.equal(lookupFailed.response.error_code, 'ad_user_lookup_failed');
  assert.ok(!lookupFailed.response.reason.includes(prepared.password));
  assert.ok(!lookupFailed.response.reason.includes('token'));
  assert.ok(!lookupFailed.response.reason.includes('password'));

  const notFound = await buildUpdate([{}]);
  assert.equal(notFound.statusCode, 200);
  assert.equal(notFound.response.status, 'ERROR');
  assert.equal(notFound.response.error_code, 'ad_user_not_found');
  assert.equal(notFound.response.match_count, 0);

  const duplicate = await buildUpdate([
    { userPrincipalName: 'iivanov@example.local', distinguishedName: 'CN=Ivan,OU=Users,DC=example,DC=local' },
    { userPrincipalName: 'iivanov2@example.local', distinguishedName: 'CN=Ivan2,OU=Users,DC=example,DC=local' },
  ]);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.response.status, 'ERROR');
  assert.equal(duplicate.response.error_code, 'ad_user_not_unique');
  assert.equal(duplicate.response.match_count, 2);

  const missingDn = await buildUpdate([{ userPrincipalName: 'iivanov@example.local' }]);
  assert.equal(missingDn.statusCode, 200);
  assert.equal(missingDn.response.status, 'ERROR');
  assert.equal(missingDn.response.error_code, 'ad_user_dn_not_found');

  const updateState = await buildUpdate([
    {
      userPrincipalName: 'iivanov@example.local',
      distinguishedName: 'CN=Ivan,OU=Users,DC=example,DC=local',
    },
  ]);
  assert.equal(updateState.update_required, true);
  assert.equal(updateState.dn, 'CN=Ivan,OU=Users,DC=example,DC=local');
  assert.equal(updateState.login, 'iivanov');
  assert.equal(updateState.password, prepared.password);
  assert.equal(updateState.unicode_pwd, `"${prepared.password}"`);
  assert.equal(updateState.pwd_last_set, '0');

  const normalize = async (ldapItems) =>
    responseOf(
      await runner(normalizeCode, {
        $: nodeLookup({ 'Подготовка смены пароля': updateState }),
      })(ldapItems),
    );

  const updateFailed = await normalize([{ error: `unicodePwd bind password token secret ${prepared.password}` }]);
  assert.equal(updateFailed.statusCode, 200);
  assert.equal(updateFailed.response.status, 'ERROR');
  assert.equal(updateFailed.response.error_code, 'ad_password_update_failed');
  assert.ok(!updateFailed.response.reason.includes(prepared.password));
  assert.ok(!updateFailed.response.reason.includes('token'));
  assert.ok(!updateFailed.response.reason.includes('password'));
  assert.ok(!updateFailed.response.reason.includes('unicodePwd'));

  const updateUnconfirmed = await normalize([{}]);
  assert.equal(updateUnconfirmed.statusCode, 200);
  assert.equal(updateUnconfirmed.response.status, 'ERROR');
  assert.equal(updateUnconfirmed.response.error_code, 'ad_password_update_unconfirmed');

  const ok = await normalize([{ result: 'success' }]);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.response.status, 'OK');
  assert.equal(ok.response.login, 'iivanov');
  assert.equal(ok.response.password, prepared.password);
  assert.equal(ok.response.password_length, 12);
  assert.equal(ok.response.change_on_first_login, true);
  assert.deepEqual(ok.response.matched_by, { login_attribute: 'userPrincipalName' });

  const workflow = readJson(workflowPath);
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveManualExecutions, false);
  const webhook = workflowNode(workflowPath, 'ad-password-reset-webhook');
  assert.equal(webhook.type, 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.path, 'ad/user/reset-password');
  const ldapSearch = workflowNode(workflowPath, 'ad-password-reset-search');
  assert.equal(ldapSearch.parameters.operation, 'search');
  assert.equal(ldapSearch.parameters.limit, 2);
  assert.equal(ldapSearch.continueOnFail, true);
  assert.equal(ldapSearch.alwaysOutputData, true);
  const ldapUpdate = workflowNode(workflowPath, 'ad-password-reset-update');
  assert.equal(ldapUpdate.parameters.operation, 'update');
  assert.deepEqual(
    ldapUpdate.parameters.attributes.replace.map((entry) => entry.id),
    ['unicodePwd', 'pwdLastSet'],
  );
  assert.equal(ldapUpdate.continueOnFail, true);
  assert.equal(ldapUpdate.alwaysOutputData, true);
}

async function testAdPasswordResetProcess() {
  const workflowPath = 'workflows/ad-password-reset-process-webhook.json';
  const runCode = codeNode(workflowPath, 'ad-password-reset-process-run');
  const baseRequest = {
    service_request: '12345678',
    applicant_full_name: 'Петров Петр Петрович',
    employee_full_name: 'Иванов Иван Иванович',
    claimed_manager_full_name: 'Петров Петр Петрович',
    approval_id: 'approval-123',
    approved_by: 'service-desk-supervisor',
    idempotency_key: 'case-123:password-reset',
  };
  const env = {
    N8N_WEBHOOK_TOKEN: 'test-token',
    N8N_INTERNAL_RUNBOOK_TOKEN: 'internal-token',
    N8N_INTERNAL_WEBHOOK_BASE_URL: 'http://127.0.0.1:5678/webhook',
  };

  const makeContext = (handlers, calls = []) => ({
    helpers: {
      async httpRequest(options) {
        calls.push(options);
        const url = new URL(options.url);
        const handler = handlers[url.pathname];
        assert.ok(handler, `Unexpected internal call to ${url.pathname}`);
        assert.equal(options.headers['X-ServiceDesk-Token'], 'test-token');
        assert.ok(options.headers['Idempotency-Key'].startsWith('case-123:password-reset:'));
        if (url.pathname === '/webhook/ad/user/reset-password') {
          assert.equal(options.headers['X-ServiceDesk-Internal-Token'], 'internal-token');
          assert.equal(options.body.approval_id, 'approval-123');
          assert.equal(options.body.approved_by, 'service-desk-supervisor');
          assert.equal(options.body.idempotency_key, 'case-123:password-reset:password_reset');
        }
        return handler(options.body, options);
      },
    },
  });

  const okHandlers = (overrides = {}) => ({
    '/webhook/hr/verify-applicant-participant': () => ({
      status: 'OK',
      matched_role: 'manager',
      applicant_full_name: baseRequest.applicant_full_name,
      employee_full_name: baseRequest.employee_full_name,
      manager_full_name: baseRequest.claimed_manager_full_name,
    }),
    '/webhook/hr/verify-manager': () => ({
      status: 'OK',
      message: 'Проверка OK.',
      relation_type_requested: 'both',
      matched_relation_types: ['managerial'],
      employee_id: '1001',
      manager_id: '2001',
    }),
    '/webhook/ad/user/login-lookup': (body) => {
      if (body.employee_id === '1001') {
        return {
          status: 'OK',
          login: 'iivanov',
          email: 'iivanov@example.ru',
          full_name: baseRequest.employee_full_name,
          employee_id: '1001',
        };
      }
      return {
        status: 'OK',
        login: 'ppetrov',
        email: 'ppetrov@example.ru',
        full_name: baseRequest.claimed_manager_full_name,
        employee_id: '2001',
      };
    },
    '/webhook/ad/user/reset-password': () => ({
      status: 'OK',
      login: 'iivanov',
      password: 'Secret123ABC',
      password_length: 12,
      change_on_first_login: true,
    }),
    '/webhook/email/send-template': (body) => {
      assert.equal(body.to[0], 'ppetrov@example.ru');
      assert.equal(body.templateId, 'ad_password_reset_notification');
      assert.equal(body.params.service_request, '12345678');
      assert.equal(body.params.employee_full_name, baseRequest.employee_full_name);
      assert.equal(body.params.password, 'Secret123ABC');
      return { status: 'sent' };
    },
    ...overrides,
  });

  const unauthorized = responseOf(await runner(runCode)(request(baseRequest, ''), env));
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.response.error.code, 'unauthorized');

  const missingEmployee = responseOf(
    await runner(runCode)(request({ service_request: '12345678', applicant_full_name: 'Петров Петр Петрович' }), env),
  );
  assert.equal(missingEmployee.statusCode, 400);
  assert.equal(missingEmployee.response.error.code, 'missing_employee_full_name');

  const invalidInternalUrl = responseOf(
    await runner(runCode)(request(baseRequest), {
      N8N_WEBHOOK_TOKEN: 'test-token',
      N8N_INTERNAL_RUNBOOK_TOKEN: 'internal-token',
      N8N_INTERNAL_WEBHOOK_BASE_URL: 'ftp://n8n.example',
    }),
  );
  assert.equal(invalidInternalUrl.statusCode, 500);
  assert.equal(invalidInternalUrl.response.error.code, 'invalid_internal_webhook_base_url');

  const missingApproval = responseOf(
    await runner(runCode)(
      request({
        service_request: '12345678',
        applicant_full_name: 'Петров Петр Петрович',
        employee_full_name: 'Иванов Иван Иванович',
        claimed_manager_full_name: 'Петров Петр Петрович',
      }),
      env,
    ),
  );
  assert.equal(missingApproval.statusCode, 400);
  assert.equal(missingApproval.response.error.code, 'missing_approval_id');

  const applicantCalls = [];
  const applicantFailure = responseOf(
    await runner(
      runCode,
      makeContext(
        okHandlers({
          '/webhook/hr/verify-applicant-participant': () => ({
            status: 'ERROR',
            error_code: 'applicant_not_participant',
            message: 'Заявитель не совпадает ни с сотрудником, ни с руководителем.',
          }),
        }),
        applicantCalls,
      ),
    )(request(baseRequest), env),
  );
  assert.equal(applicantFailure.statusCode, 200);
  assert.equal(applicantFailure.response.status, 'ERROR');
  assert.equal(applicantFailure.response.failed_step, 'applicant_participant');
  assert.equal(applicantFailure.response.error_code, 'applicant_participant_applicant_not_participant');
  assert.equal(applicantFailure.response.password_changed, false);
  assert.equal(applicantCalls.length, 1);

  const managerCalls = [];
  const managerFailure = responseOf(
    await runner(
      runCode,
      makeContext(
        okHandlers({
          '/webhook/hr/verify-manager': () => ({
            status: 'ERROR',
            error_code: 'manager_id_not_found',
            message: 'Табельный номер руководителя не найден.',
          }),
        }),
        managerCalls,
      ),
    )(request(baseRequest), env),
  );
  assert.equal(managerFailure.response.status, 'ERROR');
  assert.equal(managerFailure.response.failed_step, 'manager_verification');
  assert.equal(managerFailure.response.error_code, 'manager_verification_manager_id_not_found');
  assert.equal(Object.hasOwn(managerFailure.response.steps, 'applicant_participant'), true);
  assert.equal(Object.hasOwn(managerFailure.response.steps, 'employee_ad_lookup'), false);
  assert.equal(managerCalls.length, 2);

  const employeeAdCalls = [];
  const employeeAdFailure = responseOf(
    await runner(
      runCode,
      makeContext(
        okHandlers({
          '/webhook/ad/user/login-lookup': (body) => {
            if (body.employee_id === '1001') {
              return {
                status: 'ERROR',
                error_code: 'ad_user_not_found',
                message: 'Пользователь AD не найден.',
              };
            }
            return { status: 'OK', login: 'ppetrov', email: 'ppetrov@example.ru' };
          },
        }),
        employeeAdCalls,
      ),
    )(request(baseRequest), env),
  );
  assert.equal(employeeAdFailure.response.status, 'ERROR');
  assert.equal(employeeAdFailure.response.failed_step, 'employee_ad_lookup');
  assert.equal(employeeAdFailure.response.error_code, 'employee_ad_lookup_ad_user_not_found');
  assert.equal(Object.hasOwn(employeeAdFailure.response.steps, 'manager_ad_lookup'), false);
  assert.equal(employeeAdCalls.length, 3);

  const managerAdCalls = [];
  const managerAdFailure = responseOf(
    await runner(
      runCode,
      makeContext(
        okHandlers({
          '/webhook/ad/user/login-lookup': (body) => {
            if (body.employee_id === '2001') {
              return {
                status: 'ERROR',
                error_code: 'ad_email_not_found',
                message: 'Email руководителя не найден.',
              };
            }
            return { status: 'OK', login: 'iivanov', email: 'iivanov@example.ru' };
          },
        }),
        managerAdCalls,
      ),
    )(request(baseRequest), env),
  );
  assert.equal(managerAdFailure.response.status, 'ERROR');
  assert.equal(managerAdFailure.response.failed_step, 'manager_ad_lookup');
  assert.equal(managerAdFailure.response.error_code, 'manager_ad_lookup_ad_email_not_found');
  assert.equal(Object.hasOwn(managerAdFailure.response.steps, 'password_reset'), false);
  assert.equal(managerAdCalls.length, 4);

  const resetCalls = [];
  const resetFailure = responseOf(
    await runner(
      runCode,
      makeContext(
        okHandlers({
          '/webhook/ad/user/reset-password': () => ({
            status: 'ERROR',
            error_code: 'ad_password_update_failed',
            message: 'Не удалось сменить пароль пользователя AD.',
            reason: 'bind password token secret',
          }),
        }),
        resetCalls,
      ),
    )(request(baseRequest), env),
  );
  assert.equal(resetFailure.response.status, 'ERROR');
  assert.equal(resetFailure.response.failed_step, 'password_reset');
  assert.equal(resetFailure.response.error_code, 'password_reset_ad_password_update_failed');
  assert.equal(resetFailure.response.password_changed, false);
  assert.equal(Object.hasOwn(resetFailure.response.steps, 'notification'), false);
  assert.ok(!JSON.stringify(resetFailure.response).includes('Secret123ABC'));
  assert.equal(resetCalls.length, 5);

  const notificationCalls = [];
  const notificationFailure = responseOf(
    await runner(
      runCode,
      makeContext(
        okHandlers({
          '/webhook/email/send-template': () => ({
            error: { code: 'email_send_failed', message: 'SMTP failed.' },
          }),
        }),
        notificationCalls,
      ),
    )(request(baseRequest), env),
  );
  assert.equal(notificationFailure.response.status, 'ERROR');
  assert.equal(notificationFailure.response.failed_step, 'notification');
  assert.equal(notificationFailure.response.error_code, 'notification_email_send_failed');
  assert.equal(notificationFailure.response.password_changed, true);
  assert.equal(notificationFailure.response.notification_sent, false);
  assert.equal(notificationFailure.response.steps.password_reset.status, 'OK');
  assert.equal(Object.hasOwn(notificationFailure.response.steps.password_reset, 'password'), false);
  assert.ok(!JSON.stringify(notificationFailure.response).includes('Secret123ABC'));
  assert.equal(notificationCalls.length, 6);

  const okCalls = [];
  const ok = responseOf(await runner(runCode, makeContext(okHandlers(), okCalls))(request(baseRequest), env));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.response.status, 'OK');
  assert.equal(ok.response.password_changed, true);
  assert.equal(ok.response.notification_sent, true);
  assert.equal(ok.response.steps.notification.status, 'sent');
  assert.equal(ok.response.steps.notification.to, 'ppetrov@example.ru');
  assert.equal(ok.response.steps.password_reset.login, 'iivanov');
  assert.equal(Object.hasOwn(ok.response.steps.password_reset, 'password'), false);
  assert.ok(!JSON.stringify(ok.response).includes('Secret123ABC'));
  assert.equal(okCalls.length, 6);

  const workflow = readJson(workflowPath);
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveManualExecutions, false);
  const webhook = workflowNode(workflowPath, 'ad-password-reset-process-webhook');
  assert.equal(webhook.type, 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.path, 'ad/password-reset/process');
}

async function testCmdbuildProviderContext() {
  const prepareCode = codeNode(
    'workflows/cmdbuild-provider-email-context-webhook.json',
    'cmdbuild-provider-context-prepare',
  );
  const parseRouterCode = codeNode(
    'workflows/cmdbuild-provider-email-context-webhook.json',
    'cmdbuild-provider-context-parse-router',
  );
  const normalizeCode = codeNode(
    'workflows/cmdbuild-provider-email-context-webhook.json',
    'cmdbuild-provider-context-normalize',
  );
  const env = { N8N_WEBHOOK_TOKEN: 'test-token', CMDBUILD_BASE_URL: 'http://cmdbuild.local/cmdbuild' };

  const unauthorized = responseOf(
    await runner(prepareCode)(
      request({ hostname: 'Router for NTbook group 000 (OFF01 Office 01 - Headquarters)' }, ''),
      env,
    ),
  );
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.response.error.code, 'unauthorized');

  const missingHostname = responseOf(await runner(prepareCode)(request({}), env));
  assert.equal(missingHostname.statusCode, 400);
  assert.equal(missingHostname.response.error.code, 'missing_hostname');

  const prepared = responseOf(
    await runner(prepareCode)(
      request({ hostname: 'Router for NTbook group 000 (OFF01 Office 01 - Headquarters)' }),
      env,
    ),
  );
  assert.equal(prepared.valid, true);
  assert.equal(prepared.cmdbuild_base_url, 'http://cmdbuild.local/cmdbuild');
  assert.ok(prepared.router_search_url.includes('/services/rest/v3/classes/routerG/cards'));
  const decodedRouterSearch = decodeURIComponent(prepared.router_search_url);
  assert.ok(decodedRouterSearch.includes('"or"'));
  assert.ok(decodedRouterSearch.includes('"Description"'));
  assert.ok(decodedRouterSearch.includes('"hostname"'));
  assert.ok(decodedRouterSearch.includes('"Code"'));

  const runParse = runner(parseRouterCode, {
    $: nodeLookup({ 'Подготовка запроса CMDBuild': prepared }),
  });

  const authFailed = responseOf(
    await runParse({
      statusCode: 401,
      body: { success: false },
    }),
  );
  assert.equal(authFailed.statusCode, 502);
  assert.equal(authFailed.response.error.code, 'cmdbuild_auth_failed');

  const notFound = responseOf(
    await runParse({
      statusCode: 200,
      body: { success: true, data: [], meta: { total: 0 } },
    }),
  );
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.response.error.code, 'router_not_found');
  assert.equal(notFound.response.error.message, 'routerG не найден по Description, hostname или Code.');

  const duplicate = responseOf(
    await runParse({
      statusCode: 200,
      body: { success: true, data: [{ _id: 1 }, { _id: 2 }], meta: { total: 2 } },
    }),
  );
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.response.error.code, 'router_not_unique');

  const missingField = responseOf(
    await runParse({
      statusCode: 200,
      body: {
        success: true,
        data: [
          {
            _id: 1308541,
            Code: 'c2m-ntbook-routerg-000',
            Description: prepared.hostname,
            email: '',
            contract: 'Договор № 33333-1111 и так далее',
            ipaddress: 427547,
            Location: 206,
          },
        ],
        meta: { total: 1 },
      },
    }),
  );
  assert.equal(missingField.statusCode, 422);
  assert.equal(missingField.response.error.code, 'missing_cmdbuild_field');
  assert.deepEqual(missingField.response.error.missing_fields, ['email']);

  const parsedRouter = responseOf(
    await runParse({
      statusCode: 200,
      body: {
        success: true,
        data: [
          {
            _id: 1308541,
            Code: 'c2m-ntbook-routerg-000',
            Description: prepared.hostname,
            email: 'provider@example.test',
            contract: 'Договор № 33333-1111 и так далее',
            ipaddress: 427547,
            Location: 206,
          },
        ],
        meta: { total: 1 },
      },
    }),
  );
  assert.equal(parsedRouter.done, false);
  assert.equal(parsedRouter.provider_email, 'provider@example.test');
  assert.equal(parsedRouter.contract, 'Договор № 33333-1111 и так далее');
  assert.ok(parsedRouter.ip_url.endsWith('/IpAddress/cards/427547'));
  assert.ok(parsedRouter.room_url.endsWith('/Room/cards/206'));

  const runNormalize = runner(normalizeCode, {
    $: nodeLookup({
      'Разбор routerG': parsedRouter,
      'Чтение IpAddress': {
        statusCode: 200,
        body: { success: true, data: { _id: 427547, Description: '192.168.202.35' } },
      },
      'Чтение Room': {
        statusCode: 200,
        body: { success: true, data: { _id: 206, Description: 'Office Building A - Floor 1 - Room 001', Floor: 101 } },
      },
      'Чтение Floor': {
        statusCode: 200,
        body: { success: true, data: { _id: 101, Description: 'Office Building A - Floor 1', Building: 51 } },
      },
      'Чтение Building': {
        statusCode: 200,
        body: { success: true, data: { _id: 51, Description: 'Office Building A', City: 'City01' } },
      },
    }),
  });

  const normalized = responseOf(await runNormalize({}));
  assert.equal(normalized.statusCode, 200);
  assert.equal(normalized.response.status, 'OK');
  assert.equal(normalized.response.city, 'City01');
  assert.equal(normalized.response.location, 'Office Building A - Floor 1 - Room 001');
  assert.equal(normalized.response.ip_address, '192.168.202.35');
  assert.equal(normalized.response.provider_email, 'provider@example.test');

  const missingCity = responseOf(
    await runner(normalizeCode, {
      $: nodeLookup({
        'Разбор routerG': parsedRouter,
        'Чтение IpAddress': {
          statusCode: 200,
          body: { success: true, data: { Description: '192.168.202.35' } },
        },
        'Чтение Room': {
          statusCode: 200,
          body: { success: true, data: { Description: 'Office Building A - Floor 1 - Room 001', Floor: 101 } },
        },
        'Чтение Floor': {
          statusCode: 200,
          body: { success: true, data: { Description: 'Office Building A - Floor 1', Building: 51 } },
        },
        'Чтение Building': {
          statusCode: 200,
          body: { success: true, data: { Description: 'Office Building A', City: '' } },
        },
      }),
    })({}),
  );
  assert.equal(missingCity.statusCode, 422);
  assert.equal(missingCity.response.error.code, 'missing_cmdbuild_field');
  assert.ok(missingCity.response.error.missing_fields.includes('Building.City'));
}

async function testProviderChannelRepairMonitor() {
  const prepareCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-prepare',
  );
  const cmdbuildPrepareCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-cmdbuild-prepare',
  );
  const cmdbuildParseCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-cmdbuild-parse-router',
  );
  const cmdbuildNormalizeCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-cmdbuild-normalize',
  );
  const emailPrepareCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-email-prepare',
  );
  const emailResultCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-email-result',
  );
  const zabbixCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-zabbix-check',
  );
  const buildSqlCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-build-email-sql',
  );
  const evaluateCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-evaluate-email',
  );
  const deliverCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-deliver-result',
  );
  const progressDoneCode = codeNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-progress-done',
  );
  const env = {
    N8N_WEBHOOK_TOKEN: 'test-token',
    N8N_INTERNAL_WEBHOOK_BASE_URL: 'http://127.0.0.1:5678/webhook',
  };
  const body = {
    problem_host: 'ARM C2M-CITY-20260523-ARM-177-13',
    router_ref: 'Router for NTbook group 000 (OFF01 Office 01 - Headquarters)',
    problemUrl: 'http://localhost:8081/tr_events.php?triggerid=61119&eventid=90528',
    service_request: '12345678',
    poll_interval_minutes: 15,
    timeout_minutes: 60,
    from: 'automation-test@local.test',
    replyTo: 'automation-test@local.test',
    invocation: providerMonitorAsync('kafka_event', { result_topic: 'external.events' }),
  };

  const unauthorized = responseOf(await runner(prepareCode)(request(body, ''), env));
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.response.error.code, 'unauthorized');

  const missingAsync = responseOf(
    await runner(prepareCode)(
      request({
        problem_host: body.problem_host,
        router_ref: body.router_ref,
        problemUrl: body.problemUrl,
        service_request: body.service_request,
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        from: body.from,
        replyTo: body.replyTo,
      }),
      env,
    ),
  );
  assert.equal(missingAsync.statusCode, 400);
  assert.equal(missingAsync.response.error.code, 'missing_async_callback');

  const accepted = responseOf(await runner(prepareCode)(request(body), env));
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.response.runbook_status, 'accepted');
  assert.equal(accepted.response.async_delivery, true);
  assert.equal(accepted.response.result_topic, 'external.events');
  assert.equal(accepted.internal_webhook_base_url, 'http://127.0.0.1:5678/webhook');
  assert.equal(accepted.from_email, 'automation-test@local.test');
  assert.equal(accepted.reply_to, 'automation-test@local.test');
  assert.equal(accepted.reply_mailbox_address, 'automation-test@local.test');
  assert.equal(Object.hasOwn(accepted, 'webhook_token'), false);
  const workerTrigger = workflowNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-worker-trigger',
  );
  assert.equal(workerTrigger.type, 'n8n-nodes-base.executeWorkflowTrigger');
  assert.equal(workerTrigger.parameters.inputSource, 'passthrough');
  const workerDispatch = workflowNode(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'provider-channel-monitor-dispatch-worker',
  );
  assert.equal(workerDispatch.type, 'n8n-nodes-base.executeWorkflow');
  assert.equal(workerDispatch.parameters.workflowId.value, 'providerChannelRepairMonitor');
  assert.deepEqual(workerDispatch.parameters.workflowInputs.value, {});
  assert.equal(workerDispatch.parameters.options.waitForSubWorkflow, false);
  assertMainConnectionIncludes('workflows/provider-channel-repair-monitor-webhook.json', 'Запрос валиден?', 0, 'Запуск worker мониторинга');
  assertMainConnectionIncludes('workflows/provider-channel-repair-monitor-webhook.json', 'Запуск worker мониторинга', 0, 'Ответ accepted');
  assertMainConnectionIncludes(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'Worker мониторинга ремонта канала',
    0,
    'Подготовка state worker',
  );
  assertMainConnectionIncludes(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'Подготовка state worker',
    0,
    'Подготовка CMDBuild контекста',
  );
  assertNoMainConnectionFrom('workflows/provider-channel-repair-monitor-webhook.json', 'Ответ accepted');

  const aliasAccepted = responseOf(
    await runner(prepareCode)(
      request({
        problemHost: body.problem_host,
        routerRef: body.router_ref,
        problem_url: body.problemUrl,
        serviceRequest: body.service_request,
        pollIntervalMinutes: 15,
        timeoutMinutes: 60,
        from: body.from,
        reply_to: body.replyTo,
        invocation: providerMonitorAsync('kafka_event', { result_topic: 'external.events' }),
      }),
      env,
    ),
  );
  assert.equal(aliasAccepted.statusCode, 200);
  assert.equal(aliasAccepted.host, body.problem_host);
  assert.equal(aliasAccepted.router_ref, body.router_ref);
  assert.equal(aliasAccepted.service_request, body.service_request);

  const invalidCallback = responseOf(
    await runner(prepareCode)(
      request({
        problem_host: body.problem_host,
        router_ref: body.router_ref,
        problemUrl: body.problemUrl,
        service_request: body.service_request,
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        from: body.from,
        replyTo: body.replyTo,
        invocation: providerMonitorAsync('http_callback', {
          callback_url: 'http://evil.example/external-events/n8n',
        }),
      }),
      { ...env, NODE_ENV: 'production' },
    ),
  );
  assert.equal(invalidCallback.statusCode, 400);
  assert.equal(invalidCallback.response.error.code, 'invalid_callback_url');

  const localCallbackWithNodeProduction = responseOf(
    await runner(prepareCode)(
      request({
        problem_host: body.problem_host,
        router_ref: body.router_ref,
        problemUrl: body.problemUrl,
        service_request: body.service_request,
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        from: body.from,
        replyTo: body.replyTo,
        invocation: providerMonitorAsync('http_callback', {
          callback_url: LOCAL_CALLBACK_URL,
        }),
      }),
      { ...env, ...LOCAL_CALLBACK_ENV_WITH_NODE_PRODUCTION },
    ),
  );
  assert.equal(localCallbackWithNodeProduction.statusCode, 200);
  assert.equal(localCallbackWithNodeProduction.response.runbook_status, 'accepted');

  const cmdbuildPrepared = responseOf(
    await runner(cmdbuildPrepareCode)(accepted, { CMDBUILD_BASE_URL: 'http://cmdbuild.local/cmdbuild' }),
  );
  assert.equal(cmdbuildPrepared.terminal, false);
  assert.equal(cmdbuildPrepared.cmdbuild_base_url, 'http://cmdbuild.local/cmdbuild');
  assert.equal(cmdbuildPrepared.router_lookup_value, body.router_ref);
  const decodedSearchUrl = decodeURIComponent(cmdbuildPrepared.router_search_url);
  assert.ok(decodedSearchUrl.includes('"or"'));
  assert.ok(decodedSearchUrl.includes('"Description"'));
  assert.ok(decodedSearchUrl.includes('"hostname"'));
  assert.ok(decodedSearchUrl.includes('"Code"'));

  const runCmdbuildParse = runner(cmdbuildParseCode, {
    $: nodeLookup({ 'Подготовка CMDBuild контекста': cmdbuildPrepared }),
  });
  const contextNotFound = responseOf(
    await runCmdbuildParse({
      statusCode: 200,
      body: { success: true, data: [], meta: { total: 0 } },
    }),
  );
  assert.equal(contextNotFound.terminal, true);
  assert.equal(contextNotFound.response.runbook_status, 'ERROR');
  assert.equal(contextNotFound.response.error.code, 'router_not_found');

  const unresolvedAccepted = responseOf(
    await runner(prepareCode)(
      request({
        host: body.problem_host,
        problemUrl: body.problemUrl,
        service_request: body.service_request,
        poll_interval_minutes: 15,
        timeout_minutes: 60,
        from: body.from,
        replyTo: body.replyTo,
        invocation: providerMonitorAsync('kafka_event', { result_topic: 'external.events' }),
      }),
      env,
    ),
  );
  const unresolvedPrepared = responseOf(
    await runner(cmdbuildPrepareCode)(unresolvedAccepted, { CMDBUILD_BASE_URL: 'http://cmdbuild.local/cmdbuild' }),
  );
  const unresolvedParse = runner(cmdbuildParseCode, {
    $: nodeLookup({ 'Подготовка CMDBuild контекста': unresolvedPrepared }),
  });
  const unresolved = responseOf(
    await unresolvedParse({
      statusCode: 200,
      body: { success: true, data: [], meta: { total: 0 } },
    }),
  );
  assert.equal(unresolved.response.error.code, 'router_context_not_resolved');
  assert.equal(unresolved.response.email_dispatch, null);
  assert.equal(unresolved.response.router_lookup_status, 'not_found');

  const parsedRouter = responseOf(
    await runCmdbuildParse({
      statusCode: 200,
      body: {
        success: true,
        data: [
          {
            _id: 1308541,
            Code: 'c2m-ntbook-routerg-000',
            Description: body.router_ref,
            hostname: 'c2m-ntbook-routerg-000',
            email: 'provider@example.test',
            contract: 'CNT-100500',
            ipaddress: 427547,
            Location: 206,
          },
        ],
        meta: { total: 1 },
      },
    }),
  );
  assert.equal(parsedRouter.terminal, false);
  assert.equal(parsedRouter.router_lookup_status, 'resolved');
  assert.equal(parsedRouter.router_hostname, 'c2m-ntbook-routerg-000');
  assert.equal(parsedRouter.provider_email, 'provider@example.test');
  assert.equal(parsedRouter.contract, 'CNT-100500');

  const cmdbuildNormalized = responseOf(
    await runner(cmdbuildNormalizeCode, {
      $: nodeLookup({
        'Разбор routerG для письма': parsedRouter,
        'CMDBuild чтение IpAddress': {
          statusCode: 200,
          body: { success: true, data: { _id: 427547, Description: '192.0.2.10' } },
        },
        'CMDBuild чтение Room': {
          statusCode: 200,
          body: { success: true, data: { _id: 206, Description: 'Москва, ул. Тестовая, д. 1', Floor: 101 } },
        },
        'CMDBuild чтение Floor': {
          statusCode: 200,
          body: { success: true, data: { _id: 101, Description: 'Этаж 1', Building: 51 } },
        },
        'CMDBuild чтение Building': {
          statusCode: 200,
          body: { success: true, data: { _id: 51, Description: 'Здание 1', City: 'Москва' } },
        },
      }),
    })(parsedRouter),
  );
  assert.equal(cmdbuildNormalized.terminal, false);
  assert.equal(cmdbuildNormalized.provider_email_context.city, 'Москва');
  assert.equal(cmdbuildNormalized.provider_email_context.provider_email, 'provider@example.test');

  const emailPrepared = responseOf(
    await runner(emailPrepareCode)(cmdbuildNormalized),
  );
  assert.equal(emailPrepared.terminal, false);
  assert.equal(emailPrepared.toEmail, 'provider@example.test');
  assert.equal(emailPrepared.from_email, 'automation-test@local.test');
  assert.equal(emailPrepared.reply_to, 'automation-test@local.test');
  assert.equal(emailPrepared.reply_mailbox_address, 'automation-test@local.test');
  assert.ok(emailPrepared.email_subject.includes('Москва'));
  assert.ok(emailPrepared.email_body.includes('12345678'));

  const initialOk = responseOf(
    await runner(emailResultCode, {
      $: nodeLookup({ 'Подготовка email провайдеру': emailPrepared }),
    })({}),
  );
  assert.equal(initialOk.terminal, false);
  assert.equal(initialOk.email_dispatch.status, 'sent');
  assert.equal(initialOk.email_dispatch.to, 'provider@example.test');
  assert.equal(initialOk.email_dispatch.from, 'automation-test@local.test');
  assert.equal(initialOk.email_dispatch.reply_to, 'automation-test@local.test');
  assert.equal(initialOk.email_dispatch.reply_mailbox_address, 'automation-test@local.test');

  const initialFailed = responseOf(
    await runner(emailResultCode, {
      $: nodeLookup({ 'Подготовка email провайдеру': emailPrepared }),
    })({ error: { message: 'smtp token secret failure' } }),
  );
  assert.equal(initialFailed.terminal, true);
  assert.equal(initialFailed.response.runbook_status, 'ERROR');
  assert.equal(initialFailed.response.error.code, 'provider_email_send_failed');
  assert.ok(!initialFailed.response.error.reason.includes('token'));

  const resolved = responseOf(
    await runner(zabbixCode, {
      helpers: {
        async httpRequest() {
          return {
            status: 'resolved',
            eventid: '90528',
            triggerid: '61119',
            zabbix_origin: 'http://localhost:8081',
            source: 'event',
            problem: { recovery_eventid: '90599' },
          };
        },
      },
    })(initialOk, env),
  );
  assert.equal(resolved.terminal, true);
  assert.equal(resolved.zabbix_status.status, 'resolved');
  assert.equal(resolved.response.runbook_status, 'RESOLVED');

  const activeProblem = responseOf(
    await runner(zabbixCode, {
      helpers: {
        async httpRequest() {
          return {
            status: 'problem',
            eventid: '90528',
            triggerid: '61119',
            zabbix_origin: 'http://localhost:8081',
            source: 'event',
            problem: { event_value: '1' },
          };
        },
      },
    })(initialOk, env),
  );
  assert.equal(activeProblem.terminal, false);
  assert.equal(activeProblem.zabbix_status.status, 'problem');

  const sqlState = responseOf(await runner(buildSqlCode)(activeProblem));
  assert.ok(sqlState.sql.includes('n8n_mail_index'));
  assert.ok(sqlState.sql.includes('mailbox_address'));
  assert.ok(sqlState.sql.includes('automation-test@local.test'));
  assert.ok(sqlState.sql.includes('12345678'));
  assert.ok(sqlState.sql.includes('WITH matches AS'));

  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 1_000).toISOString();
  const stateForRows = {
    ...activeProblem,
    deadline_at: future,
    poll_interval_minutes: 15,
    timeout_minutes: 60,
    poll_seconds: 900,
  };
  const firstMatch = {
    message_id: '<provider-1@example.test>',
    mailbox: 'INBOX',
    mailbox_address: 'automation-test@local.test',
    from_email: 'provider@example.test',
    subject: 'Re: заявка 12345678',
    body_text: 'Ваше обращение зарегистрировано.',
    body_truncated: false,
    received_at: '2026-06-13T10:05:00.000Z',
    is_delivery_failure: false,
    delivery_failure_reason: null,
  };

  const ok = responseOf(
    await runner(evaluateCode)({
      state_json: JSON.stringify(stateForRows),
      match_count: 1,
      mailbox_indexed_count: 1,
      delivery_failure_count: 0,
      first_match_json: JSON.stringify(firstMatch),
    }),
  );
  assert.equal(ok.terminal, true);
  assert.equal(ok.response.runbook_status, 'OK');
  assert.equal(ok.response.email_result.from, 'provider@example.test');
  assert.equal(ok.response.email_result.subject, 'Re: заявка 12345678');

  const multi = responseOf(
    await runner(evaluateCode)({
      state_json: JSON.stringify(stateForRows),
      match_count: 2,
      mailbox_indexed_count: 1,
      delivery_failure_count: 0,
      first_match_json: JSON.stringify(firstMatch),
    }),
  );
  assert.equal(multi.response.runbook_status, 'MULTI_MAIL');
  assert.equal(multi.response.email_result.match_count, 2);

  const deliveryFailed = responseOf(
    await runner(evaluateCode)({
      state_json: JSON.stringify(stateForRows),
      match_count: 1,
      delivery_failure_count: 1,
      delivery_failure_match_json: JSON.stringify({
        ...firstMatch,
        subject: 'Undeliverable: 12345678',
        is_delivery_failure: true,
        delivery_failure_reason: 'undeliverable',
      }),
    }),
  );
  assert.equal(deliveryFailed.response.runbook_status, 'DELIVERY_FAILED');
  assert.equal(deliveryFailed.response.email_result.is_delivery_failure, true);

  const notFound = responseOf(
    await runner(evaluateCode)({
      state_json: JSON.stringify({ ...stateForRows, deadline_at: past }),
      match_count: 0,
      mailbox_indexed_count: 1,
      delivery_failure_count: 0,
    }),
  );
  assert.equal(notFound.response.runbook_status, 'NOT_FOUND');

  const mailboxNotIndexed = responseOf(
    await runner(evaluateCode)({
      state_json: JSON.stringify({ ...stateForRows, deadline_at: past }),
      match_count: 0,
      mailbox_indexed_count: 0,
      delivery_failure_count: 0,
    }),
  );
  assert.equal(mailboxNotIndexed.response.runbook_status, 'ERROR');
  assert.equal(mailboxNotIndexed.response.error.code, 'reply_mailbox_not_indexed');

  const waiting = responseOf(
    await runner(evaluateCode)({
      state_json: JSON.stringify(stateForRows),
      match_count: 0,
      mailbox_indexed_count: 1,
      delivery_failure_count: 0,
    }),
  );
  assert.equal(waiting.terminal, false);
  assert.ok(waiting.next_wait_seconds > 0);
  assert.ok(Date.parse(waiting.next_wait_at) > Date.now());
  assert.equal(waiting.response.runbook_status, 'PROGRESS');
  assert.equal(waiting.polling_diagnostic.current_status, 'polling');
  assert.equal(waiting.polling_diagnostic.checked_resource, 'n8n_mail_index');
  assert.equal(waiting.polling_diagnostic.poll_iteration, 1);
  assert.equal(waiting.polling_diagnostic.match_count, 0);
  assert.equal(waiting.polling_diagnostic.mailbox_indexed_count, 1);
  assert.equal(waiting.polling_diagnostic.reply_mailbox_address, 'automation-test@local.test');

  const progressEvent = responseOf(
    await runner(deliverCode)({
      ...waiting,
      async_callback: providerMonitorAsync('kafka_event', { result_topic: 'external.events' }).extensions.async_callback,
    }),
  );
  assert.equal(progressEvent.externalEvent.status, 'progress');
  assert.equal(progressEvent.externalEvent.result.runbook_status, 'PROGRESS');
  assert.equal(progressEvent.externalEvent.result.polling_diagnostic.poll_iteration, 1);
  assert.equal(progressEvent.externalEvent.result.polling_diagnostic.match_count, 0);
  assert.equal(
    progressEvent.externalEvent.idempotency_key,
    'case-000000000001:tool_command:cmd-provider-monitor-123:provider_channel_repair_progress_1',
  );
  assert.equal(progressEvent.shouldPublishKafka, true);
  const progressDone = responseOf(
    await runner(progressDoneCode, {
      $: nodeLookup({ 'Доставка polling diagnostics': progressEvent }),
    })({ kafka_write_result: { offset: 1 } }),
  );
  assert.equal(progressDone.progress_delivered, true);
  assert.equal(progressDone.next_wait_at, waiting.next_wait_at);
  assert.ok(Date.parse(progressDone.next_wait_at) > Date.now());

  assertMainConnectionIncludes(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'Email завершил ранбук?',
    1,
    'Доставка polling diagnostics',
  );
  assertMainConnectionIncludes(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'Доставка polling diagnostics',
    0,
    'Нужна Kafka delivery diagnostics?',
  );
  assertMainConnectionIncludes(
    'workflows/provider-channel-repair-monitor-webhook.json',
    'Завершение polling diagnostics',
    0,
    'Ожидание следующего опроса',
  );

  const callbackCalls = [];
  const delivered = responseOf(
    await runner(deliverCode, {
      helpers: {
        async httpRequest(options) {
          callbackCalls.push(options);
          return { ok: true };
        },
      },
    })(
      {
        ...ok,
        response: {
          ...ok.response,
          delivery_status: { requested_transport: 'http_callback' },
        },
        async_callback: providerMonitorAsync('http_callback', {
          callback_url: 'http://127.0.0.1:18088/external-events/n8n',
        }).extensions.async_callback,
      },
      { INTEGRATION_CALLBACK_TOKEN__N8N: 'callback-token' },
    ),
  );
  assert.equal(callbackCalls.length, 1);
  assert.equal(callbackCalls[0].headers['X-ServiceDesk-Callback-Token'], 'callback-token');
  assert.equal(callbackCalls[0].body.status, 'success');
  assert.deepEqual(callbackCalls[0].body, delivered.externalEvent);
  assert.equal(delivered.externalEvent.result.runbook_status, 'OK');
  assert.equal(delivered.externalEvent.result.delivery_status, undefined);
  assert.equal(
    delivered.externalEvent.idempotency_key,
    'case-000000000001:tool_command:cmd-provider-monitor-123:provider_channel_repair_ok',
  );
  assert.equal(delivered.shouldPublishKafka, false);
  assert.equal(delivered.delivery_status.http_callback, 'sent');

  const failedCallbackBoth = responseOf(
    await runner(deliverCode, {
      helpers: {
        async httpRequest() {
          throw new Error('callback is down');
        },
      },
    })(
      {
        ...ok,
        async_callback: providerMonitorAsync('both', {
          callback_url: 'http://127.0.0.1:18088/external-events/n8n',
          result_topic: 'external.events',
        }).extensions.async_callback,
      },
      { INTEGRATION_CALLBACK_TOKEN__N8N: 'callback-token' },
    ),
  );
  assert.equal(failedCallbackBoth.shouldPublishKafka, true);
  assert.equal(failedCallbackBoth.kafkaTopic, 'external.events');
  assert.equal(failedCallbackBoth.delivery_status.http_callback, 'failed');
  assert.equal(failedCallbackBoth.delivery_status.http_callback_error, 'callback_delivery_failed');
  assert.equal(failedCallbackBoth.externalEvent.result.delivery_status, undefined);

  const timeoutEvent = responseOf(
    await runner(deliverCode)({
      ...notFound,
      async_callback: providerMonitorAsync('kafka_event', { result_topic: 'external.events' }).extensions.async_callback,
    }),
  );
  assert.equal(timeoutEvent.externalEvent.status, 'timeout');
  assert.equal(timeoutEvent.shouldPublishKafka, true);
  assert.equal(timeoutEvent.kafkaTopic, 'external.events');

  const errorEvent = responseOf(
    await runner(deliverCode)({
      ...deliveryFailed,
      async_callback: providerMonitorAsync('kafka_event', { result_topic: 'external.events' }).extensions.async_callback,
    }),
  );
  assert.equal(errorEvent.externalEvent.status, 'error');
  assert.equal(errorEvent.externalEvent.error.code, 'DELIVERY_FAILED');
  assert.equal(errorEvent.externalEvent.error.message, deliveryFailed.response.message);
}

function testMcpToolManifest() {
  const { manifest } = loadMcpToolManifest();
  assert.equal(manifest.schema_version, '1.0');
  assert.equal(manifest.manifest_id, 'provider-ops-mcp-tools');
  assert.equal(manifest.contract_version, '1.0');

  const tools = new Map(manifest.tools.map((tool) => [tool.tool_name, tool]));
  assert.deepEqual([...tools.keys()].sort(), [
    'provider_channel_repair_monitor',
    'zabbix_problem_status_wait',
    'zabbix_problem_update',
  ]);

  const provider = tools.get('provider_channel_repair_monitor');
  assert.equal(provider.workflow_id, 'provider_channel_repair_monitor');
  assert.equal(provider.operation_id, 'monitorProviderChannelRepair');
  assert.equal(provider.webhook_path, '/webhook/provider/channel-repair/monitor');
  assert.equal(provider.execution_mode, 'async');
  assert.equal(provider.action_id, 'monitor_provider_channel_repair');
  assert.equal(provider.expected_event_type, 'provider_channel_repair_monitor.completed');
  assert.equal(provider.result_mapping.type, 'accepted_ack');
  assert.deepEqual(provider.required_inputs, ['problem_url', 'service_request']);
  assert.equal(provider.input_mapping.problemUrl.input, 'problem_url');
  assert.equal(provider.input_mapping.service_request.input, 'service_request');
  assert.ok(Object.values(provider.input_mapping).some((entry) => entry.async_invocation === true));

  const update = tools.get('zabbix_problem_update');
  assert.equal(update.workflow_id, 'zabbix_problem_update');
  assert.equal(update.operation_id, 'updateZabbixProblem');
  assert.equal(update.webhook_path, '/webhook/zabbix/problem/update');
  assert.equal(update.execution_mode, 'sync');
  assert.equal(update.result_mapping.type, 'sync_result');
  assert.deepEqual(update.required_inputs, ['problem_url', 'message']);

  const wait = tools.get('zabbix_problem_status_wait');
  assert.equal(wait.workflow_id, 'zabbix_problem_wait');
  assert.equal(wait.operation_id, 'waitZabbixProblemStatus');
  assert.equal(wait.webhook_path, '/webhook/zabbix/problem/wait');
  assert.equal(wait.execution_mode, 'async');
  assert.equal(wait.action_id, 'wait_zabbix_problem_status');
  assert.equal(wait.expected_event_type, 'zabbix_problem_status_wait.completed');
  assert.equal(wait.result_mapping.type, 'accepted_ack');
  assert.deepEqual(wait.required_inputs, ['problem_url', 'poll_interval_minutes', 'timeout_minutes']);

  for (const tool of manifest.tools) {
    assert.equal(tool.input_schema.type, 'object', tool.tool_name + ': input_schema must be object');
    assert.equal(tool.output_schema.type, 'object', tool.tool_name + ': output_schema must be object');
    assertSchemaDescriptions(tool.input_schema, tool.tool_name + '.input_schema');
    assertSchemaDescriptions(tool.output_schema, tool.tool_name + '.output_schema');
  }
}

function assertSchemaDescriptions(schema, label) {
  assert.ok(schema.properties && typeof schema.properties === 'object', label + '.properties missing');
  for (const [property, definition] of Object.entries(schema.properties)) {
    assert.equal(typeof definition.description, 'string', label + '.' + property + '.description missing');
    assert.notEqual(definition.description.trim(), '', label + '.' + property + '.description empty');
  }
}
function testOpenApiAndCatalog() {
  const openapi = readJson('contracts/n8n-openapi.json');
  assert.equal(openapi['x-localization'].selection, 'query_parameter');
  assert.equal(openapi['x-localization'].query_parameter, 'lang');
  assert.equal(openapi['x-localization'].default_locale, 'ru');
  assert.equal(openapi['x-localization'].default_locale_env, 'N8N_OPENAPI_DEFAULT_LOCALE');
  assert.deepEqual(openapi['x-localization'].supported_locales, ['en', 'ru']);
  assert.equal(openapi['x-transport-security'].http.policy, 'admin_configured');
  assert.equal(openapi['x-transport-security'].http.production_recommended_scheme, 'https');
  assert.equal(
    openapi['x-transport-security'].http.configuration.n8n_webhook_base_url_env,
    'N8N_WEBHOOK_BASE_URL',
  );
  assert.deepEqual(openapi['x-transport-security'].kafka.supported_security_protocols, ['SASL_SSL', 'SSL']);
  assert.deepEqual(openapi['x-transport-security'].kafka.supported_auth, ['sasl', 'mtls']);

  const asyncSchema = openapi.components.schemas.AsyncCallbackPackage;
  assert.equal(asyncSchema.allOf.length, 3);
  assert.equal(asyncSchema.allOf[0].then.required[0], 'callback_url');
  assert.deepEqual(asyncSchema.allOf[1].then.required, ['result_topic']);
  assert.deepEqual(asyncSchema.allOf[2].then.required, ['callback_url', 'result_topic']);

  const startResponse = openapi.components.schemas.StartRunbookResponse;
  assert.equal(Object.hasOwn(startResponse.properties, 'callback_url'), false);
  assert.equal(startResponse.properties.has_callback_url.type, 'boolean');

  const discoveryOperation = openapi.paths['/webhook/contracts/openapi.json'].get;
  assert.equal(discoveryOperation.operationId, 'getN8nOpenApiContract');
  assert.deepEqual(discoveryOperation.parameters[0].schema.enum, ['en', 'ru']);
  assert.equal(discoveryOperation.parameters[0].schema.default, 'ru');
  assert.ok(discoveryOperation.responses['400'].content['application/json'].examples.unsupportedLocale);
  assert.ok(discoveryOperation.responses['500'].content['application/json'].examples.invalidDefaultLocale);

  const zabbixRequest = openapi.components.schemas.UpdateZabbixProblemRequest;
  assert.deepEqual(zabbixRequest.required, ['message']);
  assert.deepEqual(zabbixRequest.anyOf, [{ required: ['problemUrl'] }, { required: ['problem_url'] }]);
  assert.equal(Object.hasOwn(zabbixRequest.properties, 'request_id'), false);
  assert.equal(Object.hasOwn(zabbixRequest.properties, 'requestId'), false);
  assert.equal(zabbixRequest.properties.message.maxLength, 2000);

  const statusPath = openapi.paths['/webhook/zabbix/problem/status'].post;
  assert.equal(statusPath.operationId, 'getZabbixProblemStatus');
  const statusResponse = openapi.components.schemas.GetZabbixProblemStatusResponse;
  assert.deepEqual(statusResponse.properties.status.enum, ['problem', 'resolved', 'ok']);
  assert.deepEqual(statusResponse.properties.source.enum, ['event', 'trigger_fallback']);

  const waitZabbixPath = openapi.paths['/webhook/zabbix/problem/wait'].post;
  assert.equal(waitZabbixPath.operationId, 'waitZabbixProblemStatus');
  assert.deepEqual(waitZabbixPath.tags, ['zabbix', 'runbooks']);
  assert.equal(
    waitZabbixPath['x-result-delivery'].result_schema,
    '#/components/schemas/WaitZabbixProblemStatusResult',
  );
  const waitZabbixRequest = openapi.components.schemas.WaitZabbixProblemStatusRequest;
  assert.deepEqual(waitZabbixRequest.required, ['invocation']);
  assertRequiredAlternatives(waitZabbixRequest, [
    [['problemUrl'], ['problem_url']],
    [['poll_interval_minutes'], ['pollIntervalMinutes']],
    [['timeout_minutes'], ['timeoutMinutes']],
  ]);
  assert.equal(waitZabbixRequest.properties.poll_interval_minutes.maximum, 60);
  assert.equal(waitZabbixRequest.properties.timeout_minutes.maximum, 240);
  assert.deepEqual(openapi.components.schemas.WaitZabbixProblemStatusResultStatus.enum, [
    'ok',
    'resolved',
    'problem',
    'ERROR',
  ]);

  const sendTemplate400 = openapi.paths['/webhook/email/send-template'].post.responses['400'].content['application/json'].examples;
  assert.ok(sendTemplate400.invalidTemplateParam);
  assert.ok(sendTemplate400.invalidRenderedSubject);
  assert.ok(sendTemplate400.renderedSubjectTooLong);
  assert.ok(sendTemplate400.renderedBodyTooLong);
  const sendEmail400 = openapi.paths['/webhook/email/send'].post.responses['400'].content['application/json'].examples;
  assert.equal(sendEmail400.missingFrom.value.error.code, 'missing_from');
  assert.equal(sendEmail400.missingReplyTo.value.error.code, 'missing_reply_to');
  assert.equal(openapi.paths['/webhook/email/send'].post.responses['500'], undefined);
  const sendTemplate400Again = openapi.paths['/webhook/email/send-template'].post.responses['400'].content['application/json'].examples;
  assert.equal(sendTemplate400Again.missingFrom.value.error.code, 'missing_from');
  assert.equal(sendTemplate400Again.missingReplyTo.value.error.code, 'missing_reply_to');
  assert.equal(openapi.paths['/webhook/email/send-template'].post.responses['500'], undefined);
  assert.equal(openapi.components.schemas.EmailTemplateParam.properties.sensitive.type, 'boolean');
  assert.equal(openapi.components.schemas.EmailTemplateParam.properties.sensitive.default, false);

  const waitEmailPath = openapi.paths['/webhook/email/wait-for-ticket'].post;
  assert.equal(waitEmailPath.operationId, 'waitForEmailByTicket');
  assert.deepEqual(openapi.components.schemas.WaitForEmailByTicketResultStatus.enum, [
    'OK',
    'MULTI_MAIL',
    'DELIVERY_FAILED',
    'NOT_FOUND',
  ]);
  assert.equal(openapi.components.schemas.WaitForEmailByTicketRequest.properties.timeout_minutes.maximum, 240);

  const cmdbuildPath = openapi.paths['/webhook/cmdbuild/provider-email-context'].post;
  assert.equal(cmdbuildPath.operationId, 'getProviderEmailContext');
  assert.deepEqual(cmdbuildPath.tags, ['cmdbuild', 'runbooks']);
  assert.deepEqual(openapi.components.schemas.GetProviderEmailContextRequest.required, ['hostname']);
  const cmdbuildResponse = openapi.components.schemas.GetProviderEmailContextResponse;
  assert.deepEqual(cmdbuildResponse.required, [
    'status',
    'hostname',
    'router_id',
    'city',
    'location',
    'ip_address',
    'contract',
    'provider_email',
  ]);
  assert.equal(cmdbuildResponse.properties.provider_email.format, 'email');

  const hrVerifyPath = openapi.paths['/webhook/hr/verify-manager'].post;
  assert.equal(hrVerifyPath.operationId, 'verifyEmployeeManager');
  assert.deepEqual(hrVerifyPath.tags, ['runbooks', 'hr']);
  const hrVerifyRequest = openapi.components.schemas.VerifyEmployeeManagerRequest;
  assertRequiredAlternatives(hrVerifyRequest, [
    [['employee_full_name'], ['employeeFullName']],
    [['claimed_manager_full_name'], ['claimedManagerFullName']],
  ]);
  assert.deepEqual(hrVerifyRequest.properties.relation_type.enum, ['administrative', 'managerial', 'both']);
  assert.equal(hrVerifyRequest.properties.relation_type.default, 'both');
  const hrVerifyResponse = openapi.components.schemas.VerifyEmployeeManagerResponse;
  assert.deepEqual(hrVerifyResponse.properties.status.enum, ['OK', 'ERROR']);
  assert.equal(hrVerifyResponse.properties.employee_id.type, 'string');
  assert.equal(hrVerifyResponse.properties.manager_id.type, 'string');
  assert.equal(
    openapi.components.schemas.VerifyEmployeeManagerPerson.properties.employee_id_found.description.includes(
      'business ERROR',
    ),
    true,
  );
  assert.equal(hrVerifyPath.responses['200'].content['application/json'].examples.ok.value.manager_id, '2001');
  assert.equal(
    hrVerifyPath.responses['200'].content['application/json'].examples.managerIdNotFound.value.error_code,
    'manager_id_not_found',
  );
  assert.equal(hrVerifyResponse.properties.employee.oneOf[0].$ref, '#/components/schemas/VerifyEmployeeManagerPerson');

  const applicantPath = openapi.paths['/webhook/hr/verify-applicant-participant'].post;
  assert.equal(applicantPath.operationId, 'verifyApplicantParticipant');
  assert.deepEqual(applicantPath.tags, ['runbooks', 'hr']);
  const applicantRequest = openapi.components.schemas.VerifyApplicantParticipantRequest;
  assertRequiredAlternatives(applicantRequest, [
    [['applicant_full_name'], ['applicantFullName']],
    [['employee_full_name'], ['employeeFullName']],
    [['manager_full_name'], ['managerFullName']],
  ]);
  const applicantResponse = openapi.components.schemas.VerifyApplicantParticipantResponse;
  assert.deepEqual(applicantResponse.properties.status.enum, ['OK', 'ERROR']);
  assert.deepEqual(applicantResponse.properties.matched_role.enum, ['employee', 'manager', 'both']);
  assert.deepEqual(applicantResponse.properties.error_code.enum, ['applicant_not_participant']);

  const adLookupPath = openapi.paths['/webhook/ad/user/login-lookup'].post;
  assert.equal(adLookupPath.operationId, 'lookupAdUserLogin');
  assert.deepEqual(adLookupPath.tags, ['runbooks', 'ad']);
  const adLookupRequest = openapi.components.schemas.LookupAdUserLoginRequest;
  assertRequiredAlternatives(adLookupRequest, [
    [['full_name'], ['fullName']],
    [['employee_id'], ['employeeId']],
  ]);
  assert.equal(adLookupRequest.properties.full_name_attribute.default, 'displayName');
  assert.equal(adLookupRequest.properties.employee_id_attribute.default, 'employeeID');
  assert.equal(adLookupRequest.properties.login_attribute.default, 'sAMAccountName');
  assert.equal(adLookupRequest.properties.email_attribute.default, 'mail');
  const adLookupResponse = openapi.components.schemas.LookupAdUserLoginResponse;
  assert.deepEqual(adLookupResponse.properties.status.enum, ['OK', 'ERROR']);
  assert.equal(adLookupResponse.properties.login.description.includes('login_attribute'), true);
  assert.equal(adLookupResponse.properties.email.description.includes('email_attribute'), true);
  assert.deepEqual(openapi.components.schemas.LookupAdUserLoginMatchedBy.required, [
    'full_name_attribute',
    'employee_id_attribute',
    'login_attribute',
    'email_attribute',
  ]);
  assert.deepEqual(adLookupResponse.properties.error_code.enum, [
    'ad_user_not_found',
    'ad_user_not_unique',
    'ad_login_not_found',
    'ad_email_not_found',
  ]);

  const adPasswordResetPath = openapi.paths['/webhook/ad/user/reset-password'].post;
  assert.equal(adPasswordResetPath.operationId, 'resetAdUserPassword');
  assert.deepEqual(adPasswordResetPath.tags, ['runbooks', 'ad']);
  const adPasswordResetRequest = openapi.components.schemas.ResetAdUserPasswordRequest;
  assertRequiredAlternatives(adPasswordResetRequest, [[['login']]]);
  assert.equal(adPasswordResetRequest.properties.password_length.default, 12);
  assert.equal(adPasswordResetRequest.properties.password_length.minimum, 8);
  assert.equal(adPasswordResetRequest.properties.password_length.maximum, 128);
  assert.equal(Object.hasOwn(adPasswordResetRequest.properties, 'allowed_chars'), false);
  assert.equal(Object.hasOwn(adPasswordResetRequest.properties, 'login_attribute'), false);
  assert.equal(Object.hasOwn(adPasswordResetRequest.properties, 'base_dn'), false);
  assert.deepEqual(adPasswordResetPath.security, [{ ServiceDeskWebhookToken: [] }, { ServiceDeskInternalRunbookToken: [] }]);
  const adPasswordResetResponse = openapi.components.schemas.ResetAdUserPasswordResponse;
  assert.deepEqual(adPasswordResetResponse.properties.status.enum, ['OK', 'ERROR']);
  assert.equal(adPasswordResetResponse.properties.password.description.includes('secret'), true);
  assert.deepEqual(adPasswordResetResponse.properties.error_code.enum, [
    'ad_user_lookup_failed',
    'ad_user_not_found',
    'ad_user_not_unique',
    'ad_user_dn_not_found',
    'ad_password_update_failed',
    'ad_password_update_unconfirmed',
  ]);
  assert.deepEqual(openapi.components.schemas.ResetAdUserPasswordMatchedBy.required, ['login_attribute']);
  assert.equal(
    adPasswordResetPath.responses['200'].content['application/json'].examples.ok.value.change_on_first_login,
    true,
  );
  assert.equal(
    adPasswordResetPath.responses['400'].content['application/json'].examples.invalidPasswordLength.value.error.code,
    'invalid_password_length',
  );

  const adPasswordResetProcessPath = openapi.paths['/webhook/ad/password-reset/process'].post;
  assert.equal(adPasswordResetProcessPath.operationId, 'processAdPasswordResetRequest');
  assert.deepEqual(adPasswordResetProcessPath.tags, ['runbooks', 'ad', 'hr', 'email']);
  const adPasswordResetProcessRequest = openapi.components.schemas.ProcessAdPasswordResetRequest;
  assertRequiredAlternatives(adPasswordResetProcessRequest, [
    [['service_request'], ['serviceRequest']],
    [['applicant_full_name'], ['applicantFullName']],
    [['employee_full_name'], ['employeeFullName']],
    [['claimed_manager_full_name'], ['claimedManagerFullName']],
    [['approval_id'], ['approvalId']],
    [['approved_by'], ['approvedBy']],
    [['idempotency_key'], ['idempotencyKey']],
  ]);
  const adPasswordResetProcessResponse = openapi.components.schemas.ProcessAdPasswordResetResponse;
  assert.deepEqual(adPasswordResetProcessResponse.properties.status.enum, ['OK', 'ERROR']);
  assert.equal(adPasswordResetProcessResponse.properties.password_changed.type, 'boolean');
  assert.equal(adPasswordResetProcessResponse.properties.notification_sent.type, 'boolean');
  assert.equal(adPasswordResetProcessResponse.properties.approval_id.type, 'string');
  assert.equal(adPasswordResetProcessResponse.properties.idempotency_key.type, 'string');
  assert.deepEqual(adPasswordResetProcessResponse.properties.failed_step.enum, [
    'applicant_participant',
    'manager_verification',
    'employee_ad_lookup',
    'manager_ad_lookup',
    'password_reset',
    'notification',
  ]);
  assert.deepEqual(adPasswordResetProcessResponse.not, { required: ['password'] });
  assert.equal(
    openapi.components.schemas.ProcessAdPasswordResetStepResults.properties.password_reset.description.includes(
      'without the generated password',
    ),
    true,
  );
  assert.equal(
    adPasswordResetProcessPath.responses['200'].content['application/json'].examples.ok.value.password_changed,
    true,
  );
  assert.equal(
    Object.hasOwn(
      adPasswordResetProcessPath.responses['200'].content['application/json'].examples.ok.value.steps.password_reset,
      'password',
    ),
    false,
  );

  const providerMonitorPath = openapi.paths['/webhook/provider/channel-repair/monitor'].post;
  assert.equal(providerMonitorPath.operationId, 'monitorProviderChannelRepair');
  assert.deepEqual(providerMonitorPath.tags, ['runbooks', 'cmdbuild', 'email', 'zabbix']);
  assert.equal(
    providerMonitorPath['x-result-delivery'].result_schema,
    '#/components/schemas/MonitorProviderChannelRepairResult',
  );
  const providerMonitorRequest = openapi.components.schemas.MonitorProviderChannelRepairRequest;
  assert.deepEqual(providerMonitorRequest.required, ['invocation', 'from']);
  assertRequiredAlternatives(providerMonitorRequest, [
    [['problem_host'], ['problemHost'], ['router_ref'], ['routerRef'], ['host'], ['hostname'], ['hostName']],
    [['problemUrl'], ['problem_url']],
    [['service_request'], ['serviceRequest']],
    [['poll_interval_minutes'], ['pollIntervalMinutes']],
    [['timeout_minutes'], ['timeoutMinutes']],
    [['replyTo'], ['reply_to']],
  ]);
  assert.equal(providerMonitorRequest.properties.router_ref.maxLength, 500);
  assert.equal(providerMonitorRequest.properties.poll_interval_minutes.maximum, 60);
  assert.equal(providerMonitorRequest.properties.timeout_minutes.maximum, 240);
  assert.equal(providerMonitorRequest.properties.templateId.default, 'provider_channel_outage_test');
  const providerMonitorResult = openapi.components.schemas.MonitorProviderChannelRepairResult;
  assert.ok(providerMonitorResult.properties.router_lookup_status);
  assert.ok(providerMonitorResult.properties.router_candidates);
  assert.deepEqual(providerMonitorResult.properties.email_result.oneOf, [
    { $ref: '#/components/schemas/WaitForEmailByTicketResult' },
    { type: 'null' },
  ]);
  const waitForEmailResult = openapi.components.schemas.WaitForEmailByTicketResult;
  assert.ok(waitForEmailResult.properties.body);
  assert.ok(waitForEmailResult.properties.subject);
  assert.ok(waitForEmailResult.properties.match_count);
  assert.ok(waitForEmailResult.properties.ticket_number);
  assert.deepEqual(openapi.components.schemas.MonitorProviderChannelRepairResultStatus.enum, [
    'RESOLVED',
    'OK',
    'MULTI_MAIL',
    'DELIVERY_FAILED',
    'NOT_FOUND',
    'ERROR',
  ]);

  const catalog = readJson('contracts/n8n-workflow-catalog.json');
  const provider = catalog.workflows.find((workflow) => workflow.workflow_id === 'provider_channel_failure');
  assert.equal(provider.result_delivery.default_result_topic, 'external.events');
  assert.deepEqual(provider.result_delivery.supported_transports, ['http_callback', 'kafka_event', 'both']);
  assert.equal(provider.result_delivery.transport_security.http_callback.recommended_production_scheme, 'https');
  assert.deepEqual(provider.result_delivery.transport_security.kafka_event.supported_auth, ['sasl', 'mtls']);

  const placeholder = catalog.workflows.find((workflow) => workflow.workflow_id === 'zabbix_problem_processing');
  assert.equal(placeholder.enabled, false);
  assert.equal(placeholder.lifecycle, 'internal_placeholder');

  const zabbixStatus = catalog.workflows.find((workflow) => workflow.workflow_id === 'zabbix_problem_status');
  assert.equal(zabbixStatus.enabled, true);
  assert.equal(zabbixStatus.read_only, true);
  assert.deepEqual(zabbixStatus.status_values, ['problem', 'resolved', 'ok']);

  const zabbixWait = catalog.workflows.find((workflow) => workflow.workflow_id === 'zabbix_problem_wait');
  assert.equal(zabbixWait.enabled, true);
  assert.equal(zabbixWait.read_only, true);
  assert.equal(zabbixWait.async_supported, true);
  assert.equal(zabbixWait.direct_supported, false);
  assert.equal(zabbixWait.openapi_operation_id, 'waitZabbixProblemStatus');
  assert.deepEqual(zabbixWait.status_values, ['ok', 'resolved', 'problem', 'ERROR']);
  assert.deepEqual(zabbixWait.timeout_result, { status: 'problem', timed_out: true });
  assert.deepEqual(zabbixWait.depends_on, ['zabbix_problem_status']);
  assert.deepEqual(zabbixWait.result_delivery.supported_transports, ['http_callback', 'kafka_event', 'both']);

  const emailWait = catalog.workflows.find((workflow) => workflow.workflow_id === 'email_wait_for_ticket');
  assert.equal(emailWait.enabled, true);
  assert.equal(emailWait.openapi_operation_id, 'waitForEmailByTicket');
  assert.deepEqual(emailWait.status_values, ['OK', 'MULTI_MAIL', 'DELIVERY_FAILED', 'NOT_FOUND']);
  assert.equal(emailWait.direct_timeout_limit_minutes, 5);
  assert.deepEqual(emailWait.depends_on, ['email_mailbox_collector']);
  assert.equal(emailWait.result_delivery.transport_security.http_callback.callback_base_url_env, 'ORCHESTRATOR_PUBLIC_URL');
  assert.deepEqual(emailWait.result_delivery.transport_security.kafka_event.supported_security_protocols, [
    'SASL_SSL',
    'SSL',
  ]);

  const cmdbuildContext = catalog.workflows.find((workflow) => workflow.workflow_id === 'cmdbuild_provider_email_context');
  assert.equal(cmdbuildContext.enabled, true);
  assert.equal(cmdbuildContext.read_only, true);
  assert.equal(cmdbuildContext.openapi_operation_id, 'getProviderEmailContext');
  assert.equal(cmdbuildContext.cmdbuild.class_name, 'routerG');
  assert.deepEqual(cmdbuildContext.cmdbuild.search_attributes, ['Description', 'hostname', 'Code']);
  assert.deepEqual(cmdbuildContext.cmdbuild.required_router_attributes, ['email', 'contract', 'ipaddress', 'Location']);

  const hrVerify = catalog.workflows.find((workflow) => workflow.workflow_id === 'hr_verify_manager');
  assert.equal(hrVerify.enabled, true);
  assert.equal(hrVerify.read_only, true);
  assert.equal(hrVerify.direct_supported, true);
  assert.equal(hrVerify.async_supported, false);
  assert.equal(hrVerify.openapi_operation_id, 'verifyEmployeeManager');
  assert.deepEqual(hrVerify.relation_types, ['administrative', 'managerial', 'both']);
  assert.equal(hrVerify.default_relation_type, 'both');
  assert.deepEqual(hrVerify.environment, ['HR_API_BASE_URL', 'N8N_WEBHOOK_TOKEN']);
  assert.deepEqual(hrVerify.ok_required_outputs, ['employee_id', 'manager_id']);
  assert.ok(hrVerify.business_error_codes.includes('employee_id_not_found'));
  assert.ok(hrVerify.business_error_codes.includes('manager_id_not_found'));

  const applicantParticipant = catalog.workflows.find(
    (workflow) => workflow.workflow_id === 'hr_applicant_participant',
  );
  assert.equal(applicantParticipant.enabled, true);
  assert.equal(applicantParticipant.read_only, true);
  assert.equal(applicantParticipant.direct_supported, true);
  assert.equal(applicantParticipant.async_supported, false);
  assert.equal(applicantParticipant.openapi_operation_id, 'verifyApplicantParticipant');
  assert.deepEqual(applicantParticipant.required_inputs, [
    'applicant_full_name',
    'employee_full_name',
    'manager_full_name',
  ]);
  assert.equal(applicantParticipant.matching.external_lookup, false);
  assert.deepEqual(applicantParticipant.matched_roles, ['employee', 'manager', 'both']);
  assert.deepEqual(applicantParticipant.environment, ['N8N_WEBHOOK_TOKEN']);
  assert.deepEqual(applicantParticipant.ok_required_outputs, ['matched_role']);
  assert.ok(applicantParticipant.business_error_codes.includes('applicant_not_participant'));

  const adLookup = catalog.workflows.find((workflow) => workflow.workflow_id === 'ad_user_login_lookup');
  assert.equal(adLookup.enabled, true);
  assert.equal(adLookup.read_only, true);
  assert.equal(adLookup.direct_supported, true);
  assert.equal(adLookup.async_supported, false);
  assert.equal(adLookup.openapi_operation_id, 'lookupAdUserLogin');
  assert.deepEqual(adLookup.required_inputs, ['full_name', 'employee_id']);
  assert.equal(adLookup.ad.default_full_name_attribute, 'displayName');
  assert.equal(adLookup.ad.default_employee_id_attribute, 'employeeID');
  assert.equal(adLookup.ad.default_login_attribute, 'sAMAccountName');
  assert.equal(adLookup.ad.default_email_attribute, 'mail');
  assert.deepEqual(adLookup.ad.default_attribute_env, [
    'AD_FULL_NAME_ATTRIBUTE',
    'AD_EMPLOYEE_ID_ATTRIBUTE',
    'AD_LOGIN_ATTRIBUTE',
    'AD_EMAIL_ATTRIBUTE',
  ]);
  assert.deepEqual(adLookup.environment, ['AD_BASE_DN', 'N8N_WEBHOOK_TOKEN']);
  assert.deepEqual(adLookup.ok_required_outputs, ['login', 'email']);
  assert.ok(adLookup.business_error_codes.includes('ad_user_not_unique'));
  assert.ok(adLookup.business_error_codes.includes('ad_email_not_found'));

  const adPasswordReset = catalog.workflows.find((workflow) => workflow.workflow_id === 'ad_user_password_reset');
  assert.equal(adPasswordReset.enabled, true);
  assert.equal(adPasswordReset.read_only, false);
  assert.equal(adPasswordReset.direct_supported, false);
  assert.equal(adPasswordReset.internal_only, true);
  assert.equal(adPasswordReset.async_supported, false);
  assert.equal(adPasswordReset.openapi_operation_id, 'resetAdUserPassword');
  assert.deepEqual(adPasswordReset.required_inputs, ['login']);
  assert.deepEqual(adPasswordReset.optional_inputs, ['password_length']);
  assert.equal(adPasswordReset.ad.default_login_attribute, 'sAMAccountName');
  assert.equal(adPasswordReset.ad.default_password_length, 12);
  assert.equal(adPasswordReset.ad.password_attribute, 'unicodePwd');
  assert.equal(adPasswordReset.ad.change_on_first_login_attribute, 'pwdLastSet');
  assert.deepEqual(adPasswordReset.ad.default_attribute_env, ['AD_PASSWORD_RESET_LOGIN_ATTRIBUTE', 'AD_LOGIN_ATTRIBUTE']);
  assert.deepEqual(adPasswordReset.environment, [
    'AD_BASE_DN',
    'N8N_WEBHOOK_TOKEN',
    'N8N_INTERNAL_RUNBOOK_TOKEN',
  ]);
  assert.deepEqual(adPasswordReset.ok_required_outputs, ['password', 'change_on_first_login']);
  assert.ok(adPasswordReset.business_error_codes.includes('ad_password_update_failed'));
  assert.ok(adPasswordReset.business_error_codes.includes('ad_password_update_unconfirmed'));

  const adPasswordResetProcess = catalog.workflows.find(
    (workflow) => workflow.workflow_id === 'ad_password_reset_process',
  );
  assert.equal(adPasswordResetProcess.enabled, true);
  assert.equal(adPasswordResetProcess.read_only, false);
  assert.equal(adPasswordResetProcess.direct_supported, true);
  assert.equal(adPasswordResetProcess.async_supported, false);
  assert.equal(adPasswordResetProcess.openapi_operation_id, 'processAdPasswordResetRequest');
  assert.deepEqual(adPasswordResetProcess.required_inputs, [
    'service_request',
    'applicant_full_name',
    'employee_full_name',
    'claimed_manager_full_name',
    'approval_id',
    'approved_by',
    'idempotency_key',
  ]);
  assert.deepEqual(adPasswordResetProcess.depends_on, [
    'hr_applicant_participant',
    'hr_verify_manager',
    'ad_user_login_lookup',
    'ad_user_password_reset',
    'templated_email_dispatch',
  ]);
  assert.equal(adPasswordResetProcess.password_handling.returned_to_caller, false);
  assert.equal(adPasswordResetProcess.password_handling.execution_history_saved, false);
  assert.deepEqual(adPasswordResetProcess.ok_required_outputs, [
    'password_changed',
    'notification_sent',
    'steps',
  ]);
  assert.ok(adPasswordResetProcess.business_error_codes.includes('notification_email_send_failed'));

  const providerMonitor = catalog.workflows.find(
    (workflow) => workflow.workflow_id === 'provider_channel_repair_monitor',
  );
  assert.equal(providerMonitor.enabled, true);
  assert.equal(providerMonitor.async_supported, true);
  assert.equal(providerMonitor.direct_supported, false);
  assert.equal(providerMonitor.openapi_operation_id, 'monitorProviderChannelRepair');
  assert.deepEqual(providerMonitor.status_values, [
    'RESOLVED',
    'OK',
    'MULTI_MAIL',
    'DELIVERY_FAILED',
    'NOT_FOUND',
    'ERROR',
  ]);
  assert.deepEqual(providerMonitor.depends_on, [
    'cmdbuild_provider_email_context',
    'templated_email_dispatch',
    'zabbix_problem_status',
    'email_mailbox_collector',
  ]);
  assert.equal(providerMonitor.result_delivery.default_result_topic, 'external.events');
  assert.deepEqual(providerMonitor.result_delivery.supported_transports, ['http_callback', 'kafka_event', 'both']);
  assert.equal(providerMonitor.progress_diagnostics.enabled, true);
  assert.equal(providerMonitor.progress_diagnostics.delivery, 'ExternalEvent.status=progress');
  assert.ok(providerMonitor.progress_diagnostics.fields.includes('mailbox_indexed_count'));
  assert.ok(providerMonitor.progress_diagnostics.fields.includes('match_count'));
}

async function testContractDiscoveryLocalization() {
  const buildCode = codeNode('workflows/contracts-openapi-webhook.json', 'contracts-openapi-build-response');
  const run = runner(buildCode);

  const defaultResponse = responseOf(await run({ query: {} }));
  assert.equal(defaultResponse.statusCode, 200);
  assert.equal(defaultResponse.response['x-localization'].default_locale, 'ru');
  assert.equal(
    defaultResponse.response.info.description,
    'Машиночитаемый контракт для внешне вызываемых n8n webhook в локальном integration adapter ServiceDesk.',
  );

  const envDefaultEnResponse = responseOf(await run({ query: {} }, { N8N_OPENAPI_DEFAULT_LOCALE: 'en' }));
  assert.equal(envDefaultEnResponse.statusCode, 200);
  assert.equal(
    envDefaultEnResponse.response.info.description,
    'Machine-readable contract for externally callable n8n webhooks in the local ServiceDesk integration adapter.',
  );

  const enResponse = responseOf(await run({ query: { lang: 'en' } }));
  assert.equal(enResponse.statusCode, 200);
  assert.deepEqual(enResponse.response['x-localization'].supported_locales, ['en', 'ru']);
  assert.equal(
    enResponse.response.paths['/webhook/email/send'].post.summary,
    'Send a text email through n8n',
  );

  const ruResponse = responseOf(await run({ query: { lang: 'ru' } }));
  assert.equal(ruResponse.statusCode, 200);
  assert.deepEqual(ruResponse.response['x-localization'].supported_locales, ['en', 'ru']);
  assert.equal(
    ruResponse.response.info.description,
    'Машиночитаемый контракт для внешне вызываемых n8n webhook в локальном integration adapter ServiceDesk.',
  );
  assert.equal(ruResponse.response.paths['/webhook/email/send'].post.operationId, 'sendEmail');
  assert.equal(
    ruResponse.response.paths['/webhook/email/send'].post.summary,
    'Отправить текстовое письмо через n8n',
  );
  assert.equal(
    ruResponse.response.paths['/webhook/hr/verify-manager'].post.summary,
    'Проверить пару сотрудник-руководитель по кадровой выгрузке',
  );
  assert.equal(
    ruResponse.response.paths['/webhook/hr/verify-applicant-participant'].post.summary,
    'Проверить, что заявитель является сотрудником или руководителем',
  );
  assert.equal(
    ruResponse.response.paths['/webhook/ad/user/login-lookup'].post.summary,
    'Найти login и email пользователя AD по ФИО и табельному номеру',
  );
  assert.equal(
    ruResponse.response.paths['/webhook/ad/user/reset-password'].post.summary,
    'Сменить пароль пользователя AD и потребовать смену при первом входе',
  );
  assert.equal(
    ruResponse.response.paths['/webhook/ad/password-reset/process'].post.summary,
    'Обработать заявку ServiceDesk на смену пароля AD',
  );
  assert.equal(
    ruResponse.response.components.schemas.VerifyEmployeeManagerRequest.properties.relation_type.description,
    'Какую HR-связь проверять: administrative, managerial или both.',
  );
  assert.equal(
    ruResponse.response.components.schemas.EmailTemplateParam.properties.sensitive.description,
    'Признак параметра, значение которого нельзя логировать или хранить вне согласованного бизнес-процесса.',
  );
  assert.equal(
    ruResponse.response.components.schemas.VerifyEmployeeManagerResponse.properties.manager_id.description,
    'Top-level табельный номер руководителя. Присутствует при status OK; если табельный номер руководителя не найден, endpoint возвращает status ERROR и error_code manager_id_not_found.',
  );
  assert.equal(
    ruResponse.response.components.schemas.LookupAdUserLoginRequest.properties.login_attribute.description,
    'AD атрибут, значение которого возвращается как login. Workflow также принимает loginAttribute.',
  );
  assert.equal(
    ruResponse.response.components.schemas.LookupAdUserLoginRequest.properties.email_attribute.description,
    'AD атрибут, значение которого возвращается как email. Workflow также принимает emailAttribute.',
  );
  assert.equal(
    ruResponse.response.components.schemas.ResetAdUserPasswordRequest.properties.password_length.description,
    'Длина генерируемого пароля. Workflow также принимает passwordLength.',
  );
  assert.equal(
    ruResponse.response.components.schemas.ResetAdUserPasswordResponse.properties.password.description,
    'Сгенерированный пароль. Присутствует при status OK. Считать секретом и не логировать.',
  );
  assert.equal(
    ruResponse.response.components.schemas.ProcessAdPasswordResetStepResults.properties.password_reset.description,
    'Санитизированный ResetAdUserPasswordResponse без поля сгенерированного пароля.',
  );
  assert.equal(
    ruResponse.response.components.schemas.VerifyApplicantParticipantResponse.properties.matched_role.description,
    'С каким участником совпал заявитель. Присутствует при status OK.',
  );
  assert.equal(
    ruResponse.response.components.schemas.AsyncCallbackPackage.description,
    'Пакет асинхронного завершения ServiceDesk. n8n публикует финальный результат runbook как canonical ExternalEvent, используя эти correlation fields; HTTP и Kafka являются transport-ами, а не отдельными бизнес-контрактами.',
  );
  assert.deepEqual(ruResponse.response.components.schemas.RunbookResultTransport.enum, [
    'http_callback',
    'kafka_event',
    'both',
  ]);

  const unsupported = responseOf(await run({ query: { lang: 'de' } }));
  assert.equal(unsupported.statusCode, 400);
  assert.equal(unsupported.response.error.code, 'unsupported_locale');
  assert.deepEqual(unsupported.response.error.supported_locales, ['en', 'ru']);

  const invalidDefault = responseOf(
    await run({ query: { lang: 'ru' } }, { N8N_OPENAPI_DEFAULT_LOCALE: 'de' }),
  );
  assert.equal(invalidDefault.statusCode, 500);
  assert.equal(invalidDefault.response.error.code, 'invalid_default_locale');
  assert.equal(invalidDefault.response.error.environment_variable, 'N8N_OPENAPI_DEFAULT_LOCALE');
  assert.equal(invalidDefault.response.error.locale, 'de');
  assert.deepEqual(invalidDefault.response.error.supported_locales, ['en', 'ru']);
}

function testWorkflowInlineDocumentation() {
  const files = readdirSync('workflows')
    .filter((file) => file.endsWith('.json'))
    .sort();
  assert.ok(files.length > 0, 'Expected workflow exports');

  for (const file of files) {
    const workflow = readJson(`workflows/${file}`);
    assertWorkflowInlineDocumentation(workflow);
  }
}

function assertCredentialReference(node, credentialType, expected) {
  assert.deepEqual(node.credentials?.[credentialType], expected);
}

function testEmailMailIdentityContracts() {
  for (const workflowPath of [
    'workflows/send-email-webhook.json',
    'workflows/send-templated-email-webhook.json',
    'workflows/provider-channel-repair-monitor-webhook.json',
  ]) {
    const raw = readFileSync(workflowPath, 'utf8');
    assert.ok(!raw.includes('N8N_MAIL_IDENTITY_ADDRESS'), `${workflowPath}: must not use N8N_MAIL_IDENTITY_ADDRESS`);
    assert.ok(!raw.includes('N8N_MAIL_FROM'), `${workflowPath}: must not use N8N_MAIL_FROM`);
    assert.ok(!raw.includes('noreply@local.dev'), `${workflowPath}: must not use noreply fallback`);
  }

  for (const [workflowPath, nodeId] of [
    ['workflows/send-email-webhook.json', 'send-email-node'],
    ['workflows/send-templated-email-webhook.json', 'send-templated-email-node'],
    ['workflows/provider-channel-repair-monitor-webhook.json', 'provider-channel-monitor-email-send'],
  ]) {
    const node = workflowNode(workflowPath, nodeId);
    assert.equal(node.parameters.fromEmail, '={{ $json.from_email }}');
    assert.equal(node.parameters.options.replyTo, '={{ $json.reply_to }}');
  }
}

function testLocalCredentialReferences() {
  const smtp = {
    id: 'Fh3kVhbHL6XxDh1c',
    name: 'GreenMail SMTP (local test)',
  };
  const imap = {
    id: '4vumCzVocGKeTH2I',
    name: 'GreenMail IMAP (local test)',
  };
  const postgres = {
    id: 'localServiceDeskPostgres',
    name: 'Local ServiceDesk Postgres',
  };
  const kafka = {
    id: 'localRedpandaKafka',
    name: 'Local Redpanda Kafka',
  };
  const cmdbuild = {
    id: 'localCmdbuildAdminTest',
    name: 'Local CMDBuild Admin Test',
  };
  const hr = {
    id: 'hrApiHeaderAuth',
    name: 'HR API Header Auth',
  };
  const adLdap = {
    id: 'msAdLdap',
    name: 'MS AD LDAPS',
  };

  assertCredentialReference(
    workflowNode('workflows/send-email-webhook.json', 'send-email-node'),
    'smtp',
    smtp,
  );
  assertCredentialReference(
    workflowNode('workflows/send-templated-email-webhook.json', 'send-templated-email-node'),
    'smtp',
    smtp,
  );
  assertCredentialReference(
    workflowNode('workflows/mailtest-auto-reply.json', 'mailtest-imap-trigger'),
    'imap',
    imap,
  );
  assertCredentialReference(
    workflowNode('workflows/mailtest-auto-reply.json', 'mailtest-send-reply'),
    'smtp',
    smtp,
  );
  assertCredentialReference(
    workflowNode('workflows/email-ticket-mailbox-collector.json', 'email-ticket-collector-imap-trigger'),
    'imap',
    imap,
  );
  assertCredentialReference(
    workflowNode('workflows/email-ticket-mailbox-collector.json', 'email-ticket-collector-upsert'),
    'postgres',
    postgres,
  );
  assertCredentialReference(
    workflowNode('workflows/wait-for-email-ticket-webhook.json', 'wait-email-search-index'),
    'postgres',
    postgres,
  );
  assertCredentialReference(
    workflowNode('workflows/wait-for-email-ticket-webhook.json', 'wait-email-kafka-publish'),
    'kafka',
    kafka,
  );
  assertCredentialReference(
    workflowNode('workflows/wait-zabbix-problem-status-webhook.json', 'wait-zabbix-problem-kafka-publish'),
    'kafka',
    kafka,
  );
  assertCredentialReference(
    workflowNode('workflows/provider-channel-repair-monitor-webhook.json', 'provider-channel-monitor-email-search'),
    'postgres',
    postgres,
  );
  assertCredentialReference(
    workflowNode('workflows/provider-channel-repair-monitor-webhook.json', 'provider-channel-monitor-kafka-publish'),
    'kafka',
    kafka,
  );
  assertCredentialReference(
    workflowNode('workflows/provider-channel-repair-monitor-webhook.json', 'provider-channel-monitor-email-send'),
    'smtp',
    smtp,
  );
  for (const nodeId of [
    'provider-channel-monitor-cmdbuild-search-router',
    'provider-channel-monitor-cmdbuild-get-ip',
    'provider-channel-monitor-cmdbuild-get-room',
    'provider-channel-monitor-cmdbuild-get-floor',
    'provider-channel-monitor-cmdbuild-get-building',
  ]) {
    assertCredentialReference(
      workflowNode('workflows/provider-channel-repair-monitor-webhook.json', nodeId),
      'httpBasicAuth',
      cmdbuild,
    );
  }
  for (const nodeId of [
    'cmdbuild-provider-context-search-router',
    'cmdbuild-provider-context-get-ip',
    'cmdbuild-provider-context-get-room',
    'cmdbuild-provider-context-get-floor',
    'cmdbuild-provider-context-get-building',
  ]) {
    assertCredentialReference(
      workflowNode('workflows/cmdbuild-provider-email-context-webhook.json', nodeId),
      'httpBasicAuth',
      cmdbuild,
    );
  }
  for (const nodeId of [
    'hr-verify-manager-positions-hired',
    'hr-verify-manager-org-admin',
    'hr-verify-manager-org-managerial',
    'hr-verify-manager-sub-admin',
    'hr-verify-manager-sub-managerial',
  ]) {
    assertCredentialReference(workflowNode('workflows/hr-find-manager.json', nodeId), 'httpHeaderAuth', hr);
  }
  assertCredentialReference(
    workflowNode('workflows/ad-user-login-lookup-webhook.json', 'ad-login-lookup-search'),
    'ldap',
    adLdap,
  );
  assertCredentialReference(
    workflowNode('workflows/ad-password-reset-webhook.json', 'ad-password-reset-search'),
    'ldap',
    adLdap,
  );
  assertCredentialReference(
    workflowNode('workflows/ad-password-reset-webhook.json', 'ad-password-reset-update'),
    'ldap',
    adLdap,
  );
}

async function main() {
  await testStage4();
  await testWaitForEmailByTicket();
  await testTemplatedEmail();
  await testZabbixProblem();
  await testZabbixProblemStatus();
  await testWaitZabbixProblemStatus();
  await testHrVerifyManager();
  await testHrApplicantParticipant();
  await testAdUserLoginLookup();
  await testAdPasswordReset();
  await testAdPasswordResetProcess();
  await testCmdbuildProviderContext();
  await testProviderChannelRepairMonitor();
  testOpenApiAndCatalog();
  testMcpToolManifest();
  await testContractDiscoveryLocalization();
  testWorkflowInlineDocumentation();
  testEmailMailIdentityContracts();
  testLocalCredentialReferences();
  process.stdout.write('contract tests passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
