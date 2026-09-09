# Bunny Hole protocol profile

Protocol version 1 is a bounded HTTPS control API plus a constrained FRP 0.70.1 data
plane. Request bodies are carried as binary HTTP stream bytes by FRP; Bunny Hole does
not base64-encode them or invent a second multiplexing wire format.

The normative endpoint shapes are in [`openapi.yaml`](openapi.yaml). This document also
defines validation and state-machine behavior that OpenAPI cannot express.

## Discovery and compatibility

`GET /.well-known/bunny-hole` on the management hostname returns:

- `apiVersion: 1`;
- the management origin and persistent host Ed25519 public key;
- the connector hostname, port, and allowed transports; and
- supported route protocols (`http` and `https`).

Clients reject unknown versions, malformed or unbounded fields, a management-origin
mismatch, and a changed pinned host identity. Released source/API compatibility follows
[ComVer](versioning.md). The FRP version is coupled to each host/connector release and
is not negotiated independently.

Control requests use `application/json`, UTF-8, and at most 128 KiB. Collections, names,
IDs, keys, tokens, challenges, and timestamps are independently bounded before use. IDs
have a validated ASCII prefix and 144 random bits. Control errors identify invalid input
but never echo keys, signatures, admission tokens, routes, or destinations.

`/api/*` and `/.well-known/*` are reserved on every public hostname. Only the configured
management hostname serves the documented control API; those paths never fall through to
a tunneled origin.

## Enrollment state machine

```text
new public key → pending (15 minutes) → active → revoked
                         expiry ────────┘
```

1. A device or cluster generates an Ed25519 pair locally.
2. `POST /api/v1/enrollments` sends its name, kind, and public key.
3. The host returns an enrollment ID and a five-word verification phrase. Creation is
   globally rate-limited to 30 attempts per minute and capped at 1,024 non-revoked
   enrollments.
4. The owner verifies the phrase and approves an explicit grant with a passkey or the
   offline owner key.

An `EnrollmentGrant` has exact hostnames, label-aware hostname suffixes, allowed
`http`/`https` local-origin protocols, and a maximum route count. A suffix of
`dev.example.com` permits `x.dev.example.com`, never `dev.example.com.attacker.test`.

Offline owner proofs sign this unambiguous message:

```text
bunny-hole\0PURPOSE\0HOST-PUBLIC-KEY\0FIELD-1\0...\0ONE-USE-CHALLENGE
```

The approval proof includes host identity, enrollment ID, device public key, canonical
sorted grant, and a host-issued 60-second challenge consumed before signature checking.
Approval is valid only while pending; revocation is terminal. Passkey ceremonies use
short-lived random flow tokens in URL fragments plus one-use WebAuthn challenges.
Registration flows require an owner signature. Approval flows bind one pending
enrollment and its canonical grant before authentication.

## Session authentication

1. `POST /api/v1/session/challenge` requests a challenge for an active enrollment.
2. The host stores a random 192-bit challenge for 60 seconds.
3. The connector signs enrollment ID, challenge ID, and challenge under the `session`
   purpose.
4. The challenge is atomically consumed; duplicate, expired, wrong-enrollment, or
   malformed exchanges fail uniformly.
5. The host returns current routes, a validated descriptor, and a five-minute signed FRP
   admission token.

The token includes enrollment ID, 144-bit session ID, issue time, and expiry. Its body
and signature are bounded. It can authorize `Login` only before expiry; it is not a
general API bearer token and is never logged.

## FRP profile and connector replacement

The connector writes a mode-`0600` ephemeral TOML file and starts the release-matched
`frpc`. Production permits only `wss` through the dedicated Bunny CDN connector
endpoint. FRP transport TLS is also enabled. TCP, QUIC, or unencrypted WebSocket may be
selected only with explicit local-development mode.

The control connection uses TCP multiplexing, a 20-second heartbeat and keepalive, and a
45-second dead-session timeout. `frps` limits connection pools and proxies, disables
detailed client errors, keeps its HTTP virtual-host port on the container network, and
calls the host's loopback-only authorization plugin for `Login`, `NewProxy`,
`CloseProxy`, `Ping`, `NewWorkConn`, and `NewUserConn`.

The plugin records the newest admitted token digest for each enrollment. A newer login
deterministically wins. Operations from the old connector receive `session replaced`, so
it disconnects no later than the dead-session window. Existing requests are not
transferred and can fail with the normal generic tunnel error.

