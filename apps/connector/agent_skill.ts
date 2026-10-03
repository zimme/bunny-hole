/** Credential-free consumer guidance bundled with the release-matched CLI. */
export const AGENT_SKILL = `---
name: bunny-hole
description: Publish and clean up an HTTP service through an already configured Bunny Hole host. Use for remote testing or temporary sharing from an existing environment, not infrastructure deployment.
---

# Bunny Hole

Use the installed bunny-hole CLI. Human setup must supply a protected connector config
path, named host alias, approved exact public hostname, and local origin. Do not read or
print the connector config or request private keys, Bunny credentials, or passkey data.
Human owners handle enrollment approval and infrastructure. This skill does not grant
permission to publish services beyond the user's task.

## Task-owned temporary tunnel

A temporary tunnel is an ordinary route and connector owned by the current task. There
is no separate preview resource or automatic expiry. Use the CLI's current help for
supported flags. Do not assume random route IDs provision random public hostnames.
DNS, Bunny CDN, and TLS must already cover the exact hostname. For a wildcard such
as *.tunnels.example.com, restrict the hostname to one DNS label beneath that root:
abc.tunnels.example.com is covered; abc.def.tunnels.example.com and the bare root
are not. Reject those uncovered names instead of disabling TLS verification.

1. Verify the intended application on loopback in the connector's network namespace.
   For example: curl --fail --max-time 5 http://127.0.0.1:3000/healthz. Choose a safe
   endpoint appropriate to the application.
2. Run bunny-hole check --config CONFIG_PATH --host HOST_ALIAS and inspect its JSON.
   It checks control-plane identity/authentication and lists admitted routes. It does
   not establish public readiness. A connector publishes all routes in its enrollment.
3. Create the intended route and record the returned route ID:

   bunny-hole route add --config CONFIG_PATH --host HOST_ALIAS --name TASK_NAME \\
     --protocol http --hostname PUBLIC_HOSTNAME --target 127.0.0.1:3000

   Route creation is not an idempotent update. Inspect an existing route before reuse;
   do not delete another task's route to resolve a conflict.
4. Start bunny-hole connect --config CONFIG_PATH --host HOST_ALIAS as a task-owned
   process. From another process, poll the intended public application URL with a bounded
   deadline and verify the expected response. Stop and clean up if readiness fails.
5. On completion, error, or cancellation, stop only that connector with SIGINT or
   SIGTERM. Delete only the route created by the task:

   bunny-hole route delete ROUTE_ID --config CONFIG_PATH --host HOST_ALIAS
   bunny-hole route list --config CONFIG_PATH --host HOST_ALIAS

   Verify the route is gone and the URL no longer reaches the application. If cleanup
   fails, report the route ID, hostname, and pending cleanup without credentials.

## Boundaries

- One active connector per enrollment: a second replaces the first. Independent tasks
  need separate enrollments/configs and public hostnames. Compose owns all compose-
  routes in its enrollment; do not share that enrollment across projects.
- Public viewers are not authenticated by enrollment or encrypted transport. Use an
  application's approved viewer authentication for private data. Verify anonymous
  access is denied before sharing a private service. Do not expose an unauthenticated
  terminal, command runner, filesystem browser, or administrative dashboard.
- Loopback is the default origin boundary. A container's loopback is its own namespace.
  Non-loopback origins require deliberate private-network consent; do not widen that
  permission merely to bypass a connectivity error.
- Public WebSockets, TCP/UDP forwarding, and high availability are unsupported. HTTP
  streaming and SSE have a configured whole-response timeout. WebSocket hot reload
  cannot work through this tunnel.
- Stopping a connector does not remove its durable routes or revoke its enrollment.
  A replacement connector can publish a retained route. Five-minute admission-token
  expiry is not a tunnel lifetime or crash-cleanup guarantee.
- Prefer local testing when no remote consumer needs access. Compose, Kubernetes, and
  infrastructure tooling are optional; one HTTP service needs only the connector CLI.
`;
