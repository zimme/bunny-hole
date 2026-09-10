import { assertEquals } from "./assert.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import type { Enrollment } from "../packages/api/mod.ts";
import { FrpAuthorizer } from "../apps/host/frp.ts";
import { issueSessionToken } from "../apps/host/session.ts";
import { HostStore } from "../apps/host/store.ts";

Deno.test("FRP plugin rejects malformed, unknown, and replaced sessions", async () => {
  const directory = await Deno.makeTempDir();
  const identity = await generateKeyPair();
  const device = await generateKeyPair();
  using store = new HostStore(`${directory}/state.sqlite`);
  const enrollment: Enrollment = {
    id: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    kind: "device",
    name: "test",
    publicKey: device.publicKey,
    verificationPhrase: "test-test-test-test-test",
    state: "active",
    grants: {
      exactHostnames: ["home.example.com"],
      hostnameSuffixes: [],
      protocols: ["http"],
      maxRoutes: 1,
    },
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
  store.createEnrollment(enrollment);
  store.createRoute({
    id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
    enrollmentId: enrollment.id,
    name: "home",
    protocol: "http",
    hostname: "home.example.com",
    targetHost: "127.0.0.1",
    targetPort: 8123,
    allowPrivateNetwork: false,
    active: true,
  });
  const authorizer = new FrpAuthorizer(store, identity.publicKey);
  assertEquals((await authorizer.authorize(null)).reject, true);
  const first = await issueSessionToken(identity.privateKey, enrollment.id);
  const second = await issueSessionToken(identity.privateKey, enrollment.id);
  assertEquals(
    (await authorizer.authorize(plugin("Login", first.token, {}, ""))).reject,
    false,
  );
  assertEquals(
    (await authorizer.authorize(plugin("NewProxy", first.token, {
      proxy_name: "bh-enr_AAAAAAAAAAAAAAAAAAAAAAAA.bh-rte_AAAAAAAAAAAAAAAAAAAAAAAA",
      proxy_type: "http",
      custom_domains: ["attacker.test"],
    }, "poison-run"))).reject,
    true,
  );
  const proxyName = "bh-enr_AAAAAAAAAAAAAAAAAAAAAAAA.bh-rte_AAAAAAAAAAAAAAAAAAAAAAAA";
  assertEquals(
    (await authorizer.authorize(plugin("NewProxy", first.token, {
      proxy_name: proxyName,
      proxy_type: "http",
      custom_domains: ["home.example.com"],
    }, "run-1"))).reject,
    false,
  );
  assertEquals(
    (await authorizer.authorize(plugin("CloseProxy", first.token, {
      proxy_name: "bh-enr_BBBBBBBBBBBBBBBBBBBBBBBB.bh-rte_AAAAAAAAAAAAAAAAAAAAAAAA",
    }, "run-1"))).reject,
    true,
  );
  assertEquals(
    (await authorizer.authorize(
      plugin("NewWorkConn", first.token, {}, "run-1", "wrong-run"),
    )).reject,
    true,
  );
  assertEquals(
    (await authorizer.authorize(plugin("Login", second.token, {}, ""))).reject,
    false,
  );
  assertEquals(
    (await authorizer.authorize(plugin("Ping", first.token, {}, "run-1"))).reject,
    true,
  );
  assertEquals(
    (await authorizer.authorize(plugin("Ping", second.token, {}, "run-2"))).reject,
    false,
  );
  store.revokeEnrollment(enrollment.id);
  assertEquals(
    (await authorizer.authorize(plugin("Ping", second.token, {}, "run-2"))).reject,
    true,
  );
});

function plugin(
  op: string,
  token: string,
  content: Record<string, unknown> = {},
  runId = "run-1",
  workConnectionRunId = runId,
) {
  const metas = { bunny_hole_token: token };
  if (op === "Login") {
    return {
      op,
      content: {
        ...content,
        user: "bh-enr_AAAAAAAAAAAAAAAAAAAAAAAA",
        run_id: runId,
        metas,
      },
    };
  }
  return {
    op,
    content: {
      ...content,
      user: {
        user: "bh-enr_AAAAAAAAAAAAAAAAAAAAAAAA",
        run_id: runId,
        metas,
      },
      ...(op === "NewWorkConn" ? { run_id: workConnectionRunId } : {}),
    },
  };
}
