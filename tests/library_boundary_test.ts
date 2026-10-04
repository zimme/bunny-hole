import { createConnector } from "../apps/connector/library.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "./assert.ts";

const key = await generateKeyPair();
const credentials = {
  url: "https://hole.example.com/",
  identityPublicKey: key.publicKey,
  enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
  ...key,
};
Deno.test("library rejects invalid executable, transport, CA path and unreadable bundles before authentication", async () => {
  const directory = await Deno.makeTempDir();
  try {
    for (const frpcPath of ["", "bad\0path"]) {
      assertThrows(() => createConnector({ credentials, frpcPath }), /frpcPath/);
    }
    assertThrows(
      () =>
        createConnector({ credentials, frpcPath: "frpc", transport: "tcp" as "wss" }),
      /WSS/,
    );
    for (const trustedCaFile of ["", "bad\0path"]) {
      assertThrows(
        () => createConnector({ credentials, frpcPath: "frpc", trustedCaFile }),
        /CA bundle path/,
      );
    }
    const empty = `${directory}/empty.pem`;
    const invalid = `${directory}/invalid.pem`;
    await Deno.writeTextFile(empty, "");
    await Deno.writeTextFile(invalid, "not PEM");
    for (const path of [directory, empty, invalid, `${directory}/missing`]) {
      await assertRejects(
        () =>
          createConnector({ credentials, frpcPath: "absent", trustedCaFile: path })
            .run(),
        /CA bundle/,
      );
    }
    const controller = new AbortController();
    controller.abort();
    assertEquals(
      await createConnector({ credentials, frpcPath: "absent" }).run(controller.signal),
      0,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
Deno.test("library cleans profiles after spawn failure, unexpected exit and cancellation", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const originalFetch = globalThis.fetch;
  const executable = `${directory}/frpc`;
  const trustedCaFile = `${directory}/ca-certificates.crt`;
  try {
    await Deno.writeTextFile(
      trustedCaFile,
      "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
    );
    globalThis.fetch = (input) =>
      Promise.resolve(
        Response.json(
          String(input).endsWith("challenge")
            ? {
              challengeId: "chl_AAAAAAAAAAAAAAAAAAAAAAAA",
              challenge: "A".repeat(32),
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            }
            : {
              accessToken: "token",
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              descriptor: {
                apiVersion: 1,
                name: "hole.example.com",
                managementUrl: credentials.url,
                connectorHost: "connect.example.com",
                connectorPort: 443,
                connectorTransports: ["wss"],
                identityPublicKey: key.publicKey,
                capabilities: ["http", "https"],
              },
              routes: [],
            },
        ),
      );
    await assertRejects(() =>
      createConnector({
        credentials,
        frpcPath: executable,
        trustedCaFile,
        workingDirectory: directory,
      }).run()
    );
    assertEquals(
      [...Deno.readDirSync(directory)].filter((entry) => entry.isDirectory),
      [],
    );
    await Deno.writeTextFile(executable, "#!/bin/sh\nkill -TERM $$\n", { mode: 0o700 });
    await assertRejects(
      () =>
        createConnector({
          credentials,
          frpcPath: executable,
          trustedCaFile,
          workingDirectory: directory,
        }).run(),
      /SIGTERM/,
    );
    for (const external of [false, true, "stubborn"] as const) {
      const marker = `${directory}/ready`;
      const script = `${directory}/child.ts`;
      await Deno.writeTextFile(
        script,
        `${
          external === "stubborn"
            ? 'Deno.addSignalListener("SIGTERM", () => {});\n'
            : ""
        }await Deno.writeTextFile(${
          JSON.stringify(marker)
        }, String(Deno.pid));\nsetInterval(() => {}, 1000);`,
      );
      await Deno.writeTextFile(
        executable,
        `#!/bin/sh\nexec '${Deno.execPath()}' run --allow-write '${script}'\n`,
      );
      const connector = createConnector({
        credentials,
        frpcPath: executable,
        trustedCaFile,
        workingDirectory: directory,
      });
      const controller = new AbortController();
      const running = connector.run(external === true ? controller.signal : undefined);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          await Deno.stat(marker);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert((await Deno.stat(marker)).isFile);
      if (external === true) controller.abort();
      else connector.stop();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        assertEquals(
          await Promise.race([
            running,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error("library cancellation deadline exceeded")),
                5000,
              );
            }),
          ]),
          0,
        );
      } finally {
        clearTimeout(timeout);
        // Reap only this fixture's owned child if a regression prevents escalation.
        try {
          Deno.kill(Number(await Deno.readTextFile(marker)), "SIGKILL");
        } catch { /* Already stopped. */ }
        await running;
      }
      assertEquals(
        [...Deno.readDirSync(directory)].filter((entry) => entry.isDirectory),
        [],
      );
      await Deno.remove(marker);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});
