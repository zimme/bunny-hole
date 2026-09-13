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

  const result = await checkDeploymentTemplate(root);
  assert(result.failures.some((failure) => failure.includes("tfstate")));
  assert(result.failures.some((failure) => failure.includes("not commit-pinned")));
  assert(result.failures.some((failure) => failure.includes("workflow_dispatch")));
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
      `name: Check\non:\n  pull_request:\n  push:\njobs:\n  check:\n    steps:\n      - uses: ./local-action\n`,
    ".github/workflows/plan.yml":
      `name: Plan\non:\n  workflow_dispatch:\njobs:\n  plan:\n    environment: production\n    if: github.ref_name == github.event.repository.default_branch\n    steps:\n      - uses: ./local-action\n        with:\n          ref: \${{ github.event.repository.default_branch }}\n`,
    ".github/workflows/apply.yml":
      `name: Apply\non:\n  workflow_dispatch:\n    inputs:\n      confirm:\n        required: true\njobs:\n  apply:\n    environment: production\n    if: github.ref_name == github.event.repository.default_branch\n    steps:\n      - uses: ./local-action\n        with:\n          ref: \${{ github.event.repository.default_branch }}\n          confirm: APPLY\n          api_key: \${{ secrets.BUNNYNET_API_KEY }}\n          bootstrap: terraform output -raw bootstrap_public_pullzone_id && terraform output -raw bootstrap_connector_pullzone_id\n`,
  };
  for (const [path, contents] of Object.entries(files)) {
    const full = `${template}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  assert((await Deno.readTextFile(`${template}/README.md`)).includes("WSS"));
}
