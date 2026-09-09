# Threat model

## Scope and trust boundaries

Bunny Hole exposes a deliberately configured HTTP application through Bunny CDN, one
Bunny Magic Container host, an outbound FRP-over-WSS connector, and a fixed local
origin. It does not provide public WebSocket, raw TCP/UDP, VPN routing, viewer identity,
or high availability.

Protected assets are owner/device private keys, passkeys, host identity, admission
tokens, local-origin confidentiality and integrity, public viewer credentials carried as
application data, route policy, live traffic, and released artifacts. Trust crosses:

1. the public viewer into Bunny CDN and the host HTTP parser;
2. the CDN into the Magic Container;
3. the control client into enrollment and route APIs;
4. the host FRP plugin into `frps`;
5. the outbound WSS session into `frpc`; and
6. the connector into its configured local HTTP/HTTPS origin.

Bunny is trusted to terminate public TLS, route each endpoint to the configured
container port, and isolate the application. A host operator or compromised host can
observe and alter tunneled HTTP. An application embedding the TypeScript library shares
its process and key boundary. A Kubernetes controller can read only referenced Secrets
by RBAC, but a compromised cluster administrator can read every cluster credential.

## Threats and controls

### Connector or administrator impersonation

- Each device or cluster creates a per-host Ed25519 pair locally. The private key is
  mode-`0600`, is never accepted as a flag, and never crosses the network.
- Session authentication signs a fresh random one-use challenge with a short expiry.
  Challenges are atomically consumed, bound to an enrollment, and deleted on expiry.
- Host-signed FRP admission tokens are bounded, purpose-separated, and expire after five
  minutes. The loopback plugin validates every login and proxy operation.
- Owner recovery signatures include host identity, purpose, device key, enrollment,
  canonical grant, and a consumed one-use host challenge. They cannot be replayed or
  substituted onto another host or grant.
- Passkeys require user verification, one-use WebAuthn challenges, RP/origin validation,
  and signature-counter updates. Short flow tokens remain in URL fragments until the
  management-origin page removes them and never become connector credentials.
- Verification phrases let a human compare the requesting terminal with the approval
  ceremony. Phishing remains possible if the human ignores the hostname or phrase.

### Replay, connector replacement, and revocation

- A newer authenticated FRP login for an enrollment deterministically replaces the old
  session. The plugin rejects subsequent old-session operations; streams are never moved
  or silently joined.
- Revoking an enrollment invalidates new sessions, plugin operations, and owned routes.
  Secret/key rotation uses a separately enrolled key pair followed by old-key
  revocation.
- The single-host process keeps current session ownership in memory. Restart
  deliberately drops all connections and requests.

### Open proxy, SSRF, and hostname confusion

- Public routing uses only a normalized exact `Host` mapped to a persisted active route.
  A viewer cannot supply an enrollment, route ID, target host, URL, or port.
- The connector targets only the origin stored in its signed session response. Loopback
  is mandatory unless that route has an explicit private-network grant.
- Route creation is limited by the enrollment's signed exact/suffix hostname and
  protocol grant. The management hostname is reserved and cross-enrollment hostname
  conflicts fail.
- Compose and Kubernetes reconcile only explicitly opted-in labels/Gateway objects and
  delete only their own prefixed routes. Cross-namespace Kubernetes Services need a
  `ReferenceGrant`.

### HTTP smuggling, injection, and secret crossing

- Deno and Node HTTP parsers validate wire framing. Bunny Hole independently bounds
  methods, paths, declared and streamed bodies, header count, and serialized header
  size.
- `CONNECT` and `TRACE`, GET/HEAD bodies, malformed hosts, control paths on application
  hostnames, public upgrades, and oversized input fail closed.
- Request and response hop-by-hop headers, every field named by `Connection`, all
  `x-bunny-hole-*` fields, and viewer-supplied forwarding headers are removed. Trusted
  forwarding values replace them.
- Public `Authorization`, cookies, and `Set-Cookie` remain application data only after
  an exact route is selected. They never authenticate or reach control handlers.
- Redirects are returned, never followed. Trailers are not forwarded. Partial responses
  are terminated instead of retried, preventing accidental duplicate side effects.

### Cross-request data and resource exhaustion

- FRP supplies independent multiplexed streams; the Deno proxy creates one upstream
  request object and abort controller per public request. Integration tests overlap
  requests with distinct binary bodies to detect stream crossing.
- Bodies stream with transport backpressure and a hard byte ceiling rather than being
  accumulated. Header/control JSON limits are much smaller.
- Global public concurrency, enrollment creation, enrollment count, grant route count,
  challenge lifetime, session lifetime, and request lifetime are bounded.
- Viewer cancellation, origin timeout, response completion, host shutdown, connector
  replacement, and process exit destroy upstream work and release state idempotently.
- This does not provide volumetric DDoS immunity; configure Bunny rate limiting/WAF and
  application-level limits for the exposed service.

### Container and local-host compromise

- Production images are distroless, non-root, and contain only a compiled application
  plus one checksum-verified FRP binary. They support read-only roots, dropped
  capabilities, `no-new-privileges`, and a small writable state or temporary mount.
- The connector deliberately has access to its configured origin and can observe that
  route's traffic. Compromise requires rotating the enrollment key and application
  credentials.
- A Docker socket grants daemon/host-root-equivalent control. The Compose adapter must
  run only in a trusted developer context or through a restricted socket proxy.
- Bunny Hole does not weaken Home Assistant, Plex, dashboards, or other application
  auth. Operators must not expose an unauthenticated administrative service merely
  because the transport is encrypted.

### Supply chain and contributor threats

- Deno, FRP, base images, Dev Container tools, dependencies, and GitHub Actions are
  pinned. Deno uses a frozen lockfile; FRP archives have architecture-specific hashes.
- Pull-request workflows use minimal permissions and do not receive deployment secrets.
  Dependency review, CodeQL, Scorecard, spelling, license, generated-file, audit, and
  reproducible secret checks run through repository validation/workflows.
- Tag-only increasing ComVer releases publish immutable OCI tags/digests, native
  checksums, SBOMs, and GitHub attestations. npm and JSR use OIDC after the
  human-controlled first package publication.
- The optional Bunny deployment is manual, environment-protected, and accepts only an
  already published version/digest pair. Ordinary pushes never deploy.

## Residual risk and deliberate limitations

A compromised Bunny account, CDN configuration, Magic Container host, or full-account
Bunny API key defeats the relevant boundary. Current Bunny documentation exposes no OIDC
or scoped temporary deployment credential, so dashboard deployment is safer when a
long-lived broad key is unacceptable.

SQLite protects durable policy from ordinary restarts but not from a compromised host.
It cannot store or migrate kernel sockets, FRP flow-control state, or in-flight bytes.
Multiple instances would need proven affinity or an authenticated stateful routing
layer; running replicas without it creates intermittent route failure and ambiguous
ownership.

The five-minute admission token may remain usable until expiry if copied from host or
connector memory. WSS, process isolation, secret-free logs, short lifetime, and newest-
session replacement reduce but do not eliminate that risk.

FRP remains third-party security-sensitive code. Bunny Hole pins one reviewed release
and constrains it through the authorization plugin; it does not claim to formally verify
FRP. Public WebSocket and L4 features are absent even though FRP has primitives for
them, because their ingress, authorization, backpressure, abuse, and Bunny endpoint
semantics need separate complete designs and tests.
