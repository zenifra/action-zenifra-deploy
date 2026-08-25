'use strict';

const core = require('@actions/core');
const github = require('@actions/github');

const DEFAULT_API_BASE_URL = 'https://api.zenifra.com';
const DEFAULT_PREVIEW_TTL = '24h';
const DEFAULT_WAIT_TIMEOUT = '10m';
const MAX_PREVIEW_TTL_MS = 168 * 60 * 60 * 1000;
const MIN_PREVIEW_TTL_MS = 60 * 60 * 1000;
const MAX_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_POLL_DELAY_MS = 10 * 1000;
const ACTION_USER_AGENT = 'zenifra-action-preview/1.0';
const TERMINAL_STATES = new Set(['available', 'deleted', 'failed', 'error', 'rejected', 'cancelled', 'canceled']);
const TRANSITIONAL_STATES = new Set([
  'accepted',
  'pending',
  'reserving',
  'provisioning',
  'updating',
  'deleting',
  'running'
]);

const PUBLIC_API_ERRORS = {
  unauthorized: 'Authentication failed. Check the API key and try again.',
  forbidden: 'This API key cannot manage Preview Environments for this project. Verify the project is enabled and the key has Preview management access.',
  project_not_found: 'The project could not be found.',
  preview_not_found: 'The preview environment could not be found.',
  preview_not_enabled: 'Preview environments are not enabled for this project.',
  invalid_preview_key: 'The preview key is invalid.',
  invalid_ttl: 'The preview duration is outside the allowed range.',
  plan_not_allowed: 'The selected preview plan is not available.',
  preview_limit_reached: 'The preview environment limit has been reached.',
  operation_in_progress: 'Another preview operation is already in progress.',
  api_key_ip_not_allowed: 'This API key is restricted to different IP addresses. Remove the IP allowlist for GitHub Actions or allow the runner IP.',
  invalid_request: 'The preview request is invalid.'
};

class ActionError extends Error {
  constructor(message, code = 'action_error') {
    super(message);
    this.name = 'ActionError';
    this.code = code;
  }
}

function readInput(activeCore, name) {
  const value = activeCore.getInput(name);
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeApiBaseUrl(value) {
  const rawValue = value || DEFAULT_API_BASE_URL;
  let parsed;

  try {
    parsed = new URL(rawValue);
  } catch {
    throw new ActionError('API_BASE_URL must be a valid URL.', 'invalid_input');
  }

  const isLocalHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    throw new ActionError('API_BASE_URL must use HTTPS.', 'invalid_input');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new ActionError('API_BASE_URL must contain only the API origin.', 'invalid_input');
  }

  return parsed.origin;
}

function parseBoolean(value, name, defaultValue) {
  if (value === '') {
    return defaultValue;
  }

  if (/^true$/i.test(value)) {
    return true;
  }

  if (/^false$/i.test(value)) {
    return false;
  }

  throw new ActionError(`${name} must be true or false.`, 'invalid_input');
}

function parseDuration(value, name, defaultValue, minimumMs, maximumMs) {
  const duration = value || defaultValue;
  const match = /^(\d+)([smhd])$/i.exec(duration);

  if (!match) {
    throw new ActionError(`${name} must use a whole number followed by s, m, h, or d.`, 'invalid_input');
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[unit];
  const milliseconds = amount * multiplier;

  if (!Number.isSafeInteger(milliseconds) || milliseconds < minimumMs || milliseconds > maximumMs) {
    throw new ActionError(`${name} is outside the allowed range.`, 'invalid_input');
  }

  return { value: duration, milliseconds };
}

function parsePreviewAction(value) {
  const action = (value || 'auto').toLowerCase();
  if (!['auto', 'upsert', 'delete'].includes(action)) {
    throw new ActionError('PREVIEW_ACTION must be auto, upsert, or delete.', 'invalid_input');
  }
  return action;
}

function getPullRequestContext(activeGithub) {
  const context = activeGithub && activeGithub.context ? activeGithub.context : {};
  const payload = context.payload || {};
  const pullRequest = payload.pull_request;
  const number = pullRequest && pullRequest.number;
  const isPullRequest = context.eventName === 'pull_request' && Number.isInteger(number) && number > 0;
  const repository = payload.repository && typeof payload.repository.full_name === 'string'
    ? payload.repository.full_name
    : '';
  const branch = pullRequest && pullRequest.head && typeof pullRequest.head.ref === 'string'
    ? pullRequest.head.ref
    : '';
  const commitSha = pullRequest && pullRequest.head && typeof pullRequest.head.sha === 'string'
    ? pullRequest.head.sha
    : '';

  return {
    isPullRequest,
    number: isPullRequest ? number : undefined,
    action: isPullRequest && typeof payload.action === 'string' ? payload.action : '',
    repository,
    branch,
    commitSha
  };
}

function resolvePreviewAction(requestedAction, pullRequest) {
  if (requestedAction !== 'auto') {
    return requestedAction;
  }

  if (pullRequest.isPullRequest && pullRequest.action === 'closed') {
    return 'delete';
  }

  return 'upsert';
}

function validatePreviewKey(value) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new ActionError('PREVIEW_KEY must contain only letters, numbers, dots, underscores, or hyphens.', 'invalid_input');
  }
  return value;
}

