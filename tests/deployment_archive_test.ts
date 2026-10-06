import { buildDeploymentArchive } from "../scripts/build_deployment_archive.ts";
import { assert, assertEquals, assertRejects } from "./assert.ts";

Deno.test("released deployment archive is standalone, version-bound and requires candidate consent", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const release = {
      version: "1.0.0-rc.1",
      commit: "a".repeat(40),
      repository: "zimme/bunny-hole",
      hostDigest: `sha256:${"b".repeat(64)}`,
      connectorDigest: `sha256:${"c".repeat(64)}`,
    };
    const archive = await buildDeploymentArchive(release, `${directory}/artifacts`);
    const extraction = await new Deno.Command("tar", {
      args: ["-xzf", archive, "-C", directory],
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(extraction.success);
    const root = `${directory}/bunny-hole-deployment-${release.version}`;
    const metadata = JSON.parse(await Deno.readTextFile(`${root}/release.json`));
    assertEquals(metadata.version, release.version);
    assertEquals(metadata.commit, release.commit);
    assertEquals(metadata.host.digest, release.hostDigest);
    for (
      const path of [
        ".github/workflows/apply.yml",
        ".agents/skills/bunny-hole-setup/SKILL.md",
        "terraform/.terraform.lock.hcl",
        "LICENSE",
        "scripts/test_workflows.py",
      ]
    ) {
      assert((await Deno.stat(`${root}/${path}`)).isFile);
    }
    const setup = await new Deno.Command("bash", {
      args: ["scripts/setup.sh"],
      cwd: root,
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(setup.success);
    const config = JSON.parse(
      await Deno.readTextFile(`${root}/terraform/deployment.auto.tfvars.json`),
    );
    assertEquals(config.image_tag, release.version);
    assertEquals(config.image_digest, release.hostDigest);
    assertEquals(config.allow_release_candidate, false);
    assert(config.owner_public_key.startsWith("REPLACE_WITH"));
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", await Deno.readFile(archive)),
    );
    const digest = [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    assert(
      (await Deno.readTextFile(`${directory}/artifacts/SHA256SUMS`)).includes(digest),
    );
    await assertRejects(() =>
      buildDeploymentArchive(
        { ...release, hostDigest: "latest" },
        `${directory}/invalid`,
      )
    );
    await assertRejects(() => Deno.stat(`${directory}/invalid`));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
