# Repository guide

This document is the detailed orientation for a new developer. It describes the current
repository, not a proposed future architecture. If it disagrees with executable
validation, workflow configuration, or public API types, fix the documentation and the
source together; do not silently choose one.

## Product contract

Bunny Hole is a self-hosted reverse **HTTP** tunnel. A viewer reaches Bunny CDN, which
forwards to one Bunny Magic Container host. The host maintains the relay and control
plane; a connector behind NAT maintains the long-lived outbound connection and forwards
only explicitly authorized routes to local services.

The supported production topology is intentionally narrow:

- one host region and one Magic Container instance;
- one active connector per enrollment;
- exact hostname routing selected by host configuration, never by viewer input;
- HTTP/HTTPS origins, with loopback as the default and private-network access requiring
  explicit consent;
- Ed25519 device identity and challenge-response enrollment;
- host-signed admission and durable grants;
- FRP 0.70.1 with a pinned, validated profile;
- streaming HTTP with bounded headers, bodies, concurrency, timeouts, and backpressure.

The system is not a public WebSocket proxy, arbitrary TCP/UDP tunnel, VPN, multi-replica
relay, multi-region failover system, open proxy, or general end-to-end HTTP/2 transport.
Do not describe it as one or add configuration that quietly implies those guarantees.

## Request and control lifecycle

### Enrollment

1. The connector creates a per-host Ed25519 identity and submits a pending enrollment
   over HTTPS.
2. A trusted owner verifies the human-readable phrase and approves a bounded grant using
   a passkey or offline recovery flow.
3. The host stores the enrollment and grant durably; the connector receives short-lived
   admission material.
4. Revocation and state transitions are enforced by the host, not inferred from
   connector UI state.

Never move private keys, passkey responses, Bunny credentials, or real enrollment
records into source control, logs, issues, or an AI conversation.

### Connector session

The connector loads validated configuration, starts one supervised FRP client with an
ephemeral mode-0600 profile, authenticates the session, and removes the profile on exit.
Reconnects are bounded and cancellation-aware. The library API does not download
binaries, persist credentials, or reconnect indefinitely; the CLI and OCI image own
those lifecycle responsibilities.

### Public request

The host terminates the public HTTP request, rejects reserved/control paths, matches the
exact configured hostname, applies header and body limits, replaces trusted forwarding
values, strips internal/hop-by-hop/spoofable headers, and authorizes the FRP proxy
against the durable grant. Request and response bodies stream with backpressure and
bounded timeouts. Public errors are intentionally generic; detailed security context
belongs in redacted structured logs.

## Code map and ownership

