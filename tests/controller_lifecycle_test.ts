import { runCompose } from "../apps/compose/main.ts";
import { hostResources, KubernetesClient, runOperator } from "../apps/operator/main.ts";
import { compileRoutes, desiredRoutes } from "../apps/operator/model.ts";
import { BunnyHoleClient, type Session } from "../apps/connector/client.ts";
import { saveState } from "../apps/connector/state.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import type { Route } from "../packages/api/mod.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "./assert.ts";

const key = await generateKeyPair();
const credentials = {
  url: "https://hole.example.com/",
  identityPublicKey: key.publicKey,
  enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
  ...key,
};
const baseRoute: Route = {
  id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
  enrollmentId: credentials.enrollmentId,
  name: "manual",
  protocol: "http",
  hostname: "app.test",
  targetHost: "127.0.0.1",
  targetPort: 3000,
  allowPrivateNetwork: false,
  active: true,
};
function session(routes: Route[] = []): Session {
  return {
    enrollmentId: credentials.enrollmentId,
    accessToken: "token",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    descriptor: {
      apiVersion: 1,
      name: "hole.example.com",
      managementUrl: credentials.url,
      identityPublicKey: key.publicKey,
      connectorHost: "connect.example.com",
      connectorPort: 443,
      connectorTransports: ["wss"],
      capabilities: ["http", "https"],
    },
    routes,
  };
}
class Control extends BunnyHoleClient {
  calls: string[] = [];
  constructor(readonly routes: Route[] = []) {
    super(credentials.url);
  }
  override session(): Promise<Session> {
    this.calls.push("session");
    return Promise.resolve(session([...this.routes]));
  }
  override deleteRoute(_session: Session, id: string): Promise<void> {
    this.calls.push(`delete:${id}`);
    this.routes.splice(this.routes.findIndex((r) => r.id === id), 1);
    return Promise.resolve();
  }
  override createRoute(
    _session: Session,
    route: Omit<Route, "id" | "enrollmentId" | "active">,
  ): Promise<Route> {
    this.calls.push(`create:${route.name}`);
    const result = {
      ...route,
      id: "rte_CCCCCCCCCCCCCCCCCCCCCCCC",
      enrollmentId: credentials.enrollmentId,
      active: true,
    };
    this.routes.push(result);
    return Promise.resolve(result);
  }
}
const model = {
  services: {
    app: {
      labels: {
        "dev.bunny-hole.host": "home",
        "dev.bunny-hole.name": "app",
        "dev.bunny-hole.hostname": "app.test",
        "dev.bunny-hole.target-port": "3000",
      },
    },
  },
};

