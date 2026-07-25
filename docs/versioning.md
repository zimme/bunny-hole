# Compatibility Versioning

Bunny Hole uses Compatibility Versioning (ComVer), expressed as `MAJOR.MINOR.0`. The
patch component is always zero and must never be incremented.

Compatibility determines the release line:

- A breaking change requires a major bump and resets the version to `NEXT_MAJOR.0.0`.
- A non-breaking change requires a minor bump to `CURRENT_MAJOR.NEXT_MINOR.0`.
- Bug fixes are normally non-breaking and therefore cause a minor bump.
- A bug fix that breaks compatibility is a breaking change and therefore causes a major
  bump.

Breaking means an existing supported deployment, connector, configuration, protocol
peer, CLI invocation, API consumer, or documented operational workflow must change to
keep working. Security motivation does not make a breaking change non-breaking.

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
version on the current major line is accepted. Tags with a nonzero patch component,
prerelease suffix, build metadata, leading zero, downgrade, or repeated version are
rejected.

Before creating a tag, update the connector and relay `VERSION` constants together and
check the intended tag locally:

```sh
deno task version:check
deno task release:check 1.4.0
```
