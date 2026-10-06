import { checkDeploymentTemplate } from "./deployment_template_check.ts";

/** Copy the complete validated template into a new directory, without live effects. */
export async function scaffoldDeployment(
  destination: string,
  root = Deno.cwd(),
): Promise<void> {
  if (!destination.trim()) throw new Error("A new destination directory is required");
  const result = await checkDeploymentTemplate(root);
  if (result.failures.length) throw new Error(result.failures.join("\n"));
  // mkdir without recursive is an exclusive claim: existing repositories are untouched.
  await Deno.mkdir(destination);
  try {
    for (const relative of result.files) {
      const source = `${root}/templates/bunny-deployment/${relative}`;
      const target = `${destination}/${relative}`;
      const metadata = await Deno.lstat(source);
      if (!metadata.isFile || metadata.isSymlink) {
        throw new Error(`Template entry is not a regular file: ${relative}`);
      }
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await Deno.copyFile(source, target);
    }
  } catch (error) {
    await Deno.remove(destination, { recursive: true });
    throw error;
  }
}

if (import.meta.main) {
  if (Deno.args.length !== 1) {
    throw new Error("Usage: deno task deployment:scaffold <new-directory>");
  }
  await scaffoldDeployment(Deno.args[0]);
  console.log(
    `Created ${
      Deno.args[0]
    }. Run bash scripts/setup.sh there, then edit the public configuration.`,
  );
}
