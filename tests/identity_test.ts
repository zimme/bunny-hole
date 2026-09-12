import { loadOrCreateIdentity } from "../apps/host/identity.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assertEquals, assertRejects } from "./assert.ts";

Deno.test("host identity is atomic, private, validated, and stable", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/identity.json`;
  const created = await loadOrCreateIdentity(path);
  assertEquals(await loadOrCreateIdentity(path), created);
  if (Deno.build.os !== "windows") {
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  }

  const other = await generateKeyPair();
  await Deno.writeTextFile(
    path,
    JSON.stringify({ publicKey: created.publicKey, privateKey: other.privateKey }),
    { mode: 0o600 },
  );
  await assertRejects(() => loadOrCreateIdentity(path), /does not match/);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(path, 0o644);
    await assertRejects(() => loadOrCreateIdentity(path), /permissions are too broad/);
  }
});
