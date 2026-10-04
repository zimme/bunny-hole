import { main } from "../apps/connector/main.ts";
import { saveState } from "../apps/connector/state.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assert, assertEquals, assertRejects } from "./assert.ts";

Deno.test("CLI rejects ambiguous flags, missing IDs and unsafe secret flags", async () => {
  for (
    const args of [
      ["unknown"],
      ["compose", "bad"],
      ["compose", "serve"],
      ["compose", "serve", "--project", "Bad"],
      ["host", "add", "--url"],
      ["host", "add", "--url", "https://host.test", "--name", "Bad name"],
      ["host", "use"],
      ["host", "remove"],
      ["route", "delete"],
      ["enrollment", "approve"],
      ["enrollment", "revoke"],
      ["owner", "passkey-revoke"],
      ["enrollment", "purge", "bad/id"],
      ["host", "list", "--config", "a", "--config", "b"],
      ...["token", "private-key", "secret"].map((
        flag,
      ) => ["host", "add", `--${flag}`, "hidden"]),
    ]
  ) await assertRejects(() => main(args));
  const original = console.log;
  const output: string[] = [];
  console.log = (value: unknown) => output.push(String(value));
  try {
    await main(["--help"]);
    await main(["--version"]);
    assert(output[0].includes("Usage:"));
    assert(output[1].startsWith("bunny-hole "));
  } finally {
    console.log = original;
  }
});

