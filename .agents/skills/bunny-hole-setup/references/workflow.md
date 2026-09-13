# Consumer setup workflow

This reference is the detailed procedure for the `bunny-hole-setup` skill. It assumes
the consumer has a released repository template and has read its own README and
`docs/deployment-template.md` if present. Provider schemas and Bunny UI names are
time-sensitive: verify them against the current official documentation before making a
claim or changing a resource.

## 1. Discover and classify the request

Record a short, non-secret intake:

```text
release: 1.4.0
image_digest: sha256:...
region: <Bunny region>
application: <name>
management_hostname: manage.example
connector_hostname: connect.example
route_hostnames: [service.example]
origin: http://127.0.0.1:8123
dns_owner: consumer | another operator
path: terraform | dashboard
runtime: native | compose | kubernetes
```

The image digest must belong to a published ComVer release that was tested by the
repository's release workflow and must match the selected architecture. Do not accept an
unqualified tag as a substitute. Do not request the private half of any key.

Classify the task as scaffold, provision, resume, or audit. A consumer fork may change
names, sizing, region, and public route data, but must not change the tunnel protocol,
authentication, FRP profile, or one-instance invariant as part of setup.

## 2. Inspect the template without credentials

Read the template README, Terraform variables/examples, provider lockfile, workflows,
and deployment-template documentation. Run only offline/read-only checks first:

- format and validate Terraform with backend initialization disabled;
- repository docs and static template checks;
- secret scanning and mutable-reference checks;
- image digest, port, probe, volume, region, and replica assertions; and
- a diff review of all generated files.

The template must not contain an API key, registry password, owner private key, device
key, passkey, Kubernetes Secret, state file, plan file, or session token. Keep
`.terraform/`, `*.tfstate*`, `*.tfplan`, crash logs, and local variable files ignored.
Terraform state can contain environment values and resource metadata; use an encrypted,
locked remote backend selected and secured by the consumer. Backend configuration cannot
safely be inferred from ordinary variables and must be completed privately.

## 3. Choose Terraform or dashboard

### Terraform path

Terraform manages only resources and fields documented by the pinned Bunny provider. Use
one required and allowed region, `regions_max_allowed = 1`, and min/max replicas of one.
Keep container, environment, endpoint, and volume blocks in the provider's required
stable order. Pin the provider and action/tool versions and use the committed lockfile.
Reference an immutable image digest.

Magic Containers creates CDN Pull Zones as a side effect of endpoint creation. The
template therefore target-applies only the application, imports both generated zones,
and stops. Treat their IDs as public inventory, but do not rename endpoint blocks
casually: a rename may recreate a Pull Zone. If the application or zone already exists,
inspect it first and obtain explicit approval before importing/adopting it. Run and
review a separate full plan after import; only then ask for apply approval.

Provider 0.18.2 can configure the adopted zones' cache/WebSocket policy, exact custom
hostnames, managed TLS, and optional records in an existing Bunny DNS zone.
Configuration is not proof of deployed behavior: verify certificates, DNS, caching, and
WSS after apply. Record an actual provider gap as a manual item instead of inventing an
argument.

Do not put a secret in `TF_VAR_*`, a checked-in tfvars file, a plan artifact, an output,
or a shell argument. The Bunny API key and backend credentials belong only in a
pre-created protected environment or private terminal. Never run the credential-bearing
workflow on a PR or a workflow checkout controlled by an untrusted contributor.

When using the template workflows, dispatch `Plan deployment` with the intended
`bootstrap` or `apply` operation first. Review the plan and record the public commit SHA
and canonical plan SHA-256 from its summary. The separate protected apply accepts those
values only when the commit is still the default-branch tip and the reproduced plan has
the same digest. Any mismatch is a stop condition requiring a new review. Do not export
or upload the saved plan or its normalized JSON.

After apply, report only app/container/endpoint/pull-zone IDs, region, image digest,
hostnames, and health status. Keep state and logs private.