function readInputs(activeCore, activeGithub) {
  const apiBaseUrl = normalizeApiBaseUrl(readInput(activeCore, 'API_BASE_URL'));
  const projectId = readInput(activeCore, 'PROJECT_ID');
  const apiKey = readInput(activeCore, 'API_KEY');
  const image = readInput(activeCore, 'IMAGE');

  if (!projectId) {
    throw new ActionError('PROJECT_ID is required.', 'invalid_input');
  }
  if (!apiKey) {
    throw new ActionError('API_KEY is required.', 'invalid_input');
  }

  const preview = parseBoolean(readInput(activeCore, 'PREVIEW'), 'PREVIEW', false);
  if (!preview) {
    if (!image) {
      throw new ActionError('IMAGE is required for a standard deployment.', 'invalid_input');
    }
    return { apiBaseUrl, projectId, apiKey, image, preview: false };
  }

  const pullRequest = getPullRequestContext(activeGithub);
  const requestedKey = readInput(activeCore, 'PREVIEW_KEY');
  const previewKey = requestedKey
    ? validatePreviewKey(requestedKey)
    : pullRequest.isPullRequest
      ? `pr-${pullRequest.number}`
      : '';

  if (!previewKey) {
    throw new ActionError('PREVIEW_KEY is required outside pull_request context.', 'invalid_input');
  }

  const action = resolvePreviewAction(parsePreviewAction(readInput(activeCore, 'PREVIEW_ACTION')), pullRequest);
  const ttl = parseDuration(
    readInput(activeCore, 'PREVIEW_TTL'),
    'PREVIEW_TTL',
    DEFAULT_PREVIEW_TTL,
    MIN_PREVIEW_TTL_MS,
    MAX_PREVIEW_TTL_MS
  );
  const waitTimeout = parseDuration(
    readInput(activeCore, 'WAIT_TIMEOUT'),
    'WAIT_TIMEOUT',
    DEFAULT_WAIT_TIMEOUT,
    MIN_WAIT_TIMEOUT_MS,
    MAX_WAIT_TIMEOUT_MS
  );
  const inheritEnvs = parseBoolean(readInput(activeCore, 'INHERIT_ENVS'), 'INHERIT_ENVS', false);
  if (action === 'upsert' && !image) {
    throw new ActionError('IMAGE is required for a preview upsert.', 'invalid_input');
  }

  return {
    apiBaseUrl,
    projectId,
    apiKey,
    image,
    preview: true,
    previewKey,
    action,
    inheritEnvs,
    ttl,
    waitTimeout,
    source: pullRequest.isPullRequest
      ? {
        provider: 'github_action',
        event: 'pull_request',
        ...(pullRequest.repository ? { repository: pullRequest.repository } : {}),
        ...(pullRequest.number ? { pull_request_number: pullRequest.number } : {}),
        ...(pullRequest.branch ? { branch: pullRequest.branch } : {}),
        ...(pullRequest.commitSha ? { commit_sha: pullRequest.commitSha } : {})
      }
      : undefined
  };
}

