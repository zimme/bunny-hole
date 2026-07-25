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
- **Memory/slow-peer exhaustion:** header/body/frame/concurrency limits, high-water-mark
  backpressure, request/origin/authentication/heartbeat timeouts, cancellation and
  disconnect cleanup.
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
