---
name: tunnel-protocol
description: Modify or review Bunny Hole control API, FRP profile, host, connector, routing, and security behavior.
---

# Tunnel protocol work

Read `AGENTS.md`, `docs/protocol.md`, and `docs/threat-model.md` completely.

Preserve API and pinned FRP-profile compatibility unless a ComVer release explicitly
changes it. Treat every FRP plugin operation, header, URL, hostname, identifier, token,
and state transition as untrusted. Maintain explicit bounds and ensure all error paths
clean streams, timers, sessions, processes, and abort controllers without revealing
secrets.

Add behavior tests for success, malformed/duplicate operations, cancellation, timeout,
replacement, revocation, disconnection, concurrent isolation, and secret/header
isolation as applicable. Run focused tests and the production-image integration
topology, then `deno task validate`.
