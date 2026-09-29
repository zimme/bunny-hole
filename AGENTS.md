# Agent instructions

Bunny Hole is a Deno-first, security-sensitive reverse HTTP tunnel. This file is the
canonical instruction source for all coding agents.

## Agent workflow

AI agents do the repository's implementation, tests, documentation, and review work.
Complete the requested change and its verification; do not leave routine coding steps
for a human. Humans make product and deployment decisions and perform private credential
operations. If a required decision or credential is unavailable, finish the independent
work and report the precise remaining step without asking for a secret.

Read the nearest `AGENTS.md` first; the copyable deployment template has its own.
Task-specific skills are discoverable under `.agents/skills/`. Load the relevant skill
for the area being changed. Before editing, inspect the current code, its tests, and the
relevant contract docs. Keep changes focused, add behavior tests when behavior changes,
and update affected documentation in the same change. Do not weaken a failing check to
make a change pass.

## Code map

- `apps/host`: ingress, enrollment, authorization, durable state, and FRP server.
- `apps/connector`: CLI, identity, origin policy, and supervised FRP client.
- `packages/api`: shared wire contracts, authentication, security, and logging.
- `apps/compose` and `apps/operator`: declarative route controllers.
- `tests` and `fixtures`: behavior and integration fixtures.
- `scripts`, `.github`, `.devcontainer`, and `compose.yaml`: validation, delivery, and
  the shared development environment.
- `templates/bunny-deployment`: independently copyable consumer deployment template.

Use `docs/architecture.md` for topology, `docs/protocol.md` for the wire contract,
`docs/threat-model.md` for security boundaries, and `docs/development.md` for the
complete validation environment. Check `docs/versioning.md` before public API or release
changes.

## Commands

Use Deno 2.9.5 and the Compose-native development service. Terraform 1.16.2 is pinned
for validating the consumer deployment template. From the host:

```sh
sh .devcontainer/initialize.sh
docker compose up --build --detach development
docker compose exec -T --user vscode development deno task setup
docker compose exec -T --user vscode development deno task validate
docker compose down
```

The `devcontainer:*` Deno tasks are shorthand for those same Compose commands. A Dev
Container-aware editor is an optional adapter and must not install Features or mutate
the toolchain. Inside the service, use `deno task setup`, focused Deno tasks, and
finally `deno task validate`. CI runs the same command. Node/npm exist only for Dev
Container and agent tooling; never add npm task wrappers.

The initializer gives each worktree a stable, path-derived Compose project name in its
ignored `.env`, makes linked Git metadata available in the container, and creates the
shared external Deno cache volume. Run it before direct Compose commands; the Dev
Container adapter and `devcontainer:up` do so automatically. Docker assigns published
host ports, while the rootless Docker data and host state stay private to each project.
Do not set a common `COMPOSE_PROJECT_NAME` or fixed host ports across concurrent
worktrees. Use Compose service names and network aliases inside containers; from the
host, discover the assigned loopback port. Do not require developer `/etc/hosts` edits.
Keep the unauthenticated nested Docker API on the dedicated project-local `engine`
network and do not publish it or mount the host Docker socket.

Keep execution context separate from application behavior. `CI=true` is the runner
signal for unattended tools, `BUNNY_HOLE_ENVIRONMENT_NAME` is a descriptive label, and
`COMPOSE_PROJECT_NAME` isolates Compose resources. The local tunnel fixture alone opts
into `BUNNY_HOLE_DEVELOPMENT=true` and connector `--development`. A validation command
and its caller's setup/cleanup steps choose what runs and when it stops; none of these
environment variables select the pipeline.

## Invariants

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
  the process holding the live FRP connection. Do not use mutable action references.
- Do not create releases, tags, Bunny resources, or deployments without explicit
  authorization.
- Keep `templates/bunny-deployment` copyable and self-contained. Its live workflows are
  manual, default-branch-only, protected-environment operations; PR checks receive no
  deployment or state credentials.
- Add behavior tests for protocol/security changes and run the production-image Compose
  integration path.
- Use Conventional Commits. Never add a hand-written `CHANGELOG.md`.
- Follow the canonical [Compatible Versioning](https://gitlab.com/staltz/comver)
  specification and the public API declared in `docs/versioning.md`. Use
  `MAJOR.MINOR.0`: breaking changes, including breaking bug fixes, require a major bump;
  every backwards-compatible release requires a minor bump. The patch component is
  always zero, and released versions are immutable.

Copilot setup uses the same Dev Container as CI and installs frozen dependencies. In a
Copilot session, run commands with `docker compose exec -T --user vscode development`;
start the service with `docker compose up --build --detach development` if it is no
longer running.

## Completion

Run focused tests, then `deno task validate` in the development service. Review the diff
for secrets, generated output, stale branding, unsupported claims, and unrelated
changes. In the handoff, summarize the change, test evidence, compatibility or security
impact, and checks that could not run. Never claim a check passed unless it ran against
the current change.
