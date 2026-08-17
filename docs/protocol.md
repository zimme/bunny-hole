# Tunnel protocol v1

The WebSocket subprotocol is `bunny-hole.v1`. Public deployments require WSS. Each
WebSocket message is exactly one binary frame:

```text
byte 0       protocol version (1)
byte 1       frame type
byte 2       correlation ID byte length (0 or 16–43)
next N       ASCII base64url correlation ID
remainder    bounded control JSON or raw body bytes
```

Text messages, unknown types, wrong versions, malformed UTF-8/JSON, invalid IDs, and
frames over 65,536 payload bytes close the connection. Control JSON is limited to 16,384
bytes and parsed into explicitly validated fields; it is not accepted as an
unconstrained object graph. Body chunks are raw binary, never base64 JSON.
Connection-level frames use an empty correlation ID; request-level frames require one.
Request/response end and cancellation frames have no payload. These shape rules are
enforced by both encoders and decoders.

## Authentication

1. Relay sends `challenge` with a fresh 192-bit nonce and version.
2. Connector sends `authenticate` with version and
   `HMAC-SHA-256(secret, "bunny-hole\0" || version || tunnel || nonce)`.
3. Relay uses a timing-independent byte comparison and sends `authenticated`.

The nonce prevents reuse of an observed proof on a new connection. Authentication must
finish within 5 seconds. Errors are generic and never include the ID, secret, proof, or
configured hostnames. A syntactically valid but unknown tunnel ID receives the same
upgrade and challenge flow using an ephemeral decoy key, then fails authentication
generically; the initial HTTP status therefore does not enumerate configured IDs.

## Request state machine

```text
request_start → request_body* → request_end
response_start → response_body* → response_end
                 ↘ cancel ↙
```

Correlation IDs bind every frame to one in-memory request. Duplicate starts/ends,
body-before-start, body-after-end, unknown IDs, crossed tunnel ownership, and unexpected
directions are protocol errors. `cancel` aborts the peer's fetch or stream. A connector
disconnect completes pending public requests with a generic 502; replacement completes
them with 503.

Cancellation races are explicitly bounded. Each peer retains up to 128 short-lived
correlation-ID tombstones so request or response frames already in flight and a late
cancellation of a just-completed origin request cannot be mistaken for traffic belonging
to an unknown request. Tombstones validate the expected tail of the original stream;
other frame types, duplicate ends, oversized bodies, and unknown IDs remain protocol
errors.

One newly authenticated connector deterministically replaces the previous connector for
its tunnel (close code 4101). The replacement never inherits in-flight requests. The
WebSocket API only permits callers to send close code 1000 or codes in the 3000–4999
application range. Bunny Hole therefore translates standard error intent 1001–1999 into
the corresponding private code 4001–4999; for example, policy violation 1008 is sent
as 4008.

## Limits and flow control

| Limit                                     |                                    Value |
| ----------------------------------------- | ---------------------------------------: |
| Concurrent requests per tunnel            |                                       64 |
| Simultaneous authentication handshakes    |                                      128 |
| Recent cancellation tombstones            |                                      128 |
| Request or response body                  |                                   10 MiB |
| Frame payload                             |                                   64 KiB |
| Control payload                           |                                   16 KiB |
| Header block/count                        |                             32 KiB / 100 |
| Correlation ID                            | 18 random bytes, 24 base64url characters |
| Authentication                            |                                      5 s |
| Public request                            |                                     30 s |
| Origin request                            |                                     35 s |
| Heartbeat send/dead                       |                              20 s / 45 s |
| WebSocket buffered amount high-water mark |                                    1 MiB |
| Queued inbound WebSocket messages         |                                    2 MiB |
| Backpressure wait                         |                                      5 s |

Request and response start messages must satisfy both the decoded header-block limit and
the smaller encoded control-payload limit; JSON escaping and the request path count
toward the latter. The relay returns 431 instead of forwarding an oversized public
control message.

Senders pause while `bufferedAmount` exceeds the high-water mark, but fail the send if
pressure does not fall within five seconds. This bound also applies to authentication
and heartbeat control frames. Receivers serialize message handling and close a peer
whose queued messages exceed the connection-level limit. Per-request body limits bound
each stream. A stream chunk larger than the frame-payload limit is split into
consecutive body frames without changing its bytes. Limits are hard failures, not
advisory configuration. The connector's origin timeout is deliberately longer than the
relay's public request timeout, so the relay owns the normal 504 response and its
cancellation stops the origin; the connector timeout remains a fail-safe if that
cancellation is lost.

## HTTP behavior

- Methods must be uppercase tokens. Fetch-forbidden `CONNECT`, `TRACE`, and `TRACK` are
  rejected. Paths must begin with one `/`; scheme-relative targets, backslashes, control
  characters, and targets over 8 KiB are rejected.
- GET and HEAD requests with bodies are rejected at the relay instead of risking an
  out-of-order stream at the connector. Origin response statuses must be final HTTP
  statuses from 200 through 599.
- Header names and values use platform parsing plus explicit token/injection validation.
  Deno combines duplicate request headers according to Fetch semantics; separate
  `Set-Cookie` response fields remain separate. No trailers are forwarded.
- `HEAD` responses and statuses 204, 205, and 304 never carry protocol body frames.
- Hop-by-hop headers (including the non-standard `Proxy-Connection`) and headers named
  by `Connection` are removed both ways. Internal `x-bunny-hole-*` fields and spoofed
  forwarding fields are removed.
- `X-Forwarded-Host`, `X-Forwarded-Proto`, and the relay socket peer address are set by
  the relay. Normal viewer `Authorization` and `Cookie` headers are application data and
  reach only the selected origin; they never reach control handlers.
- Redirects are returned to the public client (`redirect: manual`); the connector does
  not follow them.
- Every public relay response overrides `Cache-Control` with `no-store`; the Pull Zone
  must also have caching disabled for all tunnel paths.
- WebSocket upgrades, arbitrary TCP/UDP, HTTP trailers, and end-to-end HTTP/2 are
  unsupported.
- `/healthz`, `/readyz`, and `/_bunny/connect` are reserved relay control paths and are
  never forwarded to an origin. The experimental Edge Script additionally reserves
  `/_bunny/edge/diagnostics`.
