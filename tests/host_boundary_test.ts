import { Host } from "../apps/host/host.ts";
import { HostStore } from "../apps/host/store.ts";
import { loadHostConfig } from "../apps/host/config.ts";
import { generateKeyPair, sign } from "../packages/api/auth.ts";
import { createId, type Enrollment } from "../packages/api/mod.ts";
import { issueSessionToken } from "../apps/host/session.ts";
import { virtualPasskey } from "./helpers/virtual_passkey.ts";
import { assert, assertEquals } from "./assert.ts";

const grants = {
  exactHostnames: ["app.test"],
  hostnameSuffixes: [],
  protocols: ["http" as const],
  maxRoutes: 1,
};
async function fixture(
  run: (
    host: Host,
    store: HostStore,
    owner: Awaited<ReturnType<typeof generateKeyPair>>,
    identity: Awaited<ReturnType<typeof generateKeyPair>>,
  ) => Promise<void>,
) {
  const directory = await Deno.makeTempDir();
  try {
    const owner = await generateKeyPair();
    const identity = await generateKeyPair();
    using store = new HostStore(`${directory}/state.sqlite`);
    const host = new Host(
      loadHostConfig({
        BUNNY_HOLE_PUBLIC_URL: "https://hole.example.com",
        BUNNY_HOLE_OWNER_PUBLIC_KEY: owner.publicKey,
      }),
      store,
      identity,
      { info() {}, warn() {}, error() {} },
    );
    try {
      await run(host, store, owner, identity);
    } finally {
      host.shutdown();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
function request(
  path: string,
  value?: unknown,
  headers: HeadersInit = {},
  method = "POST",
) {
  return new Request(`https://hole.example.com${path}`, {
    method,
    headers: {
      host: "hole.example.com",
      "content-type": "application/json",
      ...headers,
    },
    ...(method !== "GET" ? { body: JSON.stringify(value ?? null) } : {}),
  });
}
async function pending(host: Host) {
  const device = await generateKeyPair();
  const response = await host.handle(
    request("/api/v1/enrollments", {
      name: "device",
      kind: "device",
      publicKey: device.publicKey,
    }),
  );
  assertEquals(response.status, 201);
  return { enrollment: await response.json() as Enrollment, device };
}
async function ownerRequest(
  host: Host,
  owner: Awaited<ReturnType<typeof generateKeyPair>>,
  identity: Awaited<ReturnType<typeof generateKeyPair>>,
  purpose: string,
  fields: string[],
  path: string,
  value?: unknown,
  method = "POST",
) {
  const issued = await host.handle(
    request("/api/v1/admin/owner/challenge", { purpose }),
  );
  const { challenge } = await issued.json();
  return host.handle(
    request(path, value, {
      "x-bunny-hole-owner-challenge": challenge,
      "x-bunny-hole-owner-signature": await sign(owner.privateKey, purpose, [
        identity.publicKey,
        ...fields,
        challenge,
      ]),
    }, method),
  );
}

Deno.test("host control parsers reject missing, oversized, unknown-field and wrong-type bodies", () =>
  fixture(async (host) => {
    for (
      const path of [
        "/api/v1/enrollments",
        "/api/v1/session/challenge",
        "/api/v1/session",
        "/api/v1/admin/owner/challenge",
        "/api/v1/admin/passkeys/registration/flows",
        "/api/v1/admin/passkeys/registration/options",
        "/api/v1/admin/passkeys/registration",
        "/api/v1/admin/enrollment-approvals",
        "/api/v1/admin/enrollment-approvals/options",
        "/api/v1/admin/enrollment-approvals/complete",
      ]
    ) {
      assertEquals((await host.handle(request(path))).status, 400);
      assertEquals((await host.handle(request(path, { extra: true }))).status, 400);
    }
    for (const body of [undefined, "{", "x".repeat(131073)]) {
      const response = await host.handle(
        new Request("https://hole.example.com/api/v1/enrollments", {
          method: "POST",
          headers: { host: "hole.example.com", "content-type": "application/json" },
          body,
        }),
      );
      assertEquals(response.status, 400);
    }
    for (const length of ["bad", "131073"]) {
      assertEquals(
        (await host.handle(
          request("/api/v1/enrollments", {}, { "content-length": length }),
        )).status,
        400,
      );
    }
    assertEquals(
      (await host.handle(
        request("/api/v1/enrollments", {
          name: "test",
          kind: "owner",
          publicKey: "AA",
        }),
      )).status,
      400,
    );
    assertEquals(
      (await host.handle(
        request("/api/v1/admin/owner/challenge", { purpose: "unknown" }),
      )).status,
      400,
    );
    assertEquals(
      (await host.handle(request("/api/v1/unknown", undefined, {}, "GET"))).status,
      404,
    );
    host.setFrpReady(true);
    assertEquals(
      (await host.handle(request("/readyz", undefined, {}, "GET"))).status,
      200,
    );
  }));

Deno.test("host enrollment and owner challenge limits are bounded and clean expired flows", () =>
  fixture(async (host) => {
    const { device } = await pending(host);
    assertEquals(
      (await host.handle(
        request("/api/v1/enrollments", {
          name: "same",
          kind: "device",
          publicKey: device.publicKey,
        }),
      )).status,
      200,
    );
    for (let i = 0; i < 128; i++) {
      assertEquals(
        (await host.handle(
          request("/api/v1/admin/owner/challenge", { purpose: "list-passkeys" }),
        )).status,
        200,
      );
    }
    assertEquals(
      (await host.handle(
        request("/api/v1/admin/owner/challenge", { purpose: "list-passkeys" }),
      )).status,
      400,
    );
    const original = Date.now;
    try {
      Date.now = () => original() + 360001;
      assertEquals(
        (await host.handle(
          request("/api/v1/admin/owner/challenge", { purpose: "list-passkeys" }),
        )).status,
        200,
      );
    } finally {
      Date.now = original;
    }
    for (let i = 0; i < 28; i++) await host.handle(request("/api/v1/enrollments", {}));
    assertEquals((await host.handle(request("/api/v1/enrollments", {}))).status, 400);
  }));

Deno.test("host bounds approval flows and consumes failed authentication without approving", () =>
  fixture(async (host, store) => {
    const { enrollment } = await pending(host);
    const authenticator = await virtualPasskey(store);
    let first = "";
    for (let i = 0; i < 128; i++) {
      const response = await host.handle(
        request("/api/v1/admin/enrollment-approvals", {
          enrollmentId: enrollment.id,
          grants,
        }),
      );
      assertEquals(response.status, 200);
      const { url } = await response.json();
      if (i === 0) first = new URL(url).hash.slice(1);
    }
    assertEquals(
      (await host.handle(
        request("/api/v1/admin/enrollment-approvals", {
          enrollmentId: enrollment.id,
          grants,
        }),
      )).status,
      400,
    );
    const details = await (await host.handle(
      request("/api/v1/admin/enrollment-approvals/options", { flowToken: first }),
    )).json();
    assertEquals(details.enrollment.id, enrollment.id);
    const assertion = await authenticator.assertion(details.options.challenge);
    assertion.response.signature = "AAAA";
    assertEquals(
      (await host.handle(
        request("/api/v1/admin/enrollment-approvals/complete", {
          flowToken: first,
          response: assertion,
        }),
      )).status,
      401,
    );
    assertEquals(store.getEnrollment(enrollment.id)?.state, "pending");
    assertEquals(
      (await host.handle(
        request("/api/v1/admin/enrollment-approvals/options", { flowToken: first }),
      )).status,
      400,
    );
    const original = Date.now;
    try {
      Date.now = () => original() + 120001;
      assertEquals(
        (await host.handle(
          request("/api/v1/admin/enrollment-approvals/options", { flowToken: first }),
        )).status,
        400,
      );
    } finally {
      Date.now = original;
    }
  }));

Deno.test("host completes real passkey registration and approval then permits owner recovery deletion", () =>
  fixture(async (host, store, owner, identity) => {
    const authenticator = await virtualPasskey();
    const flow = await ownerRequest(
      host,
      owner,
      identity,
      "create-passkey-flow",
      ["owner"],
      "/api/v1/admin/passkeys/registration/flows",
      { name: "owner" },
    );
    const flowToken = new URL((await flow.json()).url).hash.slice(1);
    const options = await (await host.handle(
      request("/api/v1/admin/passkeys/registration/options", { flowToken }),
    )).json();
    assertEquals(
      (await host.handle(
        request("/api/v1/admin/passkeys/registration", {
          flowToken,
          response: await authenticator.registration(options.challenge),
        }),
      )).status,
      200,
    );
    const { enrollment } = await pending(host);
    const approval = await (await host.handle(
      request("/api/v1/admin/enrollment-approvals", {
        enrollmentId: enrollment.id,
        grants,
      }),
    )).json();
    const approvalToken = new URL(approval.url).hash.slice(1);
    const approvalOptions = await (await host.handle(
      request("/api/v1/admin/enrollment-approvals/options", {
        flowToken: approvalToken,
      }),
    )).json();
    assertEquals(
      (await host.handle(
        request("/api/v1/admin/enrollment-approvals/complete", {
          flowToken: approvalToken,
          response: await authenticator.assertion(approvalOptions.options.challenge),
        }),
      )).status,
      200,
    );
    assertEquals(store.getEnrollment(enrollment.id)?.state, "active");
    const listed = await ownerRequest(
      host,
      owner,
      identity,
      "list-passkeys",
      [],
      "/api/v1/admin/passkeys",
      undefined,
      "GET",
    );
    assertEquals(await listed.json(), {
      passkeys: [{ id: authenticator.id, name: "owner" }],
    });
    assertEquals(
      (await ownerRequest(
        host,
        owner,
        identity,
        "purge-enrollment",
        [enrollment.id],
        `/api/v1/enrollments/${enrollment.id}`,
        undefined,
        "DELETE",
      )).status,
      400,
    );
    store.revokeEnrollment(enrollment.id);
    assertEquals(
      (await ownerRequest(
        host,
        owner,
        identity,
        "purge-enrollment",
        [enrollment.id],
        `/api/v1/enrollments/${enrollment.id}`,
        undefined,
        "DELETE",
      )).status,
      204,
    );
    assertEquals(store.getEnrollment(enrollment.id), undefined);
  }));

Deno.test("host validates session proofs, challenge limits and route policy boundaries", () =>
  fixture(async (host, store, _owner, identity) => {
    const { enrollment } = await pending(host);
    store.approveEnrollment(enrollment.id, grants);
    for (let i = 0; i < 8; i++) {
      assertEquals(
        (await host.handle(
          request("/api/v1/session/challenge", { enrollmentId: enrollment.id }),
        )).status,
        200,
      );
    }
    assertEquals(
      (await host.handle(
        request("/api/v1/session/challenge", { enrollmentId: enrollment.id }),
      )).status,
      429,
    );
    assertEquals(
      (await host.handle(
        request("/api/v1/session", {
          enrollmentId: enrollment.id,
          challengeId: createId("chl"),
          signature: "AA",
        }),
      )).status,
      401,
    );
    const token = await issueSessionToken(identity.privateKey, enrollment.id);
    const headers = { authorization: `Bearer ${token.token}` };
    assertEquals(
      (await host.handle(request("/api/v1/routes", undefined, headers))).status,
      400,
    );
    const route = {
      name: "app",
      protocol: "http",
      hostname: "app.test",
      targetHost: "127.0.0.1",
      targetPort: 3000,
      allowPrivateNetwork: false,
    };
    for (
      const changes of [{ hostname: "hole.example.com" }, { hostname: "other.test" }, {
        protocol: "https",
      }]
    ) {
      assertEquals(
        (await host.handle(
          request("/api/v1/routes", { ...route, ...changes }, headers),
        )).status,
        400,
      );
    }
    assertEquals(
      (await host.handle(request("/api/v1/routes", route, headers))).status,
      201,
    );
    assertEquals(
      (await host.handle(request("/api/v1/routes", undefined, headers, "GET"))).status,
      200,
    );
  }));

Deno.test("public ingress rejects excessive headers, oversized bodies, invalid methods and missing hosts", () =>
  fixture(async (host, store) => {
    const { enrollment } = await pending(host);
    store.approveEnrollment(enrollment.id, grants);
    store.createRoute({
      id: createId("rte"),
      enrollmentId: enrollment.id,
      name: "app",
      protocol: "http",
      hostname: "app.test",
      targetHost: "127.0.0.1",
      targetPort: 3000,
      allowPrivateNetwork: false,
      active: true,
    });
    const headers = new Headers({ host: "app.test" });
    for (let i = 0; i < 101; i++) headers.set(`x-${i}`, "value");
    assertEquals(
      (await host.handle(new Request("https://app.test/", { headers }))).status,
      431,
    );
    for (
      const [method, length, expected] of [["lowercase", "0", 405], [
        "POST",
        "1073741825",
        413,
      ], ["POST", "bad", 413]] as const
    ) {
      assertEquals(
        (await host.handle(
          new Request("https://app.test/", {
            method,
            headers: { host: "app.test", "content-length": length },
          }),
        )).status,
        expected,
      );
    }
    assertEquals((await host.handle(new Request("https://app.test/"))).status, 421);
    assertEquals(
      (await host.handle(
        new Request("https://app.test/", {
          headers: { host: "app.test", upgrade: "websocket" },
        }),
      )).status,
      501,
    );
    const loopback = {
      remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1 },
      completed: Promise.resolve(),
    } as Deno.ServeHandlerInfo;
    const plugin = await host.handle(
      request("/internal/frp/plugin?op=Login", { content: {} }),
      loopback,
    );
    assertEquals((await plugin.json()).reject, true);
    assert(
      (await host.handle(request("/internal/frp/plugin", {}, {}, "POST"))).status ===
        404,
    );
  }));

Deno.test("host bounds simultaneous control uploads and cancels every reader on shutdown", () =>
  fixture(async (host) => {
    let cancelled = 0;
    const pending: Promise<Response>[] = [];
    for (let i = 0; i < 32; i++) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        cancel() {
          cancelled++;
        },
      });
      pending.push(
        host.handle(
          new Request("https://hole.example.com/api/v1/admin/owner/challenge", {
            method: "POST",
            headers: { host: "hole.example.com", "content-type": "application/json" },
            body,
          }),
        ),
      );
    }
    const rejected = await host.handle(request("/api/v1/admin/owner/challenge", {}));
    assertEquals(rejected.status, 400);
    assertEquals(
      (await rejected.json()).error,
      "control requests temporarily unavailable",
    );
    host.shutdown();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const statuses = await Promise.race([
        Promise.all(pending).then((responses) => responses.map((r) => r.status)),
        new Promise((resolve) => {
          deadline = setTimeout(() => resolve("shutdown stalled"), 100);
        }),
      ]);
      assertEquals(statuses, Array(32).fill(400));
      assertEquals(cancelled, 32);
    } finally {
      clearTimeout(deadline);
      await Promise.all(pending);
    }
  }));