function createTimeoutSignal(milliseconds) {
  return AbortSignal.timeout(Math.max(1, Math.floor(milliseconds)));
}

async function readResponseBody(response) {
  if (!response || response.status === 204) {
    return {};
  }

  if (typeof response.json === 'function') {
    try {
      const body = await response.json();
      return body && typeof body === 'object' ? body : {};
    } catch {
      return {};
    }
  }

  return {};
}

async function requestJson(fetchFn, url, options, timeoutMs) {
  let response;
  try {
    response = await fetchFn(url, {
      ...options,
      signal: createTimeoutSignal(timeoutMs)
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new ActionError('The request to Zenifra timed out.', 'request_timeout');
    }
    throw new ActionError('Could not reach Zenifra. Check the project settings and try again.', 'request_failed');
  }

  return { response, body: await readResponseBody(response) };
}

function getErrorCode(body) {
  if (!body || typeof body !== 'object') {
    return '';
  }
  if (typeof body.code === 'string') {
    return body.code.toLowerCase();
  }
  if (body.error && typeof body.error.code === 'string') {
    return body.error.code.toLowerCase();
  }
  return '';
}

function apiError(operation, status, body) {
  const code = getErrorCode(body);
  if (PUBLIC_API_ERRORS[code]) {
    return new ActionError(PUBLIC_API_ERRORS[code], code);
  }

  if (status === 401) {
    return new ActionError(PUBLIC_API_ERRORS.unauthorized, 'unauthorized');
  }
  if (status === 403) {
    return new ActionError(PUBLIC_API_ERRORS.forbidden, 'forbidden');
  }
  if (status === 404) {
    return new ActionError(
      operation === 'delete' ? PUBLIC_API_ERRORS.preview_not_found : PUBLIC_API_ERRORS.project_not_found,
      'not_found'
    );
  }
  if (status === 409) {
    return new ActionError(PUBLIC_API_ERRORS.operation_in_progress, 'operation_in_progress');
  }
  if (status === 422) {
    return new ActionError(PUBLIC_API_ERRORS.invalid_request, 'invalid_request');
  }
  if (status === 429) {
    return new ActionError('Too many requests were sent. Try again later.', 'rate_limited');
  }

  return new ActionError(
    operation === 'update' ? 'Could not update the project.' : 'Could not complete the preview operation.',
    `http_${status}`
  );
}

function encodePathSegment(value) {
  return encodeURIComponent(value);
}

function previewUrl(apiBaseUrl, projectId, previewKey) {
  return `${apiBaseUrl}/v1/project/${encodePathSegment(projectId)}/preview-environments/${encodePathSegment(previewKey)}`;
}

function operationUrl(apiBaseUrl, projectId, previewKey, operationId) {
  return `${previewUrl(apiBaseUrl, projectId, previewKey)}/operations/${encodePathSegment(operationId)}`;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value !== '') || '';
}

function objectValue(value) {
  return value && typeof value === 'object' ? value : {};
}

function extractOperationId(body) {
  const payload = objectValue(body);
  const data = objectValue(payload.data);
  const operation = objectValue(data.operation || payload.operation);
  return firstString(
    data.operation_id,
    data.operationId,
    payload.operation_id,
    payload.operationId,
    operation.operation_id,
    operation.operationId,
    operation.id
  );
}

function extractPreviewResult(body) {
  const payload = objectValue(body);
  const data = objectValue(payload.data);
  const preview = objectValue(data.preview || data.environment || payload.preview || payload.environment);
  const operation = objectValue(data.operation || payload.operation);
  const operationId = extractOperationId(payload);
  const previewId = firstString(
    data.preview_id,
    data.previewId,
    payload.preview_id,
    payload.previewId,
    preview.id,
    preview.preview_id,
    !operationId ? payload.id : ''
  );
  const previewUrlValue = firstString(data.preview_url, data.previewUrl, payload.preview_url, payload.previewUrl, preview.url, preview.preview_url);
  const expiresAt = firstString(data.expires_at, data.expiresAt, payload.expires_at, payload.expiresAt, preview.expires_at, preview.expiresAt);
  const status = firstString(
    operation.status,
    operation.state,
    preview.status,
    data.preview_status,
    data.previewStatus,
    data.status,
    payload.preview_status,
    payload.previewStatus,
    payload.status,
    payload.state
  ).toLowerCase();

  return { operationId, previewId, previewUrl: previewUrlValue, expiresAt, status };
}

