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
