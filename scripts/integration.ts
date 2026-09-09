import { generateKeyPair, sign } from "../packages/api/auth.ts";
import { canonicalGrant, validateGrant } from "../packages/api/mod.ts";
import { BunnyHoleClient } from "../apps/connector/client.ts";
import { output, run } from "./process.ts";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";

const project = `bunny-hole-test-${crypto.randomUUID().slice(0, 8)}`;
const owner = await generateKeyPair();
const device = await generateKeyPair();
const configRelativeDirectory = `.tmp/${project}`;
const configDirectory = `${Deno.cwd()}/${configRelativeDirectory}`;
await Deno.mkdir(configDirectory, { recursive: true, mode: 0o700 });
const testHost = Deno.env.get("BUNNY_HOLE_TEST_HOST") ?? "127.0.0.1";
const hostUrl = `http://${testHost}:18080`;
const hostWorkspace = Deno.env.get("BUNNY_HOLE_WORKSPACE_HOST_PATH") ??
  Deno.cwd();
const environment: Record<string, string> = {
  ...Deno.env.toObject(),
  BUNNY_HOLE_OWNER_PUBLIC_KEY: owner.publicKey,
  BUNNY_HOLE_CONNECTOR_CONFIG_DIR: `${hostWorkspace}/${configRelativeDirectory}`,
};
const compose = [
  "compose",
  "--profile",
  "tunnel",
  "-p",
  project,
  "-f",
  "compose.yaml",
];
const publishedImages = Boolean(
  environment.BUNNY_HOLE_HOST_IMAGE && environment.BUNNY_HOLE_CONNECTOR_IMAGE,
);

