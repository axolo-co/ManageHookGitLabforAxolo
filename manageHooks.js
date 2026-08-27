#!/usr/bin/env node

const { runCli } = require('./webhookManager');

// Add the numeric IDs or unencoded paths of the GitLab groups to manage.
const GROUP_IDS = [
  // 123456,
  // 'my-group',
];

if (require.main === module) {
  runCli({ scope: 'group', targetIds: GROUP_IDS });
}

module.exports = { GROUP_IDS };
