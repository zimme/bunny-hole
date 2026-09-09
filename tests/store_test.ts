import { HostStore } from "../apps/host/store.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import type { Enrollment, Route } from "../packages/api/mod.ts";
import { assertEquals } from "./assert.ts";

Deno.test("store enforces expiry, one-use challenges, and route ownership", async () => {
  const directory = await Deno.makeTempDir();
  using store = new HostStore(`${directory}/state.sqlite`);
  const device = await generateKeyPair();
  const enrollment: Enrollment = {
    id: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    kind: "device",
    name: "device",
    publicKey: device.publicKey,
    verificationPhrase: "amber-birch-coral-drift-ember",
    state: "pending",
    grants: {
      exactHostnames: [],
      hostnameSuffixes: [],
      protocols: [],
      maxRoutes: 1,
    },
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1).toISOString(),
  };
  store.createEnrollment(enrollment);
  assertEquals(store.approveEnrollment(enrollment.id, enrollment.grants), false);

  store.saveChallenge("chl_AAAAAAAAAAAAAAAAAAAAAAAA", enrollment.id, "value", 20);
  assertEquals(
    store.consumeChallenge("chl_AAAAAAAAAAAAAAAAAAAAAAAA", enrollment.id, 10),
    "value",
  );
  assertEquals(
    store.consumeChallenge("chl_AAAAAAAAAAAAAAAAAAAAAAAA", enrollment.id, 10),
    undefined,
  );

  const active = { ...enrollment, state: "active" as const, expiresAt: null };
  const secondDevice = await generateKeyPair();
  const second = {
    ...active,
    id: "enr_BBBBBBBBBBBBBBBBBBBBBBBB",
    publicKey: secondDevice.publicKey,
  };
  store.createEnrollment(second);
  const route: Route = {
    id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
    enrollmentId: second.id,
    name: "home",
    protocol: "http",
    hostname: "home.example.com",
    targetHost: "127.0.0.1",
    targetPort: 8123,
    allowPrivateNetwork: false,
    active: true,
  };
  store.createRoute(route);
  assertEquals(
    store.routeConflicts({ ...route, id: "rte_BBBBBBBBBBBBBBBBBBBBBBBB" }),
    true,
  );
  assertEquals(store.deleteRoute(route.id, enrollment.id), false);
  assertEquals(store.deleteRoute(route.id, second.id), true);
});
