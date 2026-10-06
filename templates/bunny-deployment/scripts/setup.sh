#!/usr/bin/env bash
# Copies public examples only. Existing configuration is never overwritten.
set -euo pipefail
cd "$(dirname "$0")/.."
for name in backend.tf deployment.auto.tfvars.json; do
  destination="terraform/$name"
  if [[ ! -e "$destination" ]]; then
    (set -o noclobber; cat "$destination.example" > "$destination")
    echo "Created $destination; replace its public configuration markers."
  fi
done
echo 'Keep the four BOOTSTRAP Pull Zone markers until protected bootstrap completes.'
echo 'Before live planning: verify the release digest, private backend, and production environment protections.'
