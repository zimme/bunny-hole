# Bunny Hole

[![ComVer compliant](https://img.shields.io/badge/ComVer-compliant-brightgreen.svg)](https://gitlab.com/staltz/comver)

Bunny Hole is a self-hosted reverse HTTP tunnel for services behind NAT or a firewall.
It combines Bunny CDN and one Bunny Magic Container with a local connector that makes
the only long-lived outbound connection. No inbound port forwarding, public IP, UPnP,
VPN, or Edge Script is required.

```text
viewer → Bunny CDN → Bunny Hole host → frps ══ outbound WSS ══ frpc → HTTP service
                         Magic Container                 connector
```

The Deno host owns enrollment, exact-host routing, header policy, and the FRP
authorization plugin. Pinned, checksum-verified [FRP](https://github.com/fatedier/frp)
provides the mature multiplexed data plane. The supported deployment is deliberately one
region, one Magic Container instance, and one active connector per enrollment.

## Supported behavior

- Streaming HTTP requests and responses, binary bodies, SSE, redirects, cookies, and
  `Authorization` as application data.
- HTTP or HTTPS local origins. The default target is loopback; any other target requires
  explicit private-network consent.
- A first-use CLI wizard, named hosts, per-host Ed25519 device keys, passkey approval,
  an offline owner recovery key, bounded reconnect backoff, native bundles, and a
  non-root connector OCI image.
- Compose labels for services published on loopback ports, and a GitOps-ready Kubernetes
  Gateway API controller using `Gateway`, `HTTPRoute`, and `ReferenceGrant`.
- One cluster connected to several Bunny Hole hosts and one host enrolling many devices
  or clusters.
- A TypeScript control library distributed as `@zimme/bunny-hole` on JSR and npm.

Bunny Hole does **not** promise public WebSocket proxying, arbitrary TCP or UDP,
end-to-end HTTP/2 semantics, multiple relay replicas, multi-region failover, a VPN, or
an open proxy. Those are distinct designs, not hidden experimental switches.

## Local development

Deno 2.9.5 is pinned throughout. The complete development image is Compose-native; Dev
Container-aware editors are optional adapters and add no Features.

```sh
docker compose up --build --detach development
docker compose exec --user vscode development deno task validate
docker compose down
```

The equivalent shorthands are `deno task devcontainer:up`,
`deno task devcontainer:exec -- deno task validate`, and `deno task devcontainer:down`.
Inside the development container, use:

```sh
deno task setup
deno task validate
deno task integration
```

## Connect a developer machine

Install a release bundle or use `ghcr.io/zimme/bunny-hole-connector`. Running
`bunny-hole` without arguments starts the first-use wizard. It asks for the host HTTPS
URL and a local alias, creates a per-host Ed25519 key, writes a mode-`0600`
configuration file, and prints the pending enrollment ID and a verification phrase.

On a trusted owner machine, compare that phrase and approve an explicit grant:

```json
{
  "exactHostnames": ["assistant.example.com"],
  "hostnameSuffixes": [],
  "protocols": ["http"],
  "maxRoutes": 4
}
```

```sh
bunny-hole enrollment approve ENROLLMENT_ID \
  --grant grants/home.json --passkey --host home

bunny-hole route add --host home --name assistant --protocol http \
  --hostname assistant.example.com --target 127.0.0.1:8123

bunny-hole connect --host home
```

The first passkey is bootstrapped with an offline owner key. Keep at least two passkeys
and store the owner key separately. Private keys and Bunny credentials must never be
pasted into an AI conversation, committed, or supplied as command-line values.

## Declarative local services

`bunny-hole compose up` starts the current Compose project, reconciles only its managed
routes, and runs the connector. The service port must be published to loopback so the
host-side connector can reach it without exposing it to the LAN:

```yaml
services:
  assistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    ports: ["127.0.0.1:8123:8123"]
    labels:
      dev.bunny-hole.host: home
      dev.bunny-hole.hostname: assistant.example.com
      dev.bunny-hole.target-port: "8123"
```

Run `bunny-hole compose plan` before `sync` or `up`. A connector intentionally placed
inside a Compose network may instead set `dev.bunny-hole.target-host` to a service name
and must also set `dev.bunny-hole.allow-private-network: "true"`.

## Kubernetes

Register a cluster before deploying the controller:

```sh
umask 077
bunny-hole cluster prepare --url https://hole.example.com --name home \
  --namespace bunny-hole-system --secret-name bunny-hole-home-credentials \
  > cluster-enrollment.yaml
```

The command sends only a public key to the host and writes the private key into the
redirected Kubernetes `Secret` manifest. Approve the displayed enrollment, then apply
the secret through SOPS, Sealed Secrets, External Secrets, or another GitOps secret
workflow and install [`deploy/kubernetes/base`](deploy/kubernetes/base). A
`BunnyHoleHost` chooses the host; `Gateway` and `HTTPRoute` choose explicitly granted
hostnames and Kubernetes Services. Helm and imperative enrollment inside the cluster are
not required. Before committing the deployment overlay, replace
`REPLACE_WITH_RELEASE_DIGEST` with the connector digest recorded by the release.

## Distribution

Each immutable `MAJOR.MINOR.0` release publishes:

- `ghcr.io/zimme/bunny-hole-host` for Magic Containers;
- `ghcr.io/zimme/bunny-hole-connector` for devices and Kubernetes;
- native bundles containing matching `bunny-hole` and `frpc` executables; and
- `@zimme/bunny-hole` for Deno, JSR, and npm consumers.

FRP 0.70.1 is included in the OCI images and native bundles; the library generates the
validated profile but does not pretend FRP is a TypeScript library. See
[third-party notices](THIRD_PARTY_NOTICES.md).

Library consumers provide credentials and the matching `frpc` executable explicitly:

```ts
import { createConnector } from "@zimme/bunny-hole";

const connector = createConnector({ credentials, frpcPath: "/opt/bunny-hole/frpc" });
const stop = () => connector.stop();
process.once("SIGTERM", stop);
const exitCode = await connector.run();
```

`run()` authenticates one session, writes a mode-`0600` ephemeral FRP profile,
supervises the process, and removes the profile on exit. The library does not download
executables, persist credentials, reconnect indefinitely, or accept an insecure
transport. Use the CLI or connector OCI image when those lifecycle responsibilities
should be managed for you.

## Security and limits

The host pins identities, uses one-use Ed25519 challenges and short-lived admission
tokens, authorizes each FRP proxy against durable grants, and supports user-verified
WebAuthn passkeys. It reserves control paths, routes only exact configured hostnames,
removes internal/hop-by-hop/spoofable forwarding headers, replaces trusted forwarding
values, and returns generic public errors.

Requests and responses stream with backpressure. Defaults are 100 headers, 32 KiB of
headers, an 8 KiB path, 1 GiB per body, 64 concurrent public requests, 30 seconds per
request, 256 routes per enrollment, and 1,024 non-revoked enrollments. The production
images are distroless, non-root, capability-free, and compatible with a read-only root
filesystem plus a persistent state volume.

Read [SECURITY.md](SECURITY.md), the [threat model](docs/threat-model.md), and the
[protocol profile](docs/protocol.md) before exposing a sensitive service.

## Repository map

- `apps/host` — control plane, exact-host HTTP ingress, passkeys, and FRP plugin.
- `apps/connector` — CLI, named-host state, connector supervisor, and library API.
- `apps/compose` and `apps/operator` — declarative Compose and Gateway API adapters.
- `packages/api` — bounded schemas, signing, authorization, and HTTP filtering.
- `deploy/kubernetes` — raw Kustomize-compatible controller manifests and examples.
- `fixtures/origin`, `tests`, and `compose.yaml` — production-image integration path.

See [deployment](docs/deployment.md), [configuration](docs/configuration.md),
[development](docs/development.md), [architecture](docs/architecture.md), and
[Compatible Versioning](docs/versioning.md).

## License

[MIT](LICENSE)
