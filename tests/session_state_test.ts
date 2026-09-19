import {
  bearerToken,
  issueSessionToken,
  verifySessionToken,
} from "../apps/host/session.ts";
import { loadState, saveState, selectHost } from "../apps/connector/state.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assertEquals, assertRejects, assertThrows } from "./assert.ts";

Deno.test("session tokens are signed, bounded, expiring, and context safe", async () => {
  const host = await generateKeyPair();
  const issued = await issueSessionToken(
    host.privateKey,
    "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    1_000,
    5_000,
  );
  assertEquals(
    (await verifySessionToken(host.publicKey, issued.token, 2_000))?.enrollmentId,
    "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
  );
  assertEquals(
    await verifySessionToken(host.publicKey, issued.token, 7_000),
    undefined,
  );
  assertEquals(
    await verifySessionToken(host.publicKey, `${issued.token}.extra`),
    undefined,
  );
  const other = await generateKeyPair();
  assertEquals(
    await verifySessionToken(other.publicKey, issued.token, 2_000),
    undefined,
  );
  assertEquals(
    bearerToken(
      new Request("https://host.test", {
        headers: { authorization: `Bearer ${issued.token}` },
      }),
    ),
    issued.token,
  );
  assertThrows(
    () => bearerToken(new Request("https://host.test")),
    /authentication required/,
  );
});

Deno.test("connector state is permission-restricted and strictly parsed", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/config.json`;
  const host = await generateKeyPair();
  const device = await generateKeyPair();
  const state = {
    version: 1 as const,
    defaultHost: "home",
    hosts: {
      home: {
        url: "https://hole.example.com/",
        identityPublicKey: host.publicKey,
        enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
        ...device,
      },
    },
  };
  await saveState(state, path);
  const loaded = await loadState(path);
  assertEquals(selectHost(loaded)[0], "home");
  if (Deno.build.os !== "windows") {
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    await Deno.chmod(path, 0o644);
    await assertRejects(() => loadState(path), /group or others/);
    await Deno.chmod(path, 0o600);
  }
  await Deno.writeTextFile(path, '{"version":1,"hosts":{"bad":{"url":"x"}}}', {
    mode: 0o600,
  });
  await assertRejects(() => loadState(path), /invalid connector config/);
});
