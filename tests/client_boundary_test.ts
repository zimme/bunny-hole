import {
  BunnyHoleClient,
  parseHostCredentials,
  type Session,
} from "../apps/connector/client.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "./assert.ts";

const host = await generateKeyPair();
const device = await generateKeyPair();
const credentials = {
  url: "https://hole.example.com/",
  identityPublicKey: host.publicKey,
  enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
  ...device,
};
const descriptor = {
  apiVersion: 1,
  name: "hole.example.com",
  managementUrl: credentials.url,
  connectorHost: "connect.example.com",
  connectorPort: 443,
  connectorTransports: ["wss"],
  identityPublicKey: host.publicKey,
  capabilities: ["http", "https"],
};
const route = {
  id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
  enrollmentId: credentials.enrollmentId,
  name: "preview",
  protocol: "http" as const,
  hostname: "preview.example.com",
  targetHost: "127.0.0.1",
  targetPort: 3000,
  allowPrivateNetwork: false,
  active: true,
};
const challenge = () => ({
  challengeId: "chl_AAAAAAAAAAAAAAAAAAAAAAAA",
  challenge: "A".repeat(32),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});
const admitted = () => ({
  accessToken: "token",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  descriptor,
  routes: [route],
});
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
function responder(value: unknown): typeof fetch {
  return () => Promise.resolve(json(value));
}

Deno.test("credential parser accepts exactly its schema and rejects origin tricks", () => {
  for (
    const value of [
      null,
      {},
      { ...credentials, extra: true },
      { ...credentials, url: "bad" },
      { ...credentials, privateKey: "AA" },
      ...[
        "ftp://hole.example.com",
        "https://user@hole.example.com",
        "https://hole.example.com/path",
        "https://hole.example.com/?x",
        "https://hole.example.com/#x",
      ].map((url) => ({ ...credentials, url })),
    ]
  ) assertThrows(() => parseHostCredentials(value));
  assertEquals(parseHostCredentials(credentials), credentials);
});

Deno.test("client accepts a pinned descriptor and rejects malformed shapes, origin mismatches and unsupported capabilities", async () => {
  assertEquals(
    (await new BunnyHoleClient(credentials.url, responder(descriptor)).descriptor())
      .connectorTransports,
    ["wss"],
  );
  for (
    const value of [
      null,
      {},
      { ...descriptor, extra: true },
      { ...descriptor, apiVersion: 2 },
      { ...descriptor, managementUrl: "https://attacker.test" },
      { ...descriptor, managementUrl: "bad" },
      { ...descriptor, managementUrl: "https://hole.example.com/path" },
      { ...descriptor, name: "other.example.com" },
      { ...descriptor, connectorTransports: [] },
      { ...descriptor, connectorTransports: ["wss", "wss"] },
      { ...descriptor, connectorTransports: ["tcp"] },
      { ...descriptor, capabilities: ["http", "http"] },
      { ...descriptor, capabilities: ["tcp"] },
      { ...descriptor, connectorPort: 0 },
      { ...descriptor, identityPublicKey: "AA" },
    ]
  ) {
    await assertRejects(() =>
      new BunnyHoleClient(credentials.url, responder(value)).descriptor()
    );
  }
  for (
    const changes of [
      { managementUrl: "http://attacker.test:8080" },
      { connectorHost: "connect.example.com" },
    ]
  ) {
    await assertRejects(() =>
      new BunnyHoleClient(
        "http://host.test:8080",
        responder({
          ...descriptor,
          name: "host.test",
          managementUrl: "http://host.test:8080",
          ...changes,
        }),
        true,
      ).descriptor(), /incompatible/);
  }
});

