import { parseDocument } from "npm:yaml@2.9.0";

/** A small, dependency-light policy check for the copyable Bunny deployment template. */
export interface DeploymentTemplateCheck {
  files: string[];
  failures: string[];
}

const TEMPLATE_ROOT = "templates/bunny-deployment";
const REQUIRED_FILES = [
  "AGENTS.md",
  ".github/copilot-instructions.md",
  ".github/workflows/check.yml",
  ".github/workflows/plan.yml",
  ".github/workflows/apply.yml",
  ".agents/skills/bunny-hole-setup/SKILL.md",
  "README.md",
  ".terraform-version",
  "terraform/versions.tf",
  "terraform/variables.tf",
  "terraform/main.tf",
  "terraform/outputs.tf",
  "terraform/backend.tf.example",
  "terraform/.terraform.lock.hcl",
];

const WORKFLOWS = ["check.yml", "plan.yml", "apply.yml"];
const PINNED_ACTION =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;

/**
 * Run the template policy check. `root` is injectable so the policy can be tested
 * against an isolated fixture without changing the caller's checkout.
 */
export async function checkDeploymentTemplate(
  root = Deno.cwd(),
): Promise<DeploymentTemplateCheck> {
  const template = join(root, TEMPLATE_ROOT);
  const failures: string[] = [];
  const files = await walk(template);
  const relativeFiles = new Set(files.map((file) => relative(template, file)));

  for (const required of REQUIRED_FILES) {
    if (!relativeFiles.has(required)) {
      failures.push(`${TEMPLATE_ROOT}/${required}: required template file is missing`);
    }
  }
  if (
    ![
      "terraform/tfvars.example",
      "terraform/terraform.tfvars.example",
      "terraform/deployment.auto.tfvars.json.example",
    ].some((file) => relativeFiles.has(file))
  ) {
    failures.push(`${TEMPLATE_ROOT}/terraform: an example variables file is required`);
  }

  checkForbiddenArtifacts(template, relativeFiles, failures);
  await checkTemplateText(template, files, failures);
  await checkWorkflows(template, relativeFiles, failures);
  await checkTerraform(template, relativeFiles, failures);
  checkCopilotAndSkill(template, relativeFiles, failures);

  return { files: [...relativeFiles].sort(), failures };
}

if (import.meta.main) {
  const result = await checkDeploymentTemplate();
  if (result.failures.length > 0) {
    throw new Error(`deployment template check failed:\n${result.failures.join("\n")}`);
  }
  console.log(
    `deployment template check: ${result.files.length} files and platform invariants are valid`,
  );
}

async function checkTemplateText(
  template: string,
  files: string[],
  failures: string[],
): Promise<void> {
  const textFiles = files.filter((file) => !isBinaryName(file));
  const contents = new Map<string, string>();
  for (const file of textFiles) {
    try {
      contents.set(file, await Deno.readTextFile(file));
    } catch {
      // A read failure is reported as a missing/unreadable file by the relevant check.
    }
  }

  for (const [file, text] of contents) {
    const rel = relative(template, file);
    if (containsLikelySecret(text)) {
      failures.push(`${TEMPLATE_ROOT}/${rel}: likely secret material is present`);
    }
  }

  const all = [...contents.values()].join("\n").toLowerCase();
  if (!/\bwss\b/.test(all) && !/websocket/.test(all)) {
    failures.push(
      `${TEMPLATE_ROOT}: connector WebSocket/WSS configuration is undocumented`,
    );
  }
  if (!/no[- ]?cache|disable caching|caching.*disabled/.test(all)) {
    failures.push(
      `${TEMPLATE_ROOT}: dynamic Bunny traffic must explicitly disable caching`,
    );
  }
}

export function containsLikelySecret(text: string): boolean {
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_\-]{16,}/,
    /\bBUNNYNET_API_KEY\s*[:=]\s*(?:["'][^"'$]{12,}["']|[A-Za-z0-9_\-]{16,})/,
    /\b(?:AWS_SECRET_ACCESS_KEY|REGISTRY_PASSWORD|REGISTRY_TOKEN)\s*[:=]\s*(?:["'][^"'$]{12,}["']|[A-Za-z0-9_\-]{16,})/i,
  ].some((pattern) => pattern.test(text));
}

function checkForbiddenArtifacts(
  template: string,
  relativeFiles: Set<string>,
  failures: string[],
): void {
  for (const rel of relativeFiles) {
    const segments = rel.split("/");
    const name = segments.at(-1) ?? "";
    const forbidden = segments.includes(".terraform") ||
      /(?:^|\.)terraform\.tfstate(?:\.backup)?$/.test(name) ||
      /\.tfplan$|\.plan$|^crash\.log$/.test(name) ||
      (/(?:\.tfvars|\.auto\.tfvars)$/.test(name) &&
        name !== "terraform.tfvars.example") ||
      ["coverage", "dist"].some((part) => segments.includes(part));
    if (forbidden) {
      failures.push(
        `${TEMPLATE_ROOT}/${rel}: generated, state, plan, or secret artifact is forbidden`,
      );
    }
  }
  // Keep this argument explicit: it prevents accidental removal of the artifact check
  // when the walk implementation is refactored.
  void template;
}

