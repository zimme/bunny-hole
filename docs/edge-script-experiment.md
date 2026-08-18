# Edge Script affinity experiment

This experiment determines whether a Bunny Edge Script can act as Bunny Hole's stateful
relay. It deploys the same relay state machine used by the Magic Container; the only
platform adapter is Bunny's WebSocket upgrade API.

This is not a production deployment guide. Bunny currently documents WebSocket support
but not the isolate affinity required for an ordinary HTTP request to find a connector
socket stored in memory.

## What the probe measures

At module startup, each Edge Script isolate generates a random instance identifier. When
diagnostics are enabled:

- authenticated `GET /_bunny/edge/diagnostics` calls report that identifier, isolate
  start time, request count, and aggregate connector/pending counts;
- ordinary responses include `X-Bunny-Hole-Edge-Instance`; and
- structured relay logs include `edgeInstanceId`.

The endpoint never returns tunnel IDs, hostnames, tunnel records, or private keys.
Failed diagnostic authentication returns the same generic 404 as a missing control
resource. The diagnostic token is timing-safely compared and independent of every
connector key.

## Build

Use the pinned development environment:

```sh
deno task devcontainer:up
deno task devcontainer:exec -- deno task edge:build
```

The deployable file is `dist/bunny-hole-edge-relay.js`. It imports Bunny's runtime
`@bunny.net/edgescript-sdk` and bundles all Bunny Hole code. The adapter is deliberately
not exported from the published `@zimme/bunny-hole` package: an unsupported experiment
must not become a compatibility promise or invite production use. Run it from this
repository until the affinity requirement is proven and the adapter can move to the
Bunny Edge Scripts repository.

## Human-controlled setup

Do not paste Bunny credentials, the diagnostic token, or a connector private key into an
AI conversation. In the Bunny dashboard or a private terminal:

1. Create a **Standalone** Edge Script.
2. Deploy `dist/bunny-hole-edge-relay.js`. The current official CLI supports
   `bunny scripts deploy`; authenticate interactively and never put an API key in the
   command.
3. Add `BUNNY_HOLE_TUNNELS` using the normal public tunnel-record JSON. It contains no
   connector private key.
4. Generate an independent random diagnostic token and add it as the
   `BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN` secret.
5. Use the Pull Zone created for the standalone script. Enable WebSockets, disable
   caching for every path, preserve query strings, and attach the test hostname/TLS
   certificate.
6. Keep Origin Shield disabled for the first run.

The connector uses the normal configuration and protocol:

```sh
./bunny-hole connect --config connector.json
```

Its relay URL must be the Edge Script Pull Zone's WSS hostname. Wait for a
`connector_authenticated` log and record only the non-secret `edgeInstanceId`.

## Direct Pull Zone run

In the same private terminal, load the diagnostic token without placing it in command
history. For example, use your shell's silent interactive input and export the resulting
environment variable. Then run:

```sh
deno task edge:probe -- https://tunnel.example /health
```

Choose a public path that the local fixture returns quickly. The command sends 40
cache-bypassed diagnostic/public pairs in concurrent batches and prints only:

- observed instance identifiers;
- how often each diagnostic instance saw an authenticated connector; and
- public HTTP status counts per serving instance.

It never prints the diagnostic token or a connector private key. Save the JSON report
only if the hostname and ephemeral instance identifiers are acceptable to disclose.

Repeat from networks that reach different Bunny PoPs and while generating concurrent
traffic. One local run cannot establish global affinity.

## Origin Shield run

After the direct result:

1. Enable one Origin Shield location closest to the connector.
2. Confirm all tunnel paths remain cache-bypassed.
3. Restart the connector so its WebSocket is established after the change.
4. Repeat the identical probe from the same networks.
5. Disable Origin Shield after the test unless the result and Bunny support confirm its
   WebSocket behavior.

If the dashboard refuses Origin Shield for an Edge Script origin, record that as an
unsupported combination rather than working around it.

## Interpretation

The Edge Script relay fails the experiment if any of these occur:

- public tunnel requests intermittently return 503 while the connector is authenticated;
- more than one instance identifier appears and any instance reports zero connectors;
- the connector and public responses consistently show different identifiers;
- Origin Shield interrupts the WebSocket or does not change divergent placement;
- load, deployment, or idle eviction loses the socket without prompt reconnection; or
- private keys, diagnostic tokens, or internal headers appear in responses or logs.

Seeing one identifier with successful requests is encouraging but not sufficient. A
supported Edge Script deployment still requires Bunny to guarantee that the observed
affinity is intentional and stable across PoPs, scaling, isolate eviction, deployments,
and failures.

If Bunny confirms that guarantee and multi-location testing passes, the Edge Script
adapter can move to the Bunny Edge Scripts repository as a package consumer. If not,
keep the single-instance Magic Container as the stateful origin.
