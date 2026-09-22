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
const configVolume = `${project}-connector-config`;
const tlsDirectory = `${configDirectory}/tls`;
const tlsCertificate = `${tlsDirectory}/tls.crt`;
const tlsKey = `${tlsDirectory}/tls.key`;
const trustedCa = `${tlsDirectory}/ca.crt`;
const secrets = new Set([owner.privateKey, device.privateKey]);
await Deno.mkdir(configDirectory, { recursive: true, mode: 0o700 });
await Deno.mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
await createTestCertificates(tlsCertificate, tlsKey, trustedCa);
await Deno.writeTextFile(
  `${configDirectory}/compose.override.yaml`,
  `services:
  host:
    environment:
      BUNNY_HOLE_CONNECTOR_HOST: connector-gateway
      BUNNY_HOLE_CONNECTOR_PORT: "7443"
      BUNNY_HOLE_CONNECTOR_TRANSPORTS: wss
  connector:
    command: [connect, --host, integration, --transport, wss]
    environment:
      BUNNY_HOLE_TRUSTED_CA_FILE: /tls/ca.crt
    volumes:
      - type: volume
        source: connector-config
        target: /config
        read_only: true
      - type: bind
        source: ${tlsDirectory}
        target: /tls
        read_only: true
volumes:
  connector-config:
    external: true
    name: ${configVolume}
`,
  { mode: 0o600 },
);
const testHost = Deno.env.get("BUNNY_HOLE_TEST_HOST") ?? "127.0.0.1";
const hostUrl = `http://${testHost}:18080`;
const environment: Record<string, string> = {
  ...Deno.env.toObject(),
  BUNNY_HOLE_OWNER_PUBLIC_KEY: owner.publicKey,
  BUNNY_HOLE_TLS_DIRECTORY: tlsDirectory,
};
const compose = [
  "compose",
  "--profile",
  "tunnel",
  "-p",
  project,
  "-f",
  "compose.yaml",
  "-f",
  `${configDirectory}/compose.override.yaml`,
];
const publishedImages = Boolean(
  environment.BUNNY_HOLE_HOST_IMAGE && environment.BUNNY_HOLE_CONNECTOR_IMAGE,
);