Deno.test("client rejects malformed enrollment fields and mismatched returned identities", async () => {
  const enrollment = {
    id: credentials.enrollmentId,
    publicKey: device.publicKey,
    state: "pending",
    name: "preview",
    kind: "device",
    verificationPhrase: "amber-birch",
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
  for (
    const value of [
      null,
      { ...enrollment, extra: 1 },
      { ...enrollment, state: "unknown" },
      { ...enrollment, kind: "owner" },
      { ...enrollment, verificationPhrase: "x".repeat(129) },
      { ...enrollment, createdAt: "bad" },
      { ...enrollment, expiresAt: "bad" },
      { ...enrollment, publicKey: host.publicKey },
    ]
  ) {
    await assertRejects(
      () =>
        new BunnyHoleClient(credentials.url, responder(value)).enroll(
          "preview",
          "device",
          device.publicKey,
        ),
      /enrollment/,
    );
  }
  const client = new BunnyHoleClient(credentials.url, responder(enrollment));
  assertEquals(
    (await client.enroll("preview", "device", device.publicKey)).id,
    enrollment.id,
  );
  assertEquals((await client.enrollment(enrollment.id)).state, "pending");
  await assertRejects(
    () => client.enrollment("enr_BBBBBBBBBBBBBBBBBBBBBBBB"),
    /enrollment/,
  );
});

Deno.test("challenge validation stops before signing or admitting invalid responses", async () => {
  for (
    const value of [
      null,
      {},
      { ...challenge(), extra: true },
      { ...challenge(), challenge: "bad" },
      { ...challenge(), expiresAt: "bad" },
      { ...challenge(), expiresAt: new Date(Date.now() - 1).toISOString() },
      { ...challenge(), expiresAt: new Date(Date.now() + 180000).toISOString() },
    ]
  ) {
    let calls = 0;
    const client = new BunnyHoleClient(credentials.url, () => {
      calls++;
      return Promise.resolve(json(value));
    });
    await assertRejects(() => client.session(credentials), /challenge/);
    assertEquals(calls, 1);
  }
});

Deno.test("session validation accepts owned routes and rejects expiry, identity, ownership and unknown fields", async () => {
  const client = new BunnyHoleClient(credentials.url, (input) =>
    Promise.resolve(
      json(String(input).endsWith("challenge") ? challenge() : admitted()),
    ));
  assertEquals((await client.session(credentials)).routes, [route]);
  for (
    const value of [
      null,
      { ...admitted(), extra: true },
      { ...admitted(), accessToken: "" },
      { ...admitted(), accessToken: "x".repeat(1025) },
      { ...admitted(), expiresAt: "bad" },
      { ...admitted(), expiresAt: new Date(Date.now() - 1).toISOString() },
      { ...admitted(), expiresAt: new Date(Date.now() + 660000).toISOString() },
      { ...admitted(), routes: Array(257).fill(route) },
      {
        ...admitted(),
        descriptor: { ...descriptor, identityPublicKey: device.publicKey },
      },
      ...[{ ...route, extra: true }, { ...route, active: "true" }, {
        ...route,
        targetPort: 0,
      }, {
        ...route,
        enrollmentId: "enr_BBBBBBBBBBBBBBBBBBBBBBBB",
      }, { ...route, targetHost: "service" }].map((bad) => ({
        ...admitted(),
        routes: [bad],
      })),
    ]
  ) {
    const client = new BunnyHoleClient(
      credentials.url,
      (input) =>
        Promise.resolve(
          json(String(input).endsWith("challenge") ? challenge() : value),
        ),
    );
    await assertRejects(() => client.session(credentials));
  }
});

Deno.test("control response reader bounds streams, cancels oversized bodies and hides server errors", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assertRejects(
    () =>
      new BunnyHoleClient(credentials.url, () =>
        Promise.resolve(
          new Response(stream, { headers: { "content-type": "application/json" } }),
        )).descriptor(),
    /limit/,
  );
  assertEquals(cancelled, true);
  for (
    const response of [
      new Response("{}", { headers: { "content-type": "text/plain" } }),
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024 + 1),
        },
      }),
      new Response("{", { headers: { "content-type": "application/json" } }),
      new Response(new Uint8Array([255]), {
        headers: { "content-type": "application/json" },
      }),
      new Response(null, { headers: { "content-type": "application/json" } }),
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "bad" },
      }),
    ]
  ) {
    await assertRejects(() =>
      new BunnyHoleClient(credentials.url, () => Promise.resolve(response)).descriptor()
    );
  }
  await assertRejects(
    () =>
      new BunnyHoleClient(credentials.url, () =>
        Promise.resolve(
          new Response('{"error":"private secret"}', {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
        )).descriptor(),
    /^host request failed \(403\)$/,
  );
});

Deno.test("route requests carry admission only to the management origin and propagate cancellation", async () => {
  const session = { ...admitted(), enrollmentId: credentials.enrollmentId } as Session;
  const controller = new AbortController();
  controller.abort();
  const calls: {
    path: string;
    method?: string;
    token: string | null;
    redirect?: RequestRedirect;
  }[] = [];
  const client = new BunnyHoleClient(credentials.url, (input, init) => {
    assertEquals(new URL(String(input)).origin, "https://hole.example.com");
    calls.push({
      path: new URL(String(input)).pathname,
      method: init?.method,
      token: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
    });
    if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
    return Promise.resolve(
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(route),
    );
  });
  assertEquals(await client.createRoute(session, route), route);
  await client.deleteRoute(session, route.id);
  await assertRejects(() => client.session(credentials, controller.signal));
  assert(calls.every((call) => call.redirect === "error"));
  assertEquals(calls[0].token, "Bearer token");
  assertEquals(calls[1].method, "DELETE");
  assertEquals(calls[2].token, null);
});
