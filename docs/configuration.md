# Configuration

Bunny Hole fails closed when required production settings are absent or insecure. The
host reads environment variables. The connector reads a mode-`0600` JSON file by default
and accepts CLI flags for selecting a named host and route.

## Host environment

| Variable                          | Required/default                    | Purpose                                                                                       |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `BUNNY_HOLE_PUBLIC_URL`           | Required in production              | HTTPS origin of the management endpoint, for example `https://manage.hole.example`            |
| `BUNNY_HOLE_OWNER_PUBLIC_KEY`     | Required                            | Base64url Ed25519 public key used to authorize initial passkeys and enrollment administration |
| `HOST`                            | `0.0.0.0`                           | HTTP listener address                                                                         |
| `PORT`                            | `8080`                              | Management, health, FRP plugin, and public HTTP listener                                      |
| `BUNNY_HOLE_STATE_PATH`           | `/var/lib/bunny-hole/state.sqlite`  | SQLite control-plane state                                                                    |
| `BUNNY_HOLE_IDENTITY_PATH`        | `/var/lib/bunny-hole/identity.json` | Host Ed25519 identity; create on a persistent mode-`0700` directory                           |
| `BUNNY_HOLE_FRPS_PATH`            | `/usr/local/bin/frps`               | Bundled FRP server executable                                                                 |
| `BUNNY_HOLE_FRP_BIND_PORT`        | `7000`                              | Connector transport listener exposed through the connector CDN endpoint                       |
| `BUNNY_HOLE_FRP_HTTP_PORT`        | `9080`                              | Loopback-only HTTP vhost port used by the host proxy                                          |
| `BUNNY_HOLE_CONNECTOR_HOST`       | Public URL hostname                 | TLS hostname connectors use for FRP                                                           |
| `BUNNY_HOLE_CONNECTOR_PORT`       | `443`                               | TLS port connectors use                                                                       |
| `BUNNY_HOLE_CONNECTOR_TRANSPORTS` | `wss`                               | Advertised transports; production accepts only `wss`                                          |
| `BUNNY_HOLE_REQUEST_TIMEOUT_MS`   | `30000`                             | Whole public request/response deadline, from 1000 through 120000 ms                           |
| `BUNNY_HOLE_LOG_FORMAT`           | `json`                              | `json` for production or `pretty` for an interactive local terminal                           |
| `BUNNY_HOLE_DEVELOPMENT`          | `false`                             | Permits HTTP and direct connector transport only for reserved test or loopback hostnames      |

Listener ports must be distinct. `BUNNY_HOLE_PUBLIC_URL` must contain only an origin:
credentials, paths, queries, and fragments are rejected. The host never logs the owner
key, private host identity, bearer passkeys, enrollment challenge material, session
tokens, or complete request headers.

`BUNNY_HOLE_DEVELOPMENT` explicitly selects host and connector development behavior. The
Dev Container toolchain, `CI=true`, and an environment name do not enable it
automatically. The connector also accepts `--development` when connecting to a
development host. Development mode requires the management and connector hostnames to be
loopback or reserved `.test`/`.localhost` names. It still requires a public URL,
enforces the management `Host` boundary, and verifies that a connector's discovered
management origin matches its configured URL. Production DNS names are rejected when
this mode is enabled. The flag does not select direct transport by itself: WSS and port
443 remain the defaults. A development fixture must explicitly configure any HTTP URL or
direct connector transport it needs.

`GET /healthz` reports process liveness. `GET /readyz` succeeds only after the database,
host identity, and FRP server are ready and while the process accepts new work. Neither
endpoint returns secret-bearing state.

## Connector state and commands

The default state file is platform-specific and printed by `bunny-hole --help`. Override
it with `--config PATH` or `BUNNY_HOLE_CONFIG`. The connector creates parent directories
with mode `0700`, writes the file atomically with mode `0600`, and rejects files
readable by another Unix user. Back up the file as a secret: it contains one Ed25519
device key pair and enrollment ID per Bunny Hole host. Passkeys remain in their
authenticators and on the host.

