# Agent use

Bunny Hole can publish a deliberately selected HTTP service from an existing developer
machine or sandbox. It does not isolate agent code or authenticate public viewers. Local
tests that can reach loopback do not need a public tunnel.

## One-time human setup

The owner deploys one host, configures DNS/CDN/TLS for each exact public hostname, and
approves a separate enrollment for each independently running environment. The owner
installs release-matched connector tools and supplies a protected configuration path.
Agents may invoke the CLI with that path; they must not read, print, or copy the file.
Owner keys, passkeys, Bunny account keys, and approval ceremonies stay with the human.
See [Configuration](configuration.md) and [Deployment](deployment.md).

An exact hostname grant and a small route limit are preferable for a preview. A suffix
grant permits route creation within that suffix but does not provision DNS, CDN
hostnames, or certificates. Concurrent worktrees need distinct enrollments and public
hostnames. A second connector with the same enrollment replaces the first.

## Publish a temporary HTTP preview

Assume the human has supplied the alias `preview`, an isolated connector configuration,
and the granted, CDN-configured hostname `preview.example.com`. The application must
already listen on loopback port `3000` in the connector's network namespace.

1. Verify the intended origin locally, using a safe application health URL:

   ```sh
   curl --fail --max-time 5 http://127.0.0.1:3000/healthz
   ```

2. Inspect the secret-free control-plane check:

   ```sh
   bunny-hole check --config /protected/preview-config.json --host preview
   bunny-hole route list --config /protected/preview-config.json --host preview
   ```

   Confirm the host and enrollment are the intended ones. `connect` publishes all
   admitted routes for that enrollment. `check` does not verify the live FRP connection
   or public reachability.

3. Create one route and record its returned `id` for cleanup:

   ```sh
   bunny-hole route add --config /protected/preview-config.json --host preview \
     --name task-preview --protocol http --hostname preview.example.com \
     --target 127.0.0.1:3000
   ```

   If the intended route already exists, inspect its target and ownership before reuse.
   Route creation is not an idempotent update. Do not delete unrelated routes to resolve
   a conflict.

4. Run the connector in a task-owned foreground process or supervised job:

   ```sh
   bunny-hole connect --config /protected/preview-config.json --host preview
   ```

   Poll the public application health URL from another process with a bounded deadline.
   Do not treat a successful `check`, process startup, or one particular HTTP error as
   proof of readiness. Check the expected application response:

   ```sh
   curl --fail --max-time 5 https://preview.example.com/healthz
   ```

   Verify an unauthenticated request is denied when the application is intended to be
   private. Keep viewer credentials in the application's approved secret mechanism, not
   in command output or a shared link. Then share only the intended URL.

5. On completion, failure, or cancellation, stop the task-owned connector with `SIGINT`
   or `SIGTERM` and delete only the route created by this task:

   ```sh
   bunny-hole route delete ROUTE_ID --config /protected/preview-config.json --host preview
   bunny-hole route list --config /protected/preview-config.json --host preview
   ```

   Confirm the route is gone and the public URL no longer reaches this application.
   Record unfinished cleanup if the host is unavailable. Removing a local host alias
   does not revoke its enrollment or remove server-side routes.

## Boundaries for agent tasks

- Public URLs are public unless the application supplies viewer authentication. An
  enrollment, encrypted transport, or unguessable hostname is not viewer access control.
- Routes do not expire automatically. Five-minute admission tokens limit session login;
  they do not impose a five-minute preview lifetime. Stopping one process does not stop
  a replacement connector from using a retained route.
- Public WebSocket upgrades are unsupported. Development hot reload using WebSockets
  will not work through this tunnel; ordinary HTTP and bounded SSE can work. Requests
  have a configured whole-response deadline, including SSE.
- A container's loopback is its own namespace, not the developer host. Publish to host
  loopback or deliberately configure an allowed private-network target. Do not widen
  origin policy merely to bypass a connectivity error.
- Prefer the CLI for one preview. Compose and Kubernetes are optional orchestration
  adapters. A Compose adapter owns all `compose-` routes for its enrollment and should
  not share credentials with another project.
- The TypeScript library supports an abort signal for one FRP run. Its caller supplies
  release-matched FRP/CA files, process supervision, readiness verification, and
  cleanup. There is no requirement to introduce MCP for an agent that can already invoke
  a CLI.

Use synthetic data and an application with appropriate authentication. Do not expose an
agent terminal, unrestricted command runner, cloud metadata endpoint, filesystem
browser, or unauthenticated administrative dashboard.
