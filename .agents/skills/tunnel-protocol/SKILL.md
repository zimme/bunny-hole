---
name: tunnel-protocol
description: Modify or review Bunny Hole protocol, relay, connector, routing, and security behavior.
---

# Tunnel protocol work

Read `AGENTS.md`, `docs/protocol.md`, and `docs/threat-model.md` completely.

Preserve protocol version compatibility unless the change explicitly introduces a new
negotiated version. Treat every frame, header, URL, hostname, identifier, and state
transition as untrusted. Maintain explicit bounds and ensure all error paths clean
pending maps, streams, timers, and abort controllers without revealing secrets.

Add behavior tests for success, malformed/out-of-order/duplicate traffic, cancellation,
timeout, replacement, disconnection, crossed correlations, and secret/header isolation
as applicable. Run focused tests and the production-image integration topology, then
`deno task validate`.
