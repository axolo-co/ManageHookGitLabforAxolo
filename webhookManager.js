const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_GITLAB_API_URL = 'https://gitlab.com/api/v4';
const AXOLO_WEBHOOK_URL = 'https://api.axolo.co/gitlab/listen';
const RECOVERY_TRIGGER = 'merge_requests_events';

const COMMON_HOOK_SETTINGS = Object.freeze({
  url: AXOLO_WEBHOOK_URL,
  push_events: true,
  tag_push_events: true,
  merge_requests_events: true,
  enable_ssl_verification: true,
  issues_events: true,
  confidential_issues_events: true,
  confidential_note_events: false,
  note_events: true,
  pipeline_events: true,
  wiki_page_events: true,
  deployment_events: true,
  job_events: true,
  releases_events: true,
  emoji_events: true,
});

const SCOPES = Object.freeze({
  group: {
    resource: 'groups',
    hookSettings: Object.freeze({
      ...COMMON_HOOK_SETTINGS,
      subgroup_events: true,
      member_events: true,
    }),
  },
  project: {
    resource: 'projects',
    hookSettings: COMMON_HOOK_SETTINGS,
  },
});

class GitLabApiError extends Error {
  constructor({ method, url, status, body }) {
    const details = formatResponseBody(body);
    super(
      `GitLab API ${method} ${new URL(url).pathname} returned ${status}${
        details ? `: ${details}` : ''
      }`,
    );
    this.name = 'GitLabApiError';
    this.status = status;
  }
}

