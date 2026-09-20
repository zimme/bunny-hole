# Agent instructions

This is the canonical repository guide for developers and coding agents. Read it before
changing code, then read the nearest scoped skill or `AGENTS.md`. The orientation map
and detailed rationale live in [`docs/repository-guide.md`](docs/repository-guide.md);
update that guide when architecture, supported behavior, commands, or trust boundaries
change.

## Fast orientation

Bunny Hole is a Deno-first, security-sensitive reverse HTTP tunnel. The host runs behind
Bunny CDN and owns enrollment, exact-host routing, HTTP policy, and FRP authorization.
The connector makes the only long-lived outbound connection to the host and proxies
explicitly granted local services. The supported topology is one region, one Magic
Container instance, and one active connector per enrollment.

Start with `README.md`, then use `docs/repository-guide.md` for the complete
architecture, lifecycle, contracts, non-goals, validation layers, release path, and
change map. Use `docs/architecture.md`, `docs/protocol.md`, and `docs/threat-model.md`
for boundary-level decisions; use `docs/development.md`, `CONTRIBUTING.md`, and
`deno.json` for workflow details.

## Commands and environment

Use Deno 2.9.5 and the Compose-native development service:

```sh
docker compose up --build --detach development
docker compose exec --user vscode development deno task validate
docker compose down
```

The equivalent shorthands are `deno task devcontainer:up`,
`deno task devcontainer:exec -- deno task validate`, and `deno task devcontainer:down`.
Inside the service, use `deno task setup`, focused tasks, and finally
`deno task validate`. Node/npm exist only for Dev Container and agent tooling; do not
add npm task wrappers.

The authoritative validation runs checks for agent guidance, workflows, versioning,
dependencies, formatting, spelling, linting, types, documentation, packages, commits,
tests, coverage, integration, builds, container smoke tests, audits, secrets, licenses,
and generated files. Prefer focused tasks while iterating, then run the complete
validation before a PR.

## Non-negotiable invariants

- Keep the public product name **Bunny Hole**.
- Preserve one region, one host instance, and one active connector per enrollment.
- Do not claim public WebSocket, TCP, UDP, multi-region, multi-replica, or end-to-end
  HTTP/2 support.
- Public traffic routes only by exact configured hostname. A viewer never selects a
  tunnel or destination.
- Connector origins remain loopback-only unless explicitly opted into a private network.
- Preserve Ed25519 challenge-response authentication, host-signed admission, the strict
  pinned FRP profile, state transitions, streaming backpressure, cancellation, and
  timeouts.
- Strip internal, hop-by-hop, and spoofable forwarding headers. Never log secrets.
- Never request credentials in an agent-controlled conversation or command. Pause while
  a human uses the dashboard or a private interactive terminal.
- Do not add Edge Scripting or Bunny Database: neither supplies documented affinity for
  the process holding the live FRP connection.
- Do not use mutable action references.
- Do not create releases, tags, Bunny resources, or deployments without explicit
  authorization.
- Add behavior tests for protocol/security changes and run the production-image Compose
  integration path.
- Use Conventional Commits. Never add a hand-written `CHANGELOG.md`.
- Follow [Compatible Versioning](https://gitlab.com/staltz/comver) and
  `docs/versioning.md`: use `MAJOR.MINOR.0`, classify breaking changes as major, and
  keep released versions immutable.

## Safe implementation patterns

- Validate untrusted input at the boundary and retain explicit types after validation.
  Treat external API responses, provider state, workflow inputs, and persisted files as
  untrusted until checked.
- Prefer bounded timeouts, cancellation, backpressure, idempotent retries, and explicit
  state transitions. Do not turn an unknown or partial result into a success-shaped
  fallback.
- Keep secrets out of arguments, logs, plans, artifacts, fixtures, and AI conversations.
  Redact at the logging boundary and fail closed if redaction or integrity checks fail.
- Use immutable action SHAs, least-privilege workflow permissions, protected
  environments, reviewed immutable image digests, and committed dependency locks.
- For Terraform, preserve remote locking, `prevent_destroy`, adoption preconditions, and
  reviewed-plan/apply checks. Never bypass them to unblock a test or deployment.
- Keep public APIs and wire formats backward-compatible unless the change is explicitly
  classified as a ComVer breaking change. Add regression tests for protocol,
  authorization, routing, state, or lifecycle changes.

## Change boundaries

- `apps/host`: control plane, HTTP ingress, passkeys, durable state, and FRP
  authorization. Changes here can affect every deployed host.
- `apps/connector`: CLI, enrollment state, FRP process supervision, and library
  lifecycle. Keep credentials ephemeral and connector targets constrained.
- `apps/compose` and `apps/operator`: declarative adapters; they must not weaken host
  authorization or invent a second routing model.
- `packages/api`: shared schemas, signing, logging, and filtering. Keep it
  dependency-light and deterministic.
- `deploy/kubernetes`: raw Gateway API/Kustomize manifests. Preserve explicit host and
  route grants and secret-manager-friendly workflows.
- `scripts`, `.github`, `Dockerfile`, and `.devcontainer`: policy and delivery
  enforcement. Prefer strengthening a check over documenting an unenforced rule.

Do not mix unrelated refactors with security or deployment changes. Do not edit
generated artifacts by hand; change their source and run the owning generator.

## Completion

Read the relevant skill in `.agents/skills/` before protocol, security, deployment, or
release work. Run focused tests, then `deno task validate` in the Dev Container. Review
the diff for secrets, generated output, stale branding, unsupported claims, and
unrelated changes. Report checks that could not run.
