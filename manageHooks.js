const axios = require('axios');

const GITLAB_API_URL = 'https://gitlab.com/api/v4';
const GROUP_ID = '123456'; // Replace with your group ID
const ACCESS_TOKEN = 'glpat-abcdef'; // Replace with your access token, it should be a Owner Group Access Token

async function getGroupHooks() {
  try {
    const response = await axios.get(`${GITLAB_API_URL}/groups/${GROUP_ID}/hooks`, {
      headers: {
        'Private-Token': ACCESS_TOKEN,
      },
    });
    return response.data; 
  } catch (error) {
    console.error(
      'Error fetching group hooks:',
      error.response ? error.response.data : error.message,
    );
    return null; 
  }
}

async function deleteGroupHook(hook) {
  const response = await axios.delete(
    `${GITLAB_API_URL}/groups/${hook.group_id}/hooks/${hook.id}`, 
    {
      headers: {
        'Private-Token': ACCESS_TOKEN,
      },
    },
  );
  console.log(
    `Hook ID: ${hook.id} has been deleted from group ID: ${hook.group_id}. Status: ${response.status}`,
  );
}

async function createGroupHook(groupId) {
  try {
    const response = await axios.post(
      `${GITLAB_API_URL}/groups/${groupId}/hooks`,
      {
        url: `https://api.axolo.co/gitlab/listen`,
        subgroup_events: true,
        push_events: false,
        tag_push_events: false,
        merge_requests_events: true,
        enable_ssl_verification: true,
        issues_events: true,
        confidential_issues_events: false,
        confidential_notes_events: false,
        note_events: true,
        pipeline_events: true,
        wiki_page_events: false,
        deployment_events: true,
        job_events: true,
        releases_events: true,
        members_events: true,
      },
      {
        headers: {
          'Private-Token': ACCESS_TOKEN,
        },
      },
    );
    console.log(
      `Hook created successfully for group ID: ${groupId}. Response:`,
      response.data,
    );
    return response.data;
  } catch (error) {
    console.error(
      'Error creating group hook:',
      error.response ? error.response.data : error.message,
    );
  }
  return null;
}

async function checkHookValidity(hook) {
  const response = await axios.get(
    `${GITLAB_API_URL}/groups/${hook.group_id}/hooks/${hook.id}`,
    {
      headers: {
        'Private-Token': ACCESS_TOKEN,
      },
    },
  );
  return response.status === 200; /
}

async function processHooks(hooks) {
  const validityChecks = hooks.map(async (hook) => {
    console.log(`Hook ID: ${hook.id}, URL: ${hook.url}`);
    const isValid = await checkHookValidity(hook);
    if (isValid) {
      console.log(`Response for Hook ID is valid: ${hook.id} ${hook.url}`);
    } else {
      console.log(`Hook ID: ${hook.id} is invalid.`);
      await deleteGroupHook(hook);
      await createGroupHook(GROUP_ID);
    }
  });
  await Promise.all(validityChecks);
}

async function main() {
  const hooks = await getGroupHooks(GROUP_ID);
  if (hooks) {
    const filteredHooks = hooks.filter((hook) =>
      hook.url.includes('https://api.axolo.co/gitlab/listen'),
    );
    if (filteredHooks.length > 0) {
      await processHooks(filteredHooks); 
    } else {
      console.log('No valid hooks found creating one.');
      await createGroupHook(GROUP_ID);
    }
  } else {
    console.log('No hooks found or an error occurred.');
  }
}

main();
