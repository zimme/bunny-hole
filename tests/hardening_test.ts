import { Host } from "../apps/host/host.ts";
import { HostStore } from "../apps/host/store.ts";
import { loadHostConfig } from "../apps/host/config.ts";
import { generateKeyPair, sign, verificationPhrase } from "../packages/api/auth.ts";
import { compileRoutes, desiredRoutes } from "../apps/operator/model.ts";
import { hostResources, KubernetesClient } from "../apps/operator/main.ts";
import {
  type ConnectorEvent,
  type ConnectorState,
  superviseConnector,
  transition,
} from "../apps/connector/supervisor.ts";
import { assert, assertEquals, assertThrows } from "./assert.ts";
import { runInNewContext } from "node:vm";
import {
  BunnyHoleClient,
  type HostCredentials,
  type Session,
} from "../apps/connector/client.ts";

const gateway = {
  kind: "Gateway",
  metadata: {
    name: "public",
    namespace: "infra",
    annotations: { "bunny-hole.dev/host": "production" },
  },
  spec: {
    gatewayClassName: "bunny-hole",
    listeners: [{
      name: "http",
      protocol: "HTTP",
      port: 80,
      allowedRoutes: { namespaces: { from: "All" } },
    }],
  },
};
const route = {
  kind: "HTTPRoute",
  metadata: { name: "app", namespace: "tenant" },
  spec: {
    parentRefs: [{ name: "public", namespace: "infra" }],
    hostnames: ["app.example.com"],
    rules: [{ backendRefs: [{ name: "app", port: 8080 }] }],
  },
};

Deno.test("hardening: Gateway attachment and host delegation use separate boundaries", () => {
  assertEquals(desiredRoutes([gateway, route]).length, 1);
  const g = structuredClone(gateway);
  g.metadata.annotations["bunny-hole.dev/host"] = "system/production";
  assertThrows(() => desiredRoutes([g, route]), /host requires ReferenceGrant/);
  const grant = {
    kind: "ReferenceGrant",
    metadata: { namespace: "system" },
    spec: {
      from: [{
        group: "gateway.networking.k8s.io",
        kind: "Gateway",
        namespace: "infra",
      }],
      to: [{ group: "bunny-hole.dev", kind: "BunnyHoleHost", name: "production" }],
    },
  };
  assertEquals(desiredRoutes([g, route, grant])[0].hostRef, "system/production");
  const hosts = [{
    kind: "BunnyHoleHost",
    metadata: { name: "production", namespace: "tenant" },
    spec: {
      url: "https://host.example.com",
      credentialsSecretRef: { name: "central" },
    },
  }];
  assertEquals(hostResources(hosts, "system"), []);
});

Deno.test("hardening: unsupported policy isolates the affected host", () => {
  const bad = structuredClone(route);
  bad.metadata.name = "bad";
  Object.assign(bad.spec.rules[0], {
    matches: [{ path: { type: "PathPrefix", value: "/admin" } }],
  });
  const other = structuredClone(gateway);
  other.metadata.name = "other";
  other.metadata.annotations["bunny-hole.dev/host"] = "other";
  const otherRoute = structuredClone(route);
  otherRoute.spec.parentRefs[0].name = "other";
  const result = compileRoutes([gateway, route, bad, other, otherRoute]);
  assert(result.blockedHosts.has("infra/production"));
  assert(!result.blockedHosts.has("infra/other"));
  assertEquals(
    result.routes.filter((item) => item.hostRef === "infra/other").length,
    1,
  );
});

Deno.test("hardening: service account rotation is observed on the next request", async () => {
  const path = await Deno.makeTempFile();
  const client = Deno.createHttpClient({});
  const seen: string[] = [];
  try {
    const kube = new KubernetesClient(
      new URL("https://kube.example.com"),
      path,
      client,
      ((_url, init) => {
        seen.push(new Headers(init?.headers).get("authorization")!);
        return Promise.resolve(new Response(JSON.stringify({ items: [] })));
      }) as typeof fetch,
    );
    await Deno.writeTextFile(path, "first");
    await kube.gatewayResources();
    await Deno.writeTextFile(path, "second");
    await kube.gatewayResources();
    assertEquals(seen.slice(0, 4), Array(4).fill("Bearer first"));
    assertEquals(seen.slice(4), Array(4).fill("Bearer second"));
  } finally {
    client.close();
    await Deno.remove(path);
  }
});

