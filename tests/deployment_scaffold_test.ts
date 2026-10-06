import { assert, assertEquals, assertRejects } from "./assert.ts";
import { scaffoldDeployment } from "../scripts/scaffold_deployment.ts";
import { checkDeploymentTemplate } from "../scripts/deployment_template_check.ts";

Deno.test("deployment scaffold copies the runnable template and preserves consumer edits", async () => {
  const root = await Deno.makeTempDir();
  const destination = `${root}/consumer`;
  try {
    await scaffoldDeployment(destination);
    for (
      const file of [
        ".github/workflows/plan.yml",
        ".github/workflows/apply.yml",
        ".agents/skills/bunny-hole-setup/SKILL.md",
        "terraform/.terraform.lock.hcl",
        "scripts/deployment.sh",
        "scripts/test_workflows.py",
      ]
    ) assert((await Deno.stat(`${destination}/${file}`)).isFile);
    const runSetup = () =>
      new Deno.Command("bash", {
        args: [`${destination}/scripts/setup.sh`],
        cwd: root,
        stdout: "null",
        stderr: "piped",
      }).output();
    assert((await runSetup()).success);
    const publicConfig = `${destination}/terraform/deployment.auto.tfvars.json`;
    assert(
      (await Deno.readTextFile(publicConfig)).includes("REPLACE_WITH_RELEASE_COMVER"),
    );
    await Deno.writeTextFile(publicConfig, '{"region":"DE"}\n');
    assert((await runSetup()).success);
    await assertRejects(() => scaffoldDeployment(destination));
    assertEquals(await Deno.readTextFile(publicConfig), '{"region":"DE"}\n');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("deployment workflow guards reject unsafe effects offline", async () => {
  const result = await new Deno.Command("python3", {
    args: ["templates/bunny-deployment/scripts/test_workflows.py"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
});

Deno.test("deployment policy follows extracted guards and rejects credential overexposure", async () => {
  const root = await Deno.makeTempDir();
  const template = `${root}/templates/bunny-deployment`;
  try {
    await Deno.mkdir(`${root}/templates`);
    await scaffoldDeployment(template);
    for (
      const [file, before, after] of [
        ["scripts/deployment.sh", "bash scripts/verify-tip.sh", "true"],
        [
          "scripts/verify-inputs.sh",
          'if [[ "$OPERATION" != bootstrap ]]; then',
          "if false; then",
        ],
        [
          ".github/workflows/plan.yml",
          '      TF_INPUT: "0"',
          '      TF_INPUT: "0"\n      BUNNYNET_API_KEY: ${{ secrets.BUNNYNET_API_KEY }}',
        ],
      ]
    ) {
      const path = `${template}/${file}`;
      const original = await Deno.readTextFile(path);
      assert(original.includes(before));
      await Deno.writeTextFile(path, original.replace(before, after));
      assert((await checkDeploymentTemplate(root)).failures.length > 0);
      await Deno.writeTextFile(path, original);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