Deno.test("CLI owner operations bind proofs, handle errors and reject unsafe ceremony URLs", async () => {
  const directory = await Deno.makeTempDir();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const key = await generateKeyPair();
  const credentials = {
    url: "https://hole.example.com/",
    identityPublicKey: key.publicKey,
    enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    ...key,
  };
  const config = `${directory}/config.json`;
  const owner = `${directory}/owner.json`;
  const grant = `${directory}/grant.json`;
  const flags = ["--config", config, "--owner-key", owner];
  const paths: string[] = [];
  const output: string[] = [];
  let badChallenge = false;
  let status = 200;
  let ceremony: unknown = {
    url: "https://hole.example.com/_bunny/admin/passkey#flow_AAAAAAAAAAAAAAAAAAAAAAAA",
  };
  try {
    console.log = (value: unknown) => output.push(String(value));
    await saveState(
      { version: 1, defaultHost: "home", hosts: { home: credentials } },
      config,
    );
    await Deno.writeTextFile(owner, JSON.stringify(key), { mode: 0o600 });
    await Deno.writeTextFile(
      grant,
      JSON.stringify({
        exactHostnames: ["app.test"],
        hostnameSuffixes: [],
        protocols: ["http"],
        maxRoutes: 1,
      }),
    );
    globalThis.fetch = (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      assertEquals(init?.redirect, "error");
      assert(init?.signal);
      return Promise.resolve(
        Response.json(
          path.endsWith("challenge")
            ? { challenge: badChallenge ? "bad" : "A".repeat(32) }
            : path.endsWith("flows") || path.endsWith("enrollment-approvals")
            ? ceremony
            : {},
          { status },
        ),
      );
    };
    await main(["owner", "passkey-list", ...flags]);
    await main(["owner", "passkey-revoke", "credential", ...flags]);
    await main(["enrollment", "purge", credentials.enrollmentId, ...flags]);
    assert(paths.includes("/api/v1/admin/passkeys/credential"));
    assert(paths.includes(`/api/v1/enrollments/${credentials.enrollmentId}`));
    assertEquals(output.some((line) => line.includes(key.privateKey)), false);
    status = 403;
    await assertRejects(() => main(["owner", "passkey-list", ...flags]), /challenge/);
    status = 200;
    badChallenge = true;
    await assertRejects(() => main(["owner", "passkey-list", ...flags]), /challenge/);
    badChallenge = false;
    for (
      const url of [
        "bad",
        "https://attacker.test/_bunny/admin/passkey#flow_AAAAAAAAAAAAAAAAAAAAAAAA",
        "https://hole.example.com/_bunny/admin/passkey?x=1#flow_AAAAAAAAAAAAAAAAAAAAAAAA",
        "https://hole.example.com/_bunny/admin/passkey#bad",
        "https://hole.example.com/wrong#flow_AAAAAAAAAAAAAAAAAAAAAAAA",
      ]
    ) {
      ceremony = { url };
      await assertRejects(() => main(["owner", "passkey", ...flags]), /ceremony URL/);
    }
    ceremony = {};
    await assertRejects(() => main(["owner", "passkey", ...flags]), /registration/);
    await assertRejects(
      () =>
        main([
          "enrollment",
          "approve",
          credentials.enrollmentId,
          "--grant",
          grant,
          "--passkey",
          ...flags,
        ]),
      /approval/,
    );
    await Deno.writeTextFile(owner, "{}");
    for (
      const args of [["owner", "passkey-list"], ["owner", "passkey"], [
        "enrollment",
        "revoke",
        credentials.enrollmentId,
      ], ["enrollment", "approve", credentials.enrollmentId, "--grant", grant]]
    ) await assertRejects(() => main([...args, ...flags]), /owner key/);
    if (Deno.build.os !== "windows") {
      await Deno.chmod(owner, 0o644);
      await assertRejects(() => main(["owner", "passkey-list", ...flags]), /0600/);
    }
    await assertRejects(
      () => main(["host", "use", "absent", "--config", config]),
      /not configured/,
    );
    await assertRejects(
      () => main(["host", "remove", "absent", "--yes", "--config", config]),
      /not configured/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CLI setup, cluster preparation and connect enforce output and transport boundaries", async () => {
  const directory = await Deno.makeTempDir();
  const previousConfig = Deno.env.get("BUNNY_HOLE_CONFIG");
  const previousFrpc = Deno.env.get("BUNNY_HOLE_FRPC_PATH");
  const previousKube = Deno.env.get("KUBERNETES_SERVICE_HOST");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const originalInputTerminal = Deno.stdin.isTerminal;
  const originalOutputTerminal = Deno.stdout.isTerminal;
  const originalPrompt = globalThis.prompt;
  const originalAdd = Deno.addSignalListener;
  const originalRemove = Deno.removeSignalListener;
  const output: string[] = [];
  const errors: string[] = [];
  const identity = await generateKeyPair();
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
  let stop: (() => void) | undefined;
  let cancelSession = false;
  try {
    Deno.env.set("BUNNY_HOLE_CONFIG", `${directory}/config.json`);
    Deno.env.set("BUNNY_HOLE_FRPC_PATH", `${directory}/absent`);
    Deno.env.delete("KUBERNETES_SERVICE_HOST");
    console.log = (value: unknown) => output.push(String(value));
    console.error = (value: unknown) => errors.push(String(value));
    globalThis.fetch = (_input, init) => {
      const path = new URL(String(_input)).pathname;
      if (path.endsWith("bunny-hole")) {
        return Promise.resolve(Response.json(descriptor));
      }
      if (path.endsWith("enrollments")) {
        const body = JSON.parse(String(init?.body));
        return Promise.resolve(Response.json({
          id: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
          name: body.name,
          kind: body.kind,
          publicKey: body.publicKey,
          state: "pending",
          verificationPhrase: "amber-birch",
          createdAt: new Date().toISOString(),
          expiresAt: null,
        }));
      }
      if (path.endsWith("challenge")) {
        if (cancelSession) stop?.();
        return Promise.resolve(
          Response.json({
            challengeId: "chl_AAAAAAAAAAAAAAAAAAAAAAAA",
            challenge: "A".repeat(32),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          accessToken: "secret-admission",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          descriptor,
          routes: [],
        }),
      );
    };
    Deno.stdin.isTerminal = () => false;
    Deno.stdout.isTerminal = () => false;
    await assertRejects(() => main([]), /requires a terminal/);
    const prompts = ["https://hole.example.com", ""];
    Deno.stdin.isTerminal = () => true;
    Deno.stdout.isTerminal = () => true;
    globalThis.prompt = () => prompts.shift() ?? null;
    await main([]);
    assert(output.some((line) => line.includes("Host hole-example-com saved")));
    await assertRejects(() => main([]), /URL is required/);
    await assertRejects(
      () => main(["host", "add", "--url", "https://hole.example.com"]),
      /already exists/,
    );
    await assertRejects(() => main(["cluster", "prepare"]), /refusing to print/);
    Deno.stdout.isTerminal = () => false;
    const cluster = [
      "--url",
      "https://hole.example.com",
      "--name",
      "cluster",
      "--namespace",
      "default",
      "--secret-name",
      "identity",
    ];
    await main(["cluster", "prepare", ...cluster]);
    const yaml = output.at(-1)!;
    const encoded = yaml.match(/config.json: ([A-Za-z0-9+/=]+)/)![1];
    const exported = JSON.parse(atob(encoded));
    assertEquals(exported.identityPublicKey, identity.publicKey);
    assertEquals(exported.enrollmentId, "enr_AAAAAAAAAAAAAAAAAAAAAAAA");
    assert(errors.every((line) => !line.includes(exported.privateKey)));
    for (const field of ["name", "namespace", "secret-name"]) {
      const invalid = [...cluster];
      invalid[invalid.indexOf(`--${field}`) + 1] = "Bad/name";
      await assertRejects(() => main(["cluster", "prepare", ...invalid]), /invalid/);
    }
    for (const transport of ["bad", "tcp"]) {
      await assertRejects(
        () => main(["connect", "--transport", transport]),
        /transport/,
      );
    }
    await assertRejects(() => main(["connect"]), /CA bundle/);
    const ca = `${directory}/ca.pem`;
    await Deno.writeTextFile(
      ca,
      "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
    );
    Deno.addSignalListener = (_signal, handler) => {
      stop = handler;
    };
    Deno.removeSignalListener = () => {
      stop = undefined;
    };
    cancelSession = true;
    await main(["connect", "--trusted-ca-file", ca]);
    assertEquals(stop, undefined);
    await assertRejects(() => main(["operator"]), /Kubernetes service environment/);
    for (const target of ["bad", "localhost:0", "::1:3000"]) {
      await assertRejects(
        () => main(["route", "add", "--target", target]),
        /HOST:PORT/,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    Deno.stdin.isTerminal = originalInputTerminal;
    Deno.stdout.isTerminal = originalOutputTerminal;
    globalThis.prompt = originalPrompt;
    Deno.addSignalListener = originalAdd;
    Deno.removeSignalListener = originalRemove;
    for (
      const [name, value] of [["BUNNY_HOLE_CONFIG", previousConfig], [
        "BUNNY_HOLE_FRPC_PATH",
        previousFrpc,
      ], ["KUBERNETES_SERVICE_HOST", previousKube]]
    ) {
      if (value === undefined) Deno.env.delete(name!);
      else Deno.env.set(name!, value);
    }
    await Deno.remove(directory, { recursive: true });
  }
});
