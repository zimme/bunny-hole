#!/usr/bin/env bash
# Called only by protected default-branch workflows. Never run locally with credentials
# in an agent-controlled terminal. Plan/apply/import each require human authorization.
set -euo pipefail
umask 077
mode="${1:?Expected plan or apply}"
[[ "$mode" == plan || "$mode" == apply ]]
[[ "${OPERATION:?Expected bootstrap or apply}" == bootstrap || "$OPERATION" == apply ]]
if [[ "$mode" == apply ]]; then
  [[ "${REVIEWED_PLAN_SHA256:?Expected reviewed digest}" =~ ^[0-9a-f]{64}$ ]]
fi
# Keep plans and normalized JSON private and ephemeral, never upload either.
plan_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/bunny-hole-plan.XXXXXX")"
trap 'rm -rf "$plan_dir"' EXIT
plan_path="$plan_dir/reviewed.tfplan"
if [[ "$OPERATION" == "bootstrap" ]] && ! terraform -chdir=terraform state show bunnynet_compute_container_app.host >/dev/null 2>&1; then
  echo 'Initial bootstrap is required; this plan contains only the Magic Container app.' >&2
  terraform -chdir=terraform plan -no-color -lock-timeout=5m \
    -target=bunnynet_compute_container_app.host \
    -out="$plan_path"
elif [[ "$OPERATION" == "bootstrap" ]]; then
  echo 'The host exists; refresh-only bootstrap plan will be followed by Pull Zone adoption.' >&2
  terraform -chdir=terraform plan -no-color -lock-timeout=5m \
    -refresh-only \
    -target=bunnynet_compute_container_app.host \
    -out="$plan_path"
else
  if ! terraform -chdir=terraform state show bunnynet_compute_container_app.host >/dev/null 2>&1; then
    echo 'Initial bootstrap is required; run Plan deployment with operation=bootstrap first.' >&2
    exit 1
  fi
  for zone in public connector; do
    terraform -chdir=terraform state show "bunnynet_pullzone.${zone}" >/dev/null 2>&1 || {
      echo "Pull Zone ${zone} is not adopted; run Plan deployment with operation=bootstrap first." >&2
      exit 1
    }
  done
  terraform -chdir=terraform plan -no-color -lock-timeout=5m \
    -out="$plan_path"
fi
terraform -chdir=terraform show -json "$plan_path" |
  jq -S 'del(.timestamp)' > "$plan_dir/reviewed.json"
actual_plan_sha256="$(sha256sum "$plan_dir/reviewed.json" | cut -d ' ' -f1)"
if [[ "$mode" == plan ]]; then
  {
    echo "Reviewed commit: $(git rev-parse HEAD)"
    echo "Reviewed Terraform plan SHA-256: $actual_plan_sha256"
  } | tee -a "${GITHUB_STEP_SUMMARY:?Expected workflow summary}"
  exit 0
fi
test "$actual_plan_sha256" = "$REVIEWED_PLAN_SHA256" || {
  echo 'Plan changed since review; run Plan deployment again and review the new digest.' >&2
  exit 1
}
bash scripts/verify-tip.sh
terraform -chdir=terraform apply -auto-approve "$plan_path"
[[ "$OPERATION" == bootstrap ]] || exit 0

adopt_pullzone() {
  local resource="$1"
  local output_name="$2"
  local endpoint_id state_list state_output state_id

  endpoint_id="$(terraform -chdir=terraform output -raw "$output_name")"
  [[ "$endpoint_id" =~ ^[1-9][0-9]*$ ]] || {
    echo "$output_name did not return one valid Pull Zone ID" >&2
    return 1
  }
  state_list="$(terraform -chdir=terraform state list)" || {
    echo "Unable to inspect Terraform state for $resource; refusing adoption." >&2
    return 1
  }
  if printf '%s\n' "$state_list" | grep -Fqx -- "$resource"; then
    state_output="$(terraform -chdir=terraform state show -no-color "$resource")" || {
      echo "Unable to read Terraform state for $resource; refusing adoption." >&2
      return 1
    }
    state_id="$(printf '%s\n' "$state_output" | awk '$1 == "id" && $2 == "=" { value = $3; gsub(/^"/, "", value); gsub(/"$/, "", value); print value }')"
    [[ "$state_id" =~ ^[1-9][0-9]*$ ]] || {
      echo "Terraform state for $resource has no unambiguous ID; refusing adoption." >&2
      return 1
    }
    if [[ "$state_id" != "$endpoint_id" ]]; then
      echo "Terraform state ID for $resource does not match $output_name; refusing adoption." >&2
      return 1
    fi
    echo "$resource already adopts the endpoint-generated Pull Zone $endpoint_id."
  else
    terraform -chdir=terraform import "$resource" "$endpoint_id"
  fi
}

adopt_pullzone bunnynet_pullzone.public bootstrap_public_pullzone_id
adopt_pullzone bunnynet_pullzone.connector bootstrap_connector_pullzone_id
{
  echo '## Safe bootstrap handoff'
  terraform -chdir=terraform output -json bootstrap_handoff | jq -S .
} >> "$GITHUB_STEP_SUMMARY"
