---
name: bunny-hole-setup
description: Scaffold, review, and guide a consumer through a credential-safe Bunny Hole GitOps deployment using the repository template, Terraform, or the Bunny dashboard.
---

# Bunny Hole consumer setup

Use this skill when a repository consumer wants to deploy or review Bunny Hole on Bunny
Magic Containers, adopt an existing Bunny application, configure CDN/DNS/TLS, enroll a
connector or cluster, or prepare a rollback. It is for operating a released template; it
is not a substitute for the contributor workflow that changes Bunny Hole protocol, host,
connector, or release code.

## Before doing anything

Read `AGENTS.md`, `docs/architecture.md`, `docs/protocol.md`, `docs/threat-model.md`,
and `docs/deployment.md`. Then read the deployment-template README and
`docs/agent-assisted-deployment.md` when those files exist. Read the relevant reference
in this skill only for the mode selected below:

- [workflow](references/workflow.md) for the staged Terraform/dashboard procedure;
- [handoff schema](references/handoff-schema.md) when starting or resuming work; and
- [review checklist](references/review-checklist.md) for attacker, operator, or
  supply-chain review.

If the request changes application code, protocol behavior, the FRP profile, release
artifacts, or repository CI, stop using this skill and use the repository's contributor
and deployment skills instead. Do not silently turn a consumer deployment into a code
change.

## Select the operating mode

Ask for only non-sensitive facts: release `MAJOR.MINOR.0`, tested image digest, region,
application name, management hostname, connector hostname, exact public route hostnames,
local origin protocol/target, DNS ownership, and whether the consumer wants Terraform or
the dashboard. A public owner key is configuration, but the corresponding private key is
not. Do not ask for or accept a Bunny API key, Terraform/backend credential, registry
credential, owner private key, passkey response, device key, connector configuration,
Kubernetes Secret, session token, raw Terraform state, or any other secret-bearing
output.

The skill has four modes:

1. **Scaffold:** inspect the template, fill only non-secret variables, run formatting,
   offline validation, static checks, and produce a reviewable plan. Do not apply.
2. **Provision/review:** use the Terraform template for its documented resources and the
   dashboard only for validation or an identified provider gap. A human performs private
   dashboard and terminal actions. Explicit approval is required immediately before
   plan, apply, import, replacement, rollback, revoke, or destroy.
3. **Resume:** accept only a sanitized handoff matching
   [handoff-schema.md](references/handoff-schema.md); reject and ask the user to redact
   it if it contains credentials, private keys, passkeys, connector config, secrets,
   state, or tokens.
4. **Audit:** use [review-checklist.md](references/review-checklist.md) to review the
   repository, provider lock, workflows, image provenance, Bunny settings, and operator
   procedure without touching live resources.

## Non-negotiable deployment shape

Preserve one Bunny region, one host instance, one persistent volume, and one active
connector per enrollment. Use an immutable, release-tested host image digest; never use
`latest`, a branch tag, or an unreviewed local image. Expose management/public HTTP on
container port 8080 and connector transport on port 7000 behind a separate WSS CDN
endpoint. Use exact hostnames, no wildcard route, no direct public connector port, no
dynamic caching, and the documented `/readyz` and `/healthz` probes. Keep connector
origins loopback-only unless the consumer deliberately opts into the documented
private-network exception.

The pinned provider manages the application and, after adoption, both Pull Zones,
WebSocket/cache policy, exact hostnames, Bunny-managed TLS, and optional records in an
existing Bunny DNS zone. Never invent provider arguments or claim deployed behavior from
configuration alone. Magic Containers creates the endpoint Pull Zones as a side effect,
so bootstrap must target only the application, import both generated zones, and stop
before a separately reviewed full plan. Record certificate/DNS validation, registry
setup, and any provider gap as `pending-manual-items`. Review stable resource identity
before changing endpoint names.

For the GitHub template, plan bootstrap first and record its public commit SHA and
canonical plan digest. Supply those exact values to the separately approved bootstrap
dispatch. Repeat the plan-and-bound-apply sequence for the full convergence. A mismatch
means code or state changed; stop and review a new plan. Never upload the saved binary
plan or normalized plan JSON.

## Approval and pause rules

Keep PR checks read-only and secret-free. Never run a secret-bearing workflow against a
pull request checkout or a contributor-controlled ref. Before every private step, tell
the consumer exactly what they must do in their own dashboard or private terminal and
what safe values to return. The agent may resume from public IDs, hostnames, public
keys, image digests, verification phrases, route IDs, and health timestamps only.

Require a fresh, explicit approval for each of: `terraform plan` using a real backend or
credential, `terraform apply`, importing/adopting resources, changing DNS/TLS or CDN
behavior, replacing the image, rollback, revocation, and destruction. An earlier
approval does not authorize a later destructive or external action. Verify the final
state: exactly one healthy instance and volume, two separated endpoints, no cache on
dynamic traffic, WSS connector health, exact route match, session identity pin, and
expected public failure behavior.

For the complete staged procedure, including connector enrollment, Kubernetes secret
handling, rollback, and stop conditions, read [workflow.md](references/workflow.md).
