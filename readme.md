# Manage GitLab Webhooks for Axolo

This script helps manage GitLab webhooks for Axolo by ensuring that the webhook is active and functioning. If Axolo times out on a webhook that GitLab sends, GitLab may stop sending webhooks altogether. This script checks for failed webhooks and revives them if needed.

## Why This Script Exists

Axolo can sometimes time out on a webhook GitLab sends. If that happens, GitLab will stop sending webhooks altogether. This script helps in reviving the webhook if it sees that it has failed.

## How It Works

1. Fetch all group-level webhooks from GitLab.
2. Filter out the webhooks that match the Axolo URL (`https://api.axolo.co/gitlab/listen`).
3. For each matching webhook, check if it is valid by making a GET request to the GitLab API.
4. If a webhook is invalid, delete the existing one and create a new webhook with the appropriate configuration.
5. If no valid hooks are found, a new one will be created.

## How to Get the Token

You will need an **Owner Group Access Token** from GitLab. This token should have sufficient permissions to manage webhooks at the group level. Follow these steps to create one:

1. Go to your GitLab group settings.
2. Navigate to **Access Tokens**.
3. Create a new token with the required scopes (e.g., `api`, `write_repository`).
4. Replace `ACCESS_TOKEN` in the script with your generated token.

## How to Implement

To ensure this script runs regularly and helps maintain the webhooks, follow these steps:

1. **Schedule the Script**: Run this script every 30 minutes using a cron job, GitHub Actions, or another scheduling tool.
2. **Monitor for Failures**: Set up monitoring to notify you if the script fails. You can log the output to a file or use a notification service.
3. **Replace Group ID**: Update the `GROUP_ID` in the script with your actual GitLab group ID.
4. **Set Access Token**: Replace the `ACCESS_TOKEN` with your GitLab Owner Group Access Token.

## Example Usage

```bash
node manageHooks.js

