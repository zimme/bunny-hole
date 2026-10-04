import { loadOrCreateIdentity } from "../apps/host/identity.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assertEquals, assertRejects } from "./assert.ts";

Deno.test("host identity is private, stable and rejects malformed or mismatched files without overwriting", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/identity.json`;
  try {
    const created = await loadOrCreateIdentity(path);
    assertEquals(await loadOrCreateIdentity(path), created);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    }
    for (
      const value of [null, {}, { ...created, publicKey: "AA" }, {
        ...created,
        privateKey: "AA",
      }, { ...created, privateKey: (await generateKeyPair()).privateKey }]
    ) {
      const contents = JSON.stringify(value);
      await Deno.writeTextFile(path, contents, { mode: 0o600 });
      await assertRejects(
        () => loadOrCreateIdentity(path),
        /identity file|does not match/,
      );
      assertEquals(await Deno.readTextFile(path), contents);
    }
    if (Deno.build.os !== "windows") {
      await Deno.chmod(path, 0o644);
      await assertRejects(
        () => loadOrCreateIdentity(path),
        /permissions are too broad/,
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
