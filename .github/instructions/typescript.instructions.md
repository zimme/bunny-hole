---
applyTo: "**/*.ts"
---

Use the repository's Deno configuration and existing typed helpers. Keep permissions
explicit, validate external data before use, preserve cancellation and timeout behavior,
and avoid broad catches, unchecked casts, ambient global state, and success-shaped
fallbacks. Add focused negative tests for changes to authentication, routing,
persistence, process supervision, or streaming.

`deno lint` and `deno fmt` (see `deno.json`) are the enforced source of truth for
formatting and baseline lint rules; do not restate their rules here or fight them with
inline suppressions. Beyond what they enforce mechanically, follow the idioms already
established in `packages/api` and `apps/*`:

- Treat external input (network, env, filesystem, subprocess output) as `unknown` and
  narrow it with an explicit parser (see `packages/api/auth.ts`,
  `packages/api/mod.ts#parseId`), never an unchecked cast (`as T`).
- Model domain failures as named `Error` subclasses (see `ValidationError` in
  `packages/api/mod.ts`) instead of throwing strings or plain objects, so callers can
  discriminate failure kinds.
- Thread `AbortSignal`/`AbortController` through anything that starts a stream, timer,
  or subprocess, and confirm cancellation actually stops the underlying work — don't
  just stop awaiting it.
- Request the narrowest `--allow-*` permission scope a script or task needs (see the
  per-task flags in `deno.json`); widening a permission is a reviewable change, not an
  incidental one.