For each route, the generated local proxy name is `bh-ROUTE_ID`; FRP presents the plugin
with the user-qualified name `bh-ENROLLMENT_ID.bh-ROUTE_ID`. The plugin accepts only:

- an active enrollment and latest admitted session;
- FRP proxy type `http`;
- exactly the persisted proxy name; and
- exactly one persisted custom hostname.

Unknown operations, names, types, domains, metadata, sessions, and revoked enrollments
are rejected. The fixed built-in FRP token is intentionally not a secret or security
boundary; host-signed admission, the plugin, and WSS provide that boundary.

## Route model

`POST /api/v1/routes` requires an enrollment session token and validates:

- a random route ID and bounded unique name;
- protocol `http` or `https` (the latter means an HTTPS local origin);
- one normalized exact public hostname not equal to the management hostname;
- one syntactically valid target host and port; and
- explicit `allowPrivateNetwork: true` for any non-loopback target.

The route must fit the enrollment's signed grant and cannot conflict with another exact
hostname. Viewers do not send route IDs. Deleting a route requires the owning
enrollment; no enrollment can list or delete another enrollment's routes.

## Public HTTP behavior

- Exact normalized `Host` selects the sole destination. Missing, malformed, unknown,
  management, or conflicting hostnames fail closed.
- Methods must be uppercase tokens of at most 20 characters. `CONNECT` and `TRACE` are
  rejected. GET/HEAD bodies, paths beyond 8 KiB, and malformed or greater-than-1-GiB
  declared bodies fail before forwarding.
- At most 64 public requests are active. Additional work receives a generic 503.
- Header count and serialized size are capped at 100 and 32 KiB. Deno's HTTP parser owns
  duplicate/framing validation before application code. Hop-by-hop headers,
  `Connection`-named fields, all `x-bunny-hole-*` fields, and viewer-supplied forwarding
  fields are removed. Trusted `X-Forwarded-Host`, `X-Forwarded-Proto`, and
  `X-Forwarded-For` values replace them.
- Viewer `Authorization`, cookies, and duplicate application headers are application
  data and reach only a selected origin. They never reach a control handler. Response
  `Set-Cookie` values remain separate; internal and hop-by-hop response headers are
  stripped.
- Bodies stream in both directions with backpressure and a 1 GiB ceiling per direction.
  The default end-to-end request timeout is 30 seconds and is configurable from 1 to 120
  seconds. Public disconnect, timeout, or host shutdown destroys the upstream request
  and releases concurrency state.
- Redirects are returned without following. Trailers are not forwarded. Partial origin
  responses are terminated rather than retried. Every public response sets
  `Cache-Control: no-store`; the Bunny CDN endpoint must independently disable caching.
- Public WebSocket upgrades receive 501. Raw TCP/UDP and arbitrary destinations have no
  route representation.

Bunny may use HTTP/2 with a viewer and an HTTPS origin may use its own protocol, but the
host/FRP profile exposes HTTP/1.1 behavior. End-to-end HTTP/2 stream identity, trailers,
server push, and protocol-specific semantics are not promised.

Viewer authentication is deliberately separate. Use the tunneled application's own
authentication or Bunny CDN access controls. Connector enrollment and session tokens are
never accepted as viewer credentials.

## Passkey browser ceremonies

WebAuthn requires the page origin to match the relying-party hostname. The CLI therefore
never hosts a localhost WebAuthn proxy. It asks the host to create a bounded one-use
flow and prints an HTTPS management URL whose random token is in the fragment, so the
token is not sent in the initial HTTP request or normal access log.

The static management-origin page removes the fragment from browser history immediately,
sends it only in same-origin JSON requests, and receives WebAuthn options for the host
RP ID. Registration consumes a five-minute owner-authorized flow. Enrollment approval
displays the pending enrollment and exact grant, requires user verification, and
consumes a two-minute flow before changing state. Failed final verification also
consumes the flow. Pages use no third-party resources and set CSP, no-referrer,
no-store, and nosniff headers.

## Declarative reconciliation

Compose labels and Kubernetes Gateway API objects compile into the same exact route
model. Reconciliation creates missing routes, replaces changed managed routes, and
deletes only stale routes carrying that adapter's prefix (`compose-` or `k8s-`). Manual
routes are preserved.

Compose defaults targets to `127.0.0.1`, requiring services to publish only a loopback
host port. A non-loopback `target-host` label needs explicit private-network consent.
Kubernetes resolves only `Service` backends; cross-namespace backends need a matching
`ReferenceGrant`. Neither adapter accepts a viewer-selected URL, raw Service discovery,
nor arbitrary Docker-socket inspection.
