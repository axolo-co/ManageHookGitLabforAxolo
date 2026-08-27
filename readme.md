# Manage Axolo GitLab Webhooks

These scripts keep the Axolo webhook present and active at either the GitLab
group or project level. Choose the scope that matches your GitLab setup:

- `manageHooks.js` manages group webhooks.
- `manageProjectHooks.js` manages project webhooks.

> [!IMPORTANT]
> Do not manage both a group and one of its projects unless you intentionally
> want duplicate deliveries. GitLab sends both the group and project webhook
> for the same project event.

## Requirements

- Node.js 18 or newer. There are no npm dependencies to install.
- A GitLab token authorized to manage webhooks:
  - Classic token: the `api` scope.
  - Fine-grained PAT: Webhook `Read`, `Create`, and `Trigger` permissions at the
    project or group boundary being managed.
- For group hooks: GitLab Premium or Ultimate and the Owner role for the group.
- For project hooks: the Maintainer or Owner role for every configured project.

Test-based recovery requires GitLab 17.1 or newer for group hooks and GitLab
16.11 or newer for project hooks. GitLab.com already supports both endpoints.

## 1. Configure the targets

Edit the list at the top of the script you want to run. IDs can be numeric IDs
or unencoded GitLab paths; the script performs the URL encoding.

For groups, edit `GROUP_IDS` in `manageHooks.js`:

```js
const GROUP_IDS = [
  123456,
  'my-company/platform',
];
```

For projects, edit `PROJECT_IDS` in `manageProjectHooks.js`:

```js
const PROJECT_IDS = [
  12345678,
  'my-company/platform/api',
  'my-company/platform/web',
];
```

Use the path as it appears in GitLab. For example, enter
`my-company/platform/api`, not `my-company%2Fplatform%2Fapi`.

## 2. Configure authentication

Keep tokens out of these scripts and out of Git. The simplest setup is to copy
the ignored example file and add your token:

```bash
cp .env.example .env
```

```dotenv
GITLAB_ACCESS_TOKEN=your-token
```

The lowercase `pat` name is also accepted for compatibility:

```dotenv
pat=your-token
```

The scripts load `.env` automatically. You can instead export
`GITLAB_ACCESS_TOKEN`; exported variables take precedence over `.env` values.

For GitLab Self-Managed or GitLab Dedicated, add the API URL:

```dotenv
GITLAB_API_URL=https://gitlab.example.com/api/v4
```

If `GITLAB_API_URL` is not set, the scripts use
`https://gitlab.com/api/v4`.

## 3. Preview and run

Start with a dry run. It reads the current hooks but does not create or test
anything:

```bash
DRY_RUN=true npm run group
DRY_RUN=true npm run projects
```

Then run the scope you configured:

```bash
npm run group
npm run projects
```

You can also invoke the files directly with `node manageHooks.js` or
`node manageProjectHooks.js`.

## What each run does

For every configured target, the script:

1. Reads every page of configured webhooks.
2. Finds the exact Axolo endpoint: `https://api.axolo.co/gitlab/listen`.
3. Creates the webhook with Axolo's event configuration if it is missing.
4. Leaves an executable webhook unchanged.
5. Sends a GitLab merge-request test event to a disabled webhook, then reads it
   again to confirm that GitLab reports it as executable.

New hooks enable confidential issue, deployment, emoji, issue, job, merge
request, comment, pipeline, push, release, tag push, and wiki page events, with
SSL verification enabled.

The scripts never delete webhooks or overwrite an existing webhook's event
configuration. If multiple Axolo webhooks exist on one target, the script warns
and manages only one; remove unwanted duplicates manually.

Requests are processed sequentially. A failure for one group or project does
not prevent later entries from being checked. The process exits with a nonzero
status if the configuration is invalid or any target fails, making it suitable
for cron or CI monitoring.

## Scheduling

Run the appropriate command periodically, for example every 30 minutes. Ensure
the scheduler receives `GITLAB_ACCESS_TOKEN` from its secret store rather than
putting the token in the repository or command itself.

Example cron command after configuring the environment securely:

```cron
*/30 * * * * cd /path/to/ManageHookGitLabforAxolo && /usr/local/bin/npm run projects >> /var/log/axolo-webhooks.log 2>&1
```

Use `npm run group` instead when group-level coverage is desired.

## Verification

Run the automated tests with:

```bash
npm test
```

The tests use mocked GitLab responses and do not contact GitLab or Axolo. A
real dry run with your token is the final verification of IDs, permissions, and
the API URL.

## Troubleshooting

- `No group IDs configured` or `No project IDs configured`: populate the list
  at the top of the corresponding script.
- `GITLAB_ACCESS_TOKEN (or pat) is required`: add the token to `.env` or export
  it in the command or scheduler environment.
- HTTP `401`: the token is missing, expired, or invalid.
- HTTP `403`: the token lacks the required role, classic `api` scope, or
  fine-grained Webhook permission. A full run needs `Read`, `Create`, and
  `Trigger`.
- HTTP `404`: verify the numeric ID/path and ensure the token can see it.
- A test delivery fails: inspect GitLab's webhook recent events and confirm the
  Axolo endpoint is reachable. The script preserves the existing hook and exits
  with an error.

See GitLab's official documentation for the
[group webhook API](https://docs.gitlab.com/api/group_webhooks/),
[project webhook API](https://docs.gitlab.com/api/project_webhooks/), and
[disabled webhook recovery](https://docs.gitlab.com/user/project/integrations/webhooks/#re-enable-disabled-webhooks).
