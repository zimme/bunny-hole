import { createServer } from "node:http";
import { once } from "node:events";
import { dockerContainers, routesFromContainers } from "../apps/compose/docker.ts";
import { serveCompose } from "../apps/compose/controller.ts";
import { BunnyHoleClient, type Session } from "../apps/connector/client.ts";
import { saveState } from "../apps/connector/state.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import type { Route } from "../packages/api/mod.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "./assert.ts";

const labels = {
  "com.docker.compose.project": "home",
  "com.docker.compose.service": "app",
  "dev.bunny-hole.host": "home",
  "dev.bunny-hole.hostname": "app.test",
  "dev.bunny-hole.target-port": "3000",
  "dev.bunny-hole.allow-private-network": "true",
};
function container(changes = {}, state = "running") {
  return { State: state, Labels: { ...labels, ...changes } };
}

Deno.test("Compose service discovery is project-scoped, opt-in, bounded and replica-consistent", () => {
  const route = routesFromContainers([container(), container()], "home")[0];
  assertEquals(route.targetHost, "app");
  assertEquals(route.name, "compose-home-app");
  assertEquals(
    routesFromContainers([
      container({ "com.docker.compose.project": "other" }),
      container({}, "exited"),
      // cspell:ignore oneoff
      container({ "com.docker.compose.oneoff": "True" }),
      { State: "running", Labels: { "com.docker.compose.project": "home" } },
    ], "home"),
    [],
  );
  for (const project of ["", "Bad", "../home", "x".repeat(64)]) {
    assertThrows(() => routesFromContainers([], project), /project/);
  }
  for (
    const value of [null, Array(1025).fill(container()), [null], [{ Labels: null }]]
  ) {
    assertThrows(() => routesFromContainers(value, "home"), /Docker/);
  }
  for (
    const changes of [
      { "com.docker.compose.service": "" },
      { "dev.bunny-hole.allow-private-network": "false" },
      { "dev.bunny-hole.protocol": 42 },
    ]
  ) assertThrows(() => routesFromContainers([container(changes)], "home"));
  assertThrows(() =>
    routesFromContainers([
      container(),
      container({
        "dev.bunny-hole.hostname": "changed.test",
      }),
    ], "home"), /replicas/);
  for (
    const changes of [
      { "dev.bunny-hole.hostname": "app.test" },
      { "dev.bunny-hole.hostname": "other.test", "dev.bunny-hole.name": "home-app" },
    ]
  ) {
    assertThrows(() =>
      routesFromContainers([
        container(),
        container({
          "com.docker.compose.service": "other",
          ...changes,
        }),
      ], "home"), /duplicate/);
  }
});

Deno.test("Docker discovery uses only filtered GETs and bounds responses, errors and cancellation", async () => {
  const directory = await Deno.makeTempDir();
  const socketPath = `${directory}/docker.sock`;
  let body: string | Uint8Array = JSON.stringify([container()]);
  let status = 200;
  let stall = false;
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url!);
    assertEquals(request.method, "GET");
    assertEquals(
      JSON.parse(new URL(request.url!, "http://local").searchParams.get("filters")!),
      {
        label: ["com.docker.compose.project=home"],
      },
    );
    if (stall) return;
    response.writeHead(status);
    response.end(body);
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    assertEquals(
      await dockerContainers(
        "home",
        new AbortController().signal,
        `unix://${socketPath}`,
      ),
      [container()],
    );
    for (const value of ["{", new Uint8Array([255]), "x".repeat(4 * 1024 * 1024 + 1)]) {
      body = value;
      await assertRejects(
        () =>
          dockerContainers(
            "home",
            new AbortController().signal,
            `unix://${socketPath}`,
          ),
        /JSON|4 MiB/,
      );
    }
    status = 403;
    body = "private daemon message";
    await assertRejects(
      () =>
        dockerContainers("home", new AbortController().signal, `unix://${socketPath}`),
      /^Docker container discovery failed$/,
    );
    for (
      const endpoint of [
        "ftp://host",
        "http://user@host",
        "http://host/path",
        "http://host/?x",
        "http://host/#x",
        "unix://host/path",
        "unix:",
      ]
    ) {
      await assertRejects(
        () => dockerContainers("home", new AbortController().signal, endpoint),
        /endpoint/,
      );
    }
    await assertRejects(
      () =>
        dockerContainers("Bad", new AbortController().signal, `unix://${socketPath}`),
      /project/,
    );
    stall = true;
    const controller = new AbortController();
    const pending = dockerContainers("home", controller.signal, `unix://${socketPath}`);
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assertRejects(() => pending);
    assert(calls.length > 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    await Deno.remove(directory, { recursive: true });
  }
  const tcp = createServer((_request, response) => response.end("[]"));
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const address = tcp.address();
  assert(address && typeof address !== "string");
  try {
    assertEquals(
      await dockerContainers(
        "home",
        new AbortController().signal,
        `tcp://127.0.0.1:${address.port}`,
      ),
      [],
    );
  } finally {
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }
});

