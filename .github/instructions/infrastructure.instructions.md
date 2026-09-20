---
applyTo: "**/*.tf,**/*.yaml,**/*.yml"
---

For infrastructure changes, preserve immutable image references, provider and runtime
locks, explicit resource ownership, least privilege, and secret boundaries. Do not
commit state, plans, credentials, generated keys, or environment-specific overlays.
Review replacement and destruction behavior and test invalid, partial, and
already-adopted states.