| Area                                          | Responsibility                                                   | Change risks                                         |
| --------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/host`                                   | enrollment, passkeys, ingress, routing, FRP authorization, state | authentication, authorization, data exposure         |
| `apps/connector`                              | CLI, named hosts, state, FRP supervision, library                | credential lifetime, target escape, process cleanup  |
| `packages/api`                                | schemas, signing, logging, filtering                             | shared contract drift and unsafe defaults            |
| `apps/compose`                                | Compose label discovery and route reconciliation                 | unintended route changes or private-network exposure |
| `apps/operator`                               | Gateway API model and reconciliation                             | Kubernetes privilege and grant confusion             |
| `deploy/kubernetes`                           | Kustomize-compatible CRD, RBAC, controller deployment, example   | secret handling and cluster authority                |
| `scripts`                                     | validation, packaging, release, policy enforcement               | false assurance or weak checks                       |
| `.github/workflows`                           | CI, release, deployment, dependency and security automation      | supply-chain and credential blast radius             |
| `Dockerfile`, `.devcontainer`, `compose.yaml` | reproducible build and integration environment                   | divergence between local and CI behavior             |
| `tests` and `fixtures`                        | behavior, security, and production-image coverage                | regression gaps or secret leakage                    |

## Repository contracts

### Runtime and API

Use the schemas and public exports in `packages/api` as the source of truth for wire and
library contracts. Do not duplicate validation in a way that allows the host and
connector to disagree. Changes to authentication, grants, route selection, forwarding
headers, streaming, cancellation, or persisted state need negative tests and
compatibility analysis.

### Persistence and concurrency

The host owns durable state and must remain safe across restart, duplicate requests,
reconnects, and partial failures. Use explicit state transitions, one-use challenges,
bounded expiry, and idempotent operations. Do not replace unknown state with an empty
state or treat a failed cleanup as successful.

### Packaging and release

`deno.json`, `deno.lock`, `deno.runtime.json`, and `deno.runtime.lock` define the Deno
dependency and runtime contracts. The release workflow validates a `MAJOR.MINOR.0`
ComVer tag, refuses image tag reuse, builds non-root host and connector images for both
supported platforms, emits SBOM/provenance attestations, smoke-tests exact digests, and
publishes matching native/library artifacts. Releases are immutable.

Use Conventional Commit subjects accepted by `scripts/commit_check.ts`. Classify
compatibility using `docs/versioning.md`; ComVer patch values other than zero are
invalid. Do not hand-write a changelog or create a release without explicit
authorization.

### CI and enforcement

`deno task validate` is the authoritative gate. Its layers intentionally overlap:

- `agents:check`, `workflows:check`, and `version:check` keep project policy, action
  pinning, and release shape machine-checkable;
- `deno ci`, runtime installation, formatting, spelling, linting, and type checks keep
  the toolchain reproducible;
- docs, package, commit, test, coverage, integration, build, and container smoke checks
  cover behavior and published artifacts;
- audit, secret, license, and generated-file checks protect the supply chain.

Do not disable a check because it is inconvenient. Fix the source or update the policy
and its tests together when the contract intentionally changes.

## Safe coding patterns

- Validate once at boundaries, then pass typed values inward.
- Prefer allowlists, exact matches, bounded sizes, explicit timeouts, and cancellation
  over permissive parsing and ambient defaults.
- Check status codes and response shapes before reading external data.
- Make retries bounded and idempotent; never retry non-idempotent mutation blindly.
- Keep shell variables quoted, avoid interpolating untrusted input into shell, and use
  arrays or structured APIs where possible.
- Preserve error context without exposing credentials, tokens, private keys, cookies, or
  viewer data.
- Prefer immutable dependencies, full action SHAs, lock files, and digest-pinned images.
- Add tests for invalid input, expiry, duplicate operations, cancellation, restart,
  partial failure, and authorization boundaries—not only the happy path.
- Guard lifecycle states (for example `EnrollmentState` in `packages/api/mod.ts`) with
  one allowlist-based helper per required state set, not repeated `!== "state-x"` checks
  at each call site. A full state-machine library is unwarranted for a handful of
  states, but a scattered check does not fail to compile when a new state is added, so a
  forgotten call site silently keeps stale logic. Prefer:

  ```ts
  function requireState<S extends string>(
    entity: { state: S } | undefined,
    allowed: readonly S[],
  ): { state: S } {
    if (!entity || !allowed.includes(entity.state)) {
      throw new ValidationError("not usable in its current state");
    }
    return entity;
  }
  ```

  so every caller states which states it accepts, and adding a state is a deliberate,
  reviewable decision at each call site rather than a silent gap.
- Never leave a promise un-awaited, unreturned, and unhandled. `deno lint`'s recommended
  rules do not include a type-aware floating-promise check (`typescript-eslint`'s
  `no-floating-promises` needs full type information that `deno lint` does not do), so
  nothing here catches this mechanically — it is a real, common correctness bug class
  that needs manual review on every change. When a promise is intentionally
  fire-and-forget, mark that explicitly with `.catch(() => { ... })` (see the
  cancellation/timeout races in `apps/host/host.ts`) rather than a bare statement, so
  the omission of `await` reads as a decision, not an oversight.
- Reuse a named constant from a `LIMITS`-style object (see `packages/api/mod.ts`)
  instead of introducing a new inline number for a size, timeout, or count, and add a
  new limit there rather than starting a second source for the same kind of value.

## Consistency and maintainability

- Match the file's existing patterns (error handling, naming, module boundaries) before
  introducing a new one; a second convention for the same problem is a maintenance cost
  even if both are individually reasonable.
- Extract a shared helper only on genuine reuse (a second real call site), not
  speculatively; unused abstraction is harder to maintain than the duplication it was
  meant to prevent.
- Keep each module's public surface aligned with "Code map and ownership"; add a new
  top-level module only when a change genuinely does not belong to an existing one.
- Prefer the option-object pattern for a function needing more than two required
  parameters (Deno's own runtime/std convention) so call sites stay readable as
  parameters grow.

## Deployment-specific rules

The consumer GitOps template and Bunny deployment workflows are intentionally more
restrictive than ordinary application code. Read their nearest `AGENTS.md` and
`.agents/skills/bunny-deployment/SKILL.md` before changing them.

Terraform state and plans are sensitive. Use the remote locked backend, preserve the
provider lock file, keep public variables separate from runtime secrets, and never
commit state, plans, `.terraform/`, credentials, owner material, or generated handoff
data that is not explicitly public. Preserve Pull Zone adoption guards,
`prevent_destroy`, immutable image digests, protected environments, and reviewed
plan/apply integrity checks.

## Change workflow

1. Read this guide, `AGENTS.md`, the nearest scoped skill, and the docs for the boundary
   being changed.
2. Search for existing validators, schemas, tests, and prior patterns before adding new
   logic.
3. Make the smallest complete change, including tests and directly affected
   documentation.
4. Run focused checks while iterating.
5. Run `deno task validate` in the Compose development service.
6. Review `git diff --check`, generated files, secret scans, compatibility impact, and
   the final changed-file list.
7. In the PR, state behavior changes, security impact, migration/compatibility impact,
   tests run, and any checks that could not run.

## Drift control

When a rule can be checked, encode it in `scripts/validate.ts`, a focused
validator/test, a commit hook, or a workflow rather than relying only on prose. When a
rule cannot be automated, link it from the closest executable source and keep the prose
specific. Update this guide in the same change as architecture, commands, public limits,
workflow names, or trust-boundary changes.

A repeated value (a pinned tool version, a third-party version, a limit) must have
exactly one authoritative source file; every other mention is checked against it by
`scripts/version_check.ts` or an equivalent script, never left to match by convention.

### One `AGENTS.md`, scoped skills instead of nested files

The `agents.md` convention supports nested `AGENTS.md` files, with the closest one to an
edited path taking precedence. This repository intentionally keeps a single root
`AGENTS.md` and scopes area-specific rules through `.agents/skills/*/SKILL.md` instead
(see `SKILLS.md`). Skills are chosen deliberately per task, so they cannot be silently
shadowed the way a forgotten nested file can, and they read as ordinary Markdown from
any harness without special path-based resolution. Add a nested `AGENTS.md` only if a
subtree gains its own toolchain, license, or release process distinct enough that
`AGENTS.md` and every skill would otherwise need repeated caveats for it — not merely
because a directory is large.

## Standards and primary references

- [Deno configuration and tasks](https://docs.deno.com/runtime/reference/deno_json/)
- [TypeScript strict mode and configuration](https://docs.deno.com/runtime/fundamentals/typescript/)
- [Terraform sensitive data](https://developer.hashicorp.com/terraform/language/manage-sensitive-data)
- [GitHub repository custom instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide)
- [GitHub Actions security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-for-github-actions)
- [OpenSSF Scorecard](https://scorecard.dev/)
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- [Compatible Versioning](https://gitlab.com/staltz/comver)

### Why not adopt an external style guide or skill catalog wholesale

Deno's own [style guide](https://docs.deno.com/runtime/contributing/style_guide/) states
it is for the Deno runtime and standard library, not user code; Google's and other
vendors' TypeScript style guides are similarly scoped to their own codebases and
disagree with each other on points such as interfaces versus type aliases or JSDoc
requirements. There is no single external "official" TypeScript/Deno user-code style
guide to defer to. This repository's actual enforced baseline is `deno lint`'s
recommended rules, `deno fmt`, and Deno's default strict type-checking (all in
`deno.json`, unmodified from Deno's defaults) — extend or restate that baseline in
`.github/instructions/typescript.instructions.md` only when it says something these
tools do not already enforce.

Curated third-party skill lists (for example community "awesome-agent-skills"
aggregators) carry no vetting: installing one means feeding its instructions and any
bundled scripts to an agent that can run shell commands, which is a supply-chain and
prompt- injection risk. Do not install external skills into `.agents/skills/` on the
strength of a list ranking; only add a skill after reading it in full and confirming it
reflects this repository's actual constraints.
