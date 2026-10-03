import { assertEquals } from "./assert.ts";
import { generateKeyPair, sign } from "../packages/api/auth.ts";
import type { HostConfig } from "../apps/host/config.ts";
import { Host } from "../apps/host/host.ts";
import { HostStore } from "../apps/host/store.ts";
import { canonicalGrant, validateGrant } from "../packages/api/mod.ts";

const logger = { info() {}, warn() {}, error() {} };

Deno.test("enrollment, one-use challenge, session, and scoped route work end to end", async () => {
  const directory = await Deno.makeTempDir();
  const owner = await generateKeyPair();
  const identity = await generateKeyPair();
  const device = await generateKeyPair();
  using store = new HostStore(`${directory}/state.sqlite`);
  const host = new Host(config(owner.publicKey, directory), store, identity, logger);

  const enrollmentResponse = await host.handle(request("/api/v1/enrollments", "POST", {
    kind: "device",
    name: "developer-laptop",
    publicKey: device.publicKey,
  }));
  assertEquals(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json();
  const grant = validateGrant({
    exactHostnames: ["home.example.com"],
    hostnameSuffixes: [],
    protocols: ["http"],
    maxRoutes: 1,
  });
  const ownerChallenge = await host.handle(
    request("/api/v1/admin/owner/challenge", "POST", {
      purpose: "approve-enrollment",
    }),
  );
  const { challenge: ownerChallengeValue } = await ownerChallenge.json();
  const approval = await host.handle(
    new Request(
      `http://host.test/api/v1/enrollments/${enrollment.id}/approve`,
      {
        method: "POST",
        headers: {
          host: "host.test",
          "content-type": "application/json",
          "x-bunny-hole-owner-challenge": ownerChallengeValue,
          "x-bunny-hole-owner-signature": await sign(
            owner.privateKey,
            "approve-enrollment",
            [
              identity.publicKey,
              enrollment.id,
              device.publicKey,
              canonicalGrant(grant),
              ownerChallengeValue,
            ],
          ),
        },
        body: JSON.stringify({ grants: grant }),
      },
    ),
  );
  assertEquals(approval.status, 200);

  const challengeResponse = await host.handle(
    request("/api/v1/session/challenge", "POST", {
      enrollmentId: enrollment.id,
    }),
  );
  const challenge = await challengeResponse.json();
  const exchangeBody = {
    enrollmentId: enrollment.id,
    challengeId: challenge.challengeId,
    signature: await sign(device.privateKey, "session", [
      enrollment.id,
      challenge.challengeId,
      challenge.challenge,
    ]),
  };
  const sessionResponse = await host.handle(
    request("/api/v1/session", "POST", exchangeBody),
  );
  assertEquals(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assertEquals(
    (await host.handle(request("/api/v1/session", "POST", exchangeBody))).status,
    401,
  );

  const routeResponse = await host.handle(
    new Request("http://host.test/api/v1/routes", {
      method: "POST",
      headers: {
        host: "host.test",
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        name: "home-assistant",
        protocol: "http",
        hostname: "home.example.com",
        targetHost: "127.0.0.1",
        targetPort: 8123,
        allowPrivateNetwork: false,
      }),
    }),
  );
  assertEquals(routeResponse.status, 201);
  assertEquals(store.getRouteByHostname("home.example.com")?.name, "home-assistant");
  const route = await routeResponse.clone().json();
  const deleted = await host.handle(
    new Request(
      `http://host.test/api/v1/routes/${route.id}`,
      {
        method: "DELETE",
        headers: {
          host: "host.test",
          authorization: `Bearer ${session.accessToken}`,
        },
      },
    ),
  );
  assertEquals(deleted.status, 204);
  assertEquals(store.getRouteByHostname("home.example.com"), undefined);

  const confused = await host.handle(
    new Request("http://host.test/api/v1/routes", {
      method: "POST",
      headers: {
        host: "host.test",
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        name: "confused",
        protocol: "http",
        hostname: "home.example.com.attacker.test",
        targetHost: "127.0.0.1",
        targetPort: 8123,
        allowPrivateNetwork: false,
      }),
    }),
  );
  assertEquals(confused.status, 400);

  const lastChallengeResponse = await host.handle(
    request("/api/v1/session/challenge", "POST", { enrollmentId: enrollment.id }),
  );
  assertEquals(lastChallengeResponse.status, 200);
  const lastChallenge = await lastChallengeResponse.json();
  assertEquals(store.revokeEnrollment(enrollment.id), true);
  assertEquals(
    (await host.handle(request("/api/v1/session/challenge", "POST", {
      enrollmentId: enrollment.id,
    }))).status,
    401,
  );
  assertEquals(
    (await host.handle(request("/api/v1/session", "POST", {
      enrollmentId: enrollment.id,
      challengeId: lastChallenge.challengeId,
      signature: await sign(device.privateKey, "session", [
        enrollment.id,
        lastChallenge.challengeId,
        lastChallenge.challenge,
      ]),
    }))).status,
    401,
  );
  assertEquals(
    (await host.handle(
      new Request("http://host.test/api/v1/routes", {
        headers: { host: "host.test", authorization: `Bearer ${session.accessToken}` },
      }),
    )).status,
    401,
  );

  host.shutdown();
  assertEquals(
    (await host.handle(new Request("http://host.test/healthz"))).status,
    503,
  );
  assertEquals((await host.handle(new Request("http://host.test/readyz"))).status, 503);
});

