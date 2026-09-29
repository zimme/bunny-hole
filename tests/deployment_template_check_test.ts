import { assert, assertEquals } from "./assert.ts";
import {
  checkDeploymentTemplate,
  containsLikelySecret,
} from "../scripts/deployment_template_check.ts";

Deno.test("deployment template policy accepts a complete safe fixture", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);

  const result = await checkDeploymentTemplate(root);
  assertEquals(result.failures, []);
});

Deno.test("deployment template policy catches unsafe workflow and artifacts", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const template = `${root}/templates/bunny-deployment`;
  await Deno.writeTextFile(
    `${template}/.github/workflows/apply.yml`,
    "on:\n  push:\n\njobs:\n  apply:\n    environment: production\n    steps:\n      - uses: actions/checkout@v4\n",
  );
  await Deno.writeTextFile(`${template}/terraform/terraform.tfstate`, "{}");
  await Deno.writeTextFile(`${template}/terraform/other.tfstate.backup`, "{}");
  await Deno.writeTextFile(`${template}/terraform/crash.123.log`, "crash");
  await Deno.writeTextFile(`${template}/terraform/private.tfvars.json`, "{}");
  await Deno.writeTextFile(`${template}/terraform/local.tfvars`, "{}");
  await Deno.writeTextFile(`${template}/terraform/local.auto.tfvars`, "{}");
  await Deno.writeTextFile(`${template}/bunny-hole-owner.json`, "{}");
  const checkWorkflow = `${template}/.github/workflows/check.yml`;
  await Deno.writeTextFile(
    checkWorkflow,
    (await Deno.readTextFile(checkWorkflow)).replace(
      "pull_request:",
      "pull_request:\n    paths:\n      - terraform/**",
    ),
  );

  const result = await checkDeploymentTemplate(root);
  assert(result.failures.some((failure) => failure.includes("tfstate")));
  assert(result.failures.some((failure) => failure.includes("other.tfstate.backup")));
  assert(result.failures.some((failure) => failure.includes("crash.123.log")));
  assert(result.failures.some((failure) => failure.includes("private.tfvars.json")));
  assert(result.failures.some((failure) => failure.includes("local.tfvars")));
  assert(result.failures.some((failure) => failure.includes("local.auto.tfvars")));
  assert(result.failures.some((failure) => failure.includes("bunny-hole-owner.json")));
  assert(result.failures.some((failure) => failure.includes("path filters")));
  assert(result.failures.some((failure) => failure.includes("not commit-pinned")));
  assert(result.failures.some((failure) => failure.includes("workflow_dispatch")));
});

Deno.test("deployment template policy requires serialized private-key scanning", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const path = `${root}/templates/bunny-deployment/.github/workflows/check.yml`;
  const source = await Deno.readTextFile(path);
  await Deno.writeTextFile(
    path,
    source.replace("privateKey scan pattern {43}", "credential scan"),
  );

  const result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("serialized privateKey values")),
  );
});

Deno.test("deployment template policy detects refresh tokens and scan errors", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const path = `${root}/templates/bunny-deployment/.github/workflows/check.yml`;
  const source = await Deno.readTextFile(path);

  await Deno.writeTextFile(path, source.replace("gh[oprsu]", "gh[opsu]"));
  let result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("GitHub refresh tokens")),
  );

  await Deno.writeTextFile(
    path,
    source.replace("if (( grep_status != 1 )); then", "if false; then"),
  );
  result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) =>
      failure.includes("fail closed on git grep errors")
    ),
  );
});

Deno.test("deployment template policy runs Terraform mock-provider tests", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const path = `${root}/templates/bunny-deployment/.github/workflows/check.yml`;
  const source = await Deno.readTextFile(path);
  await Deno.writeTextFile(
    path,
    source.replace(
      "run: terraform -chdir=terraform test -no-color",
      "run: terraform -chdir=terraform validate -no-color",
    ),
  );

  const result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("mock-provider tests")),
  );
});

Deno.test("deployment template policy requires unfiltered push checks", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const path = `${root}/templates/bunny-deployment/.github/workflows/check.yml`;
  const source = await Deno.readTextFile(path);
  await Deno.writeTextFile(
    path,
    source.replace("  push:\n", "  push:\n    branches: [main]\n"),
  );

  const result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) =>
      failure.includes("every consumer default branch")
    ),
  );
});

