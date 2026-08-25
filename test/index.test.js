const assert = require('node:assert/strict');
const { test } = require('node:test');

const actionPath = require.resolve('../index.js');
const corePath = require.resolve('@actions/core');
const githubPath = require.resolve('@actions/github');

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    }
  };
}

function createCore(inputs) {
  const outputs = {};
  const logs = [];
  const summaryRows = [];
  const core = {
    inputs,
    outputs,
    logs,
    summaryRows,
    getInput(name) {
      return this.inputs[name] || '';
    },
    setOutput(name, value) {
      outputs[name] = value;
    },
    info(message) {
      logs.push({ level: 'info', message });
    },
    warning(message) {
      logs.push({ level: 'warning', message });
    },
    error(message) {
      logs.push({ level: 'error', message });
    },
    setFailed(message) {
      this.failed = message;
    },
    summary: {
      addHeading(value) {
        summaryRows.push(['heading', value]);
        return this;
      },
      addTable(value) {
        summaryRows.push(['table', value]);
        return this;
      },
      async write() {
        summaryRows.push(['write']);
      }
    }
  };
  return core;
}

function loadAction() {
  const originalCore = require.cache[corePath];
  const originalGithub = require.cache[githubPath];
  require.cache[corePath] = { id: corePath, filename: corePath, loaded: true, exports: {} };
  require.cache[githubPath] = { id: githubPath, filename: githubPath, loaded: true, exports: {} };
  delete require.cache[actionPath];
  const action = require(actionPath);
  if (originalCore) {
    require.cache[corePath] = originalCore;
  } else {
    delete require.cache[corePath];
  }
  if (originalGithub) {
    require.cache[githubPath] = originalGithub;
  } else {
    delete require.cache[githubPath];
  }
  return action;
}

function context(eventName, payload) {
  return { eventName, payload };
}

async function runWith({ inputs, eventName = 'push', payload = {}, responses }) {
  const core = createCore(inputs);
  const calls = [];
  let responseIndex = 0;
  const fetchMock = async (url, options) => {
    calls.push({ url, options });
    return responses[responseIndex++];
  };
  const action = loadAction();
  await action.run({
    core,
    github: { context: context(eventName, payload) },
    fetch: fetchMock,
    sleep: async () => {}
  });
  return { core, calls };
}

