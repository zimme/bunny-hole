import { BunnyHoleClient } from "../apps/connector/client.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assertEquals, assertRejects, assertThrows } from "./assert.ts";

const identity = await generateKeyPair();
const device = await generateKeyPair();
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

Deno.test("client accepts only HTTPS origin URLs outside local development", () => {
  assertThrows(() => new BunnyHoleClient("http://hole.example.com"), /HTTPS/);
  assertThrows(
    () => new BunnyHoleClient("https://hole.example.com/path"),
    /invalid host URL/,
  );
  assertEquals(
    new BunnyHoleClient("http://127.0.0.1:8080", fetch, true).url.origin,
    "http://127.0.0.1:8080",
  );
});

Deno.test("client strictly validates host descriptors", async () => {
  const valid = new BunnyHoleClient(
    "https://hole.example.com",
    responder(descriptor),
  );
  assertEquals((await valid.descriptor()).connectorTransports, ["wss"]);
  await assertRejects(
    () =>
      new BunnyHoleClient(
        "https://hole.example.com",
        responder({ ...descriptor, apiVersion: 2 }),
      ).descriptor(),
    /incompatible/,
  );
  await assertRejects(
    () =>
      new BunnyHoleClient(
        "https://hole.example.com",
        responder({ ...descriptor, managementUrl: "https://attacker.test" }),
      ).descriptor(),
    /incompatible/,
  );
  await assertRejects(
    () =>
      new BunnyHoleClient(
        "https://hole.example.com",
        () =>
          Promise.resolve(
            new Response("{}", { headers: { "content-type": "text/plain" } }),
          ),
      ).descriptor(),
    /invalid response/,
  );
  await assertRejects(
    () =>
      new BunnyHoleClient(
        "https://hole.example.com",
        () =>
          Promise.resolve(
            new Response("{}", {
              headers: {
                "content-type": "application/json",
                "content-length": String(1024 * 1024 + 1),
              },
            }),
          ),
      ).descriptor(),
    /exceeded the limit/,
  );
});

Deno.test("client pins host identity and validates every admitted route", async () => {
  const credentials = {
    url: "https://hole.example.com/",
    identityPublicKey: identity.publicKey,
    enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    ...device,
  };
  const route = {
    id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
    enrollmentId: credentials.enrollmentId,
    name: "home",
    protocol: "http",
    hostname: "home.example.com",
    targetHost: "127.0.0.1",
    targetPort: 8123,
    allowPrivateNetwork: false,
    active: true,
  };
  const fetcher: typeof fetch = (input) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    return responder(
      path.endsWith("challenge")
        ? {
          challengeId: "chl_AAAAAAAAAAAAAAAAAAAAAAAA",
          challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
        : {
          accessToken: "token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          descriptor,
          routes: [route],
        },
    )(input);
  };
  const session = await new BunnyHoleClient(credentials.url, fetcher).session(
    credentials,
  );
  assertEquals(session.routes[0].hostname, "home.example.com");

  const malformed: typeof fetch = async (input) => {
    const response = await fetcher(input);
    const value = await response.json();
    if ("routes" in value) value.routes[0].targetPort = 0;
    return responder(value)(input);
  };
  await assertRejects(
    () => new BunnyHoleClient(credentials.url, malformed).session(credentials),
    /invalid port/,
  );
});

function responder(value: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      }),
    );
}
