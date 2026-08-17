# Development

Deno 2.9.5 is the only task runner. Node 24.13.1 and npm 11.8.0 are present inside the
development container for GitHub Copilot CLI, Dev Container tooling, and isolated
verification/publishing of the real npm connector artifact. There is no repository
`package.json` and no npm task wrapper.

The development environment is Docker Compose-native. Docker Compose builds the complete
toolchain without the Dev Container CLI:

```sh
docker compose up --build --detach development
docker compose exec --user vscode development deno task setup
docker compose exec --user vscode development deno task validate
docker compose down
```

The existing Deno aliases run the same operations:

```sh
deno task devcontainer:up
deno task devcontainer:exec -- deno task validate
deno task devcontainer:down
```

The first command may also be run attached as `docker compose up development`. The
`development` profile prevents this long-running workspace service from joining an
ordinary integration-topology startup.

The service workload runs as `vscode`; use `--user vscode` for plain Compose execs
because Compose otherwise defaults exec sessions to the image's root bootstrap user. The
bootstrap process only prepares cache ownership and maps the Docker socket group, then
immediately drops privileges for the long-running command.

Inside the development container:

```sh
deno task setup
deno task validate
deno task integration
```

Focused tasks include `fmt`, `lint`, `check`, `test`, `coverage`, `integration`,
`build`, `edge:build`, `edge:probe`, `package:check`, `audit`, and `container:smoke`.
`edge:build` emits the portable Bunny Edge Script bundle; `edge:probe` performs the
credential-safe live affinity experiment described in
[Edge Script experiment](edge-script-experiment.md). `package:check` performs a JSR
publish dry run, creates the npm tarball with `deno pack`, installs it into an isolated
Node consumer with lifecycle scripts disabled, opens a real authenticated tunnel from
Node, and proxies a request through its public API. `deno task validate` is
authoritative and is the exact command CI invokes with `CI=true`.

## Cache design

The development image copies `deno.json` and `deno.lock` before source and runs
`deno ci`, so dependency changes invalidate that layer while source edits do not.
`/deno-dir` is a named volume made writable for the non-root `vscode` user on startup.
The repository and host Docker socket are mounted by Compose; the entrypoint maps the
socket group before dropping privileges. This works with macOS Docker Desktop and Linux
engines. Compose explicitly maps `host.docker.internal` to Docker's host gateway so
tests inside the development service can reach sibling services through their published
ports on both platforms. CI also passes the host socket's numeric group to Compose's
`group_add`, because Dev Container remote-user execution cannot reliably inherit a group
created by the running entrypoint.

`.devcontainer/devcontainer.json` only supplies editor metadata and points at the same
Compose service. It has no Features or lifecycle command, so opening the repository in a
Dev Container cannot produce a different toolchain. Its `runServices` list starts only
the long-running development service; integration topology services remain controlled by
the authoritative Deno tasks. CI pulls the GHCR development image prebuild as its
primary toolchain/dependency cache. The prebuild workflow never overwrites an existing
commit-SHA image; its moving `cache` tag changes only when a new immutable commit image
is published. Production BuildKit caching reuses compiler and source-independent layers.

There is no GitHub Actions dependency cache: local Docker volumes cannot be shared with
hosted runners, and an additional cache would duplicate image layers. npm caching is
absent because npm is used only to validate and publish a dependency-free generated
artifact, not to manage repository dependencies.

## Release artifacts

`deno task release:artifacts` cross-compiles the connector for Linux x86-64/ARM64, macOS
x86-64/ARM64, and Windows x86-64 and writes SHA-256 checksums. It is intentionally a
release task rather than part of every validation because Deno must download a separate
runtime for each target. `deno task package:build` creates the npm tarball. The tag-only
release workflow publishes both OCI images, native binaries, JSR source, and the npm
library at one matching ComVer version. After publishing, it reruns the Compose topology
with the exact relay and connector image digests before creating the GitHub release. The
library contains only the supported connector API. The experimental Edge Script adapter
remains source-only in this repository, and its generated bundle is a validation
artifact rather than a package export or separately versioned package.
