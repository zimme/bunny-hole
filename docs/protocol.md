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

## Authentication

1. Relay sends `challenge` with a fresh 192-bit nonce and version.
2. Connector sends `authenticate` with version and
   `HMAC-SHA-256(secret, "bunny-hole\0" || version || tunnel || nonce)`.
3. Relay uses a timing-independent byte comparison and sends `authenticated`.

The nonce prevents reuse of an observed proof on a new connection. Authentication must
finish within 5 seconds. Errors are generic and never include the ID, secret, proof, or
configured hostnames.

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

One newly authenticated connector deterministically replaces the previous connector for
its tunnel (close code 4101). The replacement never inherits in-flight requests.

## Limits and flow control

| Limit                                     |                                    Value |
| ----------------------------------------- | ---------------------------------------: |
| Concurrent requests per tunnel            |                                       64 |
| Request or response body                  |                                   10 MiB |
| Frame payload                             |                                   64 KiB |
| Control payload                           |                                   16 KiB |
| Header block/count                        |                             32 KiB / 100 |
| Correlation ID                            | 18 random bytes, 24 base64url characters |
| Authentication                            |                                      5 s |
| Public request                            |                                     30 s |
| Origin request                            |                                     25 s |
| Heartbeat send/dead                       |                              20 s / 45 s |
| WebSocket buffered amount high-water mark |                                    1 MiB |

Senders pause while `bufferedAmount` exceeds the high-water mark. Deno request and
response streams propagate backpressure around bounded frames. Limits are hard failures,
not advisory configuration.

## HTTP behavior

- Methods must be uppercase tokens. Paths must begin with one `/`; scheme-relative
  targets, control characters, and targets over 8 KiB are rejected.
- Header names and values use platform parsing plus explicit token/injection validation.
  Deno combines duplicate request headers according to Fetch semantics; no trailers are
  forwarded.
- Hop-by-hop headers and headers named by `Connection` are removed both ways. Internal
  `x-bunny-hole-*` fields and spoofed forwarding fields are removed.
- `X-Forwarded-Host`, `X-Forwarded-Proto`, and the relay socket peer address are set by
  the relay. Normal viewer `Authorization` and `Cookie` headers are application data and
  reach only the selected origin; they never reach control handlers.
- Redirects are returned to the public client (`redirect: manual`); the connector does
  not follow them.
- WebSocket upgrades, arbitrary TCP/UDP, HTTP trailers, and end-to-end HTTP/2 are
  unsupported.
