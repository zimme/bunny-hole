# Consumer GitOps deployment template

[`templates/bunny-deployment`](../templates/bunny-deployment) is a complete, copyable
starting repository for operating one released Bunny Hole host. It is a GitHub
repository template, not a Bunny dashboard-catalog entry: Bunny does not currently
publish a documented repository schema that creates a complete Magic Container
application, both CDN policies, custom hostnames, TLS, and DNS from a dashboard “deploy
from repository” flow.

The template uses Terraform 1.16.2 and `BunnyWay/bunnynet` 0.18.2 because the official
provider exposes the required application, Pull Zone, hostname, managed-TLS, and Bunny
DNS resources. It consumes the already published host image; it does not rebuild this
project or grant a consumer repository permission to publish upstream artifacts.

## Declared topology

The configuration deliberately creates exactly:

- one Magic Container application in one allowed and required region;
- one running host instance with autoscaling disabled;
- one persistent volume mounted at `/var/lib/bunny-hole`;
- one port-8080 CDN endpoint for management and exact public application hostnames;
- one port-7000 CDN endpoint for connector WSS only; and
- zero wildcard hostnames, public container ports, Edge Scripts, databases, or extra
  replicas.

Both Pull Zones have dynamic caching, error caching, request coalescing, redirects, and
origin retries disabled. Only the connector zone enables WebSockets. Exact hostnames
request Bunny-managed TLS. Optional `PullZone` records may be created only in an
existing Bunny DNS zone; the template never creates a zone or changes nameservers.

## Why bootstrap has two stages

A CDN endpoint nested in `bunnynet_compute_container_app` causes Magic Containers to
create its Pull Zone. Terraform cannot declare the same zone independently before it
exists without proposing a duplicate. The protected bootstrap operation therefore:

1. target-applies only `bunnynet_compute_container_app.host`;
2. refreshes and reads the generated Pull Zone IDs from the two endpoint outputs;
3. imports them at `bunnynet_pullzone.public` and `bunnynet_pullzone.connector`; and
4. stops without applying policy changes.

The operator then runs the separate plan workflow, reviews the complete imported state
and proposed edge policy, and explicitly authorizes a fresh apply. Bootstrap is
idempotent after partial failure. Endpoint and container blocks are ordered provider
lists, so renaming or reordering them is a reviewed identity change, not routine
cleanup.

## Trust and secret boundaries

Pull requests run only backend-free formatting and validation. Live plan/bootstrap/
apply jobs run only by manual dispatch from the exact protected default branch and use a
pre-created `production` GitHub Environment. Configure required reviewers, prevent
self-review, restrict deployment branches, and disable bypass where the GitHub plan
supports it before storing credentials there.

The environment holds `BUNNYNET_API_KEY` and the example HCP Terraform token
`TF_TOKEN_APP_TERRAFORM_IO`. Current Bunny documentation describes the account API key
for API/action authentication and does not document a scoped OIDC or temporary Magic
Containers deployment credential. HCP Terraform is the example encrypted, locked
remote-state service; another secure backend is valid when its authentication and
workflow mapping are deliberately adapted.

No workflow uploads state or a saved plan, comments a plan on a pull request, runs
untrusted code with secrets, or accepts an arbitrary Git ref. Apply computes and uses a
new plan in one protected job. The public GHCR image uses Bunny's anonymous GitHub
registry connection, avoiding a registry token in Terraform state.

## Use and validate

Copy the template directory into a new repository, then follow its README. An agent may
fill public values and review changes after reading the copied `AGENTS.md` and
`bunny-hole-setup` skill. A human must enter credentials and handle private identity,
passkey, enrollment, state, plan, and connector material outside the agent conversation.

Maintainers validate the embedded template with:

```sh
deno task deployment-template:check
deno task validate
```

The first command enforces file presence, workflow pins and triggers, topology,
immutable image inputs, secret hygiene, and Terraform policy. The authoritative full
validation runs the same check in the Compose-native development environment. A real
Bunny apply remains an operator-controlled non-production acceptance test because it
requires a broad account credential, incurs cost, and mutates external infrastructure.

See [agent-assisted deployment](agent-assisted-deployment.md) for safe delegation and
[deployment](deployment.md) for connector enrollment, verification, operation, and
manual-dashboard fallback.
