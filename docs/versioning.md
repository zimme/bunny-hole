# Compatible Versioning

Bunny Hole follows the canonical
[Compatible Versioning specification](https://gitlab.com/staltz/comver), expressed in
its recommended SemVer-compatible `MAJOR.MINOR.0` form. The patch component is always
zero and must never be incremented. Major zero follows exactly the same compatibility
rules as every other major version.

## Declared public API

ComVer requires a precise public API because compatibility is measured against its
supported use cases. Bunny Hole's public API is:

- the `@zimme/bunny-hole` root export (`createConnector`, `VERSION`, and its exported
  types);
- connector CLI commands, flags, exit codes, environment variables, and configuration
  file behavior documented in [Configuration](configuration.md);
- host and connector OCI entrypoints, environment variables, health endpoints, and
  documented deployment behavior;
- protocol v1 control API, pinned FRP profile, authentication, limits, HTTP behavior,
  and connector replacement semantics documented in [Tunnel protocol](protocol.md); and
- published artifact names and the security guarantees documented in
  [Security policy](../SECURITY.md) and the [Threat model](threat-model.md).

Files not reachable through a package export, repository scripts, tests, fixtures, and
unexported implementation details are not public API.

Compatibility determines the release line:

- A breaking change requires a major bump and resets the version to `NEXT_MAJOR.0.0`.
- A non-breaking change requires a minor bump to `CURRENT_MAJOR.NEXT_MINOR.0`.
- Bug fixes receive no special version category. A fix is minor only when every existing
  supported use case preserves its observable behavior.
- A bug fix that changes behavior incompatibly is a breaking change and therefore causes
  a major bump, even when the old behavior was a bug.

Breaking means an existing supported deployment, connector, configuration, protocol
peer, CLI invocation, API consumer, or documented operational workflow must change to
keep working. Features and bugs are both observable behavior under ComVer. Security
motivation does not make a breaking change non-breaking.

Every breaking commit must use a Conventional Commit breaking marker:

```text
fix!: reject previously accepted ambiguous request targets
```

or include a footer:

```text
BREAKING CHANGE: connectors must be upgraded with the host
```

The release workflow compares commits since the latest ComVer tag. If any breaking
marker is present, only a new major line is accepted. Otherwise, only a higher minor
version on the current major line is accepted. ComVer sections 8 and 10 explicitly
permit prereleases. Bunny Hole supports its normal `MAJOR.MINOR.0` releases plus the
narrow evaluation channel `MAJOR.MINOR.0-rc.N`, where N starts at 1 and increases by
one. The lowercase `rc` spelling is canonical. Other prerelease labels, nonzero patches,
build metadata, leading zeroes, downgrades, and repeated versions are rejected.

Candidate ordering does not replace compatibility checks: the proposed base version must
still satisfy the bump rules relative to the latest stable release. Promotion removes
the suffix from that same base version; RC tags do not become the stable compatibility
baseline. Before the first stable release, an RC can evolve without promising the stable
public API's compatibility. Candidates are immutable GitHub prereleases, use npm's `rc`
distribution tag, and JSR excludes them from stable resolution. They do not become
GitHub's latest stable release. Consumer Terraform rejects candidates unless
`allow_release_candidate=true` is deliberately configured.

Every published release includes an attested `bunny-hole-deployment-VERSION.tar.gz`
archive containing the standalone template and `release.json` with the exact commit and
published image digests. Its public example is stamped with the matching version and
host digest; RC deployment consent still defaults to false. Consumers need no Bunny Hole
development toolchain to extract and configure this archive.

Released versions are immutable. npm and JSR enforce immutable package versions, the
release workflow refuses to overwrite an existing versioned OCI tag, and operators
should deploy recorded OCI digests. Package publishing is restartable: it skips an exact
npm or JSR version that the immutable registry already contains and publishes only the
missing registry artifact. If any released artifact is wrong, publish the next
compatible minor or breaking major version; never replace the existing version.

Before creating a tag, update the connector CLI, connector library, host, and root
`deno.json` versions together and check the intended tag locally:

```sh
deno task version:check
deno task release:check 1.4.0
```
