const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AXOLO_WEBHOOK_URL,
  parseEnvFile,
  runWebhookManager,
} = require('../webhookManager');

const API_URL = 'https://gitlab.example/api/v4';
const DEFAULT_ENV = Object.freeze({
  GITLAB_ACCESS_TOKEN: 'test-token',
  GITLAB_API_URL: API_URL,
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function createMockFetch(steps) {
  const pendingSteps = [...steps];
  const calls = [];

  const fetchImpl = async (input, options = {}) => {
    const call = {
      url: String(input),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
    };
    calls.push(call);

    const step = pendingSteps.shift();
    assert.ok(step, `Unexpected ${call.method} request to ${call.url}`);
    assert.equal(call.method, step.method || 'GET');
    assert.equal(call.url, step.url);
    assert.equal(call.headers['Private-Token'], 'test-token');
    if (step.inspect) step.inspect(call);
    return jsonResponse(step.body, {
      status: step.status,
      headers: step.headers,
    });
  };

  fetchImpl.calls = calls;
  fetchImpl.assertDone = () => {
    assert.equal(pendingSteps.length, 0, `${pendingSteps.length} mock requests were not made`);
  };
  return fetchImpl;
}

function createLogger() {
  const messages = { log: [], warn: [], error: [] };
  return {
    messages,
    log: (message) => messages.log.push(message),
    warn: (message) => messages.warn.push(message),
    error: (message) => messages.error.push(message),
  };
}

test('rejects missing target IDs and access tokens before making requests', async () => {
  await assert.rejects(
    runWebhookManager({
      scope: 'group',
      targetIds: [],
      env: DEFAULT_ENV,
      fetchImpl: async () => assert.fail('fetch should not be called'),
    }),
    /No group IDs configured/,
  );

  await assert.rejects(
    runWebhookManager({
      scope: 'project',
      targetIds: [123],
      env: {},
      fetchImpl: async () => assert.fail('fetch should not be called'),
    }),
    /GITLAB_ACCESS_TOKEN \(or pat\) is required/,
  );
});

test('parses local env files and supports the lowercase pat alias', async () => {
  const parsed = parseEnvFile(`
    # Local configuration
    pat='test-token'
    GITLAB_API_URL="https://gitlab.example/api/v4"
    DRY_RUN=true # preview only
  `);

  assert.deepEqual(parsed, {
    pat: 'test-token',
    GITLAB_API_URL: 'https://gitlab.example/api/v4',
    DRY_RUN: 'true',
  });

  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/projects/99/hooks?per_page=100`,
      body: [],
    },
  ]);
  const summary = await runWebhookManager({
    scope: 'project',
    targetIds: [99],
    env: parsed,
    fetchImpl,
    logger: createLogger(),
  });

  assert.equal(summary.planned, 1);
  fetchImpl.assertDone();
});

test('creates a group hook with corrected GitLab event field names', async () => {
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/groups/my-group/hooks?per_page=100`,
      body: [],
    },
    {
      method: 'POST',
      url: `${API_URL}/groups/my-group/hooks`,
      body: { id: 41, alert_status: 'executable' },
      inspect(call) {
        const payload = JSON.parse(call.body);
        assert.equal(payload.url, AXOLO_WEBHOOK_URL);
        assert.equal(payload.member_events, true);
        assert.equal(payload.subgroup_events, true);
        assert.equal(payload.confidential_note_events, false);
        assert.equal(payload.confidential_issues_events, true);
        assert.equal(payload.emoji_events, true);
        assert.equal(payload.push_events, true);
        assert.equal(payload.tag_push_events, true);
        assert.equal(payload.wiki_page_events, true);
        assert.equal('members_events' in payload, false);
        assert.equal('confidential_notes_events' in payload, false);
      },
    },
  ]);

  const summary = await runWebhookManager({
    scope: 'group',
    targetIds: ['my-group'],
    env: DEFAULT_ENV,
    fetchImpl,
    logger: createLogger(),
  });

  assert.equal(summary.created, 1);
  assert.equal(summary.failed, 0);
  fetchImpl.assertDone();
});

