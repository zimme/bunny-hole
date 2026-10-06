#!/usr/bin/env bash
# Read-only point-in-time guard; branch protection remains necessary.
set -euo pipefail
[[ "$DEFAULT_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]]
[[ "$REVIEWED_COMMIT" =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse HEAD)" = "$REVIEWED_COMMIT"
encoded_branch="$(printf '%s' "$DEFAULT_BRANCH" | jq -sRr @uri)"
remote_default_tip="$(curl --fail-with-body --silent --show-error \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer $GITHUB_TOKEN" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/commits/$encoded_branch" |
  jq -er '.sha')"
[[ "$remote_default_tip" =~ ^[0-9a-f]{40}$ ]]
test "$remote_default_tip" = "$REVIEWED_COMMIT"