Running `bunny-hole` without arguments starts an interactive wizard. It asks for the
management HTTPS URL, verifies the host descriptor and fingerprint, creates a local
device key, and prints the non-secret enrollment ID and verification phrase. An
administrator approves the enrollment from another authenticated CLI:

```sh
bunny-hole enrollment approve ENROLLMENT_ID \
  --host production --grant ./grant.json --passkey
```

The pending connector polls for approval, proves possession of its private key, stores a
short-lived host-signed session, and starts FRP. Subsequent sessions use fresh Ed25519
challenge-response; the private key never crosses the network.

WSS endpoint certificates are verified with the bundled `ca-certificates.crt` next to
`frpc`. Override that public CA-bundle path only when a deployment uses its own trust
roots, with `bunny-hole connect --trusted-ca-file FILE` or `BUNNY_HOLE_TRUSTED_CA_FILE`.
The file must be a non-empty PEM bundle. Bunny Hole never falls back to unverified WSS
TLS.

Common management commands are:

```sh
bunny-hole host add --name production --url https://manage.hole.example
bunny-hole host list
bunny-hole host use production
bunny-hole host remove production --yes
bunny-hole owner passkey --host production --owner-key ./owner-key.json
bunny-hole enrollment status ENROLLMENT_ID --host production
bunny-hole enrollment revoke ENROLLMENT_ID --host production \
  --owner-key ./owner-key.json
bunny-hole route add --name home --host production --protocol http \
  --hostname home.example.com --target 127.0.0.1:8123
bunny-hole route list --host production
bunny-hole route delete ROUTE_ID --host production
bunny-hole check --host production
bunny-hole connect --host production
```

`connect` reconnects with exponential backoff, bounded jitter, and a maximum delay. It
stops cleanly on `SIGINT` and `SIGTERM`. A second authenticated connector for the same
enrollment deterministically replaces the first. Stable process exit codes are `0`
success, `64` invalid CLI usage, `69` connection or runtime failure, and `78` invalid
configuration or rejected authentication.

`check` prints secret-free JSON with `valid`, `host`, `url`, `enrollmentId`,
`scope: "control-plane"`, and the admitted `routes`. Inspect those routes before
starting a connector: `connect` publishes all of them for that enrollment. A successful
check validates control-plane authentication and the pinned host identity; it does not
prove that FRP is connected, the origin is healthy, or public DNS/CDN/TLS works. Verify
the intended public URL separately. See [Agent use](agent-use.md) for temporary previews
and cleanup.

## Consumer agent guidance

Use `bunny-hole skill` to print the bundled consumer instructions without a configured
host or network access. Use `bunny-hole skill --output PATH` to upsert a skill file,
including its parent directories; existing content at that path is replaced. For
example, install into `.agents/skills/bunny-hole/SKILL.md` for a tool that discovers
project skills there. The CLI does not install project skills during enrollment or
include credentials in the export. See [Agent use](agent-use.md).

## Routes and origins

Only `http` and `https` local origin routes are supported. `https` means TLS from the
connector to its fixed local origin; it does not add public WebSocket or arbitrary TCP
support. Hostnames are normalized and matched exactly. A public request cannot name an
enrollment, route, port, or destination.

Origins default to `127.0.0.1`; IPv6 loopback `::1` is also permitted. A non-loopback
target is rejected unless that individual route has `allowPrivateNetwork: true`. This
opt-in is intended for an explicit Compose or Kubernetes service address; it is not
permission for arbitrary destinations.

## Compose discovery

Run the connector adapter with access to the Docker API and labels on opted-in services:

```yaml
labels:
  dev.bunny-hole.host: production
  dev.bunny-hole.name: compose-home-assistant
  dev.bunny-hole.hostname: home.example.com
  dev.bunny-hole.protocol: http
  dev.bunny-hole.target-host: 127.0.0.1
  dev.bunny-hole.target-port: "8123"
```

