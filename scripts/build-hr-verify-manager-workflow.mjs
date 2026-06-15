#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { documentedWorkflow } from './workflow-inline-documentation.mjs';

const WORKFLOW_PATH = 'workflows/hr-find-manager.json';

const HR_API_HEADER_CREDENTIAL = {
  id: 'hrApiHeaderAuth',
  name: 'HR API Header Auth',
};

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const prepareRequestCode = String.raw`const input = $input.first().json || {};
const headers = input.headers || {};
const body = input.body && typeof input.body === 'object' ? input.body : {};
const env = typeof $env !== 'undefined' ? $env : {};
const envValue = (name) => env[name] || (typeof process !== 'undefined' ? process.env[name] : '') || '';
const expectedToken = envValue('N8N_WEBHOOK_TOKEN');
const actualToken = headers['x-servicedesk-token'] || headers['X-ServiceDesk-Token'] || headers['X-Servicedesk-Token'] || '';
const debugLevel = String(envValue('N8N_WORKFLOW_DEBUG') || 'off');

function diagnostic(level, event, fields = {}) {
  const order = { off: 0, Basic: 1, Verbose: 2 };
  if ((order[debugLevel] || 0) < (order[level] || 0)) return;
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|password|secret|authorization|full_name|name|person|employee/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
}

function response(statusCode, code, message, details = {}) {
  diagnostic('Basic', 'hr_verify_manager_rejected', { statusCode, code });
  return [{ json: { valid: false, statusCode, response: { error: { code, message, ...details } } } }];
}

function stringValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseLegalEntities(value) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const result = raw.map((item) => String(item || '').trim()).filter(Boolean);
  return Array.from(new Set(result));
}

function hasControlChars(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function parseBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  if (!/^https?:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(raw)) return null;
  return raw;
}

if (!expectedToken || actualToken !== expectedToken) {
  return response(401, 'unauthorized', 'Токен webhook отсутствует или некорректен.');
}

const employeeFullName = normalizeName(stringValue(body.employee_full_name, body.employeeFullName));
const claimedManagerFullName = normalizeName(stringValue(body.claimed_manager_full_name, body.claimedManagerFullName));
if (!employeeFullName) return response(400, 'missing_employee_full_name', 'Поле employee_full_name обязательно.');
if (!claimedManagerFullName) return response(400, 'missing_claimed_manager_full_name', 'Поле claimed_manager_full_name обязательно.');
if (employeeFullName.length > 300 || claimedManagerFullName.length > 300) {
  return response(400, 'full_name_too_long', 'ФИО не должно превышать 300 символов.');
}
if (hasControlChars(employeeFullName) || hasControlChars(claimedManagerFullName)) {
  return response(400, 'invalid_full_name', 'ФИО не должно содержать управляющие символы.');
}

const relationType = stringValue(body.relation_type, body.relationType) || 'both';
if (!['administrative', 'managerial', 'both'].includes(relationType)) {
  return response(400, 'invalid_relation_type', 'relation_type должен быть administrative, managerial или both.', { relation_type: relationType });
}

const legalEntities = parseLegalEntities(body.legal_entities ?? body.legalEntities);
if (legalEntities.length > 50) {
  return response(400, 'too_many_legal_entities', 'legal_entities содержит слишком много значений.');
}

const hrApiBaseUrl = parseBaseUrl(envValue('HR_API_BASE_URL'));
if (!hrApiBaseUrl) {
  return response(500, 'missing_hr_api_base_url', 'HR_API_BASE_URL должен быть http/https URL без query/fragment.');
}

diagnostic('Basic', 'hr_verify_manager_accepted', { relation_type: relationType, legal_entity_count: legalEntities.length });

return [{
  json: {
    valid: true,
    statusCode: 200,
    employee_full_name: employeeFullName,
    claimed_manager_full_name: claimedManagerFullName,
    employee_name_key: employeeFullName.toLocaleLowerCase('ru-RU'),
    claimed_manager_name_key: claimedManagerFullName.toLocaleLowerCase('ru-RU'),
    relation_type: relationType,
    legal_entities: legalEntities,
    hr_api_base_url: hrApiBaseUrl,
    positions_hired_body: {
      legalEntities,
      onlyFullDefined: true,
      withDuplicateEmployees: true
    },
    orgstructure_body: {
      legalEntities
    }
  }
}];`;

