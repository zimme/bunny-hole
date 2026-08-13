# Bunny Hole

[![ComVer compliant](https://img.shields.io/badge/ComVer-compliant-brightgreen.svg)](https://gitlab.com/staltz/comver)

Bunny Hole is a self-hosted, Bunny-native reverse HTTP tunnel. It exposes an HTTP
service behind NAT or a firewall without opening an inbound port:

```text
public client → Bunny CDN → stateful relay
              → outbound WSS connector → loopback HTTP origin
```

The relay authenticates connectors, maps configured public hostnames to named tunnels,
and multiplexes bounded HTTP streams over one persistent WebSocket. Bunny CDN supplies
public TLS, custom hostnames, and WebSocket delivery. The supported relay deployment is
a single Magic Container instance. An experimental Edge Script build exists to test
whether Bunny provides the undocumented isolate affinity it would require. Bunny
Database, inbound firewall changes, and public IP discovery are not used.

> [!IMPORTANT]
> Version 0.1 is intentionally one relay instance in one Magic Container region. It does
> not support multiple replicas, public WebSocket proxying, TCP, UDP, or end-to-end
> HTTP/2.

## Quick start

Requires the pinned Deno version from `.tool-versions` and Docker:

```sh
deno task setup
deno task test
deno task integration
```

Generate a tunnel record locally:

```sh
deno run --allow-env --allow-read apps/connector/main.ts generate \
  --tunnel home --hostname home.example.com
```

The command prints a new secret once. Redirect it to a protected file and set mode
`0600`; do not paste it into an AI chat, shell argument, issue, or commit. See
[deployment instructions](https://github.com/zimme/bunny-hole/blob/main/docs/deployment.md)
for Bunny setup.

Run the connector after configuring the relay:

```sh
export BUNNY_HOLE_TUNNEL_SECRET # enter interactively in your own terminal
deno run --allow-env --allow-net --allow-read apps/connector/main.ts connect \
  --relay wss://home.example.com \
  --tunnel home \
  --origin http://127.0.0.1:3000
```

## Distribution

Each ComVer release publishes the same connector implementation in four forms:

- `ghcr.io/zimme/bunny-hole-relay` — the self-hosted Magic Container relay image.
- `ghcr.io/zimme/bunny-hole-connector` — a non-root connector image for a local machine
  or server.
- Native connector executables for Linux, macOS, and Windows in the GitHub release.
- `@zimme/bunny-hole` on JSR and npm for embedding the connector lifecycle in a Deno or
  Node.js application, and for importing the experimental Edge Script handler.

The npm artifact is a library, not a CLI wrapper. Use the native executable or connector
OCI image for daemon operation. An embedded connector still connects only to its fixed
configured origin and gets the same validation, framing, authentication, timeouts, and
reconnect behavior:

```ts
import { createConnector } from "jsr:@zimme/bunny-hole@0.1.0";

const connector = createConnector({
  relayUrl: "wss://home.example.com",
  tunnelId: "home",
  secret: Deno.env.get("BUNNY_HOLE_TUNNEL_SECRET")!,
  origin: "http://127.0.0.1:3000",
});
await connector.run();
```

Node.js 22.14 or newer consumers can install `@zimme/bunny-hole` from npm and import the
same API. Applications are responsible for loading the secret from protected input and
shutting down with an `AbortSignal` or `connector.stop()`.

The package also exports `@zimme/bunny-hole/edge-relay`. That handler is for the
documented [Edge Script affinity experiment](docs/edge-script-experiment.md), not a
production availability claim. The repository builds a single deployable script with:

```sh
deno task edge:build
```

## Security model

- Challenge-response HMAC proves possession of a per-tunnel 256-bit secret; the secret
  is never sent across the WebSocket.
- Only exact configured hostnames route to exact configured tunnel IDs.
- The public request cannot choose an origin. A connector reaches only its local
  configured origin, which is loopback-only unless explicitly relaxed.
- Binary bodies are framed, bounded, multiplexed, subject to timeouts, and cancelled on
  disconnect.
- Hop-by-hop, internal, and spoofable forwarding headers are stripped. Trusted
  forwarding values replace viewer-supplied ones.
- Control endpoints never proxy viewer authorization or cookies. Viewer authorization
  and cookies on normal tunneled requests are application data and are intentionally
  passed to the configured origin.
- Production images run non-root and support a read-only filesystem with all Linux
  capabilities dropped.

Read the [security policy](https://github.com/zimme/bunny-hole/blob/main/SECURITY.md)
and [threat model](https://github.com/zimme/bunny-hole/blob/main/docs/threat-model.md)
before exposing a sensitive service.

## Repository map

- `apps/relay`: in-memory Magic Container relay
- `apps/edge-relay`: portable experimental Edge Script adapter and diagnostics
- `apps/connector`: local daemon, CLI, and public library entry point
- `packages/protocol`: versioned framing, authentication, limits, and filtering
- `fixtures/origin`: deterministic integration origin
- `tests`: unit, state, malformed-input, and security behavior tests
- `compose.yaml`: production-image end-to-end topology
- `.devcontainer`: common local, CI, and coding-agent toolchain

Developer commands and cache design are in the
[development guide](https://github.com/zimme/bunny-hole/blob/main/docs/development.md).
Runtime settings are in the
[configuration reference](https://github.com/zimme/bunny-hole/blob/main/docs/configuration.md).
Design and official research are in the
[architecture](https://github.com/zimme/bunny-hole/blob/main/docs/architecture.md) and
[protocol](https://github.com/zimme/bunny-hole/blob/main/docs/protocol.md)
documentation. The
[Edge Script experiment](https://github.com/zimme/bunny-hole/blob/main/docs/edge-script-experiment.md)
tests direct and Origin Shield routing without assuming either works. Releases follow
[Compatible Versioning](https://github.com/zimme/bunny-hole/blob/main/docs/versioning.md).

## License

[MIT](https://github.com/zimme/bunny-hole/blob/main/LICENSE)
