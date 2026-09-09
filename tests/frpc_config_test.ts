import { frpcConfig } from "../apps/connector/frpc_config.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import type { Session } from "../apps/connector/client.ts";
import { assert, assertThrows } from "./assert.ts";

const identity = await generateKeyPair();
const session: Session = {
  accessToken: "short-lived-token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  descriptor: {
    apiVersion: 1,
    name: "hole.example.com",
    managementUrl: "https://hole.example.com/",
    connectorHost: "connect.example.com",
    connectorPort: 443,
    connectorTransports: ["wss"],
    identityPublicKey: identity.publicKey,
    capabilities: ["http", "https"],
  },
  routes: [{
    id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
    enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    name: "home",
    protocol: "http",
    hostname: "home.example.com",
    targetHost: "127.0.0.1",
    targetPort: 8123,
    allowPrivateNetwork: false,
    active: true,
  }],
};

Deno.test("FRP configuration is secure, scoped, and contains no private key", () => {
  const config = frpcConfig(session, "wss");
  assert(config.includes('transport.protocol = "wss"'));
  assert(config.includes("transport.tls.enable = true"));
  assert(config.includes('customDomains = ["home.example.com"]'));
  assert(config.includes("short-lived-token"));
  assert(!config.includes("privateKey"));
  assertThrows(() => frpcConfig(session, "tcp"), /production connectors require/);
  assert(frpcConfig(session, "tcp", true).includes('transport.protocol = "tcp"'));
});

Deno.test("FRP configuration rejects private-network targets without opt-in", () => {
  const privateSession = structuredClone(session);
  privateSession.routes[0].targetHost = "home.internal";
  assertThrows(
    () => frpcConfig(privateSession, "wss"),
    /explicit private-network opt-in/,
  );
});
