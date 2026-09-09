# Deploy to Bunny

This guide uses the Bunny web console and immutable published images. It does not
connect Bunny to GitHub and keeps every secret-bearing action in a human-controlled
terminal or dashboard session.

## 1. Generate the owner identity

Download the Bunny Hole CLI for your platform from a release and verify it against
`SHA256SUMS` and the GitHub attestation. In a separate private terminal:

```sh
umask 077
bunny-hole owner generate --output ./bunny-hole-owner.json
```

The command writes the private key only to the protected file and prints the public key.
Back up the file in a password manager or hardware-encrypted store. Copy only the public
key for the next step. Do not paste the private file or its contents into an AI chat,
issue, log, environment variable, shell argument, or Git repository.

## 2. Select the host image

Choose an existing immutable `MAJOR.MINOR.0` release and record its digest:

```sh
docker pull ghcr.io/zimme/bunny-hole-host:REPLACE_WITH_COMVER
docker inspect --format '{{index .RepoDigests 0}}' \
  ghcr.io/zimme/bunny-hole-host:REPLACE_WITH_COMVER
```

Use the digest in production. Releases also provide SPDX SBOMs and GitHub provenance
attestations. Do not deploy `latest`, a branch tag, or an unreviewed locally built
image.

## 3. Create one Magic Container application

In **Magic Containers** in the Bunny dashboard:

1. Create an application with one region and exactly one running instance. Do not enable
   horizontal autoscaling. Select enough memory for FRP, SQLite, and the configured
   maximum concurrent HTTP bodies.
2. Add one container using the host image digest. If the GHCR package is private, enter
   registry credentials in the dashboard.
3. Expose TCP ports `8080` and `7000`. Port 8080 serves health, management, FRP plugin,
   and public HTTP ingress. Port 7000 receives connector WebSockets from its CDN
   endpoint.
4. Mount persistent storage at `/var/lib/bunny-hole`. The host identity, enrollments,
   passkeys, grants, audit events, and routes live there. This volume does not make live
   FRP connections portable between instances.
5. Enter these environment variables in the dashboard:

   ```text
   BUNNY_HOLE_PUBLIC_URL=https://manage.hole.example
   BUNNY_HOLE_CONNECTOR_HOST=connect.hole.example
   BUNNY_HOLE_CONNECTOR_PORT=443
   BUNNY_HOLE_CONNECTOR_TRANSPORTS=wss
   BUNNY_HOLE_OWNER_PUBLIC_KEY=PUBLIC_KEY_PRINTED_IN_STEP_1
   BUNNY_HOLE_REQUEST_TIMEOUT_MS=30000
   BUNNY_HOLE_LOG_FORMAT=json
   ```

6. Configure a startup check and readiness check on port 8080 at `/readyz`, and a
   liveness check at `/healthz`. Allow enough startup failures for image pull, SQLite
   initialization, and FRP startup. A two-second check interval and timeout are a useful
   starting point; use the current dashboard-supported values.

The production image runs as a non-root user. Keep the root filesystem read-only if the
dashboard supports it and make only `/var/lib/bunny-hole` writable. Do not add Linux
capabilities or privileged mode.

## 4. Create the two CDN endpoints

Create a Magic Container CDN endpoint for container port `8080`:

- Attach `manage.hole.example` and every public route hostname, then complete DNS and
  TLS certificate issuance.
- Disable caching for all paths and status codes. Preserve methods, bodies, query
  strings, `Authorization`, cookies, and `Set-Cookie`; Bunny Hole transports application
  HTTP and does not authenticate public viewers.
- Keep CDN body and request-time limits consistent with the host: the streaming host
  ceiling is 1 GiB and the timeout is 30 seconds by default. A stricter CDN setting is
  acceptable when intentional.
- Do not attach an untrusted wildcard hostname. Routes are exact and must also exist in
  the host database.

Create a second CDN endpoint for container TCP port `7000`:

- Attach only `connect.hole.example` and issue TLS.
- Enable WebSockets.
- Disable caching.
- Do not publish port 7000 directly to the Internet. Connectors use WSS on port 443.

The management and public HTTP traffic can share port 8080 because the host accepts
control routes only when the exact HTTP Host matches `BUNNY_HOLE_PUBLIC_URL`; a tunneled
application hostname cannot reach them. The connector endpoint is separate because it
forwards WebSockets to FRP's transport listener.

## 5. Create the first passkey

Wait for both CDN endpoints and `/readyz` to be healthy. In the private terminal:

```sh
bunny-hole host add --name production --url https://manage.hole.example
bunny-hole owner passkey --host production \
  --owner-key ./bunny-hole-owner.json --name primary
```

The second command prints a short-lived one-use URL on the configured management origin.
Open it, verify the hostname, and register a platform or roaming passkey. The owner
private key authorizes only this bootstrap and never enters the browser; normal
enrollment approval can then use the passkey. Keep the owner file offline for recovery
and passkey rotation.

`host add` also creates a pending enrollment for the current machine. Make a grant file
containing only the hostnames this device may publish:

```json
{
  "exactHostnames": ["home.example.com"],
  "hostnameSuffixes": [],
  "protocols": ["http", "https"],
  "maxRoutes": 8
}
```

Approve the displayed enrollment ID with the passkey:

```sh
bunny-hole enrollment approve ENROLLMENT_ID \
  --host production --grant ./home-grant.json --passkey
```

The browser shows the enrollment ID, device name, verification phrase, requested grant,
and host origin. Confirm that they match the separate connector terminal before touching
the passkey.

## 6. Publish a local HTTP service

