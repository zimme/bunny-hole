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
  types) and the exported `./edge-relay` experiment;
- connector CLI commands, flags, exit codes, environment variables, and configuration
  file behavior documented in [Configuration](configuration.md);
- relay and connector OCI entrypoints, environment variables, health endpoints, and
  documented deployment behavior;
- protocol v1 framing, authentication, limits, HTTP behavior, and connector replacement
  semantics documented in [Tunnel protocol](protocol.md); and
- published artifact names and the security guarantees documented in
  [Security policy](../SECURITY.md) and the [Threat model](threat-model.md).

Documented experimental limitations are part of that contract. Exporting the Edge Script
experiment does not exempt its supported API from ComVer. Files not reachable through a
package export, repository scripts, tests, fixtures, and unexported implementation
details are not public API.

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
BREAKING CHANGE: connectors must be upgraded with the relay
```

The release workflow compares commits since the latest ComVer tag. If any breaking
marker is present, only a new major line is accepted. Otherwise, only a higher minor
version on the current major line is accepted. The ComVer specification permits
`MAJOR.MINOR` notation, prereleases, and build metadata, but Bunny Hole's stable-release
policy deliberately accepts only normal `MAJOR.MINOR.0` versions. Nonzero patches,
suffixes, leading zeroes, downgrades, and repeated versions are rejected.

Released versions are immutable. npm and JSR enforce immutable package versions, the
release workflow refuses to overwrite an existing versioned OCI tag, and operators
should deploy recorded OCI digests. If any released artifact is wrong, publish the next
compatible minor or breaking major version; never replace the existing version.

Before creating a tag, update the connector CLI, connector library, relay, and root
`deno.json` versions together and check the intended tag locally:

```sh
deno task version:check
deno task release:check 1.4.0
```
