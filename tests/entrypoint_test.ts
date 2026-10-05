import { resolve } from "node:path";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assert, assertEquals } from "./assert.ts";

function command(entry: string, args: string[] = [], env: Record<string, string> = {}) {
  return new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", `--coverage=${resolve("coverage")}`, entry, ...args],
    env,
    stdout: "piped",
    stderr: "piped",
  });
}
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port;
  listener.close();
  return port;
}
Deno.test("entrypoints report usage, configuration, connection and healthcheck exit codes", async () => {
  for (const args of [[], ["serve"]]) {
    const result = await command("apps/compose/main.ts", args, {
      BUNNY_HOLE_COMPOSE_PROJECT: "",
    }).output();
    assertEquals(result.code, 1);
    assert(
      new TextDecoder().decode(result.stderr).includes(
        "Compose controller startup failed",
      ),
    );
  }
  for (
    const [args, expected] of [[["unknown"], 64], [[
      "host",
      "add",
      "--url",
      "http://example.com",
    ], 78], [["host", "add", "--url", "bad"], 69]] as const
  ) {
    const result = await command("apps/connector/main.ts", [...args]).output();
    assertEquals(result.code, expected);
  }
  for (const status of [200, 503]) {
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      () => new Response("ok", { status }),
    );
    try {
      assertEquals(
        (await command("apps/host/main.ts", ["--healthcheck"], {
          PORT: String(server.addr.port),
        }).output()).code,
        status === 200 ? 0 : 1,
      );
    } finally {
      await server.shutdown();
    }
  }
  assertEquals(
    (await command("apps/host/main.ts", ["--healthcheck"], { PORT: String(freePort()) })
      .output()).code,
    1,
  );
  assertEquals(
    (await command("apps/host/main.ts", [], { BUNNY_HOLE_PUBLIC_URL: "" }).output())
      .code,
    78,
  );
});

Deno.test("host entrypoint owns FRP startup, readiness, graceful shutdown and unexpected exit", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const owner = await generateKeyPair();
  try {
    const stub = `${directory}/frps.ts`;
    const executable = `${directory}/frps`;
    const marker = `${directory}/stop`;
    await Deno.writeTextFile(
      stub,
      `const listener = Deno.listen({ hostname: "127.0.0.1", port: Number(Deno.env.get("BUNNY_HOLE_FRP_BIND_PORT")) });
const timer = setInterval(async () => { try { await Deno.stat(${
        JSON.stringify(marker)
      }); listener.close(); clearInterval(timer); Deno.exit(7); } catch {} }, 20);
Deno.addSignalListener("SIGTERM", () => { listener.close(); clearInterval(timer); Deno.exit(0); });
for await (const connection of listener) connection.close();`,
    );
    await Deno.writeTextFile(
      executable,
      `#!/bin/sh\nexec '${Deno.execPath()}' run --allow-net --allow-env --allow-read '${stub}'\n`,
      { mode: 0o700 },
    );
    for (const mode of ["shutdown", "crash", "startup-failure"] as const) {
      if (mode === "startup-failure") {
        await Deno.writeTextFile(executable, "#!/bin/sh\nexit 3\n");
      }
      const port = freePort();
      const child = command("apps/host/main.ts", [], {
        PORT: String(port),
        HOST: "127.0.0.1",
        BUNNY_HOLE_PUBLIC_URL: "https://hole.example.com",
        BUNNY_HOLE_OWNER_PUBLIC_KEY: owner.publicKey,
        BUNNY_HOLE_STATE_PATH: `${directory}/${mode}.sqlite`,
        BUNNY_HOLE_IDENTITY_PATH: `${directory}/identity.json`,
        BUNNY_HOLE_FRPS_PATH: executable,
        BUNNY_HOLE_FRP_BIND_PORT: String(freePort()),
        BUNNY_HOLE_FRP_HTTP_PORT: String(freePort()),
      }).spawn();
      const output = child.output();
      try {
        if (mode !== "startup-failure") {
          const deadline = Date.now() + 10000;
          let ready = false;
          while (Date.now() < deadline) {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/readyz`);
              await response.body?.cancel();
              if (response.ok) {
                ready = true;
                break;
              }
            } catch { /* Startup is still in progress. */ }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert(ready, "host did not become ready");
          if (mode === "shutdown") child.kill("SIGTERM");
          else await Deno.writeTextFile(marker, "stop");
        }
        const result = await output;
        assertEquals(result.code, mode === "shutdown" ? 0 : 78);
        const logs = new TextDecoder().decode(result.stdout);
        assertEquals(logs.includes(owner.privateKey), false);
        if (mode === "startup-failure") {
          assert(
            new TextDecoder().decode(result.stderr).includes("frps exited with code 3"),
          );
        }
      } finally {
        try {
          child.kill("SIGKILL");
        } catch { /* Already reaped. */ }
        await output;
      }
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