function mergeResults(previous, next) {
  return {
    operationId: next.operationId || previous.operationId,
    previewId: next.previewId || previous.previewId,
    previewUrl: next.previewUrl || previous.previewUrl,
    expiresAt: next.expiresAt || previous.expiresAt,
    status: next.status || previous.status
  };
}

function isSuccessState(action, status) {
  return action === 'upsert' ? status === 'available' : status === 'deleted';
}

function isIncompatibleTerminalState(action, status) {
  return TERMINAL_STATES.has(status) && !isSuccessState(action, status);
}

function terminalStateError(action, status) {
  if (action === 'upsert') {
    return new ActionError('The preview did not become available.', 'preview_not_available');
  }
  return new ActionError('The preview could not be removed.', 'preview_not_deleted');
}

function validateOperationState(action, status) {
  if (isSuccessState(action, status)) {
    return;
  }
  if (isIncompatibleTerminalState(action, status) || (status && !TRANSITIONAL_STATES.has(status))) {
    throw terminalStateError(action, status);
  }
}

async function waitForOperation({ fetchFn, apiBaseUrl, projectId, apiKey, previewKey, operationId, action, initialResult, waitTimeout, sleep, now }) {
  const startedAt = now();
  const deadline = startedAt + waitTimeout.milliseconds;
  let delay = 1000;
  let result = initialResult;

  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new ActionError('Timed out waiting for the preview operation to finish.', 'wait_timeout');
    }

    const { response, body } = await requestJson(
      fetchFn,
      operationUrl(apiBaseUrl, projectId, previewKey, operationId),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': ACTION_USER_AGENT,
          'X-API-Key': apiKey
        }
      },
      Math.min(REQUEST_TIMEOUT_MS, remaining)
    );

    if (action === 'delete' && response.status === 404) {
      return { ...result, status: 'deleted' };
    }
    if (response.status < 200 || response.status >= 300) {
      throw apiError(action === 'upsert' ? 'preview' : 'delete', response.status, body);
    }

    result = mergeResults(result, extractPreviewResult(body));
    validateOperationState(action, result.status);
    if (isSuccessState(action, result.status)) {
      return result;
    }
    if (!result.status) {
      throw terminalStateError(action, result.status);
    }

    const sleepFor = Math.min(delay, Math.max(1, deadline - now()));
    await sleep(sleepFor);
    delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
  }
}

function createPreviewPayload(inputs) {
  const payload = {
    image: inputs.image,
    inherit_envs: inputs.inheritEnvs,
    ttl_hours: Math.round(inputs.ttl.milliseconds / (60 * 60 * 1000))
  };
  if (inputs.source) {
    payload.source = inputs.source;
  }
  return payload;
}

async function runPreview({ inputs, fetchFn, sleep, now }) {
  const url = previewUrl(inputs.apiBaseUrl, inputs.projectId, inputs.previewKey);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': ACTION_USER_AGENT,
    'X-API-Key': inputs.apiKey
  };
  const requestOptions = inputs.action === 'upsert'
    ? { method: 'PUT', headers, body: JSON.stringify(createPreviewPayload(inputs)) }
    : { method: 'DELETE', headers };
  const { response, body } = await requestJson(fetchFn, url, requestOptions, REQUEST_TIMEOUT_MS);

  if (inputs.action === 'delete' && response.status === 404) {
    return { operationId: '', previewId: '', previewUrl: '', expiresAt: '', status: 'deleted' };
  }

  let result = extractPreviewResult(body);
  if (response.status === 409 && result.operationId) {
    validateOperationState(inputs.action, result.status);
    return waitForOperation({
      fetchFn,
      apiBaseUrl: inputs.apiBaseUrl,
      projectId: inputs.projectId,
      apiKey: inputs.apiKey,
      previewKey: inputs.previewKey,
      operationId: result.operationId,
      action: inputs.action,
      initialResult: result,
      waitTimeout: inputs.waitTimeout,
      sleep,
      now
    });
  }

  if (response.status < 200 || response.status >= 300) {
    throw apiError(inputs.action === 'upsert' ? 'preview' : 'delete', response.status, body);
  }

  if (!result.status && response.status === 204 && inputs.action === 'delete') {
    result = { ...result, status: 'deleted' };
  }

  validateOperationState(inputs.action, result.status);
  if (isSuccessState(inputs.action, result.status)) {
    return result;
  }

  if (!result.operationId) {
    if (inputs.action === 'delete') {
      return { ...result, status: 'deleted' };
    }
    if (result.previewId || result.previewUrl) {
      return { ...result, status: 'available' };
    }
    throw new ActionError('Zenifra did not return a preview operation.', 'invalid_response');
  }

  return waitForOperation({
    fetchFn,
    apiBaseUrl: inputs.apiBaseUrl,
    projectId: inputs.projectId,
    apiKey: inputs.apiKey,
    previewKey: inputs.previewKey,
    operationId: result.operationId,
    action: inputs.action,
    initialResult: result,
    waitTimeout: inputs.waitTimeout,
    sleep,
    now
  });
}