Create and connect an exact route:

```sh
bunny-hole route add --host production --name home-assistant \
  --protocol http --hostname home.example.com --target 127.0.0.1:8123
bunny-hole check --host production
bunny-hole connect --host production
```

The connector opens only outbound WSS and proxies only the stored origin. Loopback is
the default. For an explicit Docker, Compose, or private-network service address, add
`--allow-private-network`; never use that option merely to bypass a typo or turn the
connector into a general proxy. Keep Home Assistant, Plex, and similar applications' own
authentication enabled. Bunny Hole does not add viewer accounts.

Test `https://home.example.com/` from a different network. A generic 404 means no active
exact route, 502 means connector/origin failure, and 503 means the host is draining or
at its concurrency bound. Public errors intentionally omit internal detail.

## Kubernetes enrollment before installation

A cluster needs no public URL. Before deploying the controller, create its key pair and
pending enrollment from the private terminal, redirecting stdout to a protected file:

```sh
umask 077
bunny-hole cluster prepare --url https://manage.hole.example \
  --name home-cluster --namespace bunny-hole-system \
  --secret-name bunny-hole-home-credentials \
  > ./home-cluster-enrollment.yaml
```

The namespace must match the controller deployment namespace. Its ClusterRole can
discover public routing resources, while a separate namespaced Role limits credential
Secret reads to that namespace.

The command refuses to print the Secret to a terminal. Its stderr contains only the
enrollment ID and human verification phrase. Approve that ID with an exact/suffix grant,
then deliver the generated Secret through SOPS, Sealed Secrets, External Secrets, or
another secret manager. Apply the public CRD/controller/Gateway resources with your
normal GitOps reconciler. One host can enroll many clusters; one cluster can declare
many `BunnyHoleHost` resources, each with a separate key pair and revocation boundary.

## Compose and container use

The connector OCI works with Docker, Compose, and Podman. Mount its protected state file
read-only, use a read-only root filesystem, drop all capabilities, set
`no-new-privileges`, and run as the file-owning non-root UID. The connector image
contains the Bunny Hole CLI and pinned `frpc`; it does not contain the host.

The `bunny-hole compose plan|sync|up` adapter derives routes only from explicit
`dev.bunny-hole.*` labels. See [configuration](configuration.md#compose-discovery). It
is an opt-in reconciler, not a transparent Docker socket proxy. Access to the Docker
socket is equivalent to host-root access; prefer a restricted socket proxy or run
`plan`/`sync` from a trusted local CLI.

## Operations and cost

- **Logs:** use Magic Container logs for structured host events, connector stderr for
  FRP lifecycle events, and CDN logs for edge delivery. Logs omit secrets and request
  bodies.
- **Revoke:**
  `bunny-hole enrollment revoke ENROLLMENT_ID --host production
  --owner-key ./bunny-hole-owner.json`
  invalidates sessions and routes. Stop the connector and remove its local state after
  revocation.
- **Rotate:** enroll a new device/cluster key, approve the same least-privilege grant,
  cut over during a maintenance window, then revoke the old enrollment. Passkeys are
  management credentials, separate from connector device keys.
- **Update:** choose a newer immutable ComVer image digest. Expect active requests and
  connectors to drop when the single instance is replaced. Verify `/readyz` and
  reconnect.
- **Rollback:** select the recorded prior digest. The persistent state schema is treated
  as part of the host's ComVer compatibility promise.
- **Cost:** estimate continuously allocated Magic Container CPU and memory, CDN traffic
  in both directions, and one long-lived CDN WebSocket per connector enrollment. Bunny's
  current CDN WebSocket pricing is per connection-minute beyond the included allowance;
  verify the live dashboard and [official pricing](https://bunny.net/pricing/) before
  purchase.

One region and one instance are deliberate correctness constraints. A database can store
routes and credentials but cannot transfer an established socket or its live byte-stream
state. Adding instances requires proven session affinity or a stateful routing/messaging
layer and is future work, not an autoscaling toggle.

## Optional manual GitHub deployment workflow

`.github/workflows/deploy-bunny.yml` can update an existing app only when manually
dispatched with an existing release version and matching digest. Protect the
`production` GitHub Environment with reviewers. Set `BUNNY_APP_ID` and
`BUNNY_CONTAINER_NAME` as environment variables, then enter the API key interactively:

```sh
gh secret set --env production BUNNYNET_API_KEY
```

Current Bunny documentation describes a full account API key and does not document OIDC
or a scoped temporary deployment credential. Keep deployment manual if that broad,
long-lived credential is unacceptable. The workflow never creates an app or deploys on
an ordinary branch push.

## Safe agent-assisted setup prompt

> Help me deploy Bunny Hole using `docs/deployment.md`. Never ask for, display, or
> handle my Bunny API key, owner private key, passkey response, connector config,
> Kubernetes Secret, registry token, or secret-bearing command output. Pause before each
> such step while I use the Bunny dashboard or a separate private terminal. Continue
> only from non-sensitive values such as resource IDs, public hostnames, public keys,
> image digests, verification phrases, and health status. Do not create, change, deploy,
> tag, release, or delete infrastructure without my explicit approval.

## Repository owner setup before the first release

Enable GitHub release immutability before the first release. Create `@zimme/bunny-hole`
on JSR and link it to this repository. npm requires the package to exist before a
trusted publisher can be configured, so publish the exact first generated tarball
interactively with npm 2FA, then configure `.github/workflows/release.yml` as its OIDC
trusted publisher using the `release` Environment. Subsequent tag workflows require no
npm or JSR token.
