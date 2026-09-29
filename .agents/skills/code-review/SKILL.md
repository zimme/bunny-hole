---
name: code-review
description: Review Bunny Hole pull requests with GitHub Copilot code review for concrete correctness, security, and operability defects.
---

# Code review

Read `AGENTS.md`, the diff, and the contracts for the changed area. Verify behavior
against code and tests rather than relying on the pull request description. For
trust-boundary changes, read `docs/architecture.md`, `docs/protocol.md`, and
`docs/threat-model.md`. Use the protocol or deployment skill when that area is involved.

Trace changed success, failure, timeout, cancellation, retry, and cleanup paths. Check
exact-host routing, authorization, state transitions, secret handling, and streaming
behavior where relevant. For deployment or workflow changes, verify pinned inputs,
protected environments, credential boundaries, and whether a failure leaves the system
in a safe state.

Report actionable findings with file and line references and explain their impact. Run
focused checks for the changed behavior when feasible, and state what could not be
verified. Avoid speculative style comments.
