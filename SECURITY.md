# Security policy

## Supported versions

Before the first stable release, only the latest commit on `main` receives fixes. After
tagged releases begin, the latest ComVer release line is supported. A security fix that
breaks a documented public contract requires a major version; a compatible fix requires
a minor version. Patch is always zero.

## Report a vulnerability

Use GitHub private vulnerability reporting for `zimme/bunny-hole`. If it is unavailable,
contact the maintainer through the private contact method on their GitHub profile. Do
not open a public issue, include live credentials or captured user traffic, probe
systems you do not own, or retain other people's data.

Include the affected revision/version, impact, a minimal reproduction using synthetic
data, and any suggested mitigation. The project aims to acknowledge a report within
seven days and coordinate disclosure according to severity and fix availability.

Never send a Bunny API key, owner/device private key, passkey data, connector config,
Kubernetes Secret, registry token, cookie, or `Authorization` value. Redact logs before
attaching them.

## Operator responsibilities

Bunny Hole provides an authenticated outbound tunnel; it does not authenticate public
viewers. Keep origin application authorization enabled, grant only exact required
hostnames, retain connector loopback defaults, and expose private networks only per
route. Use one Magic Container region and one instance. Pin OCI images by release
digest, verify attestations/checksums, protect the persistent volume, and keep the owner
recovery key offline with at least two passkeys.

The optional Bunny workflow requires a broad long-lived account key under currently
documented Bunny authentication. Store it only in a reviewer-protected GitHub
Environment or deploy manually. Pull-request and coding-agent workflows must never
receive it.

Read the complete [threat model](docs/threat-model.md),
[protocol profile](docs/protocol.md), and [deployment guide](docs/deployment.md) before
exposing a sensitive service.

## Release trust

Official releases use one immutable `MAJOR.MINOR.0` version for host and connector OCI
images, native bundles, JSR source, and the npm library. Prefer OCI digests, verify
native `SHA256SUMS`, and verify GitHub provenance/SBOM attestations. The project does
not publish an Edge Script build and does not require npm or JSR tokens after trusted
publishing is configured.