try {
  await run("docker", ["volume", "create", configVolume], { env: environment });
  if (publishedImages) {
    await run("docker", [...compose, "build", "origin", "connector-gateway"], {
      env: environment,
    });
  } else {
    await run("docker", [
      ...compose,
      "build",
      "host",
      "origin",
      "connector",
      "connector-gateway",
    ], { env: environment });
  }
  await run("docker", [
    ...compose,
    "up",
    "--no-build",
    "--detach",
    "--wait",
    "host",
    "origin",
    "connector-gateway",
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
  secrets.add(ownerChallenge);
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
  secrets.add(session.accessToken);
  await client.createRoute(session, {
    name: "origin",
    protocol: "http",
    hostname: "tunnel.test",
    targetHost: "origin",
    targetPort: 3000,
    allowPrivateNetwork: true,
  });
  const connectorConfig = JSON.stringify(
    {
      version: 1,
      defaultHost: "integration",
      hosts: {
        integration: { ...externalCredentials, url: "http://host:8080" },
      },
    },
    null,
    2,
  ) + "\n";
  const stage = new Deno.Command("docker", {
    args: [
      "run",
      "--rm",
      "--interactive",
      "--user",
      "0:0",
      "--volume",
      `${configVolume}:/config`,
      "denoland/deno:2.9.5@sha256:b429777c3dcff34a6488f365a1537db1640b2d48379b60f5e6206be034472463",
      "deno",
      "eval",
      'const data=await new Response(Deno.stdin.readable).bytes(); await Deno.writeFile("/config/config.json",data,{mode:0o600}); await Deno.chown("/config/config.json",65532,65532)',
    ],
    env: environment,
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const input = stage.stdin.getWriter();
  await input.write(new TextEncoder().encode(connectorConfig));
  await input.close();
  const stageStatus = await stage.status;
  if (!stageStatus.success) throw new Error("connector config staging failed");
  await run("docker", [
    ...compose,
    "run",
    "--rm",
    "--no-deps",
    "connector",
    "check",
    "--host",
    "integration",
    "--local-development",
  ], { env: environment });
  await run("docker", [
    ...compose,
    "up",
    "--no-build",
    "--detach",
    "connector",
  ], { env: environment });

  await waitFor(
    async () => {
      const logs = await output("docker", [
        ...compose,
        "logs",
        "--no-color",
        "connector",
      ], { env: environment });
      return logs.includes("x509: certificate signed by unknown authority");
    },
    10_000,
    "connector did not reject the gateway certificate signed by the wrong CA",
  );
  const wrongCa = await publicRequest("/wrong-ca");
  if (wrongCa.ok || wrongCa.headers.get("x-origin-status") !== null) {
    throw new Error("connector established a tunnel with the wrong CA");
  }
  await wrongCa.body?.cancel();
  await Deno.copyFile(tlsCertificate, trustedCa);
  await run("docker", [...compose, "stop", "connector"], { env: environment });
  await run("docker", [...compose, "up", "--no-build", "--detach", "connector"], {
    env: environment,
  });

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

  const originNotFound = await publicRequest("/origin-404");
  if (
    originNotFound.status !== 404 ||
    originNotFound.headers.get("x-origin-status") !== "not-found" ||
    await originNotFound.text() !== "origin-not-found"
  ) throw new Error("origin 404 was not preserved through the tunnel");

  const disconnect = await publicRequest("/disconnect-stream");
  const disconnectReader = disconnect.body?.getReader();
  if (!disconnectReader || (await disconnectReader.read()).done) {
    throw new Error("stream did not begin before public cancellation");
  }
  await disconnectReader.cancel();
  await waitFor(
    async () => {
      const observed = await publicRequest("/disconnect-observed");
      return (await observed.json()).cancelledResponses > 0;
    },
    5_000,
    "origin did not observe public response cancellation",
  );

  const started = Date.now();
  const timedOut = await publicRequest("/slow");
  const elapsed = Date.now() - started;
  if (timedOut.status !== 502 || elapsed > 5_000) {
    throw new Error(
      `origin timeout was not enforced (status=${timedOut.status}, elapsedMs=${elapsed})`,
    );
  }
  await timedOut.body?.cancel();

  await run("docker", [...compose, "stop", "connector"], { env: environment });
  await waitFor(
    async () => {
      const unavailable = await publicRequest("/after-connector-stop");
      const body = await unavailable.text();
      return [404, 502, 503].includes(unavailable.status) &&
        body !== "origin-not-found" &&
        unavailable.headers.get("x-origin-status") === null;
    },
    10_000,
    "public traffic remained available after connector stopped",
  );
  await run("docker", [...compose, "up", "--no-build", "--detach", "connector"], {
    env: environment,
  });
  await waitFor(
    async () => {
      const recovered = await publicRequest("/after-connector-restart");
      await recovered.body?.cancel();
      return recovered.ok;
    },
    30_000,
    "connector did not restore public traffic",
  );

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
  if ([...secrets].some((secret) => logs.includes(secret))) {
    throw new Error("a private key leaked into logs");
  }
  console.log(
    `integration: ${
      publishedImages ? "published" : "locally built"
    } host and connector images passed enrollment, routing, streaming, binary, and isolation checks`,
  );
} catch (error) {
  console.error(
    redactLogs(
      await output("docker", [...compose, "logs", "--no-color"], {
        env: environment,
      }).catch(() => "compose logs unavailable"),
      secrets,
    ),
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
  await run("docker", ["volume", "rm", "--force", configVolume], {
    env: environment,
  }).catch((error) => {
    console.error(`integration config cleanup failed: ${String(error)}`);
    Deno.exitCode = 1;
  });
  await Deno.remove(configDirectory, { recursive: true }).catch(() => {});
}

async function createTestCertificates(
  certificate: string,
  key: string,
  ca: string,
): Promise<void> {
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=wrong-ca",
    "-keyout",
    `${ca}.key`,
    "-out",
    ca,
  ]);
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=connector-gateway",
    "-addext",
    "subjectAltName=DNS:connector-gateway",
    "-keyout",
    key,
    "-out",
    certificate,
  ]);
}

function redactLogs(logs: string, values: Set<string>): string {
  let redacted = logs;
  for (const value of values) {
    if (value) redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted.replaceAll(
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
    "[REDACTED]",
  );
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeout: number,
  failure = "integration service did not become ready",
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
  throw new Error(failure);
}

async function rawHttpStatus(request: string): Promise<number> {
  const connection = await Deno.connect({ hostname: testHost, port: 18080 });
  const timeout = setTimeout(() => connection.close(), 10_000);
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
    clearTimeout(timeout);
    connection.close();
  }
}

function publicRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const headers = new Headers(init.headers);
    headers.set("host", "tunnel.test");
    const client = httpRequest({
      hostname: testHost,
      port: 18080,
      path,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers),
      signal,
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
