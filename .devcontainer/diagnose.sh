#!/usr/bin/env bash
# Best-effort failure evidence. Do not dump container environments or credentials.
set -uo pipefail

collect() {
  printf '\nDiagnostics: %s\n' "$1"
  shift
  timeout 30s "$@" || printf 'Diagnostic command failed or timed out.\n'
}

collect "host memory" free -m
collect "workspace disk" df -h .
collect "development services" docker compose --profile development ps --all

# Inspect only lifecycle fields, rather than the full secret-bearing configuration.
while IFS= read -r container; do
  [ -n "$container" ] || continue
  collect "container lifecycle" docker inspect --format \
    '{{.Name}} status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}' \
    "$container"
done < <(timeout 30s docker compose --profile development ps --all --quiet)

collect "development resource usage" docker compose --profile development stats --no-stream
collect "nested Docker status" docker compose exec -T --user vscode development docker info
collect "nested container lifecycle" docker compose exec -T --user vscode development \
  docker ps --all --format '{{.Names}} {{.Status}}'
collect "nested resource usage" docker compose exec -T --user vscode development \
  docker stats --no-stream
collect "Docker daemon logs" docker compose --profile development logs --no-color --tail 300 docker-engine
