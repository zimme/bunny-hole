import { run } from "./process.ts";
import { readProductVersion } from "./version_check.ts";
import { assertPublicationContext } from "./publication_context.ts";

export async function publishPackage(
  version: string,
  get: (name: string) => string | undefined,
  effects = { fetch, run },
): Promise<void> {
  // Reject invalid identity before registry requests or publication effects.
  assertPublicationContext(version, get);
  const response = await effects.fetch(
    `https://jsr.io/@zimme/bunny-hole/${version}/meta.json`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  await response.body?.cancel();
  if (response.status === 404) {
    await effects.run("deno", ["publish"]);
  } else if (!response.ok) {
    throw new Error(`registry check failed with HTTP ${response.status}`);
  } else {
    console.log(`JSR @zimme/bunny-hole@${version} already exists; skipping`);
  }
}

if (import.meta.main) {
  const version = Deno.env.get("RELEASE_TAG")?.trim();
  if (!version || version !== await readProductVersion()) {
    throw new Error("RELEASE_TAG must match the product version");
  }
  await publishPackage(version, (name) => Deno.env.get(name));
}