async function checkWorkflows(
  template: string,
  relativeFiles: Set<string>,
  failures: string[],
): Promise<void> {
  for (const name of WORKFLOWS) {
    const rel = `.github/workflows/${name}`;
    if (!relativeFiles.has(rel)) continue;
    const path = join(template, rel);
    const source = await Deno.readTextFile(path);
    const document = parseDocument(source, { uniqueKeys: true });
    for (const error of document.errors) {
      failures.push(`${TEMPLATE_ROOT}/${rel}: ${error.message}`);
    }
    inspectWorkflowActions(document.toJS(), `${TEMPLATE_ROOT}/${rel}`, failures);
    const workflow = document.toJS() as Record<string, unknown>;
    if (name === "check.yml") {
      if (/\$\{\{\s*secrets\.|\$\{\{\s*vars\.|TF_VAR_/i.test(source)) {
        failures.push(
          `${TEMPLATE_ROOT}/${rel}: check workflow must not reference secrets`,
        );
      }
    }
    if (name === "plan.yml") {
      checkProtectedWorkflow(workflow, source, rel, failures);
    }
    if (name === "apply.yml") {
      checkProtectedWorkflow(workflow, source, rel, failures);
      checkApplyWorkflow(source, rel, failures);
    }
  }
}

function inspectWorkflowActions(
  value: unknown,
  path: string,
  failures: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) inspectWorkflowActions(item, path, failures);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "uses" && typeof child === "string" && !child.startsWith("./") &&
      !PINNED_ACTION.test(child)
    ) {
      failures.push(`${path}: action reference is not commit-pinned: ${child}`);
    }
    inspectWorkflowActions(child, path, failures);
  }
}

function checkApplyWorkflow(
  source: string,
  rel: string,
  failures: string[],
): void {
  const path = `${TEMPLATE_ROOT}/${rel}`;
  if (
    !/workflow_dispatch/.test(source) || !/\b(confirm|confirmation)\b/i.test(source) ||
    !/\bAPPLY\b/.test(source)
  ) {
    failures.push(`${path}: apply workflow needs an explicit APPLY confirmation input`);
  }
  for (
    const output of [
      "bootstrap_public_pullzone_id",
      "bootstrap_connector_pullzone_id",
    ]
  ) {
    if (!source.includes(`output -raw ${output}`)) {
      failures.push(`${path}: bootstrap import must use ${output}`);
    }
  }
}

function checkProtectedWorkflow(
  workflow: Record<string, unknown>,
  source: string,
  rel: string,
  failures: string[],
): void {
  const path = `${TEMPLATE_ROOT}/${rel}`;
  const trigger = workflow.on ?? workflow["true"];
  const triggerKeys = typeof trigger === "object" && trigger !== null
    ? Object.keys(trigger as Record<string, unknown>)
    : [];
  if (!triggerKeys.includes("workflow_dispatch") || triggerKeys.length !== 1) {
    failures.push(`${path}: live workflow must be workflow_dispatch only`);
  }
  if (!/environment\s*:\s*production\b/.test(source)) {
    failures.push(
      `${path}: live workflow must use the protected production environment`,
    );
  }
  if (
    !/github\.event\.repository\.default_branch/.test(source) ||
    !/github\.ref_name/.test(source)
  ) {
    failures.push(`${path}: live workflow must guard and check out the default branch`);
  }
  if (/pull_request_target/.test(source) || /^\s*push\s*:/m.test(source)) {
    failures.push(`${path}: live workflow contains an unsafe push/PR trigger`);
  }
}

async function checkTerraform(
  template: string,
  relativeFiles: Set<string>,
  failures: string[],
): Promise<void> {
  const terraform = "terraform";
  const paths = [...relativeFiles].filter((file) => file.startsWith(`${terraform}/`));
  const source = (await Promise.all(
    paths.filter((file) => file.endsWith(".tf")).map(async (file) => {
      return await Deno.readTextFile(join(template, file));
    }),
  )).join("\n");
  const fail = (message: string) =>
    failures.push(`${TEMPLATE_ROOT}/${terraform}: ${message}`);

  if (!/required_version\s*=\s*["']\s*=\s*1\.16\.2\s*["']/.test(source)) {
    fail("Terraform 1.16.2 must be pinned");
  }
  if (
    !/source\s*=\s*["']BunnyWay\/bunnynet["']/.test(source) ||
    !/version\s*=\s*["'](?:=\s*)?0\.18\.2["']/.test(source)
  ) {
    fail("BunnyWay/bunnynet provider 0.18.2 must be pinned");
  }
  if (
    !/regions_required\s*=\s*\[\s*var\.region\s*\]/.test(source) ||
    !/regions_allowed\s*=\s*\[\s*var\.region\s*\]/.test(source) ||
    !/regions_max_allowed\s*=\s*1\b/.test(source)
  ) fail("deployment must be exactly one region");
  if (
    !/autoscaling_min\s*=\s*1\b/.test(source) ||
    !/autoscaling_max\s*=\s*1\b/.test(source)
  ) fail("deployment must be exactly one instance");
  if (
    !/image_digest\s*=/.test(source) ||
    !/sha256:(?:[0-9a-f]\{64\}|\[[0-9a-f-]+\]\{64\})/i.test(source)
  ) fail("host image must be digest-pinned with sha256 validation");
  if (!/\b8080\b/.test(source) || !/\b7000\b/.test(source)) {
    fail("container endpoints must expose ports 8080 and 7000");
  }
  if (!/\/readyz/.test(source) || !/\/healthz/.test(source)) {
    fail("readiness and liveness probes must use /readyz and /healthz");
  }
  if (!/\/var\/lib\/bunny-hole/.test(source)) {
    fail("persistent volume must mount /var/lib/bunny-hole");
  }
  if (/image_tag\s*=\s*["'](?:latest|main|master|edge)["']/i.test(source)) {
    fail("Terraform must not use mutable image tags");
  }
  if (!/\bconnector\b/i.test(source) || !/\b(?:management|public)\b/i.test(source)) {
    fail("endpoints must be separated into connector and public roles");
  }

  const connectorPullZone = extractTerraformBlock(
    source,
    'resource "bunnynet_pullzone" "connector"',
  );
  const publicPullZone = extractTerraformBlock(
    source,
    'resource "bunnynet_pullzone" "public"',
  );
  if (connectorPullZone === null || publicPullZone === null) {
    fail("connector and public CDN Pull Zones must be declared separately");
  } else {
    if (!/cache_enabled\s*=\s*false/.test(connectorPullZone)) {
      fail("connector CDN must disable caching");
    }
    if (!/cache_enabled\s*=\s*false/.test(publicPullZone)) {
      fail("public CDN must disable caching");
    }
    if (!/websockets_enabled\s*=\s*true/.test(connectorPullZone)) {
      fail("connector CDN must enable WebSockets");
    }
    if (
      !/websockets_max_connections\s*=\s*var\.connector_websocket_limit/.test(
        connectorPullZone,
      )
    ) {
      fail("connector CDN must configure an explicit bounded WebSocket limit");
    }
    if (!/websockets_enabled\s*=\s*false/.test(publicPullZone)) {
      fail("public CDN must keep WebSockets disabled");
    }
  }
}

/** Extract a Terraform block while tolerating nested blocks and quoted braces. */
function extractTerraformBlock(source: string, marker: string): string | null {
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) return null;
  const opening = source.indexOf("{", markerStart + marker.length);
  if (opening < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = opening; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      return source.slice(opening, index + 1);
    }
  }
  return null;
}

function checkCopilotAndSkill(
  template: string,
  relativeFiles: Set<string>,
  failures: string[],
): void {
  const copilot = ".github/copilot-instructions.md";
  if (relativeFiles.has(copilot)) {
    const text = Deno.readTextFileSync(join(template, copilot));
    if (!/AGENTS\.md/.test(text)) {
      failures.push(`${TEMPLATE_ROOT}/${copilot}: must point to AGENTS.md`);
    }
  }
  const skill = ".agents/skills/bunny-hole-setup/SKILL.md";
  if (relativeFiles.has(skill)) {
    const text = Deno.readTextFileSync(join(template, skill));
    if (!/AGENTS\.md/.test(text) || !/secret|credential/i.test(text)) {
      failures.push(
        `${TEMPLATE_ROOT}/${skill}: safe AGENTS/credential guidance is missing`,
      );
    }
  }
}

async function walk(path: string): Promise<string[]> {
  const result: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      // Terraform's provider cache is expected after local validation and is ignored
      // by the template. State/plan files outside it are still rejected below.
      if (entry.isDirectory && entry.name !== ".terraform") {
        result.push(...await walk(child));
      } else if (entry.isFile) result.push(child);
    }
  } catch {
    // Missing template root is represented by the required-file failures.
  }
  return result;
}

function isBinaryName(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|ico|woff2?|zip|gz|pdf)$/i.test(path);
}

function join(root: string, path: string): string {
  return `${root.replace(/\/$/, "")}/${path}`;
}

function relative(root: string, path: string): string {
  const prefix = `${root.replace(/\/$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