test('creates a project hook and URL-encodes an unencoded project path', async () => {
  const encodedPath = 'team%2Fproject';
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/projects/${encodedPath}/hooks?per_page=100`,
      body: [{ id: 1, url: 'https://example.com/webhook' }],
    },
    {
      method: 'POST',
      url: `${API_URL}/projects/${encodedPath}/hooks`,
      body: { id: 52, alert_status: 'executable' },
      inspect(call) {
        const payload = JSON.parse(call.body);
        const requestedEvents = [
          'confidential_issues_events',
          'deployment_events',
          'emoji_events',
          'issues_events',
          'job_events',
          'merge_requests_events',
          'note_events',
          'pipeline_events',
          'push_events',
          'releases_events',
          'tag_push_events',
          'wiki_page_events',
          'enable_ssl_verification',
        ];
        for (const field of requestedEvents) assert.equal(payload[field], true, field);
        assert.equal('member_events' in payload, false);
        assert.equal('subgroup_events' in payload, false);
      },
    },
  ]);

  const summary = await runWebhookManager({
    scope: 'project',
    targetIds: ['team/project'],
    env: DEFAULT_ENV,
    fetchImpl,
    logger: createLogger(),
  });

  assert.equal(summary.created, 1);
  assert.equal(summary.failed, 0);
  fetchImpl.assertDone();
});

test('leaves an executable Axolo hook unchanged', async () => {
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/groups/123/hooks?per_page=100`,
      body: [
        {
          id: 7,
          url: `${AXOLO_WEBHOOK_URL}/`,
          alert_status: 'executable',
          disabled_until: null,
        },
      ],
    },
  ]);

  const summary = await runWebhookManager({
    scope: 'group',
    targetIds: [123],
    env: DEFAULT_ENV,
    fetchImpl,
    logger: createLogger(),
  });

  assert.equal(summary.healthy, 1);
  assert.equal(fetchImpl.calls.length, 1);
  fetchImpl.assertDone();
});

test('follows GitLab pagination before deciding whether to create a hook', async () => {
  const nextUrl = `${API_URL}/projects/123/hooks?per_page=100&page=2`;
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/projects/123/hooks?per_page=100`,
      body: [{ id: 1, url: 'https://example.com/webhook' }],
      headers: { Link: `<${nextUrl}>; rel="next"` },
    },
    {
      url: nextUrl,
      body: [
        {
          id: 88,
          url: AXOLO_WEBHOOK_URL,
          alert_status: 'executable',
        },
      ],
    },
  ]);

  const summary = await runWebhookManager({
    scope: 'project',
    targetIds: [123],
    env: DEFAULT_ENV,
    fetchImpl,
    logger: createLogger(),
  });

  assert.equal(summary.healthy, 1);
  assert.equal(summary.created, 0);
  fetchImpl.assertDone();
});

test('recovers a disabled project hook with a test delivery and verifies it', async () => {
  const hook = {
    id: 9,
    url: AXOLO_WEBHOOK_URL,
    alert_status: 'disabled',
    disabled_until: null,
  };
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/projects/321/hooks?per_page=100`,
      body: [hook],
    },
    {
      method: 'POST',
      url: `${API_URL}/projects/321/hooks/9/test/merge_requests_events`,
      status: 201,
      body: { message: '201 Created' },
    },
    {
      url: `${API_URL}/projects/321/hooks/9`,
      body: { ...hook, alert_status: 'executable' },
    },
  ]);

  const summary = await runWebhookManager({
    scope: 'project',
    targetIds: [321],
    env: DEFAULT_ENV,
    fetchImpl,
    logger: createLogger(),
  });

  assert.equal(summary.recovered, 1);
  assert.equal(summary.failed, 0);
  assert.equal(fetchImpl.calls.some((call) => call.method === 'DELETE'), false);
  fetchImpl.assertDone();
});