async function writeSummary(activeCore, inputs, result) {
  if (
    !activeCore.summary ||
    typeof activeCore.summary.addHeading !== 'function' ||
    typeof activeCore.summary.addTable !== 'function' ||
    typeof activeCore.summary.write !== 'function'
  ) {
    return;
  }

  const rows = [
    [{ data: 'Chave / Key', header: true }, inputs.previewKey],
    [{ data: 'Ação / Action', header: true }, inputs.action],
    [{ data: 'Status', header: true }, result.status]
  ];
  if (result.previewId) {
    rows.push([{ data: 'ID', header: true }, result.previewId]);
  }
  if (result.previewUrl) {
    rows.push([{ data: 'URL', header: true }, result.previewUrl]);
  }
  if (result.expiresAt) {
    rows.push([{ data: 'Expira em / Expires at', header: true }, result.expiresAt]);
  }

  await activeCore.summary
    .addHeading('Ambiente de Preview / Preview Environment')
    .addTable(rows)
    .write();
}

function setPreviewOutputs(activeCore, result) {
  activeCore.setOutput('preview_id', result.previewId || '');
  activeCore.setOutput('preview_url', result.previewUrl || '');
  activeCore.setOutput('expires_at', result.expiresAt || '');
  activeCore.setOutput('operation_id', result.operationId || '');
  activeCore.setOutput('preview_status', result.status || '');
}

function publicErrorMessage(error) {
  if (error instanceof ActionError) {
    return error.message;
  }
  return 'Could not complete the Zenifra deployment.';
}

async function run(deps = {}) {
  const activeCore = deps.core || core;
  const activeGithub = deps.github || github;
  const fetchFn = deps.fetch || globalThis.fetch;
  const sleep = deps.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = deps.now || (() => Date.now());

  if (typeof fetchFn !== 'function') {
    throw new ActionError('Fetch is not available in this runtime.', 'runtime_error');
  }

  const inputs = readInputs(activeCore, activeGithub);
  if (!inputs.preview) {
    const { response, body } = await requestJson(
      fetchFn,
      `${inputs.apiBaseUrl}/v1/project/${encodePathSegment(inputs.projectId)}/image`,
      {
        method: 'PATCH',
        body: JSON.stringify({ image: inputs.image }),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': ACTION_USER_AGENT,
          'X-API-Key': inputs.apiKey
        }
      },
      REQUEST_TIMEOUT_MS
    );
    if (response.status !== 200) {
      throw apiError('update', response.status, body);
    }
    activeCore.info('Deployment updated successfully.');
    return;
  }

  const result = await runPreview({ inputs, fetchFn, sleep, now });
  setPreviewOutputs(activeCore, result);
  await writeSummary(activeCore, inputs, result);
  activeCore.info(`Preview ${result.status}.`);
}

async function main() {
  try {
    await run();
  } catch (error) {
    core.setFailed(publicErrorMessage(error));
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  ActionError,
  parseBoolean,
  parseDuration,
  parsePreviewAction,
  readInputs,
  resolvePreviewAction,
  run,
  runPreview,
  waitForOperation
};
