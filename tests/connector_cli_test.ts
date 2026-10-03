import { Host } from "../apps/host/host.ts";
import { HostStore } from "../apps/host/store.ts";
import { main } from "../apps/connector/main.ts";
import { loadState, saveState } from "../apps/connector/state.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assertEquals, assertRejects } from "./assert.ts";

Deno.test("CLI check reports admitted routes without credentials or readiness claims", async () => {
  const directory = await Deno.makeTempDir();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  try {
    const identity = await generateKeyPair();
    const device = await generateKeyPair();
    const credentials = {
      url: "https://hole.example.com/",
      identityPublicKey: identity.publicKey,
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
      identityPublicKey: identity.publicKey,
      capabilities: ["http", "https"],
    };
    const route = {
      id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
      enrollmentId: credentials.enrollmentId,
      name: "task-preview",
      protocol: "http",
      hostname: "preview.example.com",
      targetHost: "127.0.0.1",
      targetPort: 3000,
      allowPrivateNetwork: false,
      active: true,
    };
    const config = `${directory}/config.json`;
    await saveState({
      version: 1,
      defaultHost: "preview",
      hosts: { preview: credentials },
    }, config);
    let changedIdentity = false;
    const paths: string[] = [];
    globalThis.fetch = (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      paths.push(path);
      return Promise.resolve(
        new Response(
          JSON.stringify(
            path.endsWith("bunny-hole")
              ? {
                ...descriptor,
                identityPublicKey: changedIdentity
                  ? device.publicKey
                  : identity.publicKey,
              }
              : path.endsWith("challenge")
              ? {
                challengeId: "chl_AAAAAAAAAAAAAAAAAAAAAAAA",
                challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }
              : {
                accessToken: "secret-admission-token",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                descriptor,
                routes: [route],
              },
          ),
          { headers: { "content-type": "application/json" } },
        ),
      );
    };
    const output: string[] = [];
    console.log = (value: unknown) => output.push(String(value));
    await main(["check", "--config", config, "--host", "preview"]);
    assertEquals(JSON.parse(output[0]), {
      valid: true,
      host: "preview",
      url: credentials.url,
      enrollmentId: credentials.enrollmentId,
      scope: "control-plane",
      routes: [route],
    });
    assertEquals(output.length, 1);
    assertEquals(output[0].includes(device.privateKey), false);
    assertEquals(output[0].includes("secret-admission-token"), false);
    assertEquals(paths, [
      "/.well-known/bunny-hole",
      "/api/v1/session/challenge",
      "/api/v1/session",
    ]);
    changedIdentity = true;
    paths.length = 0;
    await assertRejects(
      () => main(["check", "--config", config]),
      /host identity changed/,
    );
    assertEquals(output.length, 1);
    assertEquals(paths, ["/.well-known/bunny-hole"]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CLI enrolls, approves, inspects, and removes an isolated preview", async () => {
  const directory = await Deno.makeTempDir();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  try {
    const output: string[] = [];
    console.log = (value: unknown) => output.push(String(value));
    const ownerFile = `${directory}/owner.json`;
    await main(["owner", "generate", "--output", ownerFile]);
    const owner = JSON.parse(await Deno.readTextFile(ownerFile));
    const identity = await generateKeyPair();
    using store = new HostStore(`${directory}/state.sqlite`);
    const host = new Host(
      {
        bindAddress: "127.0.0.1",
        port: 8080,
        publicUrl: new URL("http://host.test:8080"),
        statePath: `${directory}/state.sqlite`,
        identityPath: `${directory}/identity.json`,
        ownerPublicKey: owner.publicKey,
        frpsPath: "frps",
        frpBindPort: 7000,
        frpHttpPort: 9080,
        connectorHost: "host.test",
        connectorPort: 7000,
        connectorTransports: ["tcp", "quic"],
        requestTimeoutMs: 1000,
        development: true,
        logFormat: "json",
      },
      store,
      identity,
      { info() {}, warn() {}, error() {} },
    );
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      request.headers.set("host", new URL(request.url).hostname);
      return host.handle(request);
    };
    const config = `${directory}/connector.json`;
    const flags = ["--config", config, "--development"];
    await main([
      "host",
      "add",
      "--name",
      "preview",
      "--url",
      "http://host.test:8080",
      ...flags,
    ]);
    const credentials = (await loadState(config)).hosts.preview;
    assertEquals(output.some((line) => line.includes(credentials.privateKey)), false);
    await main(["host", "list", ...flags]);
    await main(["host", "use", "preview", ...flags]);
    await main(["enrollment", "status", ...flags]);
    assertEquals(JSON.parse(output.at(-1)!).state, "pending");
    const grantFile = `${directory}/grant.json`;
    await Deno.writeTextFile(
      grantFile,
      JSON.stringify({
        exactHostnames: ["preview.example.com"],
        hostnameSuffixes: [],
        protocols: ["http"],
        maxRoutes: 1,
      }),
    );
    await main([
      "enrollment",
      "approve",
      credentials.enrollmentId,
      "--grant",
      grantFile,
      "--passkey",
      ...flags,
    ]);
    assertEquals(output.at(-1)!.includes("/_bunny/admin/approve#flow_"), true);
    await main([
      "enrollment",
      "approve",
      credentials.enrollmentId,
      "--grant",
      grantFile,
      "--owner-key",
      ownerFile,
      ...flags,
    ]);
    await main(["enrollment", "status", ...flags]);
    assertEquals(JSON.parse(output.at(-1)!).state, "active");
    await main([
      "owner",
      "passkey",
      "--owner-key",
      ownerFile,
      "--name",
      "test-owner",
      ...flags,
    ]);
    assertEquals(output.at(-1)!.includes("/_bunny/admin/passkey#flow_"), true);
    await main([
      "route",
      "add",
      "--name",
      "task-preview",
      "--protocol",
      "http",
      "--hostname",
      "preview.example.com",
      "--target",
      "[::1]:3000",
      ...flags,
    ]);
    const route = JSON.parse(output.at(-1)!);
    assertEquals(route.targetHost, "::1");
    await main(["route", "list", ...flags]);
    assertEquals(JSON.parse(output.at(-1)!).routes, [route]);
    await main(["check", ...flags]);
    assertEquals(JSON.parse(output.at(-1)!).routes, [route]);
    // Route deletion leaves the enrollment reusable for the next preview.
    await main(["route", "delete", route.id, ...flags]);
    await main(["route", "list", ...flags]);
    assertEquals(JSON.parse(output.at(-1)!).routes, []);
    await main(["enrollment", "status", ...flags]);
    assertEquals(JSON.parse(output.at(-1)!).state, "active");
    await main([
      "enrollment",
      "revoke",
      credentials.enrollmentId,
      "--owner-key",
      ownerFile,
      ...flags,
    ]);
    await assertRejects(() => main(["check", ...flags]), /host request failed/);
    await assertRejects(
      () => main(["host", "remove", "preview", ...flags]),
      /requires --yes/,
    );
    assertEquals(Boolean((await loadState(config)).hosts.preview), true);
    await main(["host", "remove", "preview", "--yes", ...flags]);
    assertEquals((await loadState(config)).hosts, {});
    assertEquals(output.some((line) => line.includes(owner.privateKey)), false);
    assertEquals(output.some((line) => line.includes(credentials.privateKey)), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("consumer skill can be printed and updated without host configuration", async () => {
  const directory = await Deno.makeTempDir();
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  try {
    const output: string[] = [];
    console.log = (value: unknown) => output.push(String(value));
    globalThis.fetch = () => Promise.reject(new Error("skill export must be offline"));
    await main(["skill"]);
    const skill = output[0];
    assertEquals(skill.startsWith("---\nname: bunny-hole\n"), true);
    assertEquals(skill.includes("bunny-hole route delete ROUTE_ID"), true);
    const path = `${directory}/project/.agents/skills/bunny-hole/SKILL.md`;
    await main(["skill", "--output", path]);
    assertEquals(await Deno.readTextFile(path), skill);
    await Deno.writeTextFile(path, "older consumer guidance\n");
    await main(["skill", "--output", path]);
    assertEquals(await Deno.readTextFile(path), skill);
    for (
      const args of [["--output"], ["--output", path, "--yes"], ["--host", "preview"]]
    ) {
      await assertRejects(() => main(["skill", ...args]), /usage:/);
      assertEquals(await Deno.readTextFile(path), skill);
    }
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});