const buildSearchStateCode = String.raw`const positionsResponse = $input.first().json || {};
const requestState = $('Подготовка запроса HR').first().json || {};

function bodyOf(value) {
  return value && typeof value.body === 'object' ? value.body : value;
}

function statusOf(value) {
  return Number(value?.statusCode || 200);
}

function rowsOf(value) {
  const body = bodyOf(value);
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

function error(statusCode, code, message, details = {}) {
  return [{ json: { ...requestState, done: true, statusCode, response: { error: { code, message, ...details } } } }];
}

const httpStatus = statusOf(positionsResponse);
const body = bodyOf(positionsResponse);
if (httpStatus >= 400 || body?.success === false) {
  return error(502, 'hr_positions_hired_failed', 'HR API /Positions.Hired вернул ошибку.', { hr_status: httpStatus || null });
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function fullNameFromPerson(personInfo = {}) {
  return [personInfo.Last_name, personInfo.First_name, personInfo.Middle_name].map(text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function nameKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU');
}

function employeeKey(employee, personInfo, position) {
  return text(employee.EmployeeGID) || text(personInfo.PersonGID) || [fullNameFromPerson(personInfo), text(position.PositionGID)].join(':');
}

const peopleByKey = {};
const occupantsByPosition = {};
const rows = rowsOf(positionsResponse);
for (const legalEntityBlock of rows) {
  const legalEntity = text(legalEntityBlock.LegalEntity);
  for (const position of Array.isArray(legalEntityBlock.Positions) ? legalEntityBlock.Positions : []) {
    const positionGid = text(position.PositionGID);
    if (!positionGid) continue;
    for (const employee of Array.isArray(position.Employees) ? position.Employees : []) {
      const employeeInfo = employee.EmployeeInfo && typeof employee.EmployeeInfo === 'object' ? employee.EmployeeInfo : {};
      const personInfo = employeeInfo.PersonInfo && typeof employeeInfo.PersonInfo === 'object' ? employeeInfo.PersonInfo : {};
      const fullName = fullNameFromPerson(personInfo);
      if (!fullName) continue;
      const key = employeeKey(employee, personInfo, position);
      if (!peopleByKey[key]) {
        const employeeId = text(employee.EmployeeID || employeeInfo.EmployeeID);
        peopleByKey[key] = {
          key,
          full_name: fullName,
          name_key: nameKey(fullName),
          employee_gid: text(employee.EmployeeGID) || null,
          employee_id: employeeId || null,
          employee_id_found: Boolean(employeeId),
          person_gid: text(personInfo.PersonGID) || null,
          state: text(employeeInfo.State) || null,
          positions: []
        };
      }
      peopleByKey[key].positions.push({
        legal_entity: legalEntity || null,
        position_gid: positionGid,
        position_name: text(position.PositionName || position.Name) || null,
        regular_position_gid: text(position.RegularPositionGID) || null,
        org_unit_gid: text(position.OrgUnitGID) || null,
        org_unit_name: text(position.OrgUnitName) || null,
        org_unit_managerial_name: text(position.OrgUnitManagerialName) || null
      });
      occupantsByPosition[positionGid] = occupantsByPosition[positionGid] || [];
      if (!occupantsByPosition[positionGid].includes(key)) occupantsByPosition[positionGid].push(key);
    }
  }
}

const people = Object.values(peopleByKey);
const employeeMatches = people.filter((person) => person.name_key === requestState.employee_name_key);
const managerMatches = people.filter((person) => person.name_key === requestState.claimed_manager_name_key);
const managerEmployeeGids = Array.from(new Set(managerMatches.map((person) => person.employee_gid).filter(Boolean)));

return [{
  json: {
    ...requestState,
    done: false,
    people,
    people_by_key: peopleByKey,
    occupants_by_position: occupantsByPosition,
    employee_matches: employeeMatches,
    manager_matches: managerMatches,
    manager_employee_gids: managerEmployeeGids,
    subordinates_body: {
      EmployeeGIDs: managerEmployeeGids
    }
  }
}];`;

