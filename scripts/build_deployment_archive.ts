import { join } from "node:path";
import { parseReleaseVersion } from "./comver.ts";
import { checkDeploymentTemplate } from "./deployment_template_check.ts";
import { run } from "./process.ts";
import { readProductVersion } from "./version_check.ts";

export interface DeploymentRelease {
  version: string;
  commit: string;
  repository: string;
  hostDigest: string;
  connectorDigest: string;
}

/** Package the independently runnable consumer template with public release facts. */
export async function buildDeploymentArchive(
  release: DeploymentRelease,
  outputDirectory: string,
  root = Deno.cwd(),
): Promise<string> {
  parseReleaseVersion(release.version);
  if (
    !/^[0-9a-f]{40}$/.test(release.commit) ||
    !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(release.repository) ||
    ![release.hostDigest, release.connectorDigest].every((digest) =>
      /^sha256:[0-9a-f]{64}$/.test(digest)
    )
  ) {
    throw new Error(
      "Deployment release requires a canonical commit, repository, and image digests",
    );
  }
  const template = await checkDeploymentTemplate(root);
  if (template.failures.length) throw new Error(template.failures.join("\n"));
  await Deno.mkdir(outputDirectory, { recursive: true });
  const output = await Deno.realPath(outputDirectory);
  const temporary = await Deno.makeTempDir({ prefix: "bunny-hole-deployment-" });
  const name = `bunny-hole-deployment-${release.version}`;
  try {
    const directory = join(temporary, name);
    await Deno.mkdir(directory);
    for (const file of template.files) {
      const target = join(directory, file);
      await Deno.mkdir(join(target, ".."), { recursive: true });
      await Deno.copyFile(join(root, "templates/bunny-deployment", file), target);
    }
    await Deno.copyFile(join(root, "LICENSE"), join(directory, "LICENSE"));
    const [namespace, repositoryName] = release.repository.split("/");
    const configuration = join(
      directory,
      "terraform/deployment.auto.tfvars.json.example",
    );
    const example = JSON.parse(await Deno.readTextFile(configuration));
    Object.assign(example, {
      image_namespace: namespace,
      image_name: `${repositoryName}-host`,
      image_tag: release.version,
      image_digest: release.hostDigest,
      allow_release_candidate: false,
    });
    await Deno.writeTextFile(configuration, JSON.stringify(example, null, 2) + "\n");
    await Deno.writeTextFile(
      join(directory, "release.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          version: release.version,
          commit: release.commit,
          repository: release.repository,
          host: {
            image: `ghcr.io/${release.repository}-host:${release.version}`,
            digest: release.hostDigest,
          },
          connector: {
            image: `ghcr.io/${release.repository}-connector:${release.version}`,
            digest: release.connectorDigest,
          },
        },
        null,
        2,
      ) + "\n",
    );
    const archive = join(output, `${name}.tar.gz`);
    await run("tar", ["-czf", archive, "-C", temporary, name]);
    const checksums: string[] = [];
    for await (const file of Deno.readDir(output)) {
      if (!file.isFile || !file.name.endsWith(".tar.gz")) continue;
      const bytes = await Deno.readFile(join(output, file.name));
      const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
      );
      checksums.push(
        `${
          [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")
        }  ${file.name}`,
      );
    }
    await Deno.writeTextFile(
      join(output, "SHA256SUMS"),
      checksums.sort().join("\n") + "\n",
    );
    return archive;
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
}

if (import.meta.main) {
  const version = Deno.env.get("RELEASE_TAG") ?? "";
  if (version !== await readProductVersion()) {
    throw new Error("Release tag must match product version");
  }
  const archive = await buildDeploymentArchive({
    version,
    commit: Deno.env.get("RELEASE_COMMIT") ?? "",
    repository: Deno.env.get("RELEASE_REPOSITORY") ?? "",
    hostDigest: Deno.env.get("HOST_DIGEST") ?? "",
    connectorDigest: Deno.env.get("CONNECTOR_DIGEST") ?? "",
  }, "dist/release");
  console.log(`Built ${archive}`);
}
