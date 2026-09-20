---
name: repository-review
description: Review changes for correctness, security, operability, and maintainability.
---

# Repository review

Use this checklist when reviewing a change:

1. Identify the behavioral contract and trust boundaries affected.
2. Trace success, failure, retry, timeout, cancellation, and partial-failure paths.
3. Check that inputs and external responses are validated before use and that errors are
   visible, actionable, and appropriately redacted.
4. Inspect concurrency, idempotency, state transitions, rollback behavior, and
   destructive operations.
5. Verify tests cover changed behavior, including negative and boundary cases; add
   regression coverage for confirmed bugs.
6. Run formatting, linting, targeted tests, and the repository validation task.
7. Report concrete findings with file/line references and severity. Do not report
   speculative style preferences as defects.

Prefer a small, local fix over a refactor unless the current structure makes the safe
behavior impossible to express.