Deno.test("Compose service reconciles labels without Docker CLI, keeps healthy sessions and awaits every child", async () => {
  const directory = await Deno.makeTempDir();
  const configPath = `${directory}/config.json`;
  const key = await generateKeyPair();
  const credentials = {
    ...key,
    identityPublicKey: key.publicKey,
    enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    url: "https://hole.example.com/",
  };
  const manual: Route = {
    id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
    enrollmentId: credentials.enrollmentId,
    name: "manual",
    protocol: "http",
    hostname: "manual.test",
    targetHost: "127.0.0.1",
    targetPort: 3000,
    allowPrivateNetwork: false,
    active: true,
  };
  class Client extends BunnyHoleClient {
    routes: Route[] = [manual, {
      ...manual,
      id: "rte_BBBBBBBBBBBBBBBBBBBBBBBB",
      name: "compose-stale",
    }];
    calls = 0;
    override session(): Promise<Session> {
      this.calls++;
      return Promise.resolve({
        enrollmentId: credentials.enrollmentId,
        accessToken: `token-${this.calls}`,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        routes: [...this.routes],
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
      });
    }
    override deleteRoute(_session: Session, id: string) {
      this.routes = this.routes.filter((route) => route.id !== id);
      return Promise.resolve();
    }
    override createRoute(
      _session: Session,
      route: Omit<Route, "id" | "enrollmentId" | "active">,
    ) {
      assertEquals("host" in route, false);
      const created = {
        ...route,
        id: `rte_${String(this.calls).padStart(24, "A")}`,
        enrollmentId: credentials.enrollmentId,
        active: true,
      };
      this.routes.push(created);
      return Promise.resolve(created);
    }
  }
  try {
    await saveState({ version: 1, hosts: { home: credentials } }, configPath);
    for (const failure of [false, true]) {
      const controller = new AbortController();
      const client = new Client(credentials.url);
      let cycle = 0;
      let starts = 0;
      let stops = 0;
      await serveCompose("home", configPath, controller.signal, {
        client: () => client,
        containers: () => {
          if (failure && cycle === 2) {
            return Promise.reject(new Error("private Docker failure"));
          }
          return Promise.resolve(
            cycle < 3
              ? [container(cycle === 2 ? { "dev.bunny-hole.target-port": "4000" } : {})]
              : [],
          );
        },
        run: (options) => {
          starts++;
          return new Promise<number>((resolve) =>
            options.signal!.addEventListener("abort", () => {
              queueMicrotask(() => {
                stops++;
                resolve(0);
              });
            }, { once: true })
          );
        },
        wait: () => {
          cycle++;
          if (cycle === 4) controller.abort();
          return Promise.resolve();
        },
      });
      assertEquals(starts, failure ? 1 : 2);
      assertEquals(stops, starts);
      assertEquals(client.routes, [manual]);
    }
    for (
      const errorCase of [
        "unknown",
        "policy",
        "credentials",
        "process",
        "exit",
        "removed-host",
        "duplicate-enrollment",
      ]
    ) {
      const controller = new AbortController();
      let cycle = 0;
      let stopped = false;
      const client = new Client(credentials.url);
      await saveState({ version: 1, hosts: { home: credentials } }, configPath);
      if (errorCase === "duplicate-enrollment") {
        await saveState({
          version: 1,
          hosts: { home: credentials, alias: credentials },
        }, configPath);
      }
      await serveCompose("home", configPath, controller.signal, {
        client: () => client,
        containers: () =>
          Promise.resolve(
            errorCase === "unknown"
              ? [container({ "dev.bunny-hole.host": "missing" })]
              : errorCase === "policy"
              ? [container({ "dev.bunny-hole.allow-private-network": "false" })]
              : errorCase === "removed-host" && cycle > 0
              ? []
              : [container()],
          ),
        run: (options) => {
          if (errorCase === "process") return Promise.reject(new Error("child failed"));
          if (errorCase === "exit") return Promise.resolve(1);
          return new Promise<number>((resolve) =>
            options.signal!.addEventListener("abort", () => {
              stopped = true;
              resolve(0);
            }, { once: true })
          );
        },
        wait: async () => {
          cycle++;
          if (errorCase === "credentials") await Deno.writeTextFile(configPath, "{}");
          if (errorCase === "removed-host") {
            await saveState({ version: 1, hosts: {} }, configPath);
          }
          if (cycle === 2) controller.abort();
        },
      });
      if (errorCase === "credentials" || errorCase === "removed-host") {
        assertEquals(stopped, true);
      }
      if (errorCase === "duplicate-enrollment") assertEquals(client.calls, 0);
    }
    // Parent shutdown must interrupt discovery while an owned connector is live.
    const interrupted = new AbortController();
    const interruptionClient = new Client(credentials.url);
    let discoveryCalls = 0;
    let childStopped = false;
    await saveState({ version: 1, hosts: { home: credentials } }, configPath);
    await serveCompose("home", configPath, interrupted.signal, {
      client: () => interruptionClient,
      containers: (_project, signal) => {
        if (++discoveryCalls === 1) return Promise.resolve([container()]);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          interrupted.abort();
        });
      },
      run: (options) =>
        new Promise<number>((resolve) => {
          options.signal!.addEventListener("abort", () => {
            childStopped = true;
            resolve(0);
          }, { once: true });
        }),
      wait: () => Promise.resolve(),
    });
    assertEquals(childStopped, true);
    const controller = new AbortController();
    controller.abort();
    await serveCompose("home", configPath, controller.signal);
    await assertRejects(
      () => serveCompose("Bad", configPath, controller.signal),
      /project/,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
