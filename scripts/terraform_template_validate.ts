// cspell:words alltrue toset
import { run } from "./process.ts";

const dataDirectory = await Deno.makeTempDir({
  dir: "/tmp",
  prefix: "bunny-hole-terraform-",
});
const copiedTemplateDirectory = `${dataDirectory}/bunny-deployment`;
const terraformDirectory = `${copiedTemplateDirectory}/terraform`;
const options = { env: { ...Deno.env.toObject(), TF_DATA_DIR: dataDirectory } };

try {
  // Validate the template exactly as a consumer uses it: configuration files are
  // copied into the repository and then Terraform runs without a live backend or
  // Bunny credentials. The test-file variable blocks must override these public
  // adopted/DNS/TLS/consent values for their independent scenarios.
  await copyDirectory("templates/bunny-deployment", copiedTemplateDirectory);
  await Deno.writeTextFile(
    `${terraformDirectory}/backend.tf`,
    `terraform {\n  cloud {\n    organization = "consumer-example"\n    workspaces { name = "bunny-hole-production" }\n  }\n}\n`,
  );
  const consumerInputs = {
    application_name: "consumer-bunny-hole",
    region: "DE",
    management_hostname: "manage.consumer.example",
    application_hostnames: ["app.consumer.example"],
    connector_hostname: "connect.consumer.example",
    public_pullzone_id: "101",
    public_pullzone_name: "public-generated",
    connector_pullzone_id: "102",
    connector_pullzone_name: "connector-generated",
    image_digest: `sha256:${"a".repeat(64)}`,
    owner_public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    enable_hostname_tls: true,
    dns_zone_domain: "consumer.example",
    image_namespace: "consumer",
    image_name: "custom-host",
    volume_size_gb: 3,
    request_timeout_ms: 60000,
    connector_websocket_limit: 1000,
    dns_ttl: 600,
  };
  for (const allowReleaseCandidate of [false, true]) {
    console.log(
      `Copied consumer checks: allow_release_candidate=${allowReleaseCandidate}`,
    );
    const imageTag = allowReleaseCandidate ? "1.0.0-rc.1" : "1.0.0";
    await Deno.writeTextFile(
      `${terraformDirectory}/deployment.auto.tfvars.json`,
      JSON.stringify(
        {
          ...consumerInputs,
          image_tag: imageTag,
          allow_release_candidate: allowReleaseCandidate,
        },
        null,
        2,
      ) + "\n",
    );
    // Unlike the independent scenario fixtures, this full mock plan deliberately
    // inherits auto tfvars and verifies the configured consumer's resulting resources.
    const consumerTest = `${terraformDirectory}/tests/configured_consumer.tftest.hcl`;
    await Deno.writeTextFile(
      consumerTest,
      `
mock_provider "bunnynet" {
  mock_data "bunnynet_compute_container_imageregistry" { defaults = { id = 1 } }
  mock_data "bunnynet_dns_zone" { defaults = { id = 700 } }
}
run "configured_consumer_plan" {
  command = plan
  override_data {
    target = data.bunnynet_pullzone.public_adopted[0]
    values = { id = 101, name = "public-generated" }
  }
  override_data {
    target = data.bunnynet_pullzone.connector_adopted[0]
    values = { id = 102, name = "connector-generated" }
  }
  assert {
    condition = (
      bunnynet_compute_container_app.host.container[0].image_tag == ${
        JSON.stringify(imageTag)
      } &&
      var.allow_release_candidate == ${allowReleaseCandidate} &&
      bunnynet_compute_container_app.host.container[0].image_namespace == "consumer" &&
      bunnynet_compute_container_app.host.container[0].image_name == "custom-host" &&
      bunnynet_compute_container_app.host.container[0].image_digest == ${
        JSON.stringify(consumerInputs.image_digest)
      } &&
      bunnynet_compute_container_app.host.volume[0].size == 3 &&
      { for entry in bunnynet_compute_container_app.host.container[0].env : entry.name => entry.value }["BUNNY_HOLE_REQUEST_TIMEOUT_MS"] == "60000"
    )
    error_message = "consumer runtime image, consent and capacity must come from auto tfvars."
  }
  assert {
    condition = (
      bunnynet_pullzone.public.name == "public-generated" &&
      bunnynet_pullzone.connector.name == "connector-generated" &&
      terraform_data.pullzone_adoption.input.public_id == "101" &&
      terraform_data.pullzone_adoption.input.connector_id == "102" &&
      data.bunnynet_pullzone.public_adopted[0].id == 101 &&
      data.bunnynet_pullzone.connector_adopted[0].id == 102 &&
      bunnynet_pullzone.connector.websockets_max_connections == 1000
    )
    error_message = "consumer adoption identities and connector capacity must reach the plan."
  }
  assert {
    condition = (
      toset(keys(bunnynet_pullzone_hostname.public)) == toset(["manage.consumer.example", "app.consumer.example"]) &&
      bunnynet_pullzone_hostname.connector[0].name == "connect.consumer.example" &&
      alltrue([for hostname in bunnynet_pullzone_hostname.public : hostname.tls_enabled && hostname.force_ssl]) &&
      bunnynet_pullzone_hostname.connector[0].tls_enabled &&
      bunnynet_pullzone_hostname.connector[0].force_ssl &&
      data.bunnynet_dns_zone.existing[0].domain == "consumer.example" &&
      length(bunnynet_dns_record.pullzone) == 3 &&
      alltrue([for record in bunnynet_dns_record.pullzone : record.ttl == 600])
    )
    error_message = "consumer exact DNS, TLS and TTL settings must reach the plan."
  }
}
`,
    );
    await run("terraform", ["fmt", consumerTest], options);
    await run(
      "terraform",
      ["-chdir=" + terraformDirectory, "fmt", "-check", "-recursive"],
      options,
    );
    await run(
      "terraform",
      [
        "-chdir=" + terraformDirectory,
        "init",
        "-backend=false",
        "-input=false",
        "-lockfile=readonly",
      ],
      options,
    );
    await run(
      "terraform",
      ["-chdir=" + terraformDirectory, "validate", "-no-color"],
      options,
    );
    // Mock-provider regression tests exercise optional DNS and bootstrap sentinels
    // without Bunny credentials or any live infrastructure.
    await run(
      "terraform",
      ["-chdir=" + terraformDirectory, "test", "-no-color"],
      options,
    );
  }
} finally {
  await Deno.remove(dataDirectory, { recursive: true });
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDirectory(from, to);
    } else if (entry.isFile) {
      await Deno.writeFile(to, await Deno.readFile(from));
    }
  }
}
