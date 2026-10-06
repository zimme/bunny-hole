#!/usr/bin/env bash
# Public configuration only; this check never contacts Bunny or the backend.
set -euo pipefail
test -f terraform/backend.tf
test -f terraform/deployment.auto.tfvars.json
[[ "$OPERATION" == bootstrap || "$OPERATION" == apply ]]
markers=''
if markers="$(grep -Roh 'REPLACE_WITH[A-Za-z0-9_]*' terraform/backend.tf terraform/deployment.auto.tfvars.json)"; then
  :
else
  grep_status=$?
  if (( grep_status > 1 )); then
    echo 'Unable to inspect deployment marker files; refusing to continue.' >&2
    exit 1
  fi
fi
invalid_marker=0
while IFS= read -r marker; do
  [[ -z "$marker" ]] && continue
  case "$marker" in
    REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID|REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_NAME|REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID|REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_NAME)
      if [[ "$OPERATION" != bootstrap ]]; then
        echo "Bootstrap marker $marker is not allowed for operation=$OPERATION." >&2
        invalid_marker=1
      fi
      ;;
    *)
      echo "Unexpected deployment marker $marker." >&2
      invalid_marker=1
      ;;
  esac
done <<< "$markers"
(( invalid_marker == 0 ))
