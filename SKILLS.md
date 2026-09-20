# Agent skill index

Task-specific skills live under `.agents/skills/`; `AGENTS.md` remains canonical.

- [`tunnel-protocol`](.agents/skills/tunnel-protocol/SKILL.md): control API, FRP
  profile, host, connector, routing, streaming, and security review.
- [`bunny-deployment`](.agents/skills/bunny-deployment/SKILL.md): Magic Container, CDN,
  release image, and credential-safe deployment work.
- [`repository-review`](.agents/skills/repository-review/SKILL.md): correctness,
  security, operability, maintainability, and Terraform review checklists.

Path-specific Copilot instructions under `.github/instructions/` reinforce the same
standards for TypeScript, workflows, and infrastructure files. They do not replace
`AGENTS.md` or the scoped skills.
