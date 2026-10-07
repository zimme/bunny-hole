/** GitHub OIDC and provenance inputs used by the pinned Deno publisher. */
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

/** Keep registry release approval separate from live Bunny deployment credentials. */
export function workflowEnvironmentFailures(
  workflow: Record<string, unknown>,
  path: string,
): string[] {
  const jobs = workflow.jobs as Record<string, Record<string, unknown>> | undefined;
  const failures: string[] = [];
  if (path === ".github/workflows/release.yml" && !jobs?.release) {
    failures.push("Release workflow must contain its protected release job");
  }
  if (path === ".github/workflows/deploy-bunny.yml" && !jobs?.deploy) {
    failures.push("Bunny deployment workflow must contain its protected deploy job");
  }
  for (const [id, job] of Object.entries(jobs ?? {})) {
    const environment = typeof job.environment === "string"
      ? job.environment
      : (job.environment as { name?: unknown } | undefined)?.name;
    const release = path === ".github/workflows/release.yml" && id === "release";
    const deployment = path === ".github/workflows/deploy-bunny.yml" && id === "deploy";
    if (release && environment !== "Release") {
      failures.push("Release must use the protected Release environment");
    }
    if (deployment && environment !== "Bunny") {
      failures.push(
        "Bunny deployment must use its separate protected Bunny environment",
      );
    }
    if (
      !release && typeof environment === "string" &&
      environment.toLowerCase() === "release"
    ) {
      failures.push("Only the release job may use the Release environment");
    }
    if (
      !deployment && typeof environment === "string" &&
      environment.toLowerCase() === "bunny"
    ) {
      failures.push("Only the deployment job may use the Bunny environment");
    }
  }
  return failures;
}

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
