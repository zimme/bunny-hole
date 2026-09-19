import type { HostConfig } from "../apps/host/config.ts";
import { Host } from "../apps/host/host.ts";
import { HostStore } from "../apps/host/store.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { LIMITS } from "../packages/api/mod.ts";
import { assertEquals, assertRejects } from "./assert.ts";

const logger = { info() {}, warn() {}, error() {} };

Deno.test("public proxy preserves bodies and strips untrusted headers", async () => {
  const fixture = startFixture();
  const context = await hostContext(fixture.port);
  try {
    const response = await context.host.handle(
      new Request("http://relay.test/echo?x=1", {
        method: "POST",
        headers: {
          host: "home.example.com",
          authorization: "Bearer viewer",
          cookie: "session=viewer",
          connection: "x-smuggle",
          "x-smuggle": "bad",
          "x-forwarded-for": "attacker",
          "x-bunny-hole-secret": "hidden",
        },
        body: new Uint8Array([0, 1, 2, 255]),
      }),
      remoteInfo("192.0.2.10"),
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(response.headers.get("server"), null);
    assertEquals(response.headers.get("x-bunny-hole-leak"), null);
    assertEquals(response.headers.getSetCookie(), ["fixture=ok; HttpOnly"]);
    const value = await response.json();
    assertEquals(value.path, "/echo?x=1");
    assertEquals(value.body, [0, 1, 2, 255]);
    assertEquals(value.headers.authorization, "Bearer viewer");
    assertEquals(value.headers.cookie, "session=viewer");
    assertEquals(value.headers["x-smuggle"], undefined);
    assertEquals(value.headers["x-bunny-hole-secret"], undefined);
    assertEquals(value.headers["x-forwarded-for"], "192.0.2.10");
    assertEquals(value.headers["x-forwarded-host"], "home.example.com");
    assertEquals(value.headers["x-forwarded-proto"], "http");
    assertEquals(
      (await context.host.handle(
        new Request("http://relay.test/", {
          headers: { host: "unknown.example.com" },
        }),
      )).status,
      404,
    );
    assertEquals(
      (await context.host.handle(
        new Request("http://relay.test/", {
          headers: { host: "attacker@home.example.com" },
        }),
      )).status,
      421,
    );
    assertEquals(
      (await context.host.handle(
        new Request(`http://relay.test/?${"x".repeat(LIMITS.maxPathBytes)}`, {
          headers: { host: "home.example.com" },
        }),
      )).status,
      414,
    );
  } finally {
    context.store[Symbol.dispose]();
    await fixture.stop();
  }
});

Deno.test("public proxy enforces concurrency and graceful shutdown", async () => {
  const fixture = startFixture();
  const context = await hostContext(fixture.port);
  try {
    const held: Response[] = [];
    for (let index = 0; index < LIMITS.maxConcurrentRequests; index++) {
      held.push(
        await context.host.handle(
          new Request("http://relay.test/hold", {
            headers: { host: "home.example.com" },
          }),
        ),
      );
    }
    assertEquals(
      (await context.host.handle(
        new Request("http://relay.test/hold", {
          headers: { host: "home.example.com" },
        }),
      )).status,
      503,
    );
    await Promise.all(held.map((response) => response.body?.cancel()));
    const deadline = Date.now() + 2_000;
    while (true) {
      const response = await context.host.handle(
        new Request("http://relay.test/echo", {
          headers: { host: "home.example.com" },
        }),
      );
      if (response.status !== 503) {
        await response.body?.cancel();
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("cancelled requests were not released");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const active = await context.host.handle(
      new Request("http://relay.test/hold", {
        headers: { host: "home.example.com" },
      }),
    );
    const reader = active.body!.getReader();
    assertEquals((await reader.read()).done, false);
    context.host.shutdown();
    await assertRejects(
      () =>
        Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("shutdown did not cancel response")), 500)
          ),
        ]),
    );
    assertEquals(
      (await context.host.handle(
        new Request("http://relay.test/echo", {
          headers: { host: "home.example.com" },
        }),
      )).status,
      503,
    );
  } finally {
    context.store[Symbol.dispose]();
    await fixture.stop();
  }
});