Deno.test("deployment template policy rejects workflow scan exclusions and input interpolation", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const template = `${root}/templates/bunny-deployment`;
  const check = `${template}/.github/workflows/check.yml`;
  await Deno.writeTextFile(
    check,
    `${await Deno.readTextFile(check)}\n# secret scan ':!*.md'\n`,
  );
  const plan = `${template}/.github/workflows/plan.yml`;
  await Deno.writeTextFile(
    plan,
    (await Deno.readTextFile(plan)).replace(
      '"$OPERATION"',
      '"${{ inputs.operation }}"',
    ),
  );
  const apply = `${template}/.github/workflows/apply.yml`;
  await Deno.writeTextFile(
    apply,
    (await Deno.readTextFile(apply)).replace(
      "${{ github.event.repository.default_branch }}",
      "${{ inputs.reviewed_commit }}",
    ),
  );

  const result = await checkDeploymentTemplate(root);
  assert(result.failures.some((failure) => failure.includes("include Markdown")));
  assert(result.failures.some((failure) => failure.includes("safely bind")));
  assert(
    result.failures.some((failure) => failure.includes("reviewed immutable commit")),
  );
});

Deno.test("deployment template policy allows the intended public tfvars file", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const template = `${root}/templates/bunny-deployment`;
  await Deno.writeTextFile(
    `${template}/terraform/deployment.auto.tfvars.json`,
    JSON.stringify({ region: "de", owner_public_key: "public" }),
  );

  const result = await checkDeploymentTemplate(root);
  assertEquals(result.failures, []);
});

Deno.test("deployment template policy allows only documented tfvars examples", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const template = `${root}/templates/bunny-deployment`;
  await Deno.writeTextFile(
    `${template}/terraform/undocumented.tfvars.example`,
    'region = "de"\n',
  );

  const result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("undocumented.tfvars.example")),
  );
});

Deno.test("deployment template policy parses the protected job environment exactly", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const plan = `${root}/templates/bunny-deployment/.github/workflows/plan.yml`;
  const original = await Deno.readTextFile(plan);

  await Deno.writeTextFile(
    plan,
    original.replace("    environment: production", "    # environment: production"),
  );
  let result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) =>
      failure.includes("protected production environment")
    ),
  );

  await Deno.writeTextFile(
    plan,
    original.replace("    environment: production", "    environment: production-eu"),
  );
  result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) =>
      failure.includes("protected production environment")
    ),
  );
});

Deno.test("deployment template policy requires apply integrity guards", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const apply = `${root}/templates/bunny-deployment/.github/workflows/apply.yml`;
  const original = await Deno.readTextFile(apply);

  await Deno.writeTextFile(
    apply,
    original.replaceAll("curl --fail-with-body", "curl --silent"),
  );
  let result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("remote default-branch tip")),
  );

  await Deno.writeTextFile(
    apply,
    original.replaceAll('state_id" != "$endpoint_id"', 'state_id" == "$endpoint_id"'),
  );
  result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("Pull Zone adoption")),
  );
});

Deno.test("deployment template policy protects bootstrap marker modes", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const apply = `${root}/templates/bunny-deployment/.github/workflows/apply.yml`;
  const original = await Deno.readTextFile(apply);

  await Deno.writeTextFile(
    apply,
    original.replaceAll(
      "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID",
      "REPLACE_WITH_UNEXPECTED_VALUE",
    ),
  );
  const result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("marker guard")),
  );
});

Deno.test("deployment template policy requires non-bootstrap marker rejection", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const plan = `${root}/templates/bunny-deployment/.github/workflows/plan.yml`;
  const original = await Deno.readTextFile(plan);

  await Deno.writeTextFile(
    plan,
    original.replaceAll(
      'if [[ "$OPERATION" != bootstrap ]]; then',
      'if [[ "$OPERATION" == bootstrap ]]; then',
    ),
  );
  const result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("marker guard")),
  );
});

Deno.test("deployment template policy targets only the host on bootstrap retry", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const plan = `${root}/templates/bunny-deployment/.github/workflows/plan.yml`;
  const source = await Deno.readTextFile(plan);
  await Deno.writeTextFile(
    plan,
    source.replaceAll(
      "-target=bunnynet_compute_container_app.host",
      "-target=bunnynet_pullzone.public",
    ),
  );

  const result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("bootstrap retry plan")),
  );
});