test('keeps the legacy deployment update when PREVIEW is absent', async () => {
  const { core, calls } = await runWith({
    inputs: {
      PROJECT_ID: 'project-123',
      API_KEY: 'secret-key',
      IMAGE: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    },
    responses: [response(200)]
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.zenifra.com/v1/project/project-123/image');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), { image: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
  assert.equal(calls[0].options.headers['X-API-Key'], 'secret-key');
  assert.deepEqual(core.outputs, {});
  assert.equal(core.summaryRows.length, 0);
});

test('uses a configured API base URL for a legacy deployment', async () => {
  const { calls } = await runWith({
    inputs: {
      API_BASE_URL: 'https://api-stg.example.test',
      PROJECT_ID: 'project-123',
      API_KEY: 'secret-key',
      IMAGE: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    },
    responses: [response(200)]
  });

  assert.equal(calls[0].url, 'https://api-stg.example.test/v1/project/project-123/image');
});

test('rejects an API base URL with a path before network access', async () => {
  const core = createCore({
    API_BASE_URL: 'https://api-stg.example.test/v1',
    PROJECT_ID: 'project-123',
    API_KEY: 'secret-key',
    IMAGE: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  });
  const action = loadAction();
  let fetchCalled = false;

  await assert.rejects(
    action.run({
      core,
      github: { context: context('push', {}) },
      fetch: async () => {
        fetchCalled = true;
        return response(500);
      }
    }),
    /API_BASE_URL must contain only the API origin/
  );
  assert.equal(fetchCalled, false);
});

test('upserts a stable PR preview and publishes outputs only after availability', async () => {
  const { core, calls } = await runWith({
    inputs: {
      PROJECT_ID: 'project-123',
      API_KEY: 'secret-key',
      IMAGE: 'registry.example/app:pr-42',
      PREVIEW: 'true',

      PREVIEW_TTL: '24h',
      WAIT_TIMEOUT: '1s'
    },
    eventName: 'pull_request',
    payload: { action: 'synchronize', pull_request: { number: 42 } },
    responses: [
      response(202, {
        status: 'accepted',
        data: { operation: { operation_id: 'operation-1', status: 'accepted' } }
      }),
      response(200, {
        status: 'success',
        data: {
          operation: { operation_id: 'operation-1', status: 'available' },
          preview: {
            id: 'preview-1',
            url: 'https://preview.example/preview-1',
            expires_at: '2026-08-25T00:00:00Z'
          }
        }
      })
    ]
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    'https://api.zenifra.com/v1/project/project-123/preview-environments/pr-42'
  );
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    image: 'registry.example/app:pr-42',
    inherit_envs: true,
    ttl_hours: 24,
    source: {
      provider: 'github_action',
      event: 'pull_request',
      pull_request_number: 42
    }
  });
  assert.equal(calls[1].url, `${calls[0].url}/operations/operation-1`);
  assert.deepEqual(core.outputs, {
    project_id: 'project-123',
    preview_key: 'pr-42',
    preview_ttl: '24h',
    preview_id: 'preview-1',
    preview_url: 'https://preview.example/preview-1',
    expires_at: '2026-08-25T00:00:00Z',
    operation_id: 'operation-1',
    preview_status: 'available'
  });
  assert.ok(core.logs.some(({ message }) => message.includes('Preview available. Project ID: project-123. Preview key: pr-42. Status: available. URL: https://preview.example/preview-1. Lifetime: 24h. Expires at: 2026-08-25T00:00:00Z. Operation ID: operation-1.')));
  assert.equal(core.summaryRows.at(-1)[0], 'write');
  assert.ok(core.summaryRows.some(([kind, value]) => kind === 'table' && JSON.stringify(value).includes('preview-1')));
});

test('deletes a closed PR preview without requiring an image', async () => {
  const { core, calls } = await runWith({
    inputs: {
      PROJECT_ID: 'project-123',
      API_KEY: 'secret-key',
      PREVIEW: 'true'
    },
    eventName: 'pull_request',
    payload: { action: 'closed', pull_request: { number: 42 } },
    responses: [
      response(202, { operation_id: 'operation-delete', status: 'deleting' }),
      response(200, { operation_id: 'operation-delete', status: 'deleted' })
    ]
  });

  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.zenifra.com/v1/project/project-123/preview-environments/pr-42');
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(core.outputs, {
    project_id: 'project-123',
    preview_key: 'pr-42',
    preview_ttl: '',
    preview_id: '',
    preview_url: '',
    expires_at: '',
    operation_id: 'operation-delete',
    preview_status: 'deleted'
  });
  assert.equal(core.summaryRows.at(-1)[0], 'write');
});

test('treats a missing preview as a successful idempotent delete', async () => {
  const { core, calls } = await runWith({
    inputs: {
      PROJECT_ID: 'project-123',
      API_KEY: 'secret-key',
      PREVIEW: 'true',
      PREVIEW_KEY: 'manual-preview',
      PREVIEW_ACTION: 'delete'
    },
    responses: [response(404, { code: 'preview_not_found', message: 'private implementation detail' })]
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(core.outputs.preview_status, 'deleted');
  assert.equal(core.outputs.operation_id, '');
  assert.equal(core.summaryRows.at(-1)[0], 'write');
});

test('requires an explicit key for preview actions outside pull requests before network access', async () => {
  const core = createCore({
    PROJECT_ID: 'project-123',
    API_KEY: 'secret-key',
    IMAGE: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    PREVIEW: 'true'
  });
  const action = loadAction();
  let fetchCalled = false;

  await assert.rejects(
    action.run({
      core,
      github: { context: context('workflow_dispatch', {}) },
      fetch: async () => {
        fetchCalled = true;
        return response(500);
      }
    }),
    /PREVIEW_KEY is required outside pull_request context/
  );
  assert.equal(fetchCalled, false);
});

test('fails when an upsert reaches an incompatible terminal state', async () => {
  const core = createCore({
    PROJECT_ID: 'project-123',
    API_KEY: 'secret-key',
    IMAGE: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    PREVIEW: 'true',
    PREVIEW_KEY: 'manual-preview'
  });
  const action = loadAction();

  await assert.rejects(
    action.run({
      core,
      github: { context: context('workflow_dispatch', {}) },
      fetch: async (url, options) => {
        if (options.method === 'PUT') {
          return response(202, { operation_id: 'operation-1', status: 'accepted' });
        }
        return response(200, { operation_id: 'operation-1', status: 'deleted' });
      },
      sleep: async () => {}
    }),
    /preview did not become available/
  );
  assert.deepEqual(core.outputs, {});
  assert.equal(core.summaryRows.length, 0);
});

test('auto upserts a keyed preview outside pull requests with safe defaults', async () => {
  const { core, calls } = await runWith({
    inputs: {
      PROJECT_ID: 'project-123',
      API_KEY: 'secret-key',
      IMAGE: 'registry.example/app:manual',
      PREVIEW: 'true',
      PREVIEW_KEY: 'manual-preview'
    },
    eventName: 'workflow_dispatch',
    responses: [response(200, {
      status: 'available',
      preview: {
        id: 'preview-manual',
        url: 'https://preview.example/manual',
        expires_at: '2026-08-25T00:00:00Z'
      }
    })]
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    image: 'registry.example/app:manual',
    inherit_envs: true,
    ttl_hours: 24
  });
  assert.equal(core.outputs.preview_status, 'available');
});

test('recovers from a conflict that returns the active operation', async () => {
  const { core, calls } = await runWith({
    inputs: {
      PROJECT_ID: 'project-123',
      API_KEY: 'secret-key',
      IMAGE: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      PREVIEW: 'true',
      PREVIEW_KEY: 'manual-preview',
      PREVIEW_ACTION: 'upsert',
      WAIT_TIMEOUT: '1s'
    },
    responses: [
      response(409, { code: 'operation_in_progress', operation_id: 'operation-1', status: 'accepted' }),
      response(200, { status: 'available', preview_id: 'preview-1', preview_url: 'https://preview.example/1' })
    ]
  });

  assert.equal(calls.length, 2);
  assert.equal(core.outputs.preview_status, 'available');
});

test('validates preview duration before making a request', async () => {
  const core = createCore({
    PROJECT_ID: 'project-123',
    API_KEY: 'secret-key',
    IMAGE: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    PREVIEW: 'true',
    PREVIEW_KEY: 'manual-preview',
    PREVIEW_TTL: '169h'
  });
  const action = loadAction();
  let fetchCalled = false;

  await assert.rejects(
    action.run({
      core,
      github: { context: context('workflow_dispatch', {}) },
      fetch: async () => {
        fetchCalled = true;
        return response(500);
      }
    }),
    /PREVIEW_TTL is outside the allowed range/
  );
  assert.equal(fetchCalled, false);
});

test('backs off while polling and attaches an abort timeout to each request', async () => {
  const sleeps = [];
  let clock = 0;
  const { calls, core } = await (async () => {
    const localCore = createCore({
      PROJECT_ID: 'project-123',
      API_KEY: 'secret-key',
      IMAGE: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      PREVIEW: 'true',
      PREVIEW_KEY: 'manual-preview',
      WAIT_TIMEOUT: '5s'
    });
    const localCalls = [];
    let responseIndex = 0;
    const action = loadAction();
    await action.run({
      core: localCore,
      github: { context: context('workflow_dispatch', {}) },
      fetch: async (url, options) => {
        localCalls.push({ url, options });
        const bodies = [
          response(202, { operation_id: 'operation-1', status: 'accepted' }),
          response(200, { status: 'provisioning' }),
          response(200, { status: 'available', preview_id: 'preview-1' })
        ];
        return bodies[responseIndex++];
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      now: () => clock
    });
    return { calls: localCalls, core: localCore };
  })();

  assert.deepEqual(sleeps, [1000]);
  assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal));
  assert.equal(core.outputs.preview_status, 'available');
});

test('does not expose unsafe API error details', async () => {
  const core = createCore({
    PROJECT_ID: 'project-123',
    API_KEY: 'secret-key',
    IMAGE: 'registry.example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  });
  const action = loadAction();

  await assert.rejects(
    action.run({
      core,
      github: { context: context('push', {}) },
      fetch: async () => response(500, {
        code: 'internal_failure',
        message: 'private service detail'
      })
    }),
    (error) => {
      assert.match(error.message, /Could not update the project/);
      assert.doesNotMatch(error.message, /private service detail/);
      assert.doesNotMatch(error.message, /secret-key/);
      return true;
    }
  );
});
