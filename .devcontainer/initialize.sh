#!/bin/sh
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)

# Compose and the Dev Container CLI both read the workspace .env file. A path-based
# name keeps same-basename Git worktrees in separate Compose projects.
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] &&
  ! grep -Eq '^[[:space:]]*COMPOSE_PROJECT_NAME=' "$repo_dir/.env" 2>/dev/null; then
  path_hash=$(printf '%s' "$repo_dir" | git hash-object --stdin | cut -c 1-12)
  printf '\nCOMPOSE_PROJECT_NAME=bunny-hole-%s\n' "$path_hash" >> "$repo_dir/.env"
fi

# Linked worktrees use a .git pointer to a common directory outside the checkout.
# Mount that directory at its original absolute path so Git checks work in the container.
if ! grep -Eq '^[[:space:]]*BUNNY_HOLE_GIT_COMMON_DIR=' "$repo_dir/.env" 2>/dev/null; then
  git_common_dir=$(git -C "$repo_dir" rev-parse --path-format=absolute --git-common-dir)
  printf '\nBUNNY_HOLE_GIT_COMMON_DIR=%s\n' "$git_common_dir" >> "$repo_dir/.env"
fi

# The cache is shared across worktrees and remains outside each project's lifecycle.
docker volume create bunny-hole-development-deno-cache-v1 >/dev/null
