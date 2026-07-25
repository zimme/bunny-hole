# Agent instructions

Bunny Hole is a Deno-first, security-sensitive reverse HTTP tunnel. This file is the
canonical instruction source for all coding agents.

## Commands

Use Deno 2.9.3 and the Compose-native development service. From the host:

```sh
docker compose up --build --detach development
docker compose exec --user vscode development deno task validate
docker compose down
```

The `devcontainer:*` Deno tasks are shorthand for those same Compose commands. A Dev
Container-aware editor is an optional adapter and must not install Features or mutate
the toolchain. Inside the service, use `deno task setup`, focused Deno tasks, and
finally `deno task validate`. CI runs the same command. Node/npm exist only for Dev
Container and agent tooling; never add npm task wrappers.

## Invariants

- Keep the public product name **Bunny Hole**.
- Preserve one region, one relay instance, and one active connector per tunnel.
- Do not claim public WebSocket, TCP, UDP, multi-region, multi-replica, or end-to-end
  HTTP/2 support.
- Public traffic routes only by exact configured hostname. A viewer never selects a
  tunnel or destination.
- Connector origins remain loopback-only unless explicitly opted into a private network.
- Preserve challenge-response authentication, timing-safe proof checks, bounded binary
  framing, strict state transitions, backpressure, cancellation, and timeouts.
- Strip internal, hop-by-hop, and spoofable forwarding headers. Never log secrets.
- Never request credentials in an agent-controlled conversation or command. Pause while
  a human uses the dashboard or a private interactive terminal.
- Do not use Bunny Edge Scripting, Bunny Database, or mutable action references.
- Do not create releases, tags, Bunny resources, or deployments without explicit
  authorization.
- Add behavior tests for protocol/security changes and run the production-image Compose
  integration path.
- Use Conventional Commits. Never add a hand-written `CHANGELOG.md`.
- Use Compatibility Versioning (ComVer) in `MAJOR.MINOR.0` form. Breaking changes,
  including breaking bug fixes, require a major bump; every non-breaking release
  requires a minor bump. The patch component is always zero.

Read the relevant skill in `.agents/skills/` before protocol/security or
deployment/release work. Review `docs/architecture.md`, `docs/protocol.md`, and
`docs/threat-model.md` before changing boundaries.

## Completion

Run focused tests, then `deno task validate` in the Dev Container. Review the diff for
secrets, generated output, stale branding, unsupported claims, and unrelated changes.
Report checks that could not run.
