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
    "terraform/terraform.tfvars.example":
      'region = "de"\nhost_image_digest = "sha256:replace-with-64-hex-digest"',
    "terraform/.terraform.lock.hcl": "# reviewed provider lock file",
    ".github/workflows/check.yml":
      `name: Check\non:\n  pull_request:\n  push:\njobs:\n  check:\n    steps:\n      - uses: ./local-action\n      - name: Scan serialized private keys\n        run: echo privateKey scan pattern {43}\n`,
    ".github/workflows/plan.yml":
      `name: Plan\non:\n  workflow_dispatch:\njobs:\n  plan:\n    environment: production\n    if: github.ref_name == github.event.repository.default_branch\n    steps:\n      - uses: ./local-action\n        with:\n          ref: \${{ github.event.repository.default_branch }}\n      - name: Produce a reviewable plan\n        env:\n          OPERATION: \${{ inputs.operation }}\n        run: test \"$OPERATION\" && reviewed_plan_sha256=x && git rev-parse HEAD\n`,
    ".github/workflows/apply.yml":
      `name: Apply\non:\n  workflow_dispatch:\n    inputs:\n      confirm:\n        required: true\n      reviewed_commit:\n        required: true\n      reviewed_plan_sha256:\n        required: true\njobs:\n  apply:\n    environment: production\n    if: github.ref_name == github.event.repository.default_branch\n    steps:\n      - uses: ./local-action\n        with:\n          ref: \${{ github.event.repository.default_branch }}\n          confirm: APPLY\n          api_key: \${{ secrets.BUNNYNET_API_KEY }}\n          bootstrap: terraform output -raw bootstrap_public_pullzone_id && terraform output -raw bootstrap_connector_pullzone_id\n          verify: git rev-parse HEAD && sha256sum plan && terraform -chdir=terraform apply -auto-approve \"$plan_path\"\n`,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = `${template}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  assert((await Deno.readTextFile(`${template}/README.md`)).includes("WSS"));
}
