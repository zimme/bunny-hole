import { assert, assertEquals, assertRejects } from "./assert.ts";
import { bumpProductVersion } from "../scripts/version_bump.ts";
import {
  checkToolchainVersions,
  readProductVersion,
} from "../scripts/version_check.ts";

Deno.test("one version bump updates artifact metadata and rejects invalid or drifting inputs before effects", async () => {
  const root = await Deno.makeTempDir();
  const paths = ["deno.json", "packages/api/mod.ts", "docs/openapi.yaml"];
  try {
    await Deno.mkdir(`${root}/packages/api`, { recursive: true });
    await Deno.mkdir(`${root}/docs`);
    await Deno.writeTextFile(`${root}/deno.json`, '{"version": "1.0.0-rc.1"}\n');
    await Deno.writeTextFile(
      `${root}/packages/api/mod.ts`,
      'export const VERSION = "1.0.0-rc.1";\n',
    );
    await Deno.writeTextFile(
      `${root}/docs/openapi.yaml`,
      "info:\n  version: 1.0.0-rc.1\n",
    );
    for (const version of ["1.0.0-rc.2", "1.0.0", "1.1.0"]) {
      await bumpProductVersion(version, root);
      assertEquals(await readProductVersion(root), version);
    }
    const before = await Promise.all(
      paths.map((path) => Deno.readTextFile(`${root}/${path}`)),
    );
    for (const version of ["1.1.1", "1.1.0", "1.0.0", "1.1.0-rc.1"]) {
      await assertRejects(() => bumpProductVersion(version, root));
      assertEquals(
        await Promise.all(paths.map((path) => Deno.readTextFile(`${root}/${path}`))),
        before,
      );
    }
    let writes = 0;
    await assertRejects(
      () =>
        bumpProductVersion("1.2.0", root, async (path, source) => {
          writes++;
          if (writes === 2) {
            assertEquals(
              JSON.parse(await Deno.readTextFile(`${root}/deno.json`)).version,
              "1.2.0",
            );
            // Simulate an I/O failure after part of the second file was written.
            await Deno.writeTextFile(path, "partial write");
            throw new Error("injected second-write failure");
          }
          await Deno.writeTextFile(path, source);
        }),
      /version bump failed/,
    );
    assertEquals(writes, 5);
    assertEquals(
      await Promise.all(paths.map((path) => Deno.readTextFile(`${root}/${path}`))),
      before,
    );
    await Deno.writeTextFile(`${root}/docs/openapi.yaml`, "info:\n  version: 2.0.0\n");
    await assertRejects(() => bumpProductVersion("2.0.0", root));
    assertEquals(await Deno.readTextFile(`${root}/deno.json`), before[0]);
    assertEquals(await Deno.readTextFile(`${root}/packages/api/mod.ts`), before[1]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("toolchain validation enforces machine mirrors without duplicated prose pins", async () => {
  const root = await Deno.makeTempDir();
  const paths = [
    ".tool-versions",
    "Dockerfile",
    ".devcontainer/Dockerfile",
    "compose.yaml",
    ".github/workflows/ci.yml",
    "templates/bunny-deployment/.terraform-version",
    "templates/bunny-deployment/terraform/versions.tf",
    "templates/bunny-deployment/.github/workflows/check.yml",
    "templates/bunny-deployment/.github/workflows/plan.yml",
    "templates/bunny-deployment/.github/workflows/apply.yml",
  ];
  try {
    for (const path of paths) {
      await Deno.mkdir(
        `${root}/${path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."}`,
        { recursive: true },
      );
      await Deno.writeTextFile(`${root}/${path}`, await Deno.readTextFile(path));
    }
    await checkToolchainVersions(root);
    for (
      const [path, pattern] of [
        [".github/workflows/ci.yml", /deno-version: \S+/],
        ["compose.yaml", /NPM_VERSION: "[^"]+"/],
        [
          "templates/bunny-deployment/.github/workflows/check.yml",
          /terraform_version: \S+/,
        ],
        [
          "templates/bunny-deployment/.github/workflows/plan.yml",
          /terraform_version: \S+/,
        ],
        [
          "templates/bunny-deployment/.github/workflows/apply.yml",
          /terraform_version: \S+/,
        ],
        [".devcontainer/Dockerfile", /ARG NODE_VERSION=\S+/],
      ] as const
    ) {
      const original = await Deno.readTextFile(`${root}/${path}`);
      assert(pattern.test(original));
      await Deno.writeTextFile(
        `${root}/${path}`,
        original.replace(pattern, "removed pin"),
      );
      await assertRejects(() => checkToolchainVersions(root));
      await Deno.writeTextFile(`${root}/${path}`, original);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
