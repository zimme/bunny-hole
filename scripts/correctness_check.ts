/** Mutation witnesses ensure the security tests actually detect weakened controls. */
const mutations = [
  {
    source: "compose.yaml",
    before: "      GIT_CONFIG_VALUE_1: /workspaces/bunny-hole",
    after: '      GIT_CONFIG_VALUE_1: "*"',
    test: "tests/development_git_test.ts",
    witness:
      "development Git configuration trusts only the mounted checkout and disables host fsmonitor",
  },
  {
    source: "scripts/publication_context.ts",
    before: 'environment.toLowerCase() === "bunny"',
    after: "false",
    test: "tests/publication_context_test.ts",
    witness:
      "release forwarding supplies publisher context without exposing runner credentials elsewhere",
  },
  {
    source: ".github/workflows/release.yml",
    before: "    environment: Release",
    after: "    environment: unprotected",
    test: "tests/publication_context_test.ts",
    witness:
      "release forwarding supplies publisher context without exposing runner credentials elsewhere",
  },
  {
    source: ".github/workflows/deploy-bunny.yml",
    before: "    environment: Bunny",
    after: "    environment: release",
    test: "tests/publication_context_test.ts",
    witness:
      "release forwarding supplies publisher context without exposing runner credentials elsewhere",
  },
  {
    source: "deno.json",
    before:
      "--allow-net=jsr.io --allow-read=. --allow-run=deno scripts/publish_package.ts",
    after:
      "--allow-net=jsr.io,registry.npmjs.org --allow-read=.,/tmp --allow-write=dist,/tmp --allow-run=deno,git,npm,tar scripts/publish_package.ts",
    test: "tests/publication_context_test.ts",
    witness:
      "release forwarding supplies publisher context without exposing runner credentials elsewhere",
  },
  {
    source: "scripts/publish_package.ts",
    before: "  assertPublicationContext(version, get);",
    after: "",
    test: "tests/publication_context_test.ts",
    witness:
      "publisher validates identity, releases registry bodies and publishes only missing JSR versions",
  },
  {
    source: ".devcontainer/docker-engine.sh",
    before: "if (first <= end && start <= last) blocked[candidate] = 1",
    after: "if (0) blocked[candidate] = 1",
    test: "tests/docker_engine_test.ts",
    witness:
      "nested Docker selects disjoint bridges and fails before startup on invalid or exhausted routes",
  },
  {
    source: ".github/workflows/release.yml",
    before: "            ACTIONS_ID_TOKEN_REQUEST_TOKEN\n",
    after: "",
    test: "tests/publication_context_test.ts",
    witness:
      "release forwarding supplies publisher context without exposing runner credentials elsewhere",
  },
  {
    source: "templates/bunny-deployment/scripts/setup.sh",
    before: 'cat "$destination.example" > "$temporary"',
    after: 'cat "$destination.example" > "$destination"',
    test: "tests/deployment_scaffold_test.ts",
    witness: "deployment workflow guards reject unsafe effects offline",
  },
  {
    source: "templates/bunny-deployment/scripts/deployment.sh",
    before: 'test "$actual_plan_sha256" = "$REVIEWED_PLAN_SHA256" || {',
    after: 'test "0" = "0" || {',
    test: "tests/deployment_scaffold_test.ts",
    witness: "deployment workflow guards reject unsafe effects offline",
  },
  {
    source: "apps/compose/docker.ts",
    before: 'labels["com.docker.compose.project"] !== project',
    after: "false",
    test: "tests/compose_service_test.ts",
    witness:
      "Compose service discovery is project-scoped, opt-in, bounded and replica-consistent",
  },
  {
    source: "apps/host/store.ts",
    before: "(OLD.status='revoked' AND NEW.status!='revoked')",
    after: "(0)",
    test: "tests/enrollment_invariants_test.ts",
    witness:
      "enrollment invariants: SQLite rejects impossible states and revoked resurrection",
  },
  {
    source: "apps/connector/supervisor.ts",
    before: "  stopped: {\n    start: null,",
    after: '  stopped: {\n    start: "authenticating",',
    test: "tests/hardening_test.ts",
    witness:
      "hardening: connector transition table rejects every illegal state event pair",
  },
  {
    source: "apps/connector/origin_bridge.ts",
    before: "rejectUnauthorized: true",
    after: "rejectUnauthorized: false",
    test: "tests/origin_bridge_test.ts",
    witness: "HTTPS origins verify certificate trust and hostname while streaming",
  },
  {
    source: "apps/operator/main.ts",
    before: "if (namespace !== credentialsNamespace) continue;",
    after: "if (false) continue;",
    test: "tests/hardening_test.ts",
    witness:
      "hardening: Gateway attachment and host delegation use separate boundaries",
  },
  {
    source: "apps/operator/model.ts",
    before: '"Gateway",\n        "bunny-hole.dev",',
    after: '"HTTPRoute",\n        "bunny-hole.dev",',
    test: "tests/hardening_test.ts",
    witness:
      "hardening: Gateway attachment and host delegation use separate boundaries",
  },
  {
    source: "apps/host/host.ts",
    before: "for (const request of this.#controlRequests) request.abort();",
    after: "for (const request of this.#controlRequests) void request;",
    test: "tests/host_boundary_test.ts",
    witness:
      "host bounds simultaneous control uploads and cancels every reader on shutdown",
  },
  {
    source: "apps/host/host.ts",
    before:
      'await this.requireOwnerProof(request, "revoke-passkey", [passkeyPath[1]]);',
    after: "void request;",
    test: "tests/hardening_test.ts",
    witness:
      "hardening: owner proof revokes passkeys and removes only revoked enrollments",
  },
  {
    source: "apps/connector/library.ts",
    before: 'if (child?.pid) killProcess(child.pid, "SIGKILL");',
    after: 'if (child?.pid) child.kill("SIGKILL"); void killProcess;',
    test: "tests/library_boundary_test.ts",
    witness:
      "library cleans profiles after spawn failure, unexpected exit and cancellation",
  },
];

async function copy(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    if (
      [".git", ".env", ".tmp", "node_modules", "dist", "coverage"].includes(entry.name)
    ) continue;
    if (entry.isDirectory) {
      await copy(`${source}/${entry.name}`, `${destination}/${entry.name}`);
    } else if (entry.isFile) {
      await Deno.copyFile(`${source}/${entry.name}`, `${destination}/${entry.name}`);
    }
  }
}

for (const mutation of mutations) {
  const source = await Deno.readTextFile(mutation.source);
  if (source.split(mutation.before).length !== 2) {
    throw new Error(
      `Update mutation witness for ${mutation.source}; expected exactly one boundary`,
    );
  }
  const directory = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "bunny-hole-mutation-",
  });
  try {
    await copy(".", directory);
    await Deno.writeTextFile(
      `${directory}/${mutation.source}`,
      source.replace(mutation.before, mutation.after),
    );
    const result = await new Deno.Command("deno", {
      args: [
        "test",
        "--cached-only",
        "--allow-env",
        "--allow-net",
        "--allow-read",
        "--allow-run",
        "--allow-write",
        "--filter",
        mutation.witness,
        mutation.test,
      ],
      cwd: directory,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(result.stdout);
    if (result.success || !output.includes("1 failed")) {
      throw new Error(
        `Security test did not reject mutation of ${mutation.source}; fix the behavior test or update the witness`,
      );
    }
    console.log(`mutation rejected: ${mutation.source}`);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
