# Development

Deno 2.9.5 is the only task runner and is also the compiler, dependency manager,
formatter, linter, test runner, coverage tool, and build tool. Terraform 1.16.2 exists
only to validate the copyable consumer deployment configuration against its pinned
provider. Python's standard library runs the consumer template's offline workflow guard
tests; Deno remains the task runner. Node 24.13.1 and npm 11.8.0 exist in the
development image only for GitHub Copilot CLI, Dev Container tooling, and validating the
actual npm package. There are no npm task wrappers or repository `package.json`.

## Compose-native toolchain

The complete environment is an ordinary Compose service:

```sh
sh .devcontainer/initialize.sh
docker compose up --build --detach development
docker compose exec --user vscode development deno task setup
docker compose exec --user vscode development deno task validate
docker compose down
```

This works without a Dev Container CLI. The equivalent Deno shorthands are:

```sh
deno task devcontainer:up
deno task devcontainer:exec -- deno task validate
deno task devcontainer:down
```

`.devcontainer/devcontainer.json` is only an editor adapter pointing at that same
service. It has no Features, lifecycle tool installation, or separate toolchain, so
there is no Dev Container Feature lockfile to drift. It explicitly disables Dev
Container UID rewriting so the editor path retains the same `vscode` UID as plain
Compose and the rootless engine. The development service includes the Docker CLI and
Compose plugin. It connects to the pinned rootless Docker-in-Docker service in
`compose.yaml`, so validation can build and exercise the sibling production-image
topology without exposing the host Docker socket.

The startup entrypoint leaves repository sources host-owned and makes only the ignored
`.tmp`, `coverage`, and `dist` directories writable by the fixed development user.
Integration writes only a secret-free Compose override beneath `.tmp`. It streams the
ephemeral connector configuration over standard input into a per-run Docker volume,
where the file is owned by the production connector user with mode `0600`. Private keys
therefore never enter command arguments, environment variables, host bind mounts, or the
repository workspace.

Inside the service, run `deno task setup` once and then focused tasks such as `fmt`,
`lint`, `check`, `test`, `coverage`, `integration`, `build`, `package:check`, `audit`,
or `container:smoke`. `deno task validate` is authoritative and executes, in order:

- agent, workflow, version, deployment-template, generated-file, and license policy
  checks, including real backend-free Terraform initialization, validation, and
  mock-provider regression tests;
- frozen dependency resolution, formatting, spelling, Deno lint and type checking;
- documentation checks, tests, and coverage threshold enforcement;
- the production host/connector image integration topology;
- native production builds plus container build and smoke checks; and
- dependency audit, secret scan, and Conventional Commit validation.

Three independent settings describe an execution:

