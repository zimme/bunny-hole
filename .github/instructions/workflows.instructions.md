---
applyTo: ".github/workflows/**/*.yml,.github/workflows/**/*.yaml,.github/actions/**/*.yml"
---

Keep third-party actions pinned to full commit SHAs and permissions least privileged.
Treat workflow inputs, event payloads, branch names, and command output as untrusted.
Quote shell variables, avoid interpolating untrusted values into `run`, preserve
protected environments and concurrency controls, and update workflow policy tests when
changing an enforced invariant.