Deno.test("deployment template policy requires numeric Pull Zone state IDs", async () => {
  const root = await fixtureRoot();
  await writeFixture(root);
  const apply = `${root}/templates/bunny-deployment/.github/workflows/apply.yml`;
  const source = await Deno.readTextFile(apply);
  await Deno.writeTextFile(
    apply,
    source.replaceAll("^[1-9][0-9]*$", "^[^[:space:]]+$"),
  );

  const result = await checkDeploymentTemplate(root);
  assert(
    result.failures.some((failure) => failure.includes("Pull Zone adoption")),
  );
});

Deno.test("secret detector accepts references and rejects material", () => {
  const apiKeyName = ["BUNNYNET", "API", "KEY"].join("_");
  assertEquals(
    containsLikelySecret(`${apiKeyName}: \${{ secrets.${apiKeyName} }}`),
    false,
  );
  assertEquals(
    containsLikelySecret(["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")),
    true,
  );
  assertEquals(
    containsLikelySecret(`${apiKeyName}=plain-${"secret"}-value-123456`),
    true,
  );
  assertEquals(
    containsLikelySecret(`${apiKeyName}=\"quoted-secret-value-123456\"`),
    true,
  );
  assertEquals(
    containsLikelySecret(`${apiKeyName}: '\${{ secrets.${apiKeyName} }}'`),
    false,
  );
  assertEquals(
    containsLikelySecret(JSON.stringify({ privateKey: "A".repeat(43) })),
    true,
  );
  assertEquals(
    containsLikelySecret(JSON.stringify({ privateKey: "A".repeat(42) })),
    false,
  );
  const githubPat = `${["github", "pat"].join("_")}_${"A".repeat(30)}`;
  assertEquals(containsLikelySecret(githubPat), true);
});

async function fixtureRoot(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "bunny-deployment-check-" });
}

