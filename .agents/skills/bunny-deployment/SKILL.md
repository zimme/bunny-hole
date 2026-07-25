---
name: bunny-deployment
description: Work on Bunny Magic Container, CDN, release image, and credential-safe deployment configuration.
---

# Bunny deployment work

Read `AGENTS.md`, `docs/architecture.md`, and `docs/deployment.md`. Recheck current
official Bunny and GitHub documentation before changing platform claims or APIs.

Keep releases tag-only and immutable. Pin actions to stable releases; never use a
mutable branch action. Never expose deployment secrets to pull requests or coding
agents. Pause for human-only dashboard and private-terminal steps and resume only from
non-sensitive IDs, hostnames, image digests, and health status.

Do not enable multiple regions or relay replicas. Verify production containers are
non-root, health endpoints match probe roles, dynamic traffic is not cached, and the
deployed image is one already tested and published by the release workflow.
