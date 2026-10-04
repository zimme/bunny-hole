import { BunnyHoleClient } from "../apps/connector/client.ts";
import { createConnector } from "../apps/connector/library.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assertEquals, assertRejects, assertThrows } from "./assert.ts";

const identity = await generateKeyPair();
const device = await generateKeyPair();
const descriptor = {
  apiVersion: 1,
  name: "hole.example.com",
  managementUrl: "https://hole.example.com/",
  connectorHost: "connect.example.com",
  connectorPort: 443,
  connectorTransports: ["wss"],
  identityPublicKey: identity.publicKey,
  capabilities: ["http", "https"],
};

Deno.test("client accepts only HTTPS origin URLs outside development mode", () => {
  assertThrows(() => new BunnyHoleClient("http://hole.example.com"), /HTTPS/);
  assertThrows(
    () => new BunnyHoleClient("https://hole.example.com/path"),
    /invalid host URL/,
  );
  assertEquals(
    new BunnyHoleClient("http://127.0.0.1:8080", fetch, true).url.origin,
    "http://127.0.0.1:8080",
  );
  assertThrows(
    () => new BunnyHoleClient("http://hole.example.com", fetch, true),
    /local management hostname/,
  );
  assertThrows(
    () => new BunnyHoleClient("https://hole.example.com", fetch, true),
    /local management hostname/,
  );
});

Deno.test("library connector can run again after stop", async () => {
  const credentials = {
    url: "https://hole.example.com/",
    identityPublicKey: identity.publicKey,
    enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    ...device,
  };
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    requests++;
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    return responder(
      path.endsWith("challenge")
        ? {
          challengeId: "chl_AAAAAAAAAAAAAAAAAAAAAAAA",
          challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
        : {
          accessToken: "token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          descriptor,
          routes: [],
        },
    )(input);
  };
  const directory = await Deno.makeTempDir();
  const trustedCaFile = `${directory}/ca-certificates.crt`;
  await Deno.writeTextFile(
    trustedCaFile,
    "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
  );
  try {
    const connector = createConnector({
      credentials,
      frpcPath: Deno.execPath(),
      workingDirectory: directory,
      stderr: "pipe",
      trustedCaFile,
    });
    connector.stop();
    const firstRun = connector.run();
    await assertRejects(() => connector.run(), /already running/);
    assertEquals(typeof await firstRun, "number");
    assertEquals(typeof await connector.run(), "number");
    assertEquals(requests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("library cancellation aborts either session acquisition request", async () => {
  const directory = await Deno.makeTempDir();
  const trustedCaFile = `${directory}/ca-certificates.crt`;
  await Deno.writeTextFile(
    trustedCaFile,
    "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
  );
  const originalFetch = globalThis.fetch;
  try {
    for (const phase of ["challenge", "session"]) {
      for (const external of [false, true]) {
        let reached: () => void = () => {};
        const pending = new Promise<void>((resolve) => reached = resolve);
        let requestSignal: AbortSignal | undefined;
        globalThis.fetch = (input, init) => {
          const path = new URL(input instanceof Request ? input.url : input).pathname;
          if (phase === "session" && path.endsWith("challenge")) {
            return responder({
              challengeId: "chl_AAAAAAAAAAAAAAAAAAAAAAAA",
              challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            })(input);
          }
          reached();
          requestSignal = init?.signal ?? undefined;
          if (!requestSignal) return Promise.reject(new Error("missing abort signal"));
          const signal = requestSignal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        };
        const connector = createConnector({
          credentials: {
            url: "https://hole.example.com/",
            identityPublicKey: identity.publicKey,
            enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
            ...device,
          },
          frpcPath: Deno.execPath(),
          workingDirectory: directory,
          trustedCaFile,
        });
        const controller = new AbortController();
        const run = connector.run(external ? controller.signal : undefined);
        run.catch(() => {});
        await pending;
        if (external) controller.abort();
        else connector.stop();
        assertEquals(await run, 0);
        assertEquals(requestSignal?.aborted, true);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});

function responder(value: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      }),
    );
}
