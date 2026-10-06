/** GitHub OIDC and provenance inputs used by the pinned Deno and npm publishers. */
export const PUBLICATION_ENVIRONMENT = [
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_NAME",
  "GITHUB_REF",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_SERVER_URL",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_REF",
  "RUNNER_ENVIRONMENT",
] as const;

export function assertPublicationContext(
  version: string,
  get: (name: string) => string | undefined,
): void {
  for (const name of PUBLICATION_ENVIRONMENT) {
    if (!get(name)?.trim()) throw new Error(`Missing publication context: ${name}`);
  }
  const ref = `refs/tags/${version}`;
  if (
    get("GITHUB_ACTIONS") !== "true" ||
    get("RUNNER_ENVIRONMENT") !== "github-hosted" ||
    get("GITHUB_EVENT_NAME") !== "push" ||
    get("GITHUB_REF") !== ref ||
    get("GITHUB_WORKFLOW_REF") !==
      `${get("GITHUB_REPOSITORY")}/.github/workflows/release.yml@${ref}`
  ) {
    throw new Error(
      "Publication requires the tagged release workflow on a GitHub-hosted runner",
    );
  }
}

/** Never inherit the runner's entire environment or pass OIDC to validation steps. */
export function publicationStepFailures(step: Record<string, unknown>): string[] {
  if (typeof step.uses !== "string" || !step.uses.startsWith("devcontainers/ci@")) {
    return [];
  }
  const inputs = step.with as Record<string, unknown> | undefined;
  const failures: string[] = [];
  if (inputs?.inheritEnv && inputs.inheritEnv !== "false") {
    failures.push("Dev Container steps must not inherit the runner environment");
  }
  const entries = typeof inputs?.env === "string"
    ? inputs.env.trim().split(/\s*\n\s*/)
    : [];
  const publication = inputs?.runCmd === "deno task release:publish-package";
  if (!publication) {
    if (entries.some((entry) => entry.startsWith("ACTIONS_ID_TOKEN_REQUEST_"))) {
      failures.push(
        "OIDC request credentials belong only in the package publication step",
      );
    }
    return failures;
  }
  for (const name of PUBLICATION_ENVIRONMENT) {
    if (!entries.includes(name)) failures.push(`Publication must forward ${name}`);
  }
  const allowed = new Set<string>([
    ...PUBLICATION_ENVIRONMENT,
    "CI",
    "BUNNY_HOLE_ENVIRONMENT_NAME",
    "COMPOSE_PARALLEL_LIMIT",
    "RELEASE_TAG",
  ]);
  if (entries.some((entry) => !allowed.has(entry))) {
    failures.push(
      "Publication forwarding must contain only allowlisted variable names",
    );
  }
  return failures;
}