const evaluateCode = String.raw`const state = $('Подготовка набора кандидатов').first().json || {};
const adminOrgResponse = $('Загрузка административной оргструктуры').first().json || {};
const managerialOrgResponse = $('Загрузка управленческой оргструктуры').first().json || {};
const adminSubResponse = $('Загрузка административных подчиненных').first().json || {};
const managerialSubResponse = $('Загрузка управленческих подчиненных').first().json || {};

if (state.done) {
  return [{ json: { statusCode: state.statusCode || 500, response: state.response || { error: { code: 'invalid_state', message: 'Некорректное состояние workflow.' } } } }];
}

function bodyOf(value) {
  return value && typeof value.body === 'object' ? value.body : value;
}

function statusOf(value) {
  return Number(value?.statusCode || 200);
}

function rowsOf(value) {
  const body = bodyOf(value);
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function needs(type) {
  return state.relation_type === type || state.relation_type === 'both';
}

function technicalError(code, message, details = {}) {
  return [{ json: { statusCode: 502, response: { error: { code, message, ...details } } } }];
}

function businessError(code, message, extra = {}) {
  return [{
    json: {
      statusCode: 200,
      response: {
        status: 'ERROR',
        error_code: code,
        message,
        relation_type_requested: state.relation_type,
        employee_matches: summarizePeople(state.employee_matches || []),
        manager_matches: summarizePeople(state.manager_matches || []),
        checked_pairs: [],
        ...extra
      }
    }
  }];
}

function summarizePerson(person) {
  return {
    full_name: person?.full_name || '',
    employee_gid: person?.employee_gid || null,
    employee_id: person?.employee_id || null,
    employee_id_found: Boolean(person?.employee_id),
    person_gid: person?.person_gid || null,
    positions: Array.isArray(person?.positions) ? person.positions.map((position) => ({
      legal_entity: position.legal_entity || null,
      position_gid: position.position_gid || null,
      position_name: position.position_name || null,
      org_unit_gid: position.org_unit_gid || null,
      org_unit_name: position.org_unit_name || null,
      org_unit_managerial_name: position.org_unit_managerial_name || null
    })) : []
  };
}

function summarizePeople(people) {
  return people.map(summarizePerson);
}

function collectEmployeeIds(...responses) {
  const result = {};
  for (const response of responses) {
    if (statusOf(response) >= 400) continue;
    for (const managerEntry of rowsOf(response)) {
      for (const position of Array.isArray(managerEntry.Positions) ? managerEntry.Positions : []) {
        for (const subordinate of Array.isArray(position.Subordinates) ? position.Subordinates : []) {
          for (const employee of Array.isArray(subordinate.Employees) ? subordinate.Employees : []) {
            const employeeGid = text(employee.EmployeeGID);
            const employeeId = text(employee.EmployeeID);
            if (employeeGid && employeeId) result[employeeGid] = employeeId;
          }
        }
      }
    }
  }
  return result;
}

const employeeIds = collectEmployeeIds(adminSubResponse, managerialSubResponse);
for (const person of Object.values(state.people_by_key || {})) {
  if (!person.employee_id && person.employee_gid && employeeIds[person.employee_gid]) {
    person.employee_id = employeeIds[person.employee_gid];
    person.employee_id_found = true;
  }
}
state.employee_matches = (state.employee_matches || []).map((person) => state.people_by_key[person.key] || person);
state.manager_matches = (state.manager_matches || []).map((person) => state.people_by_key[person.key] || person);

if (!state.employee_matches.length) {
  return businessError('employee_not_found', 'Сотрудник с указанным ФИО не найден в активной кадровой выгрузке.');
}
if (state.employee_matches.length > 1) {
  return businessError('employee_not_unique', 'По ФИО сотрудника найдено несколько активных сотрудников.');
}
if (!state.manager_matches.length) {
  return businessError('manager_not_found', 'Заявленный руководитель с указанным ФИО не найден в активной кадровой выгрузке.');
}
if (state.manager_matches.length > 1) {
  return businessError('manager_not_unique', 'По ФИО заявленного руководителя найдено несколько активных сотрудников.');
}

if (needs('administrative')) {
  const status = statusOf(adminOrgResponse);
  const body = bodyOf(adminOrgResponse);
  if (status >= 400 || body?.success === false) {
    return technicalError('hr_orgstructure_administrative_failed', 'HR API /Orgstructure.Administrative вернул ошибку.', { hr_status: status || null });
  }
}
if (needs('managerial')) {
  const status = statusOf(managerialOrgResponse);
  const body = bodyOf(managerialOrgResponse);
  if (status >= 400 || body?.success === false) {
    return technicalError('hr_orgstructure_managerial_failed', 'HR API /Orgstructure.Managerial вернул ошибку.', { hr_status: status || null });
  }
}

const employee = state.employee_matches[0];
const claimedManager = state.manager_matches[0];
const peopleByKey = state.people_by_key || {};
const occupantsByPosition = state.occupants_by_position || {};
const checkedPairs = [];
const matchedEvidence = [];

function samePerson(left, right) {
  if (!left || !right) return false;
  if (left.key && right.key && left.key === right.key) return true;
  if (left.employee_gid && right.employee_gid && left.employee_gid === right.employee_gid) return true;
  return false;
}

function occupants(positionGid, employeeToExclude) {
  return (occupantsByPosition[positionGid] || [])
    .map((key) => peopleByKey[key])
    .filter(Boolean)
    .filter((person) => !samePerson(person, employeeToExclude));
}

function addChecked(relationType, employeePosition, actualManagers, extra = {}) {
  checkedPairs.push({
    relation_type: relationType,
    employee_position_gid: employeePosition.position_gid || null,
    employee_position_name: employeePosition.position_name || null,
    actual_managers: summarizePeople(actualManagers),
    ...extra
  });
}

function addMatch(relationType, employeePosition, managerPositionGid, extra = {}) {
  matchedEvidence.push({
    relation_type: relationType,
    employee_key: employee.key,
    manager_key: claimedManager.key,
    employee_position_gid: employeePosition.position_gid || null,
    employee_position_name: employeePosition.position_name || null,
    manager_position_gid: managerPositionGid || null,
    ...extra
  });
}

function evaluateAdministrative() {
  const adminUnits = {};
  for (const block of rowsOf(adminOrgResponse)) {
    const legalEntity = text(block.LegalEntity);
    for (const unit of Array.isArray(block.OrgUnits) ? block.OrgUnits : []) {
      const orgUnitGid = text(unit.OrgUnitGID);
      if (!orgUnitGid) continue;
      adminUnits[orgUnitGid] = {
        org_unit_gid: orgUnitGid,
        org_unit_name: text(unit.Name) || null,
        legal_entity: legalEntity || null,
        manager_position_gid: text(unit.ManagerPositionGID) || null
      };
    }
  }
  for (const position of employee.positions || []) {
    const unit = adminUnits[position.org_unit_gid];
    if (!unit || !unit.manager_position_gid) {
      addChecked('administrative', position, [], { org_unit_gid: position.org_unit_gid || null, reason: unit ? 'manager_position_missing' : 'org_unit_not_found' });
      continue;
    }
    const actualManagers = occupants(unit.manager_position_gid, employee);
    addChecked('administrative', position, actualManagers, { org_unit_gid: unit.org_unit_gid, manager_position_gid: unit.manager_position_gid });
    if (actualManagers.some((manager) => samePerson(manager, claimedManager))) {
      addMatch('administrative', position, unit.manager_position_gid, { org_unit_gid: unit.org_unit_gid });
    }
  }
}

function evaluateManagerial() {
  const orgParents = {};
  const positionParents = {};
  const positionIds = new Set();
  const orgIds = new Set();
  for (const block of rowsOf(managerialOrgResponse)) {
    for (const unit of Array.isArray(block.OrgUnits) ? block.OrgUnits : []) {
      const orgUnitGid = text(unit.OrgUnitGID);
      if (!orgUnitGid) continue;
      orgIds.add(orgUnitGid);
      orgParents[orgUnitGid] = text(unit.ParentGID) || '';
    }
    for (const position of Array.isArray(block.Positions) ? block.Positions : []) {
      const positionGid = text(position.PositionGID);
      if (!positionGid) continue;
      positionIds.add(positionGid);
      positionParents[positionGid] = text(position.ParentGID) || '';
    }
  }

  function nearestOccupiedParent(positionGid, employeeToExclude) {
    let current = positionParents[positionGid] || '';
    const visited = new Set([positionGid]);
    for (let depth = 0; current && depth < 100; depth += 1) {
      if (visited.has(current)) return { managers: [], manager_position_gid: null, reason: 'cycle_detected' };
      visited.add(current);
      if (positionIds.has(current) || occupantsByPosition[current]) {
        const actualManagers = occupants(current, employeeToExclude);
        if (actualManagers.length) return { managers: actualManagers, manager_position_gid: current, reason: null };
        current = positionParents[current] || '';
        continue;
      }
      if (orgIds.has(current)) {
        current = orgParents[current] || '';
        continue;
      }
      return { managers: [], manager_position_gid: null, reason: 'parent_not_found' };
    }
    return { managers: [], manager_position_gid: null, reason: current ? 'max_depth_exceeded' : 'manager_not_found' };
  }

  for (const position of employee.positions || []) {
    const result = nearestOccupiedParent(position.position_gid, employee);
    addChecked('managerial', position, result.managers, { manager_position_gid: result.manager_position_gid, reason: result.reason });
    if (result.managers.some((manager) => samePerson(manager, claimedManager))) {
      addMatch('managerial', position, result.manager_position_gid);
    }
  }
}

if (needs('administrative')) evaluateAdministrative();
if (needs('managerial')) evaluateManagerial();

if (!matchedEvidence.length) {
  return businessError('confirmed_relation_not_found', 'Кадровая выгрузка не подтверждает заявленную пару сотрудник-руководитель.', {
    checked_pairs: checkedPairs
  });
}

const pairKeys = new Set(matchedEvidence.map((item) => item.employee_key + '->' + item.manager_key));
if (pairKeys.size !== 1) {
  return businessError('multiple_confirmed_pairs', 'Найдено несколько подтвержденных пар сотрудник-руководитель.', {
    checked_pairs: checkedPairs,
    matched_pairs: matchedEvidence
  });
}

const relationTypes = Array.from(new Set(matchedEvidence.map((item) => item.relation_type))).sort();
const employeeSummary = summarizePerson(employee);
const managerSummary = summarizePerson(claimedManager);
if (!employeeSummary.employee_id_found) {
  return businessError('employee_id_not_found', 'Табельный номер сотрудника не найден в кадровой выгрузке.', {
    matched_relation_types: relationTypes,
    employee: employeeSummary,
    manager: managerSummary,
    matched_pairs: matchedEvidence,
    checked_pairs: checkedPairs
  });
}
if (!managerSummary.employee_id_found) {
  return businessError('manager_id_not_found', 'Табельный номер руководителя не найден в кадровой выгрузке.', {
    matched_relation_types: relationTypes,
    employee: employeeSummary,
    manager: managerSummary,
    matched_pairs: matchedEvidence,
    checked_pairs: checkedPairs
  });
}
const employeeIdText = 'ТН ' + employeeSummary.employee_id;
const managerIdText = 'ТН ' + managerSummary.employee_id;

return [{
  json: {
    statusCode: 200,
    response: {
      status: 'OK',
      message: 'Проверка OK: ' + employeeSummary.full_name + ' (' + employeeIdText + ') подчиняется ' + managerSummary.full_name + ' (' + managerIdText + ') по кадровой выгрузке.',
      employee_id: employeeSummary.employee_id,
      manager_id: managerSummary.employee_id,
      relation_type_requested: state.relation_type,
      matched_relation_types: relationTypes,
      employee: employeeSummary,
      manager: managerSummary,
      matched_pairs: matchedEvidence,
      checked_pairs: checkedPairs
    }
  }
}];`;

