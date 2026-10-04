## Summary

## Security and compatibility impact

## Validation

For protocol, authorization, persistence, or lifecycle changes, identify the invariant
and link the behavior tests for applicable input, identity, time, lifecycle,
concurrency, partial-effect, and exposure cases. Explain inapplicable cases using an
enforced invariant. Security changes must maintain a mutation witness.

- [ ] `deno task validate`
- [ ] Documentation updated
- [ ] No secrets, live hostnames, or customer data included
