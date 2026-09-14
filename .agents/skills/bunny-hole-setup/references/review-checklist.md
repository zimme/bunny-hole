# Deployment review checklist

Use this reference for a read-only audit. Report evidence and uncertainty; do not repair
or mutate live infrastructure during an audit unless the user separately asks for
implementation and approves each external action.

## Contributor versus consumer boundary

- A consumer edits template variables, docs, and private dashboard state only.
- A repository contributor changes host/connector/protocol/release code, provider
  integrations, workflows, or tests and must follow `AGENTS.md` and the relevant
  contributor skill.
- A deployment request must not silently alter protocol claims, authentication, FRP
  settings, public API, release tags, or CI trust boundaries.

## Attacker review

- Pull-request jobs use read-only permissions, no deployment secrets, and no privileged
  checkout of contributor-controlled code.
- No `pull_request_target`, unreviewed `workflow_run` artifact, issue-comment command,
  shell interpolation of untrusted event data, or mutable action reference can reach a
  Bunny credential.
- The API key is treated as full-account access; it exists only in a pre-protected
  environment or private terminal and is never printed, output, or put in Terraform
  variables/state intentionally.
- Owner private keys, device keys, passkeys, registry credentials, Kubernetes Secrets,
  session tokens, and raw state/plan output never enter agent context.
- Public routing uses exact hostnames. Wildcards, viewer-selected tunnels, direct
  connector ports, arbitrary origins, and broad grants are rejected.

## Operator review

- The selected image is an immutable, tested ComVer `MAJOR.MINOR.0` digest with
  provenance/SBOM evidence and the architecture is supported.
- Region and replicas are both fixed at one. There is one durable volume mounted at
  `/var/lib/bunny-hole`; the operator understands rolling replacement drops live
  connections and makes no zero-downtime claim.
- Port 8080 is the management/public HTTP endpoint and port 7000 is only the separate
  connector WSS endpoint. `/readyz` is readiness/startup and `/healthz` is liveness.
- CDN dynamic traffic is uncached; methods, bodies, query strings, auth headers,
  cookies, and `Set-Cookie` are preserved as required. TLS/DNS and custom hostnames are
  verified rather than assumed.
- The connector is outbound WSS, origins are loopback-only by default, route grants are
  least privilege, and application authentication remains enabled.
- Backups, state retention, maintenance window, rollback digest, and revocation plan are
  recorded without copying secret data.

## Supply-chain review

- Terraform provider, lockfile hashes, CI actions, base image, FRP archive, and release
  image references are pinned to reviewed immutable versions.
- No `latest`, branch action, floating provider, unreviewed generated plan, or image
  digest that differs from the tested release is accepted.
- Terraform validation and static checks run without credentials; plans are not uploaded
  by default because plans can disclose values and state.
- Provider schema claims are checked before use. Unsupported WebSocket, cache, custom
  hostname, TLS, or DNS fields are documented as dashboard/manual work rather than faked
  in Terraform.
- Endpoint names and generated pull-zone identity are stable. Imports/adoptions and
  resource renames are reviewed for replacement risk.

## Evidence to request

Request only public/non-sensitive evidence: commit or release version, image digest and
provenance result, app/container/endpoint/pull-zone IDs, region, public hostnames,
health timestamps, verification phrase, route IDs, and a list of unresolved manual
items. Ask the consumer to summarize private checks instead of pasting screenshots,
terminal output, state, manifests, credentials, or logs.