Deno.test("hardening: connector transition table rejects every illegal state event pair", () => {
  const states: ConnectorState[] = [
    "idle",
    "authenticating",
    "running",
    "backoff",
    "stopped",
  ];
  const events: ConnectorEvent[] = [
    "start",
    "authenticated",
    "failed",
    "retry",
    "stop",
  ];
  const legal: Record<string, ConnectorState> = {
    "idle/start": "authenticating",
    "idle/stop": "stopped",
    "authenticating/authenticated": "running",
    "authenticating/failed": "backoff",
    "authenticating/stop": "stopped",
    "running/failed": "backoff",
    "running/stop": "stopped",
    "backoff/retry": "authenticating",
    "backoff/stop": "stopped",
    "stopped/stop": "stopped",
  };
  for (const state of states) {
    for (const event of events) {
      const next = legal[`${state}/${event}`];
      if (next) assertEquals(transition(state, event), next);
      else assertThrows(() => transition(state, event), /illegal/);
    }
  }
  let state: ConnectorState = "idle";
  for (
    const event of [
      "start",
      "authenticated",
      "failed",
      "retry",
      "failed",
      "retry",
      "authenticated",
      "stop",
    ] as const
  ) state = transition(state, event);
  assertEquals(state, "stopped");
});

Deno.test("hardening: supervisor retries authentication and process exits with fresh sessions", async () => {
  const controller = new AbortController();
  const acquired: string[] = [];
  const executed: string[] = [];
  let attempts = 0;
  let waits = 0;
  await superviseConnector({
    client: new BunnyHoleClient("https://host.test"),
    credentials: {} as HostCredentials,
    signal: controller.signal,
    executable: "unused",
    transport: "wss",
    acquire: () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error("authentication unavailable"));
      }
      const token = `session-${attempts}`;
      acquired.push(token);
      return Promise.resolve({ accessToken: token } as Session);
    },
  }, {
    run: (options) => {
      executed.push(options.session.accessToken);
      if (executed.length === 1) return Promise.reject(new Error("process failed"));
      if (executed.length === 3) controller.abort();
      return Promise.resolve(0);
    },
    wait: () => {
      waits++;
      return Promise.resolve();
    },
  });
  assertEquals(attempts, 4);
  assertEquals(executed, acquired);
  assertEquals(waits, 4);
});

async function fixture() {
  const identity = await generateKeyPair();
  const store = new HostStore(":memory:");
  const config = loadHostConfig({
    BUNNY_HOLE_DEVELOPMENT: "true",
    BUNNY_HOLE_PUBLIC_URL: "http://host.test",
    BUNNY_HOLE_OWNER_PUBLIC_KEY: identity.publicKey,
  });
  return {
    identity,
    store,
    host: new Host(config, store, identity, { info() {}, warn() {}, error() {} }),
  };
}
function request(path: string, body: unknown) {
  return new Request("http://host.test" + path, {
    method: "POST",
    headers: { host: "host.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("hardening: concurrent approval links do not invalidate each other", async () => {
  const { host, store } = await fixture();
  try {
    const keys = await generateKeyPair();
    const { id: enrollmentId } = await (await host.handle(
      request("/api/v1/enrollments", {
        kind: "device",
        name: "device",
        publicKey: keys.publicKey,
      }),
    )).json();
    const body = {
      enrollmentId,
      grants: {
        exactHostnames: ["app.example.com"],
        hostnameSuffixes: [],
        protocols: ["http"],
        maxRoutes: 1,
      },
    };
    const first =
      await (await host.handle(request("/api/v1/admin/enrollment-approvals", body)))
        .json();
    await host.handle(request("/api/v1/admin/enrollment-approvals", body));
    const options = await host.handle(
      request("/api/v1/admin/enrollment-approvals/options", {
        flowToken: new URL(first.url).hash.slice(1),
      }),
    );
    assertEquals(await options.json(), { error: "no passkeys are registered" });
  } finally {
    host.shutdown();
    store[Symbol.dispose]();
  }
});

Deno.test("hardening: shutdown cancels unfinished control uploads", async () => {
  const { host, store } = await fixture();
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    const pending = host.handle(
      new Request("http://host.test/api/v1/admin/owner/challenge", {
        method: "POST",
        headers: { host: "host.test", "content-type": "application/json" },
        body: stream,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    host.shutdown();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      pending.then((response) => response.status),
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve("shutdown stalled"), 100);
      }),
    ]);
    clearTimeout(deadline);
    await pending;
    assertEquals(result, 400);
  } finally {
    host.shutdown();
    store[Symbol.dispose]();
  }
});

