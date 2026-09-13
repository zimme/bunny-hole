import { run } from "./process.ts";

const terraformDirectory = "templates/bunny-deployment/terraform";
const dataDirectory = await Deno.makeTempDir({
  dir: "/tmp",
  prefix: "bunny-hole-terraform-",
});
const options = { env: { ...Deno.env.toObject(), TF_DATA_DIR: dataDirectory } };

try {
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
} finally {
  await Deno.remove(dataDirectory, { recursive: true });
}
