# Development

Deno 2.9.3 is the only task runner. Node 24.13.1 and npm are present inside the Dev
Container solely for the Dev Container CLI, GitHub Copilot CLI, and agent tooling. There
is no `package.json` and no npm wrapper script.

From the host:

```sh
deno task devcontainer:up
deno task devcontainer:exec -- deno task validate
deno task devcontainer:down
```

Inside the Dev Container:

```sh
deno task setup
deno task validate
deno task integration
```

Focused tasks include `fmt`, `lint`, `check`, `test`, `coverage`, `integration`,
`build`, `audit`, and `container:smoke`. `deno task validate` is authoritative and is
the exact command CI invokes with `CI=true`.

## Cache design

The Dev Container image copies `deno.json` and `deno.lock` before source and runs
`deno ci`, so dependency changes invalidate that layer while source edits do not.
`/deno-dir` is a named volume owned by `vscode` for repeated local runs. CI pulls the
GHCR Dev Container prebuild as the primary toolchain/dependency cache. Production
BuildKit caching reuses compiler and source-independent layers.

There is no GitHub Actions dependency cache: local Docker volumes cannot be shared with
hosted runners, and an additional cache would duplicate image layers. npm caching is
absent because there is no npm lockfile.
