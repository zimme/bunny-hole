---
name: bunny-hole-setup
description: Configure, review, provision, verify, update, or retire this Bunny Hole GitOps deployment while keeping credentials outside the agent context.
---

# Bunny Hole deployment setup

Read `AGENTS.md`, `README.md`, every file under `terraform/`, and the
[sanitized handoff schema](references/handoff-schema.md) before acting. This is a
consumer infrastructure repository; do not modify Bunny Hole application/protocol code
or substitute an unpublished image.

## Modes

- **Scaffold or review:** fill only non-secret configuration, verify release provenance,
  run backend-free checks, and review topology, pins, replacement risk, and pending
  human steps. Do not contact Bunny or a state backend.
- **Bootstrap:** after explicit authorization, instruct the human to run the protected
  plan with `operation=bootstrap`, review it, and record its public commit and plan
  digest. A separately approved bootstrap dispatch must reproduce both before it creates
  the app, imports the automatically generated Pull Zones, prints `bootstrap_handoff`,
  and stops. Commit the handoff's actual generated Pull Zone IDs and names before a full
  plan: `name` is replacement-only in provider 0.18.2, so it is never routine cleanup.
  Never import a resource until its ID and ownership have been verified.
- **Plan or apply:** require a separate explicit approval for each operation. Use only
  the protected default-branch workflows. Enter the reviewed commit and canonical plan
  digest into apply; a mismatch requires a new plan and review. Never accept a
  PR-produced plan or upload a plan/state artifact.
- **Dashboard fallback:** give the exact fields from `README.md` when a provider or
  account feature cannot express them. Record the item as pending until the human
  returns non-sensitive evidence.
- **Operate:** update or roll back only to a released ComVer tag and matching digest.
  Enroll replacement keys before revocation. Destruction requires a separate private
  plan and explicit authorization; this repository intentionally has no destroy job.

## Credential boundary

Never ask for, read, display, store, transform, or handle a Bunny API key, HCP/backend
credential, registry token, owner private key, passkey response, connector config,
device key, Kubernetes Secret, session token, raw Terraform state, or binary plan. Do
not ask the human to type one into an agent-controlled terminal. Pause while they use a
separate private terminal, Bunny dashboard, HCP dashboard, or protected GitHub
Environment. Resume only from public hostnames/URLs, public keys, region, ComVer, image
digest, resource/Pull Zone/enrollment/route IDs, verification phrase, and health status.

## Required review

Confirm the final state has one region, one instance, one state volume, immutable host
digest, ports 8080 and 7000 on separate CDN endpoints, caching disabled on both zones,
WebSockets enabled only for the connector, exact non-wildcard hostnames, managed TLS,
and successful `/healthz` and `/readyz`. First converge policy and optional Bunny DNS
with `enable_hostname_tls=false`; publish and verify DNS propagation, then separately
review the TLS-stage apply. Check that actions and the provider are pinned, PR jobs
receive no secrets, live jobs check out only the protected default branch, and no state,
plan, credential, or private key is tracked.

When pausing, provide only a handoff matching
[references/handoff-schema.md](references/handoff-schema.md). It may include public
generated Pull Zone IDs/names and CDN domains, but never state or credentials. Reject a
handoff containing extra secret-bearing fields and ask the human to redact it.