try {
  if (publishedImages) {
    await run("docker", [...compose, "build", "origin"], { env: environment });
  } else {
    await run("docker", [...compose, "build", "host", "origin", "connector"], {
      env: environment,
    });
  }
  await run("docker", [
    ...compose,
    "up",
    "--no-build",
    "--detach",
    "--wait",
    "host",
    "origin",
  ], { env: environment });

  const client = new BunnyHoleClient(hostUrl, fetch, true);
  const descriptor = await client.descriptor();
  const enrollment = await client.enroll("integration", "device", device.publicKey);
  const grant = validateGrant({
    exactHostnames: ["tunnel.test"],
    hostnameSuffixes: [],
    protocols: ["http"],
    maxRoutes: 2,
  });
  const ownerChallengeResponse = await fetch(
    `${hostUrl}/api/v1/admin/owner/challenge`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "approve-enrollment" }),
    },
  );
  if (!ownerChallengeResponse.ok) throw new Error("owner challenge failed");
  const { challenge: ownerChallenge } = await ownerChallengeResponse.json();
  const approval = await fetch(
    `${hostUrl}/api/v1/enrollments/${enrollment.id}/approve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bunny-hole-owner-challenge": ownerChallenge,
        "x-bunny-hole-owner-signature": await sign(
          owner.privateKey,
          "approve-enrollment",
          [
            descriptor.identityPublicKey,
            enrollment.id,
            device.publicKey,
            canonicalGrant(grant),
            ownerChallenge,
          ],
        ),
      },
      body: JSON.stringify({ grants: grant }),
    },
  );
  if (!approval.ok) throw new Error(`approval failed: ${approval.status}`);
  const externalCredentials = {
    url: hostUrl,
    identityPublicKey: descriptor.identityPublicKey,
    enrollmentId: enrollment.id,
    ...device,
  };
  const session = await client.session(externalCredentials);
  await client.createRoute(session, {
    name: "origin",
    protocol: "http",
    hostname: "tunnel.test",
    targetHost: "origin",
    targetPort: 3000,
    allowPrivateNetwork: true,
  });
  await Deno.writeTextFile(
    `${configDirectory}/config.json`,
    `${
      JSON.stringify(
        {
          version: 1,
          defaultHost: "integration",
          hosts: {
            integration: { ...externalCredentials, url: "http://host:8080" },
          },
        },
        null,
        2,
      )
    }\n`,
    { mode: 0o600 },
  );
  await run("docker", [
    ...compose,
    "up",
    "--no-build",
    "--detach",
    "connector",
  ], { env: environment });

  await waitFor(async () => {
    const response = await publicRequest("/");
    await response.body?.cancel();
    return response.ok;
  }, 30_000);

  const echo = await publicRequest("/hello?case=echo", {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-bunny-hole-private-key": device.privateKey,
      "x-forwarded-for": "attacker",
      "x-test": "safe",
    },
    body: "streamed request",
  });
  if (!echo.ok || echo.headers.get("cache-control") !== "no-store") {
    throw new Error(`echo failed securely: ${echo.status}`);
  }
  const echoed = await echo.json();
  if (
    echoed.body !== "streamed request" || echoed.path !== "/hello?case=echo" ||
    echoed.headers["x-test"] !== "safe" ||
    echoed.headers["x-bunny-hole-private-key"] !== undefined ||
    echoed.headers["x-forwarded-for"] === "attacker"
  ) throw new Error("header or body isolation check failed");

  const binary = crypto.getRandomValues(new Uint8Array(32_768));
  const binaryResponse = await publicRequest("/binary", {
    method: "POST",
    body: binary,
  });
  const binaryResult = new Uint8Array(await binaryResponse.arrayBuffer());
  if (
    binary.length !== binaryResult.length ||
    !binary.every((byte, index) => byte === binaryResult[index])
  ) {
    throw new Error("binary body was corrupted");
  }

  const streamed = await publicRequest("/stream", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const value of ["alpha", "-", "omega"]) {
          controller.enqueue(new TextEncoder().encode(value));
        }
        controller.close();
      },
    }),
  });
  if (await streamed.text() !== "first:alpha-omega:last") {
    throw new Error("fragmented stream was not preserved");
  }

  const bodies = Array.from(
    { length: 12 },
    (_, index) => `request-${index}-${"x".repeat(2_000 + index)}`,
  );
  const results = await Promise.all(bodies.map(async (body, index) => {
    const response = await publicRequest(`/multiplex?id=${index}`, {
      method: "POST",
      body,
    });
    return (await response.json()).body;
  }));
  if (JSON.stringify(results) !== JSON.stringify(bodies)) {
    throw new Error("concurrent request bodies crossed");
  }

  const filtered = await publicRequest("/response-headers");
  if (
    filtered.headers.get("x-bunny-hole-future-control") !== null ||
    filtered.headers.get("x-safe-response") !== "allowed"
  ) throw new Error("response header filtering failed");
  await filtered.body?.cancel();

  const started = Date.now();
  const timedOut = await publicRequest("/slow");
  if (timedOut.status !== 502 || Date.now() - started > 5_000) {
    throw new Error("origin timeout was not enforced");
  }

  if (
    await rawHttpStatus(
      "GET / HTTP/1.1\r\nHost: unknown.test\r\nConnection: close\r\n\r\n",
    ) !== 404
  ) {
    throw new Error("unknown hostname was routed");
  }
  if (
    await rawHttpStatus(
      `POST / HTTP/1.1\r\nHost: tunnel.test\r\nContent-Length: 1073741825\r\nConnection: close\r\n\r\n`,
    ) !== 413
  ) throw new Error("oversized declared body was accepted");
  const logs = await output("docker", [...compose, "logs", "--no-color"], {
    env: environment,
  });
  if (logs.includes(device.privateKey) || logs.includes(owner.privateKey)) {
    throw new Error("a private key leaked into logs");
  }
  console.log(
    `integration: ${
      publishedImages ? "published" : "locally built"
    } host and connector images passed enrollment, routing, streaming, binary, and isolation checks`,
  );
} catch (error) {
  console.error(
    await output("docker", [...compose, "logs", "--no-color"], { env: environment })
      .catch(() => "compose logs unavailable"),
  );
  throw error;
} finally {
  try {
    await run("docker", [...compose, "down", "--volumes", "--remove-orphans"], {
      env: environment,
    });
  } catch (error) {
    console.error(`integration cleanup failed: ${String(error)}`);
    Deno.exitCode = 1;
  }
  await Deno.remove(configDirectory, { recursive: true }).catch(() => {});
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
      // Services are still converging.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("integration service did not become ready");
}

async function rawHttpStatus(request: string): Promise<number> {
  const connection = await Deno.connect({ hostname: testHost, port: 18080 });
  try {
    await connection.write(new TextEncoder().encode(request));
    const bytes = new Uint8Array(512);
    const count = await connection.read(bytes);
    return Number(
      new TextDecoder().decode(bytes.subarray(0, count ?? 0)).split("\r\n")[0].split(
        " ",
      )[1],
    );
  } finally {
    connection.close();
  }
}

function publicRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers);
    headers.set("host", "tunnel.test");
    const client = httpRequest({
      hostname: testHost,
      port: 18080,
      path,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers),
    }, (response) => {
      const responseHeaders = new Headers();
      for (const [name, values] of Object.entries(response.headersDistinct)) {
        for (const value of values ?? []) responseHeaders.append(name, value);
      }
      resolve(
        new Response(
          Readable.toWeb(response) as ReadableStream<Uint8Array>,
          {
            status: response.statusCode ?? 502,
            statusText: response.statusMessage,
            headers: responseHeaders,
          },
        ),
      );
    });
    client.on("error", reject);
    if (init.body === undefined || init.body === null) {
      client.end();
    } else if (typeof init.body === "string" || init.body instanceof Uint8Array) {
      client.end(init.body);
    } else if (init.body instanceof ReadableStream) {
      (async () => {
        for await (const chunk of init.body as ReadableStream<Uint8Array>) {
          if (!client.write(chunk)) await once(client, "drain");
        }
        client.end();
      })().catch((error) => {
        client.destroy(error instanceof Error ? error : undefined);
        reject(error);
      });
    } else {
      reject(new Error("unsupported integration request body"));
      client.destroy();
    }
  });
}
