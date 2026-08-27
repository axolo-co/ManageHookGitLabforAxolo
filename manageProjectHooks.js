#!/usr/bin/env node

const { runCli } = require('./webhookManager');

// Add the numeric IDs or unencoded paths of the GitLab projects to manage.
const PROJECT_IDS = [
  // 12345678,
  // 'my-group/my-project',
];

if (require.main === module) {
  runCli({ scope: 'project', targetIds: PROJECT_IDS });
}

module.exports = { PROJECT_IDS };
