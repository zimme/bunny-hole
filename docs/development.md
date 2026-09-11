# Development

Deno 2.9.5 is the only task runner and is also the compiler, dependency manager,
formatter, linter, test runner, coverage tool, build tool, and task runner. Node 24.13.1
and npm 11.8.0 exist in the development image only for GitHub Copilot CLI, Dev Container
tooling, and validating the actual npm package. There are no npm task wrappers or
repository `package.json`.

## Compose-native toolchain

The complete environment is an ordinary Compose service:

```sh
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
there is no Dev Container Feature lockfile to drift. The development service includes
the Docker CLI and Compose plugin. It connects to the pinned rootless Docker-in-Docker
service in `compose.yaml`, so validation can build and exercise the sibling
production-image topology without exposing the host Docker socket.

Inside the service, run `deno task setup` once and then focused tasks such as `fmt`,
`lint`, `check`, `test`, `coverage`, `integration`, `build`, `package:check`, `audit`,
or `container:smoke`. `deno task validate` is authoritative and executes, in order:

- agent, workflow, version, generated-file, and license policy checks;
- frozen dependency resolution, formatting, spelling, Deno lint and type checking;
- documentation checks, tests, and coverage threshold enforcement;
- the production host/connector image integration topology;
- native production builds plus container build and smoke checks; and
- dependency audit, secret scan, and Conventional Commit validation.

`CI=true` changes output or interactivity only. GitHub Actions runs the same task inside
the same development service.

## Cache design

The development Dockerfile copies `deno.json`, `deno.lock`, and the smaller
`deno.runtime.json`/`deno.runtime.lock` production graph before source. It freezes and
prewarms both graphs, so dependency changes invalidate the layer while ordinary source
changes do not. The split prevents repository-only tools such as cspell from being
embedded by `deno compile`; `deno task validate` checks both lockfiles. `/deno-dir` is a
persistent named local volume whose ownership is fixed for the non-root `vscode` user.
The GHCR development prebuild is the primary CI toolchain/dependency cache, and BuildKit
registry layers cache production images.

No GitHub Actions dependency cache is layered on top: local volumes do not transfer to
hosted runners, and a second Deno cache would duplicate the image. npm caching is absent
because npm has no dependency lockfile in this repository and is not the task runner.

The isolated daemon and development container share the repository at the stable
`/workspaces/bunny-hole` path so nested integration bind mounts work identically on
Docker Desktop and Linux. Its data lives in the `development-docker-data` named volume.
The rootless daemon needs a privileged outer container to initialize its user namespace,
but its API is reachable only on the private Compose network and controls only the
nested daemon—not the host daemon. This is the boundary used by pull-request CI.

Ubuntu 24.04 and newer restrict unprivileged user namespaces through AppArmor. GitHub
workflows load the narrowly scoped profile recommended by RootlessKit before starting
the same Compose topology; Docker Desktop does not require that host compatibility step.
The profile permits user-namespace creation only for the RootlessKit binary in the
pinned sidecar image.

## Production topology tests

`deno task integration` creates an isolated Compose project with random project and
credential material, builds the exact `host-runtime` and `connector-runtime` Dockerfile
targets, enrolls a connector, approves its grant, starts FRP, and exercises public HTTP
through the host to the deterministic origin. It covers concurrent isolation, streaming
and binary bodies, header stripping, oversized requests, timeouts, route confusion,
replacement/revocation behavior, health, readiness, and secret-free logs. Cleanup uses
only that generated Compose project.

`deno task container:smoke` verifies the production process user and health behavior.
The final images are distroless and contain only the compiled application plus `frps` or
`frpc`; Deno and source files remain in build stages.

## Package and release artifacts

`deno task package:check` performs a JSR dry run, builds the dependency-free npm
tarball, installs it into an isolated Node consumer with lifecycle scripts disabled, and
exercises the exported control library. `deno task release:artifacts` is intentionally
tag-workflow work because it downloads a Deno runtime and checksum-verified FRP archive
for every Linux, macOS, and Windows target.

Every release surface uses one immutable ComVer version: host OCI, connector OCI, native
bundle, JSR module, and npm package. Releases occur only from increasing `MAJOR.MINOR.0`
tags. See [versioning](versioning.md).

## Contribution workflow

Install the Conventional Commit hook with `deno task hooks:install`. Add behavior tests
at the nearest boundary, run focused checks while iterating, then run the complete
Compose-native validation. Review the final diff for credentials, generated artifacts,
stale names, unsupported transport claims, and dependency/license changes.
