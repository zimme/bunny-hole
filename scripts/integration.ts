import { createSecret } from "../packages/protocol/auth.ts";
import { output, run } from "./process.ts";

const project = `bunny-hole-test-${crypto.randomUUID().slice(0, 8)}`;
const secret = createSecret();
const testHost = Deno.env.get("BUNNY_HOLE_TEST_HOST") ?? "127.0.0.1";
const relayUrl = `http://${testHost}:18080`;
const environment = { ...Deno.env.toObject(), BUNNY_HOLE_TEST_SECRET: secret };
const compose = ["compose", "-p", project, "-f", "compose.yaml"];

try {
  try {
    await run("docker", [...compose, "up", "--build", "--detach", "--wait"], {
      env: environment,
    });
  } catch (error) {
    console.error(
      await output("docker", [...compose, "logs", "--no-color"], {
        env: environment,
      }).catch(() => "compose logs unavailable"),
    );
    throw error;
  }
  await waitFor(async () => {
    const response = await fetch(`${relayUrl}/readyz`);
    return response.ok;
  }, 30_000);
  await waitFor(async () => {
    const response = await fetch(`${relayUrl}/`, {
      headers: { host: "tunnel.test" },
    });
    return response.status !== 503;
  }, 30_000);

  const echo = await fetch(`${relayUrl}/hello?case=echo`, {
    method: "POST",
    headers: {
      host: "tunnel.test",
      "content-type": "text/plain",
      "x-bunny-hole-secret": secret,
      "x-forwarded-for": "attacker",
      "x-test": "safe",
    },
    body: "streamed request",
  });
  if (!echo.ok) throw new Error(`echo failed: ${echo.status}`);
  const echoed = await echo.json();
  if (
    echoed.body !== "streamed request" ||
    echoed.path !== "/hello?case=echo" ||
    echoed.headers["x-test"] !== "safe" ||
    echoed.headers["x-bunny-hole-secret"] !== undefined ||
    echoed.headers["x-forwarded-for"] === "attacker"
  ) throw new Error("header or body isolation check failed");

  const binary = crypto.getRandomValues(new Uint8Array(32_768));
  const binaryResponse = await fetch(`${relayUrl}/binary`, {
    method: "POST",
    headers: { host: "tunnel.test" },
    body: binary,
  });
  const binaryResult = new Uint8Array(await binaryResponse.arrayBuffer());
  if (!equalBytes(binary, binaryResult)) throw new Error("binary body was corrupted");

  const bodies = Array.from(
    { length: 12 },
    (_, index) => `request-${index}-${"x".repeat(2_000 + index)}`,
  );
  const results = await Promise.all(bodies.map(async (body, index) => {
    const response = await fetch(`${relayUrl}/multiplex?id=${index}`, {
      method: "POST",
      headers: { host: "tunnel.test" },
      body,
    });
    return (await response.json()).body;
  }));
  if (JSON.stringify(results) !== JSON.stringify(bodies)) {
    throw new Error("multiplexed requests crossed response bodies");
  }

  if (await rawStatus("unknown.test") !== 404) {
    throw new Error("unknown hostname was routed");
  }

  const relayLogs = await output("docker", [...compose, "logs", "relay"], {
    env: environment,
  });
  if (relayLogs.includes(secret)) throw new Error("secret leaked into relay logs");
  console.log(
    "integration: production relay image passed streaming, binary, routing, and multiplexing checks",
  );
} catch (error) {
  console.error(
    await output("docker", [...compose, "logs", "--no-color"], {
      env: environment,
    }).catch(() => "compose logs unavailable"),
  );
  throw error;
} finally {
  await run("docker", [...compose, "down", "--volumes", "--remove-orphans"], {
    env: environment,
  }).catch(() => {});
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // Services are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("integration service did not become ready");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

async function rawStatus(hostname: string): Promise<number> {
  const connection = await Deno.connect({ hostname: testHost, port: 18080 });
  try {
    await connection.write(
      new TextEncoder().encode(
        `GET / HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`,
      ),
    );
    const bytes = new Uint8Array(512);
    const count = await connection.read(bytes);
    const line =
      new TextDecoder().decode(bytes.subarray(0, count ?? 0)).split("\r\n")[0];
    const status = Number(line.split(" ")[1]);
    if (!Number.isInteger(status)) throw new Error("invalid raw HTTP response");
    return status;
  } finally {
    connection.close();
  }
}