test('reports a failed recovery without deleting or recreating the hook', async () => {
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/groups/444/hooks?per_page=100`,
      body: [
        {
          id: 10,
          url: AXOLO_WEBHOOK_URL,
          alert_status: 'temporarily_disabled',
        },
      ],
    },
    {
      method: 'POST',
      url: `${API_URL}/groups/444/hooks/10/test/merge_requests_events`,
      status: 502,
      body: { message: 'Hook execution failed' },
    },
  ]);
  const logger = createLogger();

  const summary = await runWebhookManager({
    scope: 'group',
    targetIds: [444],
    env: DEFAULT_ENV,
    fetchImpl,
    logger,
  });

  assert.equal(summary.failed, 1);
  assert.match(logger.messages.error[0], /returned 502/);
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.method),
    ['GET', 'POST'],
  );
  fetchImpl.assertDone();
});

test('fails verification when GitLab still reports the tested hook as disabled', async () => {
  const disabledHook = {
    id: 11,
    url: AXOLO_WEBHOOK_URL,
    alert_status: 'disabled',
  };
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/projects/445/hooks?per_page=100`,
      body: [disabledHook],
    },
    {
      method: 'POST',
      url: `${API_URL}/projects/445/hooks/11/test/merge_requests_events`,
      status: 201,
      body: { message: '201 Created' },
    },
    {
      url: `${API_URL}/projects/445/hooks/11`,
      body: disabledHook,
    },
  ]);
  const logger = createLogger();

  const summary = await runWebhookManager({
    scope: 'project',
    targetIds: [445],
    env: DEFAULT_ENV,
    fetchImpl,
    logger,
  });

  assert.equal(summary.failed, 1);
  assert.match(logger.messages.error[0], /is still disabled/);
  fetchImpl.assertDone();
});

test('dry-run reports a planned creation without sending a POST request', async () => {
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/projects/555/hooks?per_page=100`,
      body: [],
    },
  ]);

  const summary = await runWebhookManager({
    scope: 'project',
    targetIds: [555],
    env: { ...DEFAULT_ENV, DRY_RUN: 'true' },
    fetchImpl,
    logger: createLogger(),
  });

  assert.equal(summary.planned, 1);
  assert.equal(summary.created, 0);
  assert.equal(fetchImpl.calls.length, 1);
  fetchImpl.assertDone();
});

test('dry-run reports disabled-hook recovery without sending a test delivery', async () => {
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/groups/556/hooks?per_page=100`,
      body: [
        {
          id: 12,
          url: AXOLO_WEBHOOK_URL,
          alert_status: 'temporarily_disabled',
        },
      ],
    },
  ]);

  const summary = await runWebhookManager({
    scope: 'group',
    targetIds: [556],
    env: { ...DEFAULT_ENV, DRY_RUN: 'yes' },
    fetchImpl,
    logger: createLogger(),
  });

  assert.equal(summary.planned, 1);
  assert.equal(fetchImpl.calls.length, 1);
  fetchImpl.assertDone();
});

test('warns about duplicate Axolo hooks and does not modify them automatically', async () => {
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/groups/777/hooks?per_page=100`,
      body: [
        { id: 2, url: AXOLO_WEBHOOK_URL, alert_status: 'disabled' },
        { id: 3, url: AXOLO_WEBHOOK_URL, alert_status: 'executable' },
      ],
    },
  ]);
  const logger = createLogger();

  const summary = await runWebhookManager({
    scope: 'group',
    targetIds: [777],
    env: DEFAULT_ENV,
    fetchImpl,
    logger,
  });

  assert.equal(summary.healthy, 1);
  assert.match(logger.messages.warn[0], /Found 2 Axolo webhooks/);
  assert.equal(fetchImpl.calls.length, 1);
  fetchImpl.assertDone();
});

test('continues with later targets and summarizes partial failures', async () => {
  const fetchImpl = createMockFetch([
    {
      url: `${API_URL}/projects/1/hooks?per_page=100`,
      status: 403,
      body: { message: 'Forbidden' },
    },
    {
      url: `${API_URL}/projects/2/hooks?per_page=100`,
      body: [],
    },
    {
      method: 'POST',
      url: `${API_URL}/projects/2/hooks`,
      body: { id: 22, alert_status: 'executable' },
    },
  ]);

  const summary = await runWebhookManager({
    scope: 'project',
    targetIds: [1, 2],
    env: DEFAULT_ENV,
    fetchImpl,
    logger: createLogger(),
  });

  assert.equal(summary.checked, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.failures[0].targetId, '1');
  fetchImpl.assertDone();
});
