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
  // adopted/TLS values for their bootstrap cases.
  await copyDirectory("templates/bunny-deployment", copiedTemplateDirectory);
  await Deno.writeTextFile(
    `${terraformDirectory}/backend.tf`,
    `terraform {\n  cloud {\n    organization = "consumer-example"\n    workspaces { name = "bunny-hole-production" }\n  }\n}\n`,
  );
  await Deno.writeTextFile(
    `${terraformDirectory}/deployment.auto.tfvars.json`,
    JSON.stringify(
      {
        application_name: "consumer-bunny-hole",
        region: "DE",
        management_hostname: "manage.consumer.example",
        application_hostnames: ["app.consumer.example"],
        connector_hostname: "connect.consumer.example",
        public_pullzone_id: "101",
        public_pullzone_name: "public-generated",
        connector_pullzone_id: "102",
        connector_pullzone_name: "connector-generated",
        image_tag: "0.1.0",
        image_digest: `sha256:${"a".repeat(64)}`,
        owner_public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        enable_hostname_tls: true,
      },
      null,
      2,
    ) + "\n",
  );
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
