# Bunny Hole deployment repository

This template declares one released Bunny Hole host on Bunny Magic Containers and keeps
its configuration reviewable in Git. It is a GitHub repository template, not a Bunny
dashboard-catalog template. It references the upstream host OCI image by both an
immutable ComVer tag and matching digest; it does not rebuild Bunny Hole.

The resulting topology is deliberately fixed:

```text
public HTTPS hostname ─┐
management HTTPS host ─┼─ Bunny CDN :443 → host :8080
connector WSS hostname ┘  Bunny CDN :443 → host :7000
                                              │
                                     one region / one instance
```

Terraform provisions the application, one persistent volume, the host container, health
probes, and two CDN endpoints. Magic Containers creates a Pull Zone for each endpoint. A
protected bootstrap operation adopts those generated zones into Terraform; subsequent
plans enforce no caching on either zone, WebSockets only on the connector zone,
Bunny-managed TLS, and optional linked records in an existing Bunny DNS zone.

## 1. Create the repository

Copy this directory into a new private repository. Keep `AGENTS.md`, the setup skill,
workflows, provider lockfile, and Terraform files together. Protect `main`, require the
`Check deployment` workflow, and require pull requests for changes.

An AI agent may customize public configuration and run offline checks, but it must read
`AGENTS.md` and `.agents/skills/bunny-hole-setup/SKILL.md` first. Never paste a Bunny
API key, state/backend credential, registry token, owner private key, passkey response,
connector configuration, Kubernetes Secret, Terraform state, or binary plan into an AI
conversation.

## 2. Choose and verify a release

Select an existing Bunny Hole `MAJOR.MINOR.0` release. In a separate private terminal,
verify its provenance and record the host image digest. Generate the owner identity:

```sh
umask 077
bunny-hole owner generate --output ./bunny-hole-owner.json
```

Keep `bunny-hole-owner.json` offline. Only its printed public key belongs in Terraform.
Do not use a branch image, `latest`, or an unreviewed local build.

## 3. Configure public inputs

Copy and commit the two non-secret configuration files:

```sh
cp terraform/backend.tf.example terraform/backend.tf
cp terraform/deployment.auto.tfvars.json.example \
  terraform/deployment.auto.tfvars.json
```

Replace every `REPLACE_WITH` marker. The example backend uses an HCP Terraform workspace
in **Local execution mode** so GitHub Actions executes Terraform while HCP provides
encrypted, locked remote state. Other secure remote backends are possible, but adapt the
workflow credential mapping and retain encryption, locking, access control, and backup.
Never use local state in shared automation or GitHub caches/artifacts for state.

The deployment variables contain only public configuration: region, hostnames, owner
public key, release version/digest, connector WebSocket capacity, and optional existing
Bunny DNS zone information. External DNS remains outside this stack. Do not put any
credential in `tfvars`.

## 4. Protect the GitHub Environment

Before adding secrets, create a GitHub Environment named `production`:

- require an independent reviewer and prevent self-review;
- allow deployments only from the protected default branch;
- disable administrator bypass where your GitHub plan supports it; and
- add `BUNNYNET_API_KEY` and `TF_TOKEN_APP_TERRAFORM_IO` as environment secrets.

Enter both values through the GitHub UI or private interactive commands such as
`gh secret set --env production`; do not place their values in command arguments or an
agent-controlled terminal. Bunny currently documents the account API key as broad and
does not document a scoped/OIDC Magic Containers credential. HCP tokens should be scoped
only to this workspace.

The public GHCR Bunny Hole image uses Bunny's existing anonymous GitHub registry
connection. If the account lacks that connection, add the public GitHub registry in the
Bunny dashboard. Never model a registry PAT in Terraform: the provider would retain it
in state.

## 5. Validate without credentials

Pull requests and ordinary pushes run only backend-free checks:

```sh
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform validate -no-color
```

They receive no Bunny or backend secrets. Every action and provider is pinned. Review
the plan for exact hostnames, one region/instance, the image digest, and replacement or
destruction before authorizing a live operation.

## 6. Bootstrap once, then plan and apply

Magic Containers owns initial creation of the CDN Pull Zones, so first run **Apply
deployment** manually with `operation=bootstrap` and confirmation `BOOTSTRAP`. After the
protected-environment approval, the workflow:

1. applies only `bunnynet_compute_container_app.host` when absent;
2. reads the two generated Pull Zone IDs from safe Terraform outputs;
3. imports them as `bunnynet_pullzone.public` and `bunnynet_pullzone.connector`; and
4. stops without applying their policy changes.

Then run **Plan deployment**, inspect the complete plan, and run **Apply deployment**
with `operation=apply` and confirmation `APPLY`. Apply recomputes a fresh plan from the
protected default branch and applies it in the same job. Plans and state are never
uploaded as artifacts or posted to pull requests.

Bootstrap is idempotent after partial failure. Never rename endpoint or container blocks
casually: the Bunny provider models them as ordered lists and an endpoint rename may
replace its Pull Zone. Never use `terraform destroy` as a routine rollback.

## 7. Verify and enroll

After apply, verify the safe outputs and Bunny dashboard:

- exactly one healthy instance in the selected region;
- the released host digest and persistent `/var/lib/bunny-hole` volume;
- `/healthz` and `/readyz` return 200 through the management hostname;
- public/management traffic reaches port 8080 with caching disabled;
- connector WSS reaches port 7000 with WebSockets enabled and caching disabled;
- all configured hostnames have valid managed TLS; and
- no direct public container port or wildcard hostname exists.

In the private terminal, add the host, bootstrap at least two passkeys, approve the
device's least-privilege grant, create an exact route, and start the connector as
documented by Bunny Hole. Keep application authentication enabled.

An AI-visible handoff may include only the values defined in `safe_handoff`: public
URLs/hostnames, region, ComVer, digest, resource IDs, Pull Zone IDs, and pending manual
checks. It must never contain state or credentials.

## Operations

- Update by changing both the ComVer tag and matching digest in a pull request,
  reviewing the plan, and using the protected apply workflow. Expect the single host and
  active connector sessions to restart.
- Roll back by restoring the previously recorded compatible digest and repeating the
  same review/apply flow.
- Rotate a connector by enrolling a new key, cutting over, then revoking the old
  enrollment. The Terraform stack never manages device or owner private keys.
- To retire the deployment, revoke enrollments and back up state first. Review a
  targeted destruction plan in a private terminal; this template intentionally provides
  no automated destroy workflow.

See the upstream
[Bunny Hole deployment guide](https://github.com/zimme/bunny-hole/blob/main/docs/deployment.md)
for enrollment, connector, Kubernetes, diagnostics, cost, and application-level security
guidance.
