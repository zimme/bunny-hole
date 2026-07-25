# Contributing

Thank you for improving Bunny Hole. Discuss major protocol or trust-boundary changes in
an issue first. Follow [AGENTS.md](AGENTS.md), use Conventional Commits, add behavior
tests, and run:

```sh
deno task devcontainer:up
deno task devcontainer:exec -- deno task validate
deno task devcontainer:down
```

Pull requests must explain security impact, tests, documentation changes, and any
compatibility effect. Never include real tunnel records, credentials, customer
hostnames, or logs containing viewer data. By contributing, you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md) and license your contribution under MIT.

## Compatibility Versioning

Bunny Hole uses [ComVer](docs/versioning.md), always in `MAJOR.MINOR.0` form:

- mark every breaking change with `!` in its Conventional Commit subject or a
  `BREAKING CHANGE:` footer;
- use a major version bump for any breaking change, including a bug fix whose remedy
  breaks compatibility; and
- use a minor version bump for every non-breaking release, including ordinary fixes.

Patch versions other than zero are invalid.
