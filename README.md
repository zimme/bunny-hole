# Bunny Hole

Bunny Hole is a self-hosted, Bunny-native reverse HTTP tunnel. It exposes an HTTP
service behind NAT or a firewall without opening an inbound port:

```text
public client → Bunny CDN → Magic Container relay
              → outbound WSS connector → loopback HTTP origin
```

The relay authenticates connectors, maps configured public hostnames to named tunnels,
and multiplexes bounded HTTP streams over one persistent WebSocket. Bunny CDN supplies
public TLS, custom hostnames, and WebSocket delivery. Bunny Edge Scripting, Bunny
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
[deployment instructions](docs/deployment.md) for Bunny setup.

Run the connector after configuring the relay:

```sh
export BUNNY_HOLE_TUNNEL_SECRET # enter interactively in your own terminal
deno run --allow-env --allow-net --allow-read apps/connector/main.ts connect \
  --relay wss://home.example.com \
  --tunnel home \
  --origin http://127.0.0.1:3000
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

Read [SECURITY.md](SECURITY.md) and the [threat model](docs/threat-model.md) before
exposing a sensitive service.

## Repository map

- `apps/relay`: in-memory Magic Container relay
- `apps/connector`: local daemon and CLI
- `packages/protocol`: versioned framing, authentication, limits, and filtering
- `fixtures/origin`: deterministic integration origin
- `tests`: unit, state, malformed-input, and security behavior tests
- `compose.yaml`: production-image end-to-end topology
- `.devcontainer`: common local, CI, and coding-agent toolchain

Developer commands and cache design are in [docs/development.md](docs/development.md).
Runtime settings are in [docs/configuration.md](docs/configuration.md). Design and
official research are in [docs/architecture.md](docs/architecture.md) and
[docs/protocol.md](docs/protocol.md). Releases follow
[Compatibility Versioning](docs/versioning.md).

## License

[MIT](LICENSE)