function formatResponseBody(body) {
  if (body === null || body === undefined || body === '') return '';
  const value = typeof body === 'string' ? body : JSON.stringify(body);
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function normalizeApiUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`GITLAB_API_URL is not a valid URL: ${value}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('GITLAB_API_URL must use http or https.');
  }

  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function normalizeWebhookUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return String(value).replace(/\/+$/, '');
  }
}

function isAxoloHook(hook) {
  return (
    hook &&
    typeof hook.url === 'string' &&
    normalizeWebhookUrl(hook.url) === normalizeWebhookUrl(AXOLO_WEBHOOK_URL)
  );
}

function isExecutable(hook) {
  if (hook.alert_status === 'executable') return true;

  // Older GitLab versions did not always return alert_status. In that case,
  // the absence of a disabled-until timestamp is the best available signal.
  return hook.alert_status == null && hook.disabled_until == null;
}

function parseDryRun(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function parseEnvFile(contents) {
  const values = {};

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2] || '';
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[key] = value;
  }

  return values;
}

function loadEnvironment({ currentEnv = process.env, envFile = path.join(__dirname, '.env') } = {}) {
  let fileEnv = {};
  if (fs.existsSync(envFile)) {
    fileEnv = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
  }

  // Explicitly exported variables take precedence over local .env values.
  return { ...fileEnv, ...currentEnv };
}

function validateTargetIds(targetIds) {
  if (!Array.isArray(targetIds)) {
    throw new Error('The target ID configuration must be an array.');
  }

  const normalized = targetIds.map((targetId) => String(targetId).trim());
  if (normalized.some((targetId) => targetId.length === 0)) {
    throw new Error('Target IDs cannot be empty strings.');
  }

  return [...new Set(normalized)];
}

function findNextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

function createGitLabClient({ apiUrl, accessToken, fetchImpl }) {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const apiRoot = new URL(`${normalizedApiUrl}/`);

  async function request(pathOrUrl, { method = 'GET', body } = {}) {
    const url = new URL(pathOrUrl, apiRoot);
    if (url.origin !== apiRoot.origin || !url.pathname.startsWith(apiRoot.pathname)) {
      throw new Error(`Refusing to follow a GitLab API link outside ${normalizedApiUrl}.`);
    }

    const headers = {
      Accept: 'application/json',
      'Private-Token': accessToken,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const responseText = await response.text();
    let responseBody = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    }

    if (!response.ok) {
      throw new GitLabApiError({
        method,
        url: url.toString(),
        status: response.status,
        body: responseBody,
      });
    }

    return {
      body: responseBody,
      headers: response.headers,
      status: response.status,
      url,
    };
  }

  async function listHooks(resource, encodedTargetId) {
    const hooks = [];
    let nextUrl = new URL(
      `${resource}/${encodedTargetId}/hooks?per_page=100`,
      apiRoot,
    ).toString();

    while (nextUrl) {
      const response = await request(nextUrl);
      if (!Array.isArray(response.body)) {
        throw new Error('GitLab returned an invalid webhook list response.');
      }
      hooks.push(...response.body);

      const linkUrl = findNextLink(response.headers.get('link'));
      if (linkUrl) {
        nextUrl = linkUrl;
        continue;
      }

      const nextPage = response.headers.get('x-next-page');
      if (nextPage) {
        const nextPageUrl = new URL(response.url);
        nextPageUrl.searchParams.set('page', nextPage);
        nextUrl = nextPageUrl.toString();
      } else {
        nextUrl = null;
      }
    }

    return hooks;
  }

  return { request, listHooks };
}

async function manageTarget({
  client,
  dryRun,
  encodedTargetId,
  logger,
  scope,
  targetId,
}) {
  const scopeConfig = SCOPES[scope];
  const hookBasePath = `${scopeConfig.resource}/${encodedTargetId}/hooks`;
  const hooks = await client.listHooks(scopeConfig.resource, encodedTargetId);
  const axoloHooks = hooks.filter(isAxoloHook).sort((left, right) => left.id - right.id);

  if (axoloHooks.length === 0) {
    if (dryRun) {
      logger.log(`[${scope} ${targetId}] Would create the Axolo webhook.`);
      return 'planned';
    }

    const response = await client.request(hookBasePath, {
      method: 'POST',
      body: scopeConfig.hookSettings,
    });
    logger.log(
      `[${scope} ${targetId}] Created Axolo webhook ${response.body?.id ?? '(unknown ID)'}.`,
    );
    return 'created';
  }

  if (axoloHooks.length > 1) {
    logger.warn(
      `[${scope} ${targetId}] Found ${axoloHooks.length} Axolo webhooks. ` +
        'Only one will be managed; remove duplicates manually to avoid duplicate deliveries.',
    );
  }

  const executableHook = axoloHooks.find(isExecutable);
  if (executableHook) {
    logger.log(
      `[${scope} ${targetId}] Axolo webhook ${executableHook.id} is executable.`,
    );
    return 'healthy';
  }

  const hook = axoloHooks[0];
  if (dryRun) {
    logger.log(
      `[${scope} ${targetId}] Would test disabled Axolo webhook ${hook.id} to re-enable it.`,
    );
    return 'planned';
  }

  await client.request(`${hookBasePath}/${hook.id}/test/${RECOVERY_TRIGGER}`, {
    method: 'POST',
  });

  const refreshedHook = await client.request(`${hookBasePath}/${hook.id}`);
  if (!isExecutable(refreshedHook.body)) {
    throw new Error(
      `Webhook ${hook.id} accepted a test delivery but is still ${
        refreshedHook.body?.alert_status || 'not executable'
      }.`,
    );
  }

  logger.log(`[${scope} ${targetId}] Re-enabled Axolo webhook ${hook.id}.`);
  return 'recovered';
}

async function runWebhookManager({
  scope,
  targetIds,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  if (!SCOPES[scope]) {
    throw new Error(`Unsupported webhook scope: ${scope}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Node.js 18 or newer is required (global fetch is unavailable).');
  }

  const configuredTargetIds = validateTargetIds(targetIds);
  if (configuredTargetIds.length === 0) {
    throw new Error(
      `No ${scope} IDs configured. Add at least one ID to the list at the top of the script.`,
    );
  }

  const accessToken = (env.GITLAB_ACCESS_TOKEN || env.pat)?.trim();
  if (!accessToken) {
    throw new Error('GITLAB_ACCESS_TOKEN (or pat) is required.');
  }

  const dryRun = parseDryRun(env.DRY_RUN);
  const apiUrl = env.GITLAB_API_URL || DEFAULT_GITLAB_API_URL;
  const client = createGitLabClient({ apiUrl, accessToken, fetchImpl });
  const summary = {
    checked: configuredTargetIds.length,
    healthy: 0,
    created: 0,
    recovered: 0,
    planned: 0,
    failed: 0,
    failures: [],
  };

  for (const targetId of configuredTargetIds) {
    try {
      const result = await manageTarget({
        client,
        dryRun,
        encodedTargetId: encodeURIComponent(targetId),
        logger,
        scope,
        targetId,
      });
      summary[result] += 1;
    } catch (error) {
      summary.failed += 1;
      summary.failures.push({ targetId, error });
      logger.error(`[${scope} ${targetId}] ${error.message}`);
    }
  }

  logger.log(
    `Summary: ${summary.checked} checked, ${summary.healthy} healthy, ` +
      `${summary.created} created, ${summary.recovered} recovered, ` +
      `${summary.planned} planned, ${summary.failed} failed.`,
  );
  return summary;
}

async function runCli(options) {
  try {
    const summary = await runWebhookManager({
      ...options,
      env: options.env || loadEnvironment(),
    });
    if (summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  AXOLO_WEBHOOK_URL,
  COMMON_HOOK_SETTINGS,
  SCOPES,
  createGitLabClient,
  findNextLink,
  isAxoloHook,
  isExecutable,
  loadEnvironment,
  manageTarget,
  normalizeWebhookUrl,
  parseEnvFile,
  parseDryRun,
  runCli,
  runWebhookManager,
};