Deno.test("Compose plan is credential-free and sync preserves manual and unchanged routes", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/state.json`;
  const original = console.log;
  const lines: string[] = [];
  console.log = (value: unknown) => lines.push(String(value));
  try {
    const signal = new AbortController().signal;
    await runCompose("plan", "/absent", signal, {
      capture: () => Promise.resolve(JSON.stringify(model)),
      client: () => {
        throw new Error("plan must not authenticate");
      },
    });
    assertEquals(JSON.parse(lines[0]).routes[0].name, "compose-app");
    await saveState({ version: 1, hosts: { home: credentials } }, path);
    const client = new Control([{ ...baseRoute }, {
      ...baseRoute,
      name: "compose-app",
      id: "rte_BBBBBBBBBBBBBBBBBBBBBBBB",
    }, { ...baseRoute, name: "compose-stale", id: "rte_DDDDDDDDDDDDDDDDDDDDDDDD" }]);
    await runCompose("sync", path, signal, {
      capture: () => Promise.resolve(JSON.stringify(model)),
      client: () => client,
    });
    assertEquals(client.calls, [
      "session",
      "delete:rte_DDDDDDDDDDDDDDDDDDDDDDDD",
      "session",
    ]);
    assertEquals(client.routes.map((route) => route.name), ["manual", "compose-app"]);
    client.routes[1].targetPort = 4000;
    client.calls = [];
    await runCompose("sync", path, signal, {
      capture: () => Promise.resolve(JSON.stringify(model)),
      client: () => client,
    });
    assertEquals(client.calls, [
      "session",
      "delete:rte_BBBBBBBBBBBBBBBBBBBBBBBB",
      "create:compose-app",
      "session",
    ]);
    assertEquals(client.routes[1].targetPort, 3000);
    await assertRejects(
      () =>
        runCompose("sync", path, signal, {
          capture: () =>
            Promise.resolve(
              JSON.stringify({
                services: {
                  app: {
                    labels: {
                      ...model.services.app.labels,
                      "dev.bunny-hole.host": "missing",
                    },
                  },
                },
              }),
            ),
        }),
      /not configured/,
    );
  } finally {
    console.log = original;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Compose up awaits cancellation of every connector and does not connect empty hosts", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/state.json`;
  try {
    await saveState(
      { version: 1, hosts: { home: credentials, unused: credentials } },
      path,
    );
    const commands: string[][] = [];
    let stopped = false;
    await runCompose("up", path, new AbortController().signal, {
      run: (_command, args) => {
        commands.push(args);
        return Promise.resolve();
      },
      capture: () => Promise.resolve(JSON.stringify(model)),
      client: () => new Control(),
      supervise: (options) => {
        stopped = options.signal.aborted;
        return Promise.resolve();
      },
    });
    assertEquals(commands[0].slice(-3), ["--wait", "--wait-timeout", "120"]);
    assertEquals(stopped, false);
    let calls = 0;
    let cleaned = false;
    const twoHosts = {
      services: {
        ...model.services,
        other: {
          labels: {
            ...model.services.app.labels,
            "dev.bunny-hole.host": "unused",
            "dev.bunny-hole.name": "other",
            "dev.bunny-hole.hostname": "other.test",
          },
        },
      },
    };
    await assertRejects(() =>
      runCompose("up", path, new AbortController().signal, {
        run: () => Promise.resolve(),
        capture: () => Promise.resolve(JSON.stringify(twoHosts)),
        client: () => new Control(),
        supervise: (options) => {
          calls++;
          if (calls === 1) return Promise.reject(new Error("child failed"));
          return new Promise<void>((resolve) =>
            options.signal.addEventListener("abort", () => {
              queueMicrotask(() => {
                cleaned = true;
                resolve();
              });
            }, { once: true })
          );
        },
      }), /child failed/);
    assertEquals(calls, 2);
    assertEquals(cleaned, true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

const hostResource = {
  kind: "BunnyHoleHost",
  metadata: { name: "production", namespace: "default" },
  spec: { url: credentials.url, credentialsSecretRef: { name: "identity" } },
};
const gateway = {
  kind: "Gateway",
  metadata: { name: "public", annotations: { "bunny-hole.dev/host": "production" } },
  spec: {
    gatewayClassName: "bunny-hole",
    listeners: [{ name: "http", protocol: "HTTP" }],
  },
};
const httpRoute = {
  kind: "HTTPRoute",
  metadata: { name: "app" },
  spec: {
    parentRefs: [{ name: "public" }],
    hostnames: ["app.test"],
    rules: [{ backendRefs: [{ name: "app", port: 3000 }] }],
  },
};

Deno.test("operator owns connector replacement, removal and cleanup across reconciliation cycles", async () => {
  const originalNamespace = Deno.env.get("BUNNY_HOLE_CREDENTIALS_NAMESPACE");
  Deno.env.set("BUNNY_HOLE_CREDENTIALS_NAMESPACE", "default");
  const controller = new AbortController();
  let cycle = 0;
  let closes = 0;
  let starts = 0;
  let stops = 0;
  const desired = desiredRoutes([gateway, httpRoute])[0];
  const control = new Control([{
    ...baseRoute,
    id: "rte_DDDDDDDDDDDDDDDDDDDDDDDD",
    name: "k8s-stale",
  }, {
    ...baseRoute,
    name: desired.name,
    targetHost: "old.default.svc",
    allowPrivateNetwork: true,
  }]);
  try {
    await runOperator(controller.signal, {
      kube: {
        gatewayResources: () =>
          Promise.resolve(cycle < 3 ? [hostResource, gateway, httpRoute] : []),
        credentials: () => Promise.resolve(credentials),
        close: () => {
          closes++;
        },
      },
      client: () => control,
      run: (options) => {
        starts++;
        return new Promise<number>((resolve) =>
          options.signal!.addEventListener("abort", () => {
            stops++;
            resolve(0);
          }, { once: true })
        );
      },
      wait: () => {
        cycle++;
        if (cycle === 2) control.routes[0].id = "rte_BBBBBBBBBBBBBBBBBBBBBBBB";
        if (cycle === 4) controller.abort();
        return Promise.resolve();
      },
    });
    assertEquals(starts, 2);
    assertEquals(stops, 2);
    assertEquals(closes, 1);
    assert(control.calls.includes("delete:rte_DDDDDDDDDDDDDDDDDDDDDDDD"));
    assert(control.calls.includes(`create:${desired.name}`));
  } finally {
    if (originalNamespace === undefined) {
      Deno.env.delete("BUNNY_HOLE_CREDENTIALS_NAMESPACE");
    } else Deno.env.set("BUNNY_HOLE_CREDENTIALS_NAMESPACE", originalNamespace);
  }
});

Deno.test("operator isolates invalid policies, reports process failures and stops on API failure", async () => {
  const previous = Deno.env.get("BUNNY_HOLE_CREDENTIALS_NAMESPACE");
  Deno.env.set("BUNNY_HOLE_CREDENTIALS_NAMESPACE", "default");
  try {
    for (
      const failure of [
        "policy",
        "credentials",
        "url",
        "process",
        "exit",
        "api",
      ] as const
    ) {
      const controller = new AbortController();
      let closes = 0;
      let runs = 0;
      await runOperator(controller.signal, {
        kube: {
          gatewayResources: () =>
            failure === "api"
              ? Promise.reject(new Error("API unavailable"))
              : Promise.resolve([
                hostResource,
                gateway,
                failure === "policy"
                  ? { ...httpRoute, spec: { ...httpRoute.spec, rules: [] } }
                  : httpRoute,
              ]),
          credentials: () =>
            failure === "credentials" ? Promise.reject("denied") : Promise.resolve(
              failure === "url"
                ? { ...credentials, url: "https://wrong.example.com/" }
                : credentials,
            ),
          close: () => {
            closes++;
          },
        },
        client: () => new Control(),
        run: () => {
          runs++;
          return failure === "process"
            ? Promise.reject("process failed")
            : Promise.resolve(1);
        },
        wait: async () => {
          await Promise.resolve();
          controller.abort();
        },
      });
      assertEquals(runs, failure === "process" || failure === "exit" ? 1 : 0);
      assertEquals(closes, 1);
    }
  } finally {
    if (previous === undefined) Deno.env.delete("BUNNY_HOLE_CREDENTIALS_NAMESPACE");
    else Deno.env.set("BUNNY_HOLE_CREDENTIALS_NAMESPACE", previous);
  }
});

Deno.test("Kubernetes resource and Secret readers reject failures and reload rotated tokens", async () => {
  assertEquals(
    hostResources([null, {}, { ...hostResource, spec: {} }, {
      ...hostResource,
      spec: { ...hostResource.spec, transport: "tcp" },
    }], "default"),
    [],
  );
  const directory = await Deno.makeTempDir();
  const tokenPath = `${directory}/token`;
  const client = Deno.createHttpClient({});
  let response = new Response("{}", { status: 404 });
  const authorization: string[] = [];
  const kube = new KubernetesClient(
    new URL("https://kube.test"),
    tokenPath,
    client,
    (_input, init) => {
      authorization.push(new Headers(init?.headers).get("authorization")!);
      return Promise.resolve(response.clone());
    },
  );
  try {
    await Deno.writeTextFile(tokenPath, "first\n");
    assertEquals(await kube.gatewayResources(), []);
    await Deno.writeTextFile(tokenPath, "second");
    response = Response.json({ items: [1] });
    assertEquals(await kube.gatewayResources(), [1, 1, 1, 1]);
    assertEquals(authorization.slice(-4), Array(4).fill("Bearer second"));
    response = Response.json({
      data: { "config.json": btoa(JSON.stringify(credentials)) },
    });
    assertEquals(await kube.credentials("default", "identity"), credentials);
    for (
      const data of [{}, { data: {} }, { data: { "config.json": "!" } }, {
        data: { "config.json": btoa("{}") },
      }]
    ) {
      response = Response.json(data);
      await assertRejects(() => kube.credentials("default", "identity"), /Secret/);
    }
    response = new Response("{}", { status: 403 });
    await assertRejects(() => kube.gatewayResources(), /list failed/);
    await assertRejects(
      () => kube.credentials("default", "identity"),
      /request failed/,
    );
    response = Response.json({ items: "invalid" });
    assertEquals(await kube.gatewayResources(), []);
    await Deno.writeTextFile(tokenPath, " ");
    await assertRejects(() => kube.gatewayResources(), /token unavailable/);
  } finally {
    kube.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Gateway policy rejects ambiguous attachments and unsupported listener and backend shapes", () => {
  for (
    const spec of [{ ...gateway.spec, listeners: [] }, {
      ...gateway.spec,
      listeners: [{ name: "http", protocol: "HTTP", allowedRoutes: { kinds: "bad" } }],
    }, {
      ...gateway.spec,
      listeners: [{ name: "http", protocol: "HTTP", allowedRoutes: { kinds: [null] } }],
    }, {
      ...gateway.spec,
      listeners: [{
        name: "http",
        protocol: "HTTP",
        allowedRoutes: { namespaces: { from: "Selector" } },
      }],
    }]
  ) assertThrows(() => desiredRoutes([{ ...gateway, spec }, httpRoute]));
  for (
    const spec of [
      { ...httpRoute.spec, hostnames: [] },
      { ...httpRoute.spec, hostnames: ["app.test", "app.test"] },
      { ...httpRoute.spec, rules: [] },
      {
        ...httpRoute.spec,
        rules: [{ backendRefs: [{ name: "app", port: 3000, weight: 2 }] }],
      },
      { ...httpRoute.spec, parentRefs: [{ name: "public" }, { name: "public" }] },
    ]
  ) assertThrows(() => desiredRoutes([gateway, { ...httpRoute, spec }]));
  const wildcard = {
    ...gateway,
    spec: {
      ...gateway.spec,
      listeners: [{ name: "http", protocol: "HTTP", hostname: "*.test" }],
    },
  };
  assertEquals(desiredRoutes([wildcard, httpRoute]).length, 1);
  for (const hostname of ["test", "a.b.test", "test.attacker.com"]) {
    assertThrows(() =>
      desiredRoutes([wildcard, {
        ...httpRoute,
        spec: { ...httpRoute.spec, hostnames: [hostname] },
      }])
    );
  }
  assertEquals(
    compileRoutes([{ ...gateway, spec: { ...gateway.spec, listeners: [] } }]).errors,
    ["invalid Gateway"],
  );
  assertEquals(
    desiredRoutes([gateway, {
      ...httpRoute,
      spec: {
        ...httpRoute.spec,
        parentRefs: [null, { name: "absent" }, { name: "public", kind: "Service" }],
      },
    }]),
    [],
  );
});

Deno.test("Compose command adapters report process failures and decode plan output", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const executable = `${directory}/compose`;
  const previous = Deno.env.get("BUNNY_HOLE_COMPOSE_COMMAND");
  const original = console.log;
  const lines: string[] = [];
  Deno.env.set("BUNNY_HOLE_COMPOSE_COMMAND", executable);
  console.log = (value: unknown) => lines.push(String(value));
  try {
    await Deno.writeTextFile(
      executable,
      `#!/bin/sh\nprintf '%s' '${JSON.stringify(model)}'\n`,
      { mode: 0o700 },
    );
    await runCompose("plan", "/absent", new AbortController().signal);
    assertEquals(JSON.parse(lines[0]).routes.length, 1);
    await Deno.writeTextFile(
      executable,
      "#!/bin/sh\necho 'configuration rejected' >&2\nexit 7\n",
    );
    await assertRejects(
      () => runCompose("plan", "/absent", new AbortController().signal),
      /configuration rejected/,
    );
    await assertRejects(
      () => runCompose("up", "/absent", new AbortController().signal),
      /failed \(7\)/,
    );
  } finally {
    console.log = original;
    if (previous === undefined) Deno.env.delete("BUNNY_HOLE_COMPOSE_COMMAND");
    else Deno.env.set("BUNNY_HOLE_COMPOSE_COMMAND", previous);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("operator API failure and shutdown await a live connector and close the HTTP client", async () => {
  const previous = Deno.env.get("BUNNY_HOLE_CREDENTIALS_NAMESPACE");
  Deno.env.set("BUNNY_HOLE_CREDENTIALS_NAMESPACE", "default");
  try {
    for (const failApi of [false, true]) {
      const controller = new AbortController();
      let cycles = 0;
      let stops = 0;
      let closed = false;
      await runOperator(controller.signal, {
        kube: {
          gatewayResources: () =>
            failApi && cycles > 0
              ? Promise.reject("API failed")
              : Promise.resolve([hostResource]),
          credentials: () => Promise.resolve(credentials),
          close: () => {
            closed = true;
          },
        },
        client: () => new Control(),
        run: (options) =>
          new Promise<number>((resolve) =>
            options.signal!.addEventListener("abort", () => {
              stops++;
              resolve(0);
            }, { once: true })
          ),
        wait: () => {
          cycles++;
          if (!failApi || cycles > 1) controller.abort();
          return Promise.resolve();
        },
      });
      assertEquals(stops, 1);
      assertEquals(closed, true);
    }
    const controller = new AbortController();
    await runOperator(controller.signal, {
      kube: {
        gatewayResources: () => {
          setTimeout(() => controller.abort(), 1);
          return Promise.resolve([]);
        },
        credentials: () => Promise.resolve(credentials),
        close() {},
      },
    });
    const stopped = new AbortController();
    stopped.abort();
    await runOperator(stopped.signal, {
      kube: {
        gatewayResources: () => {
          throw new Error("must not read resources");
        },
        credentials: () => Promise.resolve(credentials),
        close() {},
      },
    });
    Deno.env.set("BUNNY_HOLE_CREDENTIALS_NAMESPACE", "Bad/namespace");
    await assertRejects(() => runOperator(stopped.signal), /credentials namespace/);
  } finally {
    if (previous === undefined) Deno.env.delete("BUNNY_HOLE_CREDENTIALS_NAMESPACE");
    else Deno.env.set("BUNNY_HOLE_CREDENTIALS_NAMESPACE", previous);
  }
});

Deno.test("Kubernetes bootstrap reads the configured CA and accepts IPv6 API hosts", async () => {
  const directory = await Deno.makeTempDir();
  const previousHost = Deno.env.get("KUBERNETES_SERVICE_HOST");
  try {
    const result = await new Deno.Command("openssl", {
      args: [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${directory}/key.pem`,
        "-out",
        `${directory}/ca.crt`,
        "-subj",
        "/CN=kube.test",
        "-days",
        "1",
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(result.code, 0);
    for (const host of ["kube.test", "::1", "[::1]"]) {
      Deno.env.set("KUBERNETES_SERVICE_HOST", host);
      const kube = await KubernetesClient.create(undefined, directory);
      kube.close();
    }
  } finally {
    if (previousHost === undefined) Deno.env.delete("KUBERNETES_SERVICE_HOST");
    else Deno.env.set("KUBERNETES_SERVICE_HOST", previousHost);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("backend delegation requires the exact source namespace, kind and target Service", () => {
  const cross = {
    ...httpRoute,
    spec: {
      ...httpRoute.spec,
      rules: [{ backendRefs: [{ name: "app", namespace: "backend", port: 3000 }] }],
    },
  };
  assertThrows(() => desiredRoutes([gateway, cross]), /ReferenceGrant/);
  const grant = {
    kind: "ReferenceGrant",
    metadata: { namespace: "backend" },
    spec: {
      from: [{
        group: "gateway.networking.k8s.io",
        kind: "HTTPRoute",
        namespace: "default",
      }],
      to: [{ group: "", kind: "Service", name: "app" }],
    },
  };
  assertEquals(desiredRoutes([gateway, cross, grant])[0].targetHost, "app.backend.svc");
  assertThrows(
    () =>
      desiredRoutes([gateway, cross, {
        ...grant,
        spec: { ...grant.spec, to: [{ group: "", kind: "Service", name: "other" }] },
      }]),
    /ReferenceGrant/,
  );
  assertEquals(
    desiredRoutes([
      { ...gateway, metadata: { ...gateway.metadata, annotations: {} } },
      httpRoute,
    ]),
    [],
  );
  assertThrows(
    () =>
      desiredRoutes([{
        ...gateway,
        metadata: {
          ...gateway.metadata,
          annotations: { "bunny-hole.dev/host": "invalid/reference/extra" },
        },
      }, httpRoute]),
    /host reference/,
  );
  assertEquals(
    desiredRoutes([{
      ...gateway,
      spec: {
        ...gateway.spec,
        listeners: [null, { protocol: "HTTPS", name: "tls" }, { protocol: "HTTP" }],
      },
    }, httpRoute]),
    [],
  );
});