Deno.test("hardening: owner proof revokes passkeys and removes only revoked enrollments", async () => {
  const { host, store, identity } = await fixture();
  try {
    store.savePasskey({
      id: "credential",
      name: "lost",
      publicKey: new Uint8Array([1]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
    assertEquals(
      (await host.handle(
        new Request("http://host.test/api/v1/admin/passkeys/credential", {
          method: "DELETE",
          headers: { host: "host.test" },
        }),
      )).status,
      403,
    );
    const { challenge } = await (await host.handle(
      request("/api/v1/admin/owner/challenge", { purpose: "revoke-passkey" }),
    )).json();
    const signature = await sign(identity.privateKey, "revoke-passkey", [
      identity.publicKey,
      "credential",
      challenge,
    ]);
    const init = {
      method: "DELETE",
      headers: {
        host: "host.test",
        "x-bunny-hole-owner-challenge": challenge,
        "x-bunny-hole-owner-signature": signature,
      },
    };
    assertEquals(
      (await host.handle(
        new Request("http://host.test/api/v1/admin/passkeys/credential", init),
      )).status,
      204,
    );
    assertEquals(store.listPasskeys(), []);
    assertEquals(
      (await host.handle(
        new Request("http://host.test/api/v1/admin/passkeys/credential", init),
      )).status,
      403,
    );
    const keys = await generateKeyPair();
    const { id } = await (await host.handle(
      request("/api/v1/enrollments", {
        kind: "device",
        name: "person",
        publicKey: keys.publicKey,
      }),
    )).json();
    assert(!store.purgeEnrollment(id));
    store.revokeEnrollment(id);
    assert(store.purgeEnrollment(id));
    assertEquals(store.getEnrollment(id), undefined);
  } finally {
    host.shutdown();
    store[Symbol.dispose]();
  }
});

Deno.test("hardening: verification phrase encodes 64 bits", async () => {
  const pair = await generateKeyPair();
  assertEquals((await verificationPhrase(pair.publicKey)).split("-").length, 16);
});

Deno.test("hardening: passkey cancellation permits retry and details reflow", async () => {
  const { host, store } = await fixture();
  try {
    const html = await (await host.handle(
      new Request("http://host.test/_bunny/admin/approve", {
        headers: { host: "host.test" },
      }),
    )).text();
    assert(html.includes("white-space:pre-wrap"));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    const button = {
      disabled: true,
      onclick: undefined as unknown as () => Promise<void>,
    };
    const status = { textContent: "" };
    const details = { textContent: "" };
    runInNewContext(script, {
      location: { hash: "#flow", pathname: "/_bunny/admin/approve" },
      history: { replaceState() {} },
      document: {
        querySelector(selector: string) {
          return selector === "#continue"
            ? button
            : selector === "#status"
            ? status
            : details;
        },
      },
      fetch: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              enrollment: {
                id: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
                name: "<untrusted display name>",
                verificationPhrase: "amber-birch",
              },
              grants: {
                exactHostnames: ["app.example.com"],
                hostnameSuffixes: [],
                protocols: ["https"],
                maxRoutes: 1,
              },
              options: { challenge: "AA", allowCredentials: [] },
            }),
        }),
      navigator: {
        credentials: {
          get: () => {
            const e = new Error("Cancelled");
            e.name = "NotAllowedError";
            throw e;
          },
        },
      },
      Uint8Array,
      atob,
      btoa,
      Error,
    });
    await new Promise((r) => setTimeout(r, 0));
    assert(details.textContent.includes("Exact hostnames: app.example.com"));
    assert(details.textContent.includes("Maximum routes: 1"));
    assertEquals(button.disabled, false);
    await button.onclick();
    assertEquals(button.disabled, false);
    assert(status.textContent.includes("try again"));
  } finally {
    host.shutdown();
    store[Symbol.dispose]();
  }
});
