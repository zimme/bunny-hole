# Agent instructions

This repository declares one Bunny Hole host on Bunny Magic Containers. Read `README.md`
and `.agents/skills/bunny-hole-setup/SKILL.md` before changing or applying the
deployment.

## Safety boundaries

- Keep exactly one required/allowed region and one host instance. Do not enable Magic
  deployment, autoscaling, multiple regions, or multiple replicas.
- Deploy only an immutable released `MAJOR.MINOR.0` host image tag and matching
  `sha256:` digest. Never use `latest`, a branch, or a locally built image.
- Keep the management/public endpoint on container port 8080 and the connector endpoint
  on port 7000. Disable caching on both Pull Zones and enable WebSockets only on the
  connector Pull Zone.
- Never request, read, print, store, or handle a Bunny API key, backend credential,
  registry token, owner private key, passkey response, connector configuration,
  Kubernetes Secret, Terraform state, or binary plan. A human supplies secrets through
  protected GitHub Environments or a separate private terminal.
- Planning, applying, importing, destroying, rotating, revoking, and changing DNS or TLS
  are external mutations. Do none of them without explicit human authorization.
- AI-visible handoffs may contain only public hostnames and URLs, region, ComVer, image
  digest, resource IDs, Pull Zone IDs, enrollment IDs, verification phrases, route IDs,
  and health status.
- Do not upload Terraform state or plan files as workflow artifacts or post complete
  plans to pull-request comments.

## Validation

Use Terraform 1.16.2 and the committed provider lockfile:

```sh
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform validate -no-color
```

Pull requests run only these secret-free checks. `plan` and `apply` are manual,
default-branch workflows. They must remain protected by GitHub Environments and must
never execute pull-request code with deployment credentials.

Review every change for least privilege, accidental replacement or destruction,
provider-list ordering, secret/state leakage, mutable references, unsupported Bunny
behavior, and drift from the Bunny Hole security model.