Deno.test("public proxy cancels an origin that exceeds its timeout", async () => {
  const fixture = startFixture();
  const context = await hostContext(fixture.port, 25);
  try {
    const response = await context.host.handle(
      new Request("http://relay.test/wait", {
        headers: { host: "home.example.com" },
      }),
    );
    assertEquals(response.status, 502);
  } finally {
    context.store[Symbol.dispose]();
    await fixture.stop();
  }
});

Deno.test("public proxy exposes an early origin response during upload", async () => {
  const fixture = startFixture();
  const context = await hostContext(fixture.port);
  let requestBody: ReadableStreamDefaultController<Uint8Array> | undefined;
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        requestBody = controller;
        controller.enqueue(new TextEncoder().encode("still-uploading"));
      },
    });
    const response = await Promise.race([
      context.host.handle(
        new Request("http://relay.test/early", {
          method: "POST",
          headers: { host: "home.example.com" },
          body,
        }),
        remoteInfo("192.0.2.4"),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("early response was blocked")), 500)
      ),
    ]);
    assertEquals(response.status, 202);
    assertEquals(await response.text(), "early");
  } finally {
    try {
      requestBody?.close();
    } catch {
      // The proxy cancels the unfinished viewer upload after the response ends.
    }
    context.store[Symbol.dispose]();
    await fixture.stop();
  }
});

function startFixture(): { port: number; stop: () => Promise<void> } {
  let port = 0;
  const waiting = new Set<() => void>();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen(address) {
      port = address.port;
    },
  }, async (request) => {
    if (new URL(request.url).pathname === "/early") {
      return new Response("early", { status: 202 });
    }
    if (new URL(request.url).pathname === "/wait") {
      await new Promise<void>((resolve) => {
        const finish = () => {
          waiting.delete(finish);
          resolve();
        };
        waiting.add(finish);
      });
      return new Response(null, { status: 499 });
    }
    if (new URL(request.url).pathname === "/hold") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
        headers: Object.fromEntries(request.headers),
        body: [...new Uint8Array(await request.arrayBuffer())],
      }),
      {
        headers: {
          "content-type": "application/json",
          "set-cookie": "fixture=ok; HttpOnly",
          server: "fixture",
          "x-bunny-hole-leak": "secret",
        },
      },
    );
  });
  return {
    port,
    async stop() {
      for (const finish of [...waiting]) finish();
      await server.shutdown();
    },
  };
}

async function hostContext(frpHttpPort: number, requestTimeoutMs = 30_000) {
  const directory = await Deno.makeTempDir();
  const owner = await generateKeyPair();
  const identity = await generateKeyPair();
  const device = await generateKeyPair();
  const store = new HostStore(`${directory}/state.sqlite`);
  store.createEnrollment({
    id: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    kind: "device",
    name: "test",
    publicKey: device.publicKey,
    verificationPhrase: "amber-birch-coral-drift-ember",
    state: "active",
    grants: {
      exactHostnames: ["home.example.com"],
      hostnameSuffixes: [],
      protocols: ["http"],
      maxRoutes: 1,
    },
    createdAt: new Date().toISOString(),
    expiresAt: null,
  });
  store.createRoute({
    id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
    enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    name: "home",
    protocol: "http",
    hostname: "home.example.com",
    targetHost: "127.0.0.1",
    targetPort: 8123,
    allowPrivateNetwork: false,
    active: true,
  });
  const config: HostConfig = {
    bindAddress: "127.0.0.1",
    port: 8080,
    publicUrl: new URL("http://relay.test:8080"),
    statePath: `${directory}/state.sqlite`,
    identityPath: `${directory}/identity.json`,
    ownerPublicKey: owner.publicKey,
    frpsPath: "frps",
    frpBindPort: 7000,
    frpHttpPort,
    connectorHost: "relay.test",
    connectorPort: 7000,
    connectorTransports: ["tcp"],
    requestTimeoutMs,
    logFormat: "json",
    localDevelopment: true,
  };
  return { store, host: new Host(config, store, identity, logger) };
}

function remoteInfo(hostname: string): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp", hostname, port: 1234 },
    completed: new Promise<void>(() => {}),
  } as Deno.ServeHandlerInfo;
}