| Setting                                                   | Meaning                                                                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI=true`                                                 | Signals an unattended runner to tools that recognize `CI`. It does not choose tests, start services, or tear them down. GitHub Actions sets it automatically, and the Dev Container action passes it into the service. |
| `BUNNY_HOLE_DEVELOPMENT=true` / connector `--development` | Explicitly enables HTTP and direct transport behavior for isolated fixtures with reserved test or loopback hostnames. This opt-in is independent of `CI` and is never inferred from an environment name.               |
| `BUNNY_HOLE_ENVIRONMENT_NAME`                             | Descriptive name for validation output, defaulting to `development`. It can be `ci-e2e-tests`, `copilot`, or another useful label; it changes no behavior.                                                             |

`COMPOSE_PROJECT_NAME` is a separate technical identity: it scopes containers, networks,
and volumes so worktrees do not interfere. A job can therefore run with `CI=true`, local
development behavior, and the name `ci-e2e-tests` at the same time. The selected command
controls validation (`deno task validate` or a focused task); the caller controls
lifecycle (`up`, `exec`, and `down`). CI and release workflows explicitly tear down
their Compose projects after running, while Copilot setup leaves its service available
for the agent. GitHub Actions runs the same tasks inside the same development service.

The initializer writes a path-derived `COMPOSE_PROJECT_NAME` to the ignored `.env` file
unless one is already configured, and creates the external Deno cache volume. The Dev
Container adapter runs it during startup; GitHub workflows run it before
`devcontainers/ci` reads Compose for its build. `deno task devcontainer:up` does too.
This keeps same-named Git worktrees in separate projects, each with its own rootless
Docker daemon data and host state. It also mounts the Git common directory at its
original path, so linked worktrees can run tracked-file, secret, and commit checks
inside the container. Docker selects network ranges and published host ports to avoid
collisions. Inside a Compose project, services resolve `host.test`,
`connector-gateway.test`, and `origin` through Docker's project-local DNS. Nothing needs
to be added to the developer machine's `/etc/hosts`. From the host machine, use
`docker compose --profile tunnel port host 8080` to find the loopback-bound HTTP port.
The `host.test` alias is only available inside the Compose networks, so host tools can
connect to `127.0.0.1` at that port and send `Host: host.test` when exercising
management APIs. Set `BUNNY_HOLE_HOST_HTTP_PORT` only when a stable port is needed and
unused. The connector listener stays inside Compose networking and has no published host
port.

Use Docker Engine 28 or newer when relying on loopback port publishing for host-only
access. Earlier Engine releases could expose loopback-published ports to peers on the
same local network. The container network aliases do not make the advertised `host.test`
management URL resolve in a host browser; this fixture is intended for container and
command-line integration checks. Browser passkey testing needs a separately reachable,
trusted management origin.

The `copilot-setup-steps.yml` workflow uses the pinned `devcontainers/ci` action to
start this service and runs `deno ci` inside it. That command installs the frozen
dependencies; it does not run the validation pipeline or stop the service. Copilot can
then use `docker compose exec -T --user vscode development deno task ...` for focused
checks. The CI workflow uses the same action and service with `deno task validate` as
its `runCmd` to execute the full gate. The action forwards GitHub's `CI` variable into
the container. CI also forwards `COMPOSE_PARALLEL_LIMIT=1` so nested integration startup
uses one Docker engine call at a time on the hosted runner. A local agent can start the
service directly with Compose, without running either GitHub workflow.

On failure, CI and Copilot setup run `bash .devcontainer/diagnose.sh` before cleanup.
The script collects host memory and disk availability, container exit and out-of-memory
state, resource usage, nested Docker status, and the daemon's recent logs. Each command
has a 30-second timeout followed by a force kill after five more seconds, so an
unresponsive daemon cannot block the remaining evidence. It inspects selected lifecycle
fields without dumping container environments. These diagnostics do not retry validation
or turn a failed gate into a success.

## Cache design

The development Dockerfile copies `deno.json`, `deno.lock`, and the smaller
`deno.runtime.json`/`deno.runtime.lock` production graph before source. It freezes and
prewarms both graphs, so dependency changes invalidate the layer while ordinary source
changes do not. It also prewarms the provider graph from the consumer template's frozen
Terraform lockfile. The split prevents repository-only tools such as cspell from being
embedded by `deno compile`; `deno task validate` checks both lockfiles. `/deno-dir` and
the image's Terraform provider cache are writable by the non-root `vscode` user. The
GHCR development prebuild is the primary CI toolchain/dependency cache, and BuildKit
registry layers cache production images.

No GitHub Actions dependency cache is layered on top: local volumes do not transfer to
hosted runners, and a second Deno cache would duplicate the image. npm caching is absent
because npm has no dependency lockfile in this repository and is not the task runner.

The development services in different worktrees share one external Deno dependency cache
volume, `bunny-hole-development-deno-cache-v1`. Deno's cache is designed to be shared
across projects, while each checkout retains its own frozen lockfiles and build output.
Docker does not remove this external cache with `compose down`, even with `--volumes`.
Terraform's provider cache remains prewarmed in the image; the rootless daemon's data
and host state remain project-local.

The isolated daemon and development container share the repository at the stable
`/workspaces/bunny-hole` path so nested integration bind mounts work identically on
Docker Desktop and Linux. Its data lives in the `development-docker-data` named volume.
The rootless daemon needs a privileged outer container to initialize its user namespace,
but its unauthenticated API is reachable only on the dedicated project-local `engine`
network, which contains the daemon and development service, and controls only the nested
daemon—not the host daemon. This is the boundary used by pull-request CI.

Ubuntu 24.04 and newer restrict unprivileged user namespaces through AppArmor. GitHub
workflows load the narrowly scoped profile recommended by RootlessKit before starting
the same Compose topology; Docker Desktop does not require that host compatibility step.
The profile permits user-namespace creation only for the RootlessKit binary in the
pinned sidecar image.

## Production topology tests

`deno task integration` creates an isolated Compose project, a per-run configuration
volume, and random credential material. It builds the exact `host-runtime` and
`connector-runtime` Dockerfile targets, enrolls a connector, approves its grant, starts
FRP over a verified local WSS gateway, and exercises public HTTP through the host to the
deterministic origin. It first proves that a different CA rejects the gateway
certificate and cannot establish a usable route, then trusts the gateway certificate and
runs the public-traffic checks. These cover concurrent isolation, streaming and binary
bodies, public-disconnect propagation, header stripping, oversized requests, origin
timeouts, route confusion, connector disconnect/recovery, origin 404 preservation, and
secret-free logs. The management origin remains local HTTP under explicit development
mode; this is not a Bunny CDN or public management-TLS acceptance test. Cleanup targets
only the generated Compose project and its exact configuration volume.

Bunny-specific acceptance remains a manual, protected-environment operation: verify the
Magic Container's persistent state across restarts, the exact CDN ports and custom TLS
hostnames, disabled caching/retries, connector WebSocket policy, DNS, and the
one-region, one-instance topology before a real deployment or material platform change.

`deno task container:smoke` verifies the production process user and health behavior.
The final images are distroless and contain only the compiled application plus `frps` or
`frpc`. The connector also carries its checksum-pinned public CA bundle for FRP WSS
verification; Deno and source files remain in build stages.

## Package and release artifacts

`deno task package:check` performs a JSR dry run, builds the dependency-free npm
tarball, installs it into an isolated Node consumer with lifecycle scripts disabled, and
exercises the exported control library. `deno task release:artifacts` is intentionally
tag-workflow work because it downloads a Deno runtime and checksum-verified FRP archive
for every Linux, macOS, and Windows target. It also bundles the same checksum-pinned
public CA file and MPL-2.0 license used by the connector OCI image; native users keep
`bunny-hole`, `frpc`, and `ca-certificates.crt` together.

Every release surface uses one immutable ComVer version: host OCI, connector OCI, native
bundle, JSR module, and npm package. Releases occur only from increasing `MAJOR.MINOR.0`
tags. See [versioning](versioning.md).

## Contribution workflow

Install the Conventional Commit hook with `deno task hooks:install`. Add behavior tests
at the nearest boundary, run focused checks while iterating, then run the complete
Compose-native validation. Review the final diff for credentials, generated artifacts,
stale names, unsupported transport claims, and dependency/license changes.

## Correctness gates

Read [correctness engineering](correctness.md) before changing security or lifecycle
behavior. `deno task correctness:check` runs mutation witnesses in disposable copies;
the full validation command requires those witnesses to be rejected by behavior tests.

`deno task coverage` enforces a 90% whole-suite gate plus complete application source
accounting, application line/branch/function gates, and per-file line floors. See
[coverage accountability](correctness.md#coverage-accountability) for targets and
visible remaining gaps. Inspect `coverage/html/index.html` and
`coverage/application.lcov` after validation. CI also runs Windows configuration
replacement/recovery tests with the same pinned Deno version; the complete container
validation remains on Linux.