### Dashboard fallback

When the provider cannot configure a setting, pause and give the human a click-by-click
checklist from the current Bunny dashboard. The checklist must include: one region and
one instance; digest-pinned image; ports 8080 and 7000; persistent
`/var/lib/bunny-hole`; the documented public environment values; `/readyz`
readiness/startup and `/healthz` liveness; non-root/read-only settings where supported;
a management/public endpoint on 8080 with caching disabled; and a separate connector
endpoint on 7000 with WSS enabled, caching disabled, and no direct port exposure.

Certificate/DNS validation, registry credentials, and any genuinely unsupported endpoint
policy remain human-only steps. Return IDs and public verification facts, not
screenshots containing secrets or copied private values.

## 4. Complete the private checkpoints

Use two explicit checkpoints:

**Checkpoint A — resource authorization.** The consumer privately creates or authorizes
the Bunny application, backend, and deployment credentials. The agent waits. Resume with
app/container/endpoint or pull-zone IDs, selected region, image digest, and health
state. If a user pastes a credential, tell them to rotate it and provide a redacted
summary instead.

**Checkpoint B — edge and identity.** The consumer privately completes DNS/TLS,
registry-credential entry, owner identity generation, passkey ceremony, and any
connector or Kubernetes credential creation. The agent waits. Resume with public
hostnames, enrollment ID, verification phrase, route IDs, and health state only.

An owner public key may be placed in configuration. The owner private key remains in the
consumer's protected file and is never passed to the agent. A Kubernetes enrollment
manifest or Secret is redirected to a protected file and delivered through the
consumer's secret manager; never ask the agent to inspect or apply it.

## 5. Enroll and route a connector

The consumer uses the released CLI or documented Compose/Kubernetes path in a private
terminal. The agent can explain the sequence but cannot handle device keys or secret
configuration. Verify the enrollment ID and short verification phrase out-of-band before
approval. The grant must be least privilege: exact hostnames or explicit suffixes,
protocols, and a bounded route count. Do not grant a wildcard or turn the connector into
a general proxy.

Create an exact route to the intended loopback origin, run the documented host check,
and connect over outbound WSS. Do not expose the connector listener directly. Keep
application authentication enabled; Bunny Hole authenticates connectors and owners, not
public viewers.

## 6. Verify and hand off

Verify both probes, exact management hostname, connector WSS health, one healthy host
instance, persistent volume, image digest, and endpoint separation. Test an external
request to the exact route from another network. Confirm that an unknown hostname is not
routed, an inactive connector gives the documented public failure, cache headers are not
causing dynamic content to persist, and a reconnect replaces the prior active connector.
Do not claim public WebSocket, TCP/UDP, multi-region, multi-replica, or end-to-end
HTTP/2 support.

Write a sanitized handoff according to [handoff-schema.md](handoff-schema.md). It may
include IDs, URLs/hostnames, version/digest, region, route IDs, verification phrase,
health timestamp, and unresolved manual items. It must not include credentials, keys,
passkeys, connector config, Kubernetes Secret data, session tokens, raw state, or plan
output. If any unresolved manual item affects security or reachability, leave the task
at `pending-manual-items` rather than claiming completion.

## 7. Update, rollback, and revoke

During a maintenance window, record the current digest and state compatibility before
replacement. Approve an update or rollback separately. Deploy the previous tested
digest, expect the single instance replacement to drop active requests and the
connector, then verify readiness, host check, reconnect, and exact routing. Never roll
back to a mutable tag or untested image.

For rotation, enroll and verify the new device first, cut over, then explicitly revoke
the old enrollment. Revocation invalidates sessions and routes; stop the old connector
and remove its local secret state in the private terminal. Destruction is a separate
explicit approval and must include a backup/retention decision for the persistent volume
and a warning that it removes identity, enrollments, passkeys, grants, routes, and audit
history.
