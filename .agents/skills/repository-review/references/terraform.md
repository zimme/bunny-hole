# Terraform review checklist

- Pin Terraform and provider versions and keep the lock file updated.
- Validate variable types, ranges, formats, and cross-variable invariants.
- Treat state and plans as sensitive; never upload them as ordinary artifacts.
- Use `prevent_destroy`, adoption guards, and explicit confirmation for replacement or
  destruction of externally generated resources.
- Bind plan and apply inputs to the reviewed revision, and document any remaining race
  window in operational guidance.
- Test bootstrap, already-adopted, invalid-marker, and partial-failure paths.