function codeNode(id, name, jsCode, position) {
  return {
    parameters: { jsCode },
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function ifNode(id, name, position, valueExpression) {
  return {
    parameters: {
      conditions: {
        boolean: [
          {
            value1: valueExpression,
            value2: true,
          },
        ],
      },
    },
    id,
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 1,
    position,
  };
}

function respondNode(id, name, position) {
  return {
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify($json.response) }}',
      options: {
        responseCode: '={{ $json.statusCode }}',
      },
    },
    id,
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position,
  };
}

function httpNode(id, name, method, url, position, bodyExpression = null) {
  const parameters = {
    method,
    url,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    options: {
      response: {
        response: {
          fullResponse: true,
          neverError: true,
          responseFormat: 'json',
        },
      },
    },
  };
  if (bodyExpression) {
    parameters.sendBody = true;
    parameters.contentType = 'json';
    parameters.body = bodyExpression;
  }
  return {
    parameters,
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.1,
    position,
    credentials: {
      httpHeaderAuth: HR_API_HEADER_CREDENTIAL,
    },
  };
}

function workflow() {
  return documentedWorkflow({
    id: 'verifyEmployeeManager',
    name: 'HR: проверка заявленного руководителя',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'hr/verify-manager',
          responseMode: 'responseNode',
          options: {},
        },
        id: 'hr-verify-manager-webhook',
        name: 'Webhook проверки руководителя',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: '9a6312b1-bdf0-4fa6-9849-3e48d83ee685',
        position: [240, 300],
      },
      codeNode('hr-verify-manager-prepare', 'Подготовка запроса HR', prepareRequestCode, [520, 300]),
      ifNode('hr-verify-manager-valid', 'Запрос валиден?', [780, 300], '={{ $json.valid }}'),
      httpNode(
        'hr-verify-manager-positions-hired',
        'Загрузка активных назначений',
        'POST',
        '={{ $json.hr_api_base_url + "/Positions.Hired" }}',
        [1040, 200],
        '={{ $json.positions_hired_body }}',
      ),
      codeNode('hr-verify-manager-build-state', 'Подготовка набора кандидатов', buildSearchStateCode, [1300, 200]),
      ifNode('hr-verify-manager-state-done', 'Ответ уже готов?', [1560, 200], '={{ $json.done }}'),
      httpNode(
        'hr-verify-manager-org-admin',
        'Загрузка административной оргструктуры',
        'POST',
        '={{ $json.hr_api_base_url + "/Orgstructure.Administrative" }}',
        [1820, 40],
        '={{ $json.orgstructure_body }}',
      ),
      httpNode(
        'hr-verify-manager-org-managerial',
        'Загрузка управленческой оргструктуры',
        'GET',
        '={{ $json.hr_api_base_url + "/Orgstructure.Managerial" }}',
        [2080, 40],
      ),
      httpNode(
        'hr-verify-manager-sub-admin',
        'Загрузка административных подчиненных',
        'POST',
        '={{ $json.hr_api_base_url + "/Employee.Subordinates.Administrative" }}',
        [2340, 40],
        '={{ $json.subordinates_body }}',
      ),
      httpNode(
        'hr-verify-manager-sub-managerial',
        'Загрузка управленческих подчиненных',
        'POST',
        '={{ $json.hr_api_base_url + "/Employee.Subordinates.Managerial" }}',
        [2600, 40],
        '={{ $json.subordinates_body }}',
      ),
      codeNode('hr-verify-manager-evaluate', 'Проверка пары руководитель-сотрудник', evaluateCode, [2860, 200]),
      respondNode('hr-verify-manager-response', 'Нормализованный ответ', [3120, 300]),
    ],
    connections: {
      'Webhook проверки руководителя': {
        main: [[{ node: 'Подготовка запроса HR', type: 'main', index: 0 }]],
      },
      'Подготовка запроса HR': {
        main: [[{ node: 'Запрос валиден?', type: 'main', index: 0 }]],
      },
      'Запрос валиден?': {
        main: [
          [{ node: 'Загрузка активных назначений', type: 'main', index: 0 }],
          [{ node: 'Нормализованный ответ', type: 'main', index: 0 }],
        ],
      },
      'Загрузка активных назначений': {
        main: [[{ node: 'Подготовка набора кандидатов', type: 'main', index: 0 }]],
      },
      'Подготовка набора кандидатов': {
        main: [[{ node: 'Ответ уже готов?', type: 'main', index: 0 }]],
      },
      'Ответ уже готов?': {
        main: [
          [{ node: 'Нормализованный ответ', type: 'main', index: 0 }],
          [{ node: 'Загрузка административной оргструктуры', type: 'main', index: 0 }],
        ],
      },
      'Загрузка административной оргструктуры': {
        main: [[{ node: 'Загрузка управленческой оргструктуры', type: 'main', index: 0 }]],
      },
      'Загрузка управленческой оргструктуры': {
        main: [[{ node: 'Загрузка административных подчиненных', type: 'main', index: 0 }]],
      },
      'Загрузка административных подчиненных': {
        main: [[{ node: 'Загрузка управленческих подчиненных', type: 'main', index: 0 }]],
      },
      'Загрузка управленческих подчиненных': {
        main: [[{ node: 'Проверка пары руководитель-сотрудник', type: 'main', index: 0 }]],
      },
      'Проверка пары руководитель-сотрудник': {
        main: [[{ node: 'Нормализованный ответ', type: 'main', index: 0 }]],
      },
    },
    active: false,
    settings: {
      executionOrder: 'v1',
      saveDataErrorExecution: 'none',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: false,
    },
  });
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const expected = `${stableJson(workflow())}\n`;
  let current = '';
  try {
    current = readFileSync(WORKFLOW_PATH, 'utf8');
  } catch {
    current = '';
  }
  if (current === expected) {
    process.stdout.write('hr verify manager workflow is up to date\n');
    return 0;
  }
  if (checkOnly) {
    process.stderr.write(`${WORKFLOW_PATH} is out of date\n`);
    return 1;
  }
  writeFileSync(WORKFLOW_PATH, expected, 'utf8');
  process.stdout.write(`updated ${WORKFLOW_PATH}\n`);
  return 0;
}

process.exitCode = main();