Deno.test("management API is isolated by hostname and rejects malformed input", async () => {
  const directory = await Deno.makeTempDir();
  const owner = await generateKeyPair();
  const identity = await generateKeyPair();
  using store = new HostStore(`${directory}/state.sqlite`);
  const production: HostConfig = {
    ...config(owner.publicKey, directory),
    publicUrl: new URL("https://hole.example.com"),
    connectorHost: "connect.example.com",
    connectorPort: 443,
    connectorTransports: ["wss"],
    development: false,
  };
  const host = new Host(production, store, identity, logger);
  assertEquals(
    (await host.handle(
      new Request("https://relay/.well-known/bunny-hole", {
        headers: { host: "viewer.example.com" },
      }),
    )).status,
    404,
  );
  assertEquals(
    (await host.handle(
      new Request("https://relay/.well-known/bunny-hole", {
        headers: { host: "hole.example.com" },
      }),
    )).status,
    200,
  );
  assertEquals(
    (await host.handle(
      new Request("https://relay/api/v1/enrollments", {
        method: "POST",
        headers: { host: "hole.example.com", "content-type": "text/plain" },
        body: "{}",
      }),
    )).status,
    400,
  );
  assertEquals(
    (await host.handle(
      new Request("https://relay/api/v1/routes", {
        method: "GET",
        headers: { host: "hole.example.com" },
      }),
    )).status,
    401,
  );
  assertEquals(
    (await host.handle(request("/internal/frp/plugin?op=Login", "POST", {}))).status,
    404,
  );
  assertEquals(
    (await host.handle(
      new Request("https://relay/_bunny/admin/passkey", {
        headers: { host: "viewer.example.com" },
      }),
    )).status,
    404,
  );
});

Deno.test("development keeps the management hostname boundary", async () => {
  const directory = await Deno.makeTempDir();
  const owner = await generateKeyPair();
  const identity = await generateKeyPair();
  using store = new HostStore(`${directory}/state.sqlite`);
  const host = new Host(config(owner.publicKey, directory), store, identity, logger);
  assertEquals(
    (await host.handle(
      new Request("http://host.test/.well-known/bunny-hole", {
        headers: { host: "viewer.test" },
      }),
    )).status,
    404,
  );
  assertEquals(
    (await host.handle(
      new Request("http://host.test/.well-known/bunny-hole", {
        headers: { host: "host.test" },
      }),
    )).status,
    200,
  );
});