The service port must be published to host loopback when the adapter uses the default
`127.0.0.1`. To connect through a private container network instead, set an explicit
`dev.bunny-hole.target-host` and `dev.bunny-hole.allow-private-network: "true"`. The
adapter reconciles only labeled routes and never treats arbitrary public request data as
a destination.

One Compose project owns all `compose-` routes for its enrollment. Sync removes any such
routes absent from the current project, even when another project created them. Use
separate enrollment/configuration files for independently managed projects. Named hosts
in one configuration file are all reconciled; hosts with no labeled services have their
stale `compose-` routes removed. This also respects the one-active-connector limit per
enrollment.

## Kubernetes GitOps

Install the checked-in manifests with the standard Gateway API CRDs. A `BunnyHoleHost`
names a pre-registered host and references a Secret containing the credential file
generated by the host-side registration command. Credential Secrets must live in the
controller namespace; its namespaced Role cannot read Secrets elsewhere. Host resources
outside that namespace are ignored. Every 15 seconds, the controller lists `Gateway`,
`HTTPRoute`, `ReferenceGrant`, and `BunnyHoleHost` resources and reconciles only its
managed routes. Its deliberately narrow profile accepts HTTP listeners and whole-host
`HTTPRoute` resources with one Service backend; it refuses path matches, filters,
traffic splitting, and unsupported listener policies. Gateway attachment follows
allowedRoutes; cross-namespace Gateway-to-host delegation and Service backends require
ReferenceGrant. It does not claim Gateway API conformance, publish resource status, or
require a public cluster URL or inbound cluster port.

The host can enroll multiple clusters, and a cluster can contain multiple named
`BunnyHoleHost` resources. Register each cluster-host pair separately so compromise and
revocation remain scoped. Commit public CRDs, Gateways, HTTPRoutes, and secret
references to Git; deliver the generated Secret through a secret manager or encrypted
GitOps mechanism, never plain Git.

## Limits

Protocol and HTTP limits are centralized in `packages/api/mod.ts`: request and response
bodies are 1 GiB while streaming, paths 8 KiB, control JSON 128 KiB, headers 32 KiB/100
fields, and the single host accepts at most 64 concurrent public requests. Configure CDN
and Magic Container limits consistently; an intentionally smaller CDN limit is safe.
Trailers are not forwarded; hop-by-hop, internal, and spoofable forwarding headers are
removed.

## Hardening migration to 1.0.0

Upgrade host and connectors together. Enrollment phrases now contain sixteen words (64
bits); compare the entire phrase. HTTPS origins require valid certificates matching the
configured target hostname. For a private CA, set `BUNNY_HOLE_ORIGIN_CA_FILE` in the
CLI/container process, or pass `originCaFile` to `createConnector`. This bundle is
separate from the connector WSS `trustedCaFile`. No TLS verification bypass is provided.
The low-level `frpcConfig` helper accepts HTTP routes only; use the supervised connector
for HTTPS origins so its verified bridge remains alive.

Keep BunnyHoleHost resources and Secrets in `BUNNY_HOLE_CREDENTIALS_NAMESPACE`.
Cross-namespace Gateways need the explicit grant shown in
[`deploy/kubernetes/example/host-and-route.yaml`](../deploy/kubernetes/example/host-and-route.yaml).
Healthy operator connections remain alive beyond admission-token expiry. Compose and CLI
reconnect with fresh authentication after process exit.

List or revoke owner passkeys using the offline recovery key in a private terminal:

```sh
bunny-hole owner passkey-list --host production --owner-key ./owner-key.json
bunny-hole owner passkey-revoke CREDENTIAL_ID --host production --owner-key ./owner-key.json
bunny-hole enrollment purge ENROLLMENT_ID --host production --owner-key ./owner-key.json
```

Purge is available only after revocation; it removes the live enrollment record and
associated audit records, not backups or vendor logs. See [correctness](correctness.md)
for retention and operator acceptance. Cancellation sends SIGTERM, then SIGKILL after
two seconds if the child does not stop.
