# Agent-assisted Bunny Hole deployment

This guide is for someone deploying a released Bunny Hole template from a consumer
repository. It complements the repository's [deployment guide](deployment.md) and the
[`bunny-hole-setup` skill](../.agents/skills/bunny-hole-setup/SKILL.md). The skill has
the detailed procedure and
[sanitized handoff schema](../.agents/skills/bunny-hole-setup/references/handoff-schema.md);
this page explains how to work safely with an agent.

## What the agent can do

An agent can inspect the template, read the provider schema, fill non-secret values,
format and validate Terraform without a backend, run static checks, review action and
provider pins, compare an image digest with release evidence, draft dashboard steps, and
interpret public health/identity facts returned by the operator.

An agent must not receive or handle a Bunny API key, Terraform/backend credential,
registry credential, owner private key, device key, passkey response, connector
configuration, Kubernetes Secret, session token, raw Terraform state, plan artifact, or
secret-bearing command output. Do not paste these into chat, issues, logs, shell
arguments, `tfvars`, workflow outputs, or generated handoff files. If one is pasted,
stop and rotate it before continuing.

The agent also cannot infer approval from a previous message. A human must explicitly
approve each live plan/apply/import, DNS/TLS or CDN change, image replacement, rollback,
revocation, and destruction. A protected GitHub Environment is useful only when it was
pre-created with reviewers and branch restrictions; a workflow naming an environment
does not create those protections.

## A safe staged session

1. **Prepare public inputs.** Provide the released `MAJOR.MINOR.0` version, tested image
   digest, region, app name, management and connector hostnames, exact route hostnames,
   local origin summary, DNS ownership, and Terraform/dashboard preference.
2. **Offline review.** Have the agent read the consumer template README and
   `docs/deployment-template.md` when present. Ask it to run formatting, backend-free
   validation, docs/static checks, secret scanning, and immutable-reference checks. Do
   not provide credentials to make these checks pass.
3. **Resource checkpoint.** In a private terminal or Bunny dashboard, the operator
   creates or authorizes the app/backend and, if needed, enters registry credentials.
   Pause. Return only public resource IDs, selected region, image digest, and health
   state. For Terraform, ask for a sanitized plan summary. The human records the public
   reviewed commit and plan digest from the protected workflow, then gives a new
   explicit approval before entering them into the apply dispatch.
4. **Edge and identity checkpoint.** After bootstrap imports the two
   Magic-Container-generated Pull Zones, return its sanitized handoff with each actual
   generated Pull Zone ID/name and CDN domain. Commit those exact values, then review a
   separate full policy/DNS plan with hostname TLS disabled. The operator publishes and
   verifies DNS (Bunny DNS records or external CNAME/alias records), then reviews a
   distinct TLS-stage plan that creates managed-TLS exact hostnames. The operator
   privately completes certificate validation, owner identity, passkey, and enrollment.
   Pause. Return only public hostnames/IDs, the verification phrase, route IDs, and
   health status.
5. **Connector and verification.** In the private connector terminal, approve a
   least-privilege exact/suffix grant, create the exact route, and connect over WSS.
   Test the exact hostname from another network. Verify one healthy instance, both
   probes, image digest, no cache, endpoint separation, replacement behavior, and
   documented 404/502/503 responses.
6. **Handoff.** Ask the agent to produce a sanitized record using the schema. Keep
   unresolved dashboard/DNS/TLS or registry items as `pending-manual-items`; do not
   claim `verified` until each requested check has evidence.

The pinned provider can manage the application, adopted Pull Zones, WebSocket/cache
policy, exact custom hostnames, managed TLS, and optional records in an existing Bunny
DNS zone. It cannot atomically create and manage a Magic Container endpoint's
side-effect Pull Zone: bootstrap therefore creates only the application, imports both
generated zones, records their actual IDs/names, and stops. Provider 0.18.2 treats Pull
Zone name as replacement-only, so the template fails a full plan unless the committed
handoff names match the zones at its recorded IDs. The protected apply must reproduce
both the reviewed commit and canonical plan digest. First review/apply policy and DNS
with custom hostname TLS disabled; only after propagation is verified should a
separately reviewed plan enable managed TLS. Use the dashboard only for provider gaps
and certificate/DNS validation, and never claim a setting is verified without checking
the deployed result. Endpoint renames require a separate review because they may
recreate a Pull Zone.

## Prompt to give an agent

```text
Help me deploy the released Bunny Hole template from this repository. Read AGENTS.md,
the architecture/protocol/threat-model/deployment docs, the template README, and
docs/agent-assisted-deployment.md. Use only non-sensitive inputs and the immutable
tested image digest. Never ask for, display, store, or handle my Bunny API key,
Terraform/backend or registry credentials, owner/device private keys, passkey response,
connector configuration, Kubernetes Secret, session token, raw state, plan artifact,
or secret-bearing output. Pause before every dashboard or private-terminal step and
resume only from public IDs, hostnames, public keys, digests, verification phrases,
route IDs, and health status. Ask for explicit approval immediately before any plan,
apply, import, replacement, rollback, revoke, or destroy. Do not use mutable tags or
actions, do not enable autoscaling, and do not claim unsupported WebSocket, TCP/UDP,
multi-region, multi-replica, or end-to-end HTTP/2 behavior. Produce a sanitized handoff
when stopping.
```

For review-only work, replace the final request with: “Do not mutate live resources; use
the deployment review checklist and report evidence, uncertainty, and risks.”
