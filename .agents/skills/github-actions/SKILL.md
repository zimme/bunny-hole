---
name: github-actions
description: Add or change GitHub Actions workflows, composite actions, or CI/CD policy under .github/.
---

# GitHub Actions and CI/CD work

Read `AGENTS.md` (Non-negotiable invariants, Safe implementation patterns) and
`scripts/workflows_check.ts`, the enforced policy check for this area, before changing
anything under `.github/workflows/` or `.github/actions/`.

Pin every third-party action to a full commit SHA, never a mutable tag or branch, and
scope `permissions:` to the minimum each job needs. Treat workflow inputs, event
payloads (`github.event.*`), branch and ref names, and any subprocess/tool output as
untrusted: never interpolate them directly into a `run:` shell block — pass them through
an `env:` variable and quote it, or use an action input, so a crafted title, branch
name, or comment cannot inject shell commands. Preserve protected environments,
`concurrency` groups, and required-check gating; do not weaken them to unblock a run.

When a change affects an invariant `scripts/workflows_check.ts` enforces (action
pinning, permissions shape, protected environments), update that check and its tests in
the same change, not just the workflow — an enforced rule with a stale test is a false
assurance. Run `deno task workflows:check` and `deno task validate` before opening a
pull request.
