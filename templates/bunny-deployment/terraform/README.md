# Bunny Hole Terraform deployment template

This directory provisions the documented Bunny Hole Magic Containers shape:

- one required and allowed region, one running instance, and no autoscaling;
- one non-root Bunny Hole host container from a public GHCR image pinned by both a
  released `MAJOR.MINOR.0` tag and a lower-case `sha256:` digest;
- one encrypted persistent volume at `/var/lib/bunny-hole`;
- a public/management CDN endpoint on container TCP port `8080` and a separate connector
  CDN endpoint on TCP port `7000`;
- `/healthz` liveness and `/readyz` startup/readiness probes; and
- adopted Pull Zones with standard routing, disabled caching/error caching/request
  coalescing/retries, application cookies preserved, and WebSockets enabled only on the
  connector Pull Zone with an explicit bounded connection limit.

The Bunny provider does not create the two Pull Zones as ordinary Terraform resources:
Magic Containers creates them as a side effect of the CDN endpoints. The declarations
below are intentionally an adoption workflow. They must be imported after the target
bootstrap apply. Custom hostnames use Bunny-managed TLS (`tls_enabled = true`, with no
certificate private key in this repository). Optional Bunny DNS records link an
already-existing zone to the adopted Pull Zones; this template never creates a DNS zone
or changes nameserver delegation.

## Before you start

Use Terraform **1.16.2** and the exact `BunnyWay/bunnynet` provider **0.18.2**. Verify
that the selected Bunny region and a published, tested host image are available. Keep
the Bunny API key out of files and agent conversations: the provider reads it only from
`BUNNYNET_API_KEY` in a private shell or a protected CI environment. Bunny documents
that this is a full-account key and does not document scoped/OIDC deployment keys.

The HCP Terraform backend is the checked-in example. Copy it and replace its
organization placeholder before `terraform init`:

```sh
cp backend.tf.example backend.tf
cp tfvars.example terraform.tfvars
chmod 600 terraform.tfvars
```

Edit `terraform.tfvars` with public configuration only. `owner_public_key` is the public
Ed25519 key printed by the private owner-generation command. Never put the owner private
key, passkey response, connector state, registry token, or Bunny API key in a tfvars
file. The JSON example is also public-only configuration and may be copied to
`deployment.auto.tfvars.json`; keep the resulting file untracked if it contains local
hostnames or release details.

For HCP Terraform, authenticate the private shell with `terraform login` or configure
the protected `TF_TOKEN_app_terraform_io` mechanism. State contains resource
configuration and must be encrypted, access-controlled, locked, backed up, and kept out
of pull requests. Other secure remote backends may be used only after adapting the
backend example and the repository's protected workflow.

## Bootstrap and adopt the auto-generated Pull Zones

Run these commands in a private terminal. Do not paste the API key, state, plan, or
command output containing sensitive provider data into an issue or AI conversation.

```sh
terraform fmt -check
terraform init -upgrade=false
terraform validate

# Creates only the Magic Containers application, host container, endpoints and volume.
# It deliberately does not try to create the side-effect Pull Zones as new resources.
terraform apply -target=bunnynet_compute_container_app.host

# These IDs are safe resource identifiers.
terraform output bootstrap_public_pullzone_id
terraform output bootstrap_connector_pullzone_id
```

Import the two side-effect Pull Zones by ID. The following full plan may show their
generated names changing to the stable, account-unique `public_pullzone_name` and
`connector_pullzone_name` chosen before bootstrap:

```sh
terraform import bunnynet_pullzone.public "PUBLIC_PULLZONE_ID"
terraform import bunnynet_pullzone.connector "CONNECTOR_PULLZONE_ID"
terraform plan
```

The import must be done before a normal full apply. A name collision or unexpected
replacement is a stop condition. Review the plan carefully: the two Pull Zones should
resolve to the compute-container origin endpoint IDs, `public` must have
`websockets_enabled = false`, `connector` must have it enabled, and both must show
caching, error caching, request coalescing, and origin retries disabled. If Bunny
reports drift caused by a dashboard-only setting that provider 0.18.2 cannot model, stop
and resolve it manually; do not add undocumented Terraform arguments.

## Apply and hostname/DNS setup

After the plan has been reviewed, apply from the protected default branch or an
environment-gated private terminal:

```sh
terraform apply
```

The hostname resources attach the management hostname and each exact application
hostname to the public Pull Zone, and the connector hostname only to the connector Pull
Zone. They request Bunny-managed TLS and force HTTPS. Complete the DNS validation and
certificate issuance steps in the Bunny dashboard, then test `/readyz` and
`/.well-known/bunny-hole` on the exact management hostname.

To let Bunny DNS manage records, set `dns_zone_domain` to an **existing** Bunny DNS zone
that is authoritative for every configured hostname and apply again. The module creates
only `PullZone` records with the matching Pull Zone IDs. It never creates a zone,
delegates nameservers, or overwrites an unrelated zone. Leave the variable null when DNS
is managed elsewhere and create CNAME/alias records to each Pull Zone's `*_cdn_domain`
output using that DNS provider's documented workflow.

Do not use a wildcard hostname. Bunny Hole's host routing is exact, and the connector
hostname must never be attached to the public Pull Zone. Public HTTP/WebSocket cache and
forwarding behavior still needs an external verification after any Bunny dashboard
change: `Authorization`, cookies, and `Set-Cookie` are application data, while the
connector endpoint must accept WSS and the public endpoint must not accept WebSockets.

## Updating, rollback, and destroy safety

For an update, change only `image_tag` and its matching tested `image_digest` from an
immutable ComVer release, inspect the plan, and schedule a maintenance window. The
single host instance and live FRP connection are stateful; a replacement can drop active
requests and connectors. Verify `/readyz`, `check`, reconnect, exact hostname routing,
and the pinned descriptor identity after the update. Roll back by restoring a previous
compatible tag/digest pair.

The application and Pull Zone resources have `prevent_destroy = true`. This is
intentional: a typo or an unreviewed rename must not erase the host identity, SQLite
state, or public ingress. Hostname resources are protected too. Never remove the guard
or run `terraform destroy` as part of routine rotation. If retirement is explicitly
approved, take an encrypted state backup, revoke enrollments, stop connectors, inspect
the complete destroy plan, and remove the lifecycle guard in a separate reviewed change.
DNS records are external traffic configuration and should likewise be removed only with
an explicit maintenance plan.

## Secret-safe handoff

Safe outputs include resource IDs, exact hostnames, Pull Zone CDN domains, image tag and
digest, region, URLs, and health status recorded separately by the operator. Do not
share Terraform state, plan files, provider logs, owner private material, registry
credentials, passkeys, connector configuration, session tokens, or private backend
credentials. The `deployment_handoff` output intentionally contains only IDs and public
release/topology values.

This template provisions infrastructure only. Enrollment, passkey ceremonies, route
grants, connector state, and private DNS/provider credentials remain human-controlled
steps described in [`docs/deployment.md`](../../../docs/deployment.md).
