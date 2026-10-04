import { assertEquals } from "./assert.ts";
import { grantAllowsRoute, validateGrant } from "../packages/api/mod.ts";

Deno.test("grants match only explicit hostnames, suffixes, and protocols", () => {
  const grant = validateGrant({
    exactHostnames: ["home.example.com"],
    hostnameSuffixes: ["dev.example.com"],
    protocols: ["http"],
    maxRoutes: 4,
  });
  const base = {
    id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
    enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    name: "test",
    targetHost: "127.0.0.1",
    targetPort: 3000,
    allowPrivateNetwork: false,
    active: true,
  } as const;
  assertEquals(
    grantAllowsRoute(grant, {
      ...base,
      protocol: "http",
      hostname: "home.example.com",
    }),
    true,
  );
  assertEquals(
    grantAllowsRoute(grant, {
      ...base,
      protocol: "http",
      hostname: "x.dev.example.com",
    }),
    true,
  );
  assertEquals(
    grantAllowsRoute(grant, {
      ...base,
      protocol: "http",
      hostname: "dev.example.com.attacker.test",
    }),
    false,
  );
});
