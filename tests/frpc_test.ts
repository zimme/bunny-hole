import { join } from "node:path";
import {
  defaultTrustedCaFile,
  runFrpc,
  validateTrustedCaFile,
} from "../apps/connector/frpc.ts";
import type { Session } from "../apps/connector/client.ts";
import { assert, assertEquals, assertRejects } from "./assert.ts";

const session: Session = {
  enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
  accessToken: "short-lived-token",
  expiresAt: "2030-01-01T00:00:00.000Z",
  descriptor: {
    apiVersion: 1,
    name: "hole.example.com",
    managementUrl: "https://hole.example.com/",
    connectorHost: "connect.example.com",
    connectorPort: 443,
    connectorTransports: ["wss"],
    identityPublicKey: "identity",
    capabilities: ["http"],
  },
  routes: [],
};

Deno.test("WSS trusted CA validation fails closed before FRP starts", async () => {
  const directory = await Deno.makeTempDir();
  const trustedCaFile = `${directory}/ca-certificates.crt`;
  try {
    await assertRejects(
      () => validateTrustedCaFile(`${directory}/missing.pem`),
      /trusted CA bundle is unreadable/,
    );
    await assertRejects(() => validateTrustedCaFile(directory), /unreadable/);
    await Deno.writeTextFile(`${directory}/empty.pem`, "");
    await assertRejects(
      () => validateTrustedCaFile(`${directory}/empty.pem`),
      /unreadable/,
    );
    await assertRejects(
      () =>
        runFrpc({
          executable: `${directory}/missing-frpc`,
          session,
          transport: "wss",
          trustedCaFile: `${directory}/empty.pem`,
        }),
      /trusted CA bundle is unreadable/,
    );
    await Deno.writeTextFile(trustedCaFile, "not a certificate\n");
    await assertRejects(
      () => validateTrustedCaFile(trustedCaFile),
      /not a PEM certificate bundle/,
    );
    await Deno.writeTextFile(
      trustedCaFile,
      "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
    );
    assertEquals(await validateTrustedCaFile(trustedCaFile), trustedCaFile);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("FRPC uses the explicit CA environment override or the executable sibling", () => {
  const executable = "/opt/bunny-hole/frpc";
  const previous = Deno.env.get("BUNNY_HOLE_TRUSTED_CA_FILE");
  try {
    Deno.env.delete("BUNNY_HOLE_TRUSTED_CA_FILE");
    assertEquals(
      defaultTrustedCaFile(executable),
      "/opt/bunny-hole/ca-certificates.crt",
    );
    Deno.env.set("BUNNY_HOLE_TRUSTED_CA_FILE", "/private/roots.pem");
    assertEquals(defaultTrustedCaFile(executable), "/private/roots.pem");
  } finally {
    if (previous === undefined) Deno.env.delete("BUNNY_HOLE_TRUSTED_CA_FILE");
    else Deno.env.set("BUNNY_HOLE_TRUSTED_CA_FILE", previous);
  }
});

Deno.test("FRPC writes a verified-WSS profile and propagates its process status", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const certificate = join(directory, "ca-certificates.crt");
  const executable = join(directory, "fake-frpc");
  const captured = join(directory, "captured.toml");
  try {
    await Deno.writeTextFile(
      certificate,
      "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
    );
    await Deno.writeTextFile(
      executable,
      `#!/bin/sh\ncp "$2" "${captured}"\nexit 7\n`,
      { mode: 0o700 },
    );
    assertEquals(
      await runFrpc({
        executable,
        session,
        transport: "wss",
        trustedCaFile: certificate,
      }),
      7,
    );
    const profile = await Deno.readTextFile(captured);
    assert(
      profile.includes(`transport.tls.trustedCaFile = ${JSON.stringify(certificate)}`),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("FRPC cancellation terminates a running subprocess", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const certificate = join(directory, "ca-certificates.crt");
  const executable = join(directory, "waiting-frpc");
  const captured = join(directory, "captured.toml");
  const controller = new AbortController();
  try {
    await Deno.writeTextFile(
      certificate,
      "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
    );
    await Deno.writeTextFile(
      executable,
      `#!/bin/sh\ncp "$2" "${captured}"\nwhile :; do sleep 1; done\n`,
      { mode: 0o700 },
    );
    const running = runFrpc({
      executable,
      session,
      transport: "wss",
      trustedCaFile: certificate,
      signal: controller.signal,
    });
    await waitForFile(captured);
    controller.abort();
    assert(typeof await running === "number");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("fake FRPC did not start");
}