async function writeFixture(root: string): Promise<void> {
  const template = `${root}/templates/bunny-deployment`;
  const files: Record<string, string> = {
    "AGENTS.md":
      "Read the canonical AGENTS.md before working. Bunny Hole deployment template.",
    ".github/copilot-instructions.md": "Follow ../AGENTS.md for this template.",
    ".agents/skills/bunny-hole-setup/SKILL.md":
      "Read AGENTS.md. Never request credentials or secrets.",
    "README.md":
      "Bunny Hole deployment. Configure WSS and disable caching for dynamic traffic.",
    ".terraform-version": "1.16.2\n",
    "terraform/versions.tf":
      `terraform {\n  required_version = "= 1.16.2"\n  required_providers {\n    bunnynet = { source = "BunnyWay/bunnynet" version = "= 0.18.2" }\n  }\n}`,
    "terraform/variables.tf":
      `variable "region" {}\nvariable "connector_websocket_limit" {}\nvariable "host_image_digest" { validation { condition = can(regex("^sha256:[0-9a-f]{64}$", var.host_image_digest)) } }`,
    "terraform/main.tf":
      `resource "bunnynet_compute_container_app" "this" {\n  regions_required = [var.region]\n  regions_allowed = [var.region]\n  regions_max_allowed = 1\n  autoscaling_min = 1\n  autoscaling_max = 1\n  container { name = "host" image_digest = var.host_image_digest\n    endpoint { name = "connector" port = 7000 }\n    endpoint { name = "management" port = 8080 }\n    startup_probe { path = "/readyz" }\n    readiness_probe { path = "/readyz" }\n    liveness_probe { path = "/healthz" }\n    volume_mount { mount_path = "/var/lib/bunny-hole" }\n  }\n}\nresource "bunnynet_pullzone" "connector" {\n  cache_enabled = false\n  websockets_enabled = true\n  websockets_max_connections = var.connector_websocket_limit\n}\nresource "bunnynet_pullzone" "public" {\n  cache_enabled = false\n  websockets_enabled = false\n}`,
    "terraform/outputs.tf": 'output "safe" { value = "public" }',
    "terraform/backend.tf.example": "terraform { cloud {} }",
    "terraform/tfvars.example":
      'region = "de"\nhost_image_digest = "sha256:replace-with-64-hex-digest"',
    "terraform/.terraform.lock.hcl": "# reviewed provider lock file",
    ".github/workflows/check.yml":
      `name: Check\non:\n  pull_request:\n  push:\njobs:\n  check:\n    steps:\n      - uses: ./local-action\n      - name: Run mock-provider regression tests\n        run: terraform -chdir=terraform test -no-color\n      - name: Scan serialized private keys\n        run: |\n          if matched_files="$(git grep -IlE '(gh[oprsu]|github_pat)_[A-Za-z0-9_]{20,}|privateKey scan pattern {43}')"; then\n            printf '%s\\n' "$matched_files"\n            exit 1\n          else\n            grep_status=$?\n            if (( grep_status != 1 )); then\n              echo 'Credential scan failed; refusing to continue.' >&2\n              exit "$grep_status"\n            fi\n          fi\n`,
    ".github/workflows/plan.yml":
      `name: Plan\non:\n  workflow_dispatch:\njobs:\n  plan:\n    environment: production\n    if: github.ref_name == github.event.repository.default_branch\n    steps:\n      - uses: ./local-action\n        with:\n          ref: \${{ github.event.repository.default_branch }}\n      - name: Produce a reviewable plan\n        env:\n          OPERATION: \${{ inputs.operation }}\n        run: test \"$OPERATION\" && reviewed_plan_sha256=x && git rev-parse HEAD\n`,
    ".github/workflows/apply.yml":
      `name: Apply\non:\n  workflow_dispatch:\n    inputs:\n      confirm:\n        required: true\n      reviewed_commit:\n        required: true\n      reviewed_plan_sha256:\n        required: true\njobs:\n  apply:\n    environment: production\n    if: github.ref_name == github.event.repository.default_branch\n    steps:\n      - uses: ./local-action\n        with:\n          ref: \${{ github.event.repository.default_branch }}\n          persist-credentials: false\n      - name: Apply\n        env:\n          DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}\n          REVIEWED_COMMIT: \${{ inputs.reviewed_commit }}\n        run: |\n          git rev-parse HEAD\n          sha256sum plan\n          remote_default_tip=\"$(git ls-remote --exit-code --refs origin \"refs/heads/$DEFAULT_BRANCH\" | awk 'NR == 1 { print $1 }')\"\n          [[ \"$remote_default_tip\" =~ ^[0-9a-f]{40}$ ]]\n          test \"$remote_default_tip\" = \"$REVIEWED_COMMIT\"\n          terraform -chdir=terraform apply -auto-approve \"$plan_path\"\n          endpoint_id=\"$(terraform -chdir=terraform output -raw bootstrap_public_pullzone_id)\"\n          endpoint_id=\"$(terraform -chdir=terraform output -raw bootstrap_connector_pullzone_id)\"\n          terraform -chdir=terraform state list\n          terraform -chdir=terraform state show -no-color \"$resource\"\n          if [[ \"$state_id\" != \"$endpoint_id\" ]]; then exit 1; fi\n          terraform -chdir=terraform import \"$resource\" \"$endpoint_id\"\n`,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = `${template}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  const planPath = `${template}/.github/workflows/plan.yml`;
  await Deno.writeTextFile(
    planPath,
    `${await Deno.readTextFile(planPath)}
      - name: Verify deployment markers
        env:
          OPERATION: \${{ inputs.operation }}
        run: |
          markers=''
          if markers="$(grep -Roh 'REPLACE_WITH[A-Za-z0-9_]*' terraform/backend.tf terraform/deployment.auto.tfvars.json)"; then :; fi
          invalid_marker=0
          if [[ "$OPERATION" != bootstrap ]]; then invalid_marker=1; fi
          case "$OPERATION" in bootstrap|apply) ;; esac
          case "$marker" in REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID|REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_NAME|REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID|REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_NAME) ;; *) invalid_marker=1 ;; esac
