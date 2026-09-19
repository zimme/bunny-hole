import { routesFromCompose } from "../apps/compose/model.ts";
import { desiredRoutes } from "../apps/operator/model.ts";
import { assert, assertEquals, assertThrows } from "./assert.ts";

Deno.test("Compose labels produce a loopback route by default", () => {
  assertEquals(
    routesFromCompose({
      services: {
        home: {
          labels: {
            "dev.bunny-hole.host": "home-host",
            "dev.bunny-hole.hostname": "home.example.com",
            "dev.bunny-hole.target-port": "8123",
          },
        },
        database: {},
      },
    }),
    [{
      host: "home-host",
      name: "compose-project-home",
      protocol: "http",
      hostname: "home.example.com",
      targetHost: "127.0.0.1",
      targetPort: 8123,
      allowPrivateNetwork: false,
    }],
  );
});

Deno.test("Gateway API resources bind a route to an annotated Bunny Hole host", () => {
  const routes = desiredRoutes([
    {
      kind: "Gateway",
      metadata: {
        name: "public",
        namespace: "apps",
        annotations: { "bunny-hole.dev/host": "production" },
      },
      spec: {
        gatewayClassName: "bunny-hole",
        listeners: [{
          name: "http",
          protocol: "HTTP",
          port: 80,
          hostname: "home.example.com",
        }],
      },
    },
    {
      kind: "HTTPRoute",
      metadata: { name: "home", namespace: "apps" },
      spec: {
        parentRefs: [{ name: "public" }],
        hostnames: ["home.example.com"],
        rules: [{ backendRefs: [{ name: "home-assistant", port: 8123 }] }],
      },
    },
  ]);
  assert(routes[0].name.startsWith("k8s-apps-home-home-example-com-"));
  assertEquals(
    { ...routes[0], name: "managed" },
    {
      hostRef: "apps/production",
      name: "managed",
      protocol: "http",
      hostname: "home.example.com",
      targetHost: "home-assistant.apps.svc",
      targetPort: 8123,
      allowPrivateNetwork: true,
    },
  );
});

Deno.test("Gateway adapter refuses semantics it cannot preserve", () => {
  const gateway = {
    kind: "Gateway",
    metadata: {
      name: "public",
      namespace: "apps",
      annotations: { "bunny-hole.dev/host": "production" },
    },
    spec: {
      gatewayClassName: "bunny-hole",
      listeners: [{ name: "http", protocol: "HTTP", port: 80 }],
    },
  };
  assertThrows(
    () =>
      desiredRoutes([gateway, {
        kind: "HTTPRoute",
        metadata: { name: "split", namespace: "apps" },
        spec: {
          parentRefs: [{ name: "public" }],
          hostnames: ["split.example.com"],
          rules: [{
            matches: [{ path: { type: "PathPrefix", value: "/admin" } }],
            backendRefs: [{ name: "service", port: 8080 }],
          }],
        },
      }]),
    /path matches/,
  );
  const route = desiredRoutes([gateway, {
    kind: "HTTPRoute",
    metadata: { name: "long", namespace: "apps" },
    spec: {
      parentRefs: [{ name: "public" }],
      hostnames: [`${"a".repeat(63)}.example.com`],
      rules: [{ backendRefs: [{ name: "service", port: 8080 }] }],
    },
  }])[0];
  assert(route.name.startsWith("k8s-"));
  assert(route.name.length <= 128);
});

Deno.test("Gateway listener honors allowed route kinds", () => {
  const gateway = {
    kind: "Gateway",
    metadata: {
      name: "public",
      namespace: "apps",
      annotations: { "bunny-hole.dev/host": "production" },
    },
    spec: {
      gatewayClassName: "bunny-hole",
      listeners: [{
        name: "http",
        protocol: "HTTP",
        allowedRoutes: {
          kinds: [{ group: "gateway.networking.k8s.io", kind: "GRPCRoute" }],
        },
      }],
    },
  };
  const route = {
    kind: "HTTPRoute",
    metadata: { name: "home", namespace: "apps" },
    spec: {
      parentRefs: [{ name: "public" }],
      hostnames: ["home.example.com"],
      rules: [{ backendRefs: [{ name: "home", port: 8080 }] }],
    },
  };
  assertEquals(desiredRoutes([gateway, route]), []);
});
