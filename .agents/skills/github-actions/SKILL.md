---
name: github-actions
description: Change or review Bunny Hole GitHub Actions workflows, composite actions, and Copilot setup.
---

# GitHub Actions work

Read `AGENTS.md`, `scripts/workflows_check.ts`, and the relevant workflow or action. For
development setup, also read `docs/development.md` and `compose.yaml`.

Pin third-party actions to full commit SHAs, scope job permissions to what each job
uses, and keep PR jobs free of deployment credentials. Treat workflow inputs and event
fields as untrusted; pass dynamic values through `env:` and quote them in shell code.
Preserve protected environments and required validation gates.

The Copilot setup job must build and run the shared Dev Container with frozen Deno
dependencies installed. Reuse the pinned `devcontainers/ci` action and GHCR cache used
by CI. Its `runCmd: deno ci` installs frozen dependencies after the container starts; it
is not the validation pipeline or a command that shuts down the container. CI uses
`runCmd: deno task validate` for the full gate, explicitly forwards GitHub's `CI`
signal, and tears down its project in an `always()` step. Copilot setup leaves its
environment running for the agent. Keep `BUNNY_HOLE_ENVIRONMENT_NAME` descriptive and
`BUNNY_HOLE_DEVELOPMENT` an explicit test transport opt-in; neither is derived from
`CI`. Run `.devcontainer/initialize.sh` before `devcontainers/ci`: its separate build
phase reads Compose before Dev Container `initializeCommand` runs. Keep the toolchain
aligned with `.tool-versions`, `compose.yaml`, and the Dev Container. Check workflow
syntax and policy with `deno task workflows:check`, then run `deno task validate` in the
development service when possible.
