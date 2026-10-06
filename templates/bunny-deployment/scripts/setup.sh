#!/usr/bin/env bash
# Copies public examples only. Existing configuration is never overwritten.
set -euo pipefail
cd "$(dirname "$0")/.."
temporary=''
trap 'if [[ -n "$temporary" ]]; then rm -f -- "$temporary"; fi' EXIT
for name in backend.tf deployment.auto.tfvars.json; do
  destination="terraform/$name"
  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    temporary="$(mktemp "terraform/.bunny-hole-config.XXXXXX")"
    cat "$destination.example" > "$temporary"
    # Atomic no-overwrite creation, including a racing file, directory, or symlink.
    python3 - "$temporary" "$destination" <<'PY'
import os
import sys
os.link(sys.argv[1], sys.argv[2], follow_symlinks=False)
PY
    rm -f -- "$temporary"
    temporary=''
    echo "Created $destination; replace its public configuration markers."
  fi
done
echo 'Keep the four BOOTSTRAP Pull Zone markers until protected bootstrap completes.'
echo 'Before live planning: verify the release digest, private backend, and production environment protections.'