Deno.test("passkey registration uses a bounded one-use management-origin flow", async () => {
  const directory = await Deno.makeTempDir();
  const owner = await generateKeyPair();
  const identity = await generateKeyPair();
  using store = new HostStore(`${directory}/state.sqlite`);
  const host = new Host(config(owner.publicKey, directory), store, identity, logger);
  const ownerChallenge = await host.handle(
    request("/api/v1/admin/owner/challenge", "POST", {
      purpose: "create-passkey-flow",
    }),
  );
  const { challenge } = await ownerChallenge.json();
  const ownerSignature = await sign(
    owner.privateKey,
    "create-passkey-flow",
    [identity.publicKey, "primary", challenge],
  );
  const startFlow = () =>
    host.handle(
      new Request(
        "http://host.test/api/v1/admin/passkeys/registration/flows",
        {
          method: "POST",
          headers: {
            host: "host.test",
            "content-type": "application/json",
            "x-bunny-hole-owner-challenge": challenge,
            "x-bunny-hole-owner-signature": ownerSignature,
          },
          body: JSON.stringify({ name: "primary" }),
        },
      ),
    );
  const started = await startFlow();
  assertEquals(started.status, 200);
  assertEquals((await startFlow()).status, 403);
  const ceremony = new URL((await started.json()).url);
  assertEquals(ceremony.origin, "http://host.test:8080");
  assertEquals(ceremony.pathname, "/_bunny/admin/passkey");
  assertEquals(ceremony.search, "");
  const flowToken = ceremony.hash.slice(1);
  const options = await host.handle(
    request("/api/v1/admin/passkeys/registration/options", "POST", { flowToken }),
  );
  assertEquals(options.status, 200);
  const page = await host.handle(
    new Request("http://host.test/_bunny/admin/passkey", {
      headers: { host: "host.test" },
    }),
  );
  assertEquals(page.status, 200);
  assertEquals(page.headers.get("referrer-policy"), "no-referrer");
  for (const path of ["/_bunny/admin/passkey", "/_bunny/admin/approve"]) {
    const accessiblePage = await host.handle(
      new Request(`http://host.test${path}`, { headers: { host: "host.test" } }),
    );
    const html = await accessiblePage.text();
    assertEquals(html.includes('<html lang="en">'), true);
    assertEquals(
      html.includes('role="status" aria-live="polite" aria-atomic="true"'),
      true,
    );
    assertEquals(
      html.includes('tabindex="0" aria-label="Enrollment and grant details"'),
      true,
    );
    assertEquals(html.includes('aria-describedby="status"'), true);
    assertEquals(html.includes("<noscript>"), true);
    // This checks our exact generated template, not arbitrary HTML or a sanitizer.
    const opening = html.split("<script>");
    const closing = html.split("</script>");
    assertEquals(opening.length, 2);
    assertEquals(closing.length, 2);
    const script = opening[1].split("</script>")[0];
    // Parse the actual generated browser code without executing a ceremony.
    new Function(script);
  }

  const consumed = await host.handle(
    request("/api/v1/admin/passkeys/registration", "POST", {
      flowToken,
      response: {},
    }),
  );
  assertEquals(consumed.status, 400);
  assertEquals(
    (await host.handle(
      request("/api/v1/admin/passkeys/registration/options", "POST", { flowToken }),
    )).status,
    400,
  );
});

Deno.test("approval options reject enrollments revoked or pruned after flow creation", async () => {
  for (const revoked of [true, false]) {
    const directory = await Deno.makeTempDir();
    try {
      const owner = await generateKeyPair();
      const identity = await generateKeyPair();
      const device = await generateKeyPair();
      using store = new HostStore(`${directory}/state.sqlite`);
      const host = new Host(
        config(owner.publicKey, directory),
        store,
        identity,
        logger,
      );
      const enrolled = await host.handle(request("/api/v1/enrollments", "POST", {
        kind: "device",
        name: "pending device",
        publicKey: device.publicKey,
      }));
      const { id: enrollmentId } = await enrolled.json();
      const started = await host.handle(
        request("/api/v1/admin/enrollment-approvals", "POST", {
          enrollmentId,
          grants: {
            exactHostnames: ["home.example.com"],
            hostnameSuffixes: [],
            protocols: ["http"],
            maxRoutes: 1,
          },
        }),
      );
      assertEquals(started.status, 200);
      const flowToken = new URL((await started.json()).url).hash.slice(1);
      if (revoked) store.revokeEnrollment(enrollmentId);
      else {store.pruneExpiredEnrollments(
          new Date(Date.now() + 60 * 60_000).toISOString(),
        );}
      const options = await host.handle(
        request("/api/v1/admin/enrollment-approvals/options", "POST", { flowToken }),
      );
      assertEquals(options.status, 400);
      assertEquals(await options.json(), { error: "enrollment cannot be approved" });
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

function request(path: string, method: string, body: unknown): Request {
  return new Request(`http://host.test${path}`, {
    method,
    headers: { host: "host.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function config(ownerPublicKey: string, directory: string): HostConfig {
  return {
    bindAddress: "127.0.0.1",
    port: 8080,
    publicUrl: new URL("http://host.test:8080"),
    statePath: `${directory}/state.sqlite`,
    identityPath: `${directory}/identity.json`,
    ownerPublicKey,
    frpsPath: "frps",
    frpBindPort: 7000,
    frpHttpPort: 9080,
    connectorHost: "host.test",
    connectorPort: 7000,
    connectorTransports: ["tcp"],
    requestTimeoutMs: 30_000,
    logFormat: "json",
    development: true,
  };
}