`,
  );
  const markerGuard = [
    "      - name: Verify marker modes",
    "        env:",
    "          OPERATION: ${{ inputs.operation }}",
    "        run: |",
    "          set -euo pipefail",
    "          markers=''",
    "          if markers=\"$(grep -Roh 'REPLACE_WITH[A-Za-z0-9_]*' terraform/backend.tf terraform/deployment.auto.tfvars.json)\"; then :; fi",
    "          invalid_marker=0",
    "          while IFS= read -r marker; do",
    '            case "$marker" in',
    "              REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID|REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_NAME|REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID|REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_NAME)",
    '                if [[ "$OPERATION" != bootstrap ]]; then invalid_marker=1; fi',
    "                ;;",
    "              *) invalid_marker=1 ;;",
    "            esac",
    '          done <<< "$markers"',
    "          (( invalid_marker == 0 ))",
  ].join("\n");
  await Deno.writeTextFile(
    planPath,
    `${await Deno.readTextFile(planPath)}\n${markerGuard}\n`,
  );
  const retryPlan = [
    "      - name: Bootstrap retry target",
    "        run: |",
    "          terraform -chdir=terraform plan -refresh-only \\",
    "            -target=bunnynet_compute_container_app.host \\",
    "            -out=plan",
  ].join("\n");
  await Deno.writeTextFile(
    planPath,
    `${await Deno.readTextFile(planPath)}\n${retryPlan}\n`,
  );
  const applyPath = `${template}/.github/workflows/apply.yml`;
  const applySource = await Deno.readTextFile(applyPath);
  await Deno.writeTextFile(
    applyPath,
    applySource
      .replace(
        "      - name: Apply\n",
        '      - name: Verify deployment markers\n        env:\n          OPERATION: \${{ inputs.operation }}\n        run: |\n          markers="$(grep -Roh \'REPLACE_WITH[A-Za-z0-9_]*\' terraform/backend.tf terraform/deployment.auto.tfvars.json)"\n          invalid_marker=0\n          case "$OPERATION" in bootstrap|apply) ;; esac\n          case "$marker" in REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID|REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_NAME|REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID|REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_NAME) ;; *) invalid_marker=1 ;; esac\n          (( invalid_marker == 0 ))\n      - name: Apply\n',
      )
      .replace(
        "      confirm:\n        required: true",
        "      confirm:\n        description: Enter APPLY\n        required: true",
      )
      .replace(
        '          remote_default_tip="$(git ls-remote --exit-code --refs origin "refs/heads/$DEFAULT_BRANCH" | awk \'NR == 1 { print $1 }\')"',
        '          encoded_branch="$(printf \'%s\' "$DEFAULT_BRANCH" | jq -sRr @uri)"\n          remote_default_tip="$(curl --fail-with-body --silent --show-error --header "Authorization: Bearer $GITHUB_TOKEN" "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/commits/$encoded_branch" | jq -er \'.sha\')"',
      )
      .replace(
        "          DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}",
        "          DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}\n          GITHUB_API_URL: \${{ github.api_url }}",
      )
      .replace(
        "          terraform -chdir=terraform state list",
        '          if printf \'%s\\n\' "$(terraform -chdir=terraform state list)" | grep -Fqx -- "$resource"; then :; fi\\n          terraform -chdir=terraform state list',
      )
      .replace(
        '          terraform -chdir=terraform import "$resource" "$endpoint_id"',
        '          terraform -chdir=terraform import "$resource" "$endpoint_id"\\n          terraform -chdir=terraform output -json bootstrap_handoff | jq -S . >> "$GITHUB_STEP_SUMMARY"',
      ),
  );
  await Deno.writeTextFile(
    applyPath,
    `${await Deno.readTextFile(applyPath)}\n${retryPlan}\n${markerGuard}\n`,
  );
  const adoptionFixture = [
    "      - name: Adoption fixture",
    "        run: |",
    "          terraform -chdir=terraform state list",
    '          if printf \'%s\\n\' "$(terraform -chdir=terraform state list)" | grep -Fqx -- "$resource"; then :; fi',
    '          terraform -chdir=terraform state show -no-color "$resource"',
    '          state_id="$(terraform -chdir=terraform state show -no-color "$resource" | awk \'$1 == "id" && $2 == "=" { value = $3; gsub(/^"/, "", value); gsub(/"$/, "", value); print value }\')"',
    '          [[ "$state_id" =~ ^[1-9][0-9]*$ ]]',
    '          if [[ "$state_id" != "$endpoint_id" ]]; then exit 1; fi',
    '          terraform -chdir=terraform import "$resource" "$endpoint_id"',
    '          terraform -chdir=terraform output -json bootstrap_handoff | jq -S . >> "$GITHUB_STEP_SUMMARY"',
  ].join("\n");
  await Deno.writeTextFile(
    applyPath,
    `${await Deno.readTextFile(applyPath)}\n${adoptionFixture}\n`,
  );
  assert((await Deno.readTextFile(`${template}/README.md`)).includes("WSS"));
}
