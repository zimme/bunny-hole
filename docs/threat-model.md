# Threat model

## Assets and trust boundaries

Assets are tunnel secrets, local-origin confidentiality/integrity, public viewer
credentials, relay availability, and released artifact integrity. Untrusted parties
include public HTTP clients, unauthenticated WebSocket peers, compromised networks,
malicious origins, package consumers, and contributors modifying CI.

The Bunny CDN and Magic Container platform are trusted to terminate TLS and run the
configured image. Relay operators can observe proxied application traffic. Local
connectors trust the configured relay hostname and their configured origin. An
application embedding the connector library shares the connector trust boundary: that
process can read the tunnel secret and all tunneled origin traffic. The library does not
provide process isolation or secret storage.

The experimental Edge Script relay additionally trusts Bunny to keep a WebSocket and the
invocation state owning it alive. Correctness also requires public HTTP requests to
reach that exact state. Bunny does not currently document this affinity. A routing miss
fails closed with 503; it must never fall back to a viewer-selected origin. The optional
diagnostic token is a separate test secret, is timing-safely compared, and exposes only
ephemeral instance IDs and aggregate counts.

## Principal threats and controls

- **Connector impersonation/replay:** 256-bit secrets, fresh nonce HMAC
  challenge-response, WSS, authentication timeout, generic failure.
- **Open proxy/SSRF:** exact hostname-to-tunnel mapping; no viewer-selected tunnel or
  destination; connector origin is fixed and loopback by default.
- **Request smuggling/injection:** Deno's HTTP parser, token/header validation, single
  structured path field, no trailers, hop-by-hop stripping, bounded frames.
- **Header spoofing/secret crossing:** internal and forwarding headers removed; trusted
  forwarding values replaced; structured secret-redacted logging.
- **Cross-request data:** random correlation IDs, tunnel ownership checks, strict state
  transitions, per-request stream/controller maps, concurrency tests.
- **Memory/slow-peer exhaustion:** header/body/frame/request and pending-authentication
  limits, bounded high-water-mark backpressure waits, request/origin/authentication/
  heartbeat timeouts, cancellation and disconnect cleanup.
- **Connector takeover:** documented newest-authenticated-wins policy closes the old
  socket and fails its pending requests. Secret rotation revokes old clients.
- **Container escape/persistence:** non-root distroless runtime, read-only filesystem,
  no capabilities, no-new-privileges, no persistent volume.
- **Supply chain:** frozen lockfile, minimal runtime dependencies, pinned toolchain and
  actions, tag-only releases, registry OIDC, isolated package installation, artifact
  allowlists, checksums, SBOM and provenance attestations, CodeQL, dependency review,
  Scorecard, and reproducible local validation.

## Residual risks

The account API key used for optional deployment is long-lived and broad according to
current Bunny documentation. Keep deployment manual or protect the key with a GitHub
Environment approval. A relay compromise exposes live application traffic and can send
requests to connected origins. Bunny Hole supplies transport, not viewer authentication;
protect sensitive origins with their own authorization. One instance is an availability
and state-loss boundary.

The Edge Script experiment is not a supported deployment until multi-location and load
testing plus a Bunny platform guarantee establish its state-routing semantics. Magic
Container rolling updates can temporarily overlap relay pods; maintenance-mode 503s are
expected until the deployment returns to exactly one healthy instance.
