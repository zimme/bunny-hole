import { dirname, join } from "node:path";
import { generateKeyPair, sign } from "../../packages/api/auth.ts";
import {
  canonicalGrant,
  isRecord,
  parsePort,
  parseProtocol,
  validateGrant,
  ValidationError,
  VERSION,
} from "../../packages/api/mod.ts";
import { BunnyHoleClient, type HostCredentials } from "./client.ts";
import { frpcConfig, runFrpc } from "./frpc.ts";
import {
  defaultStatePath,
  loadState,
  loadStateOrEmpty,
  saveState,
  selectHost,
} from "./state.ts";

export const EXIT_USAGE = 64;
export const EXIT_CONFIG = 78;
export const EXIT_CONNECTION = 69;

class UsageError extends Error {}

const HELP = `Bunny Hole ${VERSION}

Usage:
  bunny-hole                         Run the first-use setup wizard
  bunny-hole host add [--name NAME] --url HTTPS_URL
  bunny-hole host list | host use NAME | host remove NAME --yes
  bunny-hole enrollment status [--host NAME]
  bunny-hole enrollment approve ID --grant FILE --owner-key FILE [--host NAME]
  bunny-hole enrollment approve ID --grant FILE --passkey [--host NAME]
  bunny-hole enrollment revoke ID --owner-key FILE [--host NAME]
  bunny-hole route add --name NAME --protocol PROTOCOL --target HOST:PORT
                        --hostname HOST
                        [--allow-private-network] [--host NAME]
  bunny-hole route list [--host NAME]
  bunny-hole route delete ID [--host NAME]
  bunny-hole connect [--host NAME] [--transport wss|quic|tcp|websocket]
  bunny-hole check [--host NAME]
  bunny-hole owner generate --output FILE
  bunny-hole owner passkey --owner-key FILE [--host NAME] [--name NAME]
  bunny-hole cluster prepare --url HTTPS_URL --name NAME --namespace NAMESPACE
                               --secret-name NAME > cluster-enrollment.yaml
  bunny-hole --version

Private keys are stored only in mode-0600 files and are never accepted as command-line
values. Production host URLs must use HTTPS. Non-loopback targets require the explicit
--allow-private-network option.
`;

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Bunny Hole failed");
    Deno.exit(
      error instanceof UsageError
        ? EXIT_USAGE
        : error instanceof ValidationError
        ? EXIT_CONFIG
        : EXIT_CONNECTION,
    );
  }
}

export async function main(args: string[]): Promise<void> {
  if (args.length === 0) return await wizard();
  if (["--help", "-h", "help"].includes(args[0])) return console.log(HELP);
  if (["--version", "-V"].includes(args[0])) {
    return console.log(`bunny-hole ${VERSION}`);
  }
  if (args[0] === "operator") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
    try {
      return await (await import("../operator/main.ts")).runOperator(
        controller.signal,
      );
    } finally {
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
    }
  }
  if (args[0] === "compose") {
    const command = args[1];
    if (!["plan", "sync", "up"].includes(command)) {
      throw new UsageError("compose command must be plan, sync, or up");
    }
    const flags = flagsFrom(args.slice(2));
    const controller = new AbortController();
    const stop = () => controller.abort();
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
    try {
      return await (await import("../compose/main.ts")).runCompose(
        command as "plan" | "sync" | "up",
        configPath(flags),
        controller.signal,
      );
    } finally {
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
    }
  }
  const [group, command, ...rest] = args;
  if (group === "host" && command === "add") return await addHost(flagsFrom(rest));
  if (group === "host" && command === "list") return await listHosts(flagsFrom(rest));
  if (group === "host" && command === "use") return await useHost(rest);
  if (group === "host" && command === "remove") return await removeHost(rest);
  if (group === "enrollment" && command === "status") {
    return await enrollmentStatus(flagsFrom(rest));
  }
  if (group === "enrollment" && command === "approve") {
    return await approveEnrollment(rest[0], flagsFrom(rest.slice(1)));
  }
  if (group === "enrollment" && command === "revoke") {
    return await revokeEnrollment(rest[0], flagsFrom(rest.slice(1)));
  }
  if (group === "route" && command === "add") return await addRoute(flagsFrom(rest));
  if (group === "route" && command === "list") return await listRoutes(flagsFrom(rest));
  if (group === "route" && command === "delete") {
    return await deleteRoute(rest[0], flagsFrom(rest.slice(1)));
  }
  if (group === "owner" && command === "generate") {
    return await generateOwner(flagsFrom(rest));
  }
  if (group === "owner" && command === "passkey") {
    return await addPasskey(flagsFrom(rest));
  }
  if (group === "cluster" && command === "prepare") {
    return await prepareCluster(flagsFrom(rest));
  }
  if (group === "connect") return await connect(flagsFrom(args.slice(1)));
  if (group === "check") return await check(flagsFrom(args.slice(1)));
  throw new UsageError("unknown command; use --help");
}

async function wizard(): Promise<void> {
  if (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal()) {
    throw new UsageError(
      "interactive setup requires a terminal; use `bunny-hole host add`",
    );
  }
  console.log("Welcome to Bunny Hole. This creates a device key for one host.\n");
  const url = prompt("Bunny Hole host URL (https://…):")?.trim();
  if (!url) throw new UsageError("host URL is required");
  const suggested = new URL(url).hostname.replaceAll(".", "-");
  const name = prompt(`Local name for this host (${suggested}):`)?.trim() || suggested;
  await addHost({ url, name });
}

async function addHost(flags: Flags): Promise<void> {
  const url = required(flags, "url");
  const alias = typeof flags.name === "string" ? flags.name : new URL(url).hostname;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(alias)) {
    throw new UsageError("invalid host name");
  }
  const client = new BunnyHoleClient(url, fetch, localDevelopment(flags));
  const descriptor = await client.descriptor();
  const state = await loadStateOrEmpty(configPath(flags));
  if (state.hosts[alias]) throw new UsageError("host already exists");
  const keys = await generateKeyPair();
  const result = await client.enroll(deviceName(), "device", keys.publicKey);
  state.hosts[alias] = {
    url: client.url.href,
    identityPublicKey: descriptor.identityPublicKey,
    enrollmentId: result.id,
    ...keys,
  };
  state.defaultHost ??= alias;
  await saveState(state, configPath(flags));
  console.log(
    `Host ${alias} saved.\nEnrollment: ${result.id}\nVerification: ${result.verificationPhrase}`,
  );
  console.log(
    "Approve this pending enrollment in the host administration flow, then run `bunny-hole connect`.",
  );
}

async function listHosts(flags: Flags): Promise<void> {
  const state = await loadState(configPath(flags));
  for (const name of Object.keys(state.hosts).sort()) {
    console.log(
      `${name === state.defaultHost ? "*" : " "} ${name}\t${state.hosts[name].url}`,
    );
  }
}

async function useHost(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith("--")) throw new UsageError("host name is required");
  const flags = flagsFrom(args.slice(1));
  const state = await loadState(configPath(flags));
  if (!state.hosts[name]) throw new UsageError("host is not configured");
  state.defaultHost = name;
  await saveState(state, configPath(flags));
}

async function removeHost(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith("--")) throw new UsageError("host name is required");
  const flags = flagsFrom(args.slice(1));
  if (flags.yes !== true) throw new UsageError("host removal requires --yes");
  const path = configPath(flags);
  const state = await loadState(path);
  if (!state.hosts[name]) throw new UsageError("host is not configured");
  delete state.hosts[name];
  if (state.defaultHost === name) {
    state.defaultHost = Object.keys(state.hosts).sort()[0];
  }
  await saveState(state, path);
}

async function enrollmentStatus(flags: Flags): Promise<void> {
  const state = await loadState(configPath(flags));
  const [name, credentials] = selectHost(state, optionalString(flags, "host"));
  const enrollment = await clientFor(credentials, flags).enrollment(
    credentials.enrollmentId,
  );
  console.log(
    JSON.stringify(
      { host: name, enrollmentId: credentials.enrollmentId, ...enrollment },
      null,
      2,
    ),
  );
}

async function approveEnrollment(id: string | undefined, flags: Flags): Promise<void> {
  if (!id) throw new UsageError("enrollment ID is required");
  const grantPath = required(flags, "grant");
  if (flags.passkey === true) {
    return await approveWithPasskey(id, grantPath, flags);
  }
  const ownerKeyPath = required(flags, "owner-key");
  await assertPrivateFile(ownerKeyPath);
  const state = await loadState(configPath(flags));
  const [, credentials] = selectHost(state, optionalString(flags, "host"));
  const grants = validateGrant(JSON.parse(await Deno.readTextFile(grantPath)));
  const ownerValue: unknown = JSON.parse(await Deno.readTextFile(ownerKeyPath));
  if (!isRecord(ownerValue) || typeof ownerValue.privateKey !== "string") {
    throw new ValidationError("invalid owner key file");
  }
  const pendingResponse = await fetch(
    new URL(`/api/v1/enrollments/${encodeURIComponent(id)}`, credentials.url),
  );
  const pending: unknown = await pendingResponse.json();
  if (
    !pendingResponse.ok || !isRecord(pending) || typeof pending.publicKey !== "string"
  ) {
    throw new ValidationError("pending enrollment is unavailable");
  }
  const challenge = await ownerChallenge(credentials.url, "approve-enrollment");
  const signature = await sign(ownerValue.privateKey, "approve-enrollment", [
    credentials.identityPublicKey,
    id,
    pending.publicKey,
    canonicalGrant(grants),
    challenge,
  ]);
  const response = await fetch(
    new URL(`/api/v1/enrollments/${encodeURIComponent(id)}/approve`, credentials.url),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bunny-hole-owner-challenge": challenge,
        "x-bunny-hole-owner-signature": signature,
      },
      body: JSON.stringify({ grants }),
    },
  );
  if (!response.ok) throw new ValidationError("enrollment approval failed");
  console.log(`Enrollment ${id} approved.`);
}

async function revokeEnrollment(id: string | undefined, flags: Flags): Promise<void> {
  if (!id) throw new UsageError("enrollment ID is required");
  const ownerKeyPath = required(flags, "owner-key");
  await assertPrivateFile(ownerKeyPath);
  const owner: unknown = JSON.parse(await Deno.readTextFile(ownerKeyPath));
  if (!isRecord(owner) || typeof owner.privateKey !== "string") {
    throw new ValidationError("invalid owner key file");
  }
  const state = await loadState(configPath(flags));
  const [, credentials] = selectHost(state, optionalString(flags, "host"));
  const challenge = await ownerChallenge(credentials.url, "revoke-enrollment");
  const response = await fetch(
    new URL(`/api/v1/enrollments/${encodeURIComponent(id)}/revoke`, credentials.url),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bunny-hole-owner-challenge": challenge,
        "x-bunny-hole-owner-signature": await sign(
          owner.privateKey,
          "revoke-enrollment",
          [credentials.identityPublicKey, id, challenge],
        ),
      },
      body: "{}",
    },
  );
  if (!response.ok) throw new ValidationError("enrollment revocation failed");
  console.log(`Enrollment ${id} revoked.`);
}

async function approveWithPasskey(
  id: string,
  grantPath: string,
  flags: Flags,
): Promise<void> {
  const state = await loadState(configPath(flags));
  const [, credentials] = selectHost(state, optionalString(flags, "host"));
  const grants = validateGrant(JSON.parse(await Deno.readTextFile(grantPath)));
  const response = await fetch(
    new URL("/api/v1/admin/enrollment-approvals", credentials.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollmentId: id, grants }),
    },
  );
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || typeof value.url !== "string") {
    throw new ValidationError("could not start passkey approval");
  }
  const url = validateCeremonyUrl(
    value.url,
    credentials.url,
    "/_bunny/admin/approve",
  );
  console.log(
    `Open this one-use URL and verify enrollment ${id} before approving:\n${url.href}`,
  );
}

function validateCeremonyUrl(value: string, hostUrl: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("host returned an invalid ceremony URL");
  }
  if (
    url.origin !== new URL(hostUrl).origin || url.pathname !== path || url.search ||
    !/^#flow_[A-Za-z0-9_-]{24}$/.test(url.hash)
  ) {
    throw new ValidationError("host returned an invalid ceremony URL");
  }
  return url;
}

async function ownerChallenge(
  hostUrl: string,
  purpose: "approve-enrollment" | "revoke-enrollment" | "create-passkey-flow",
): Promise<string> {
  const response = await fetch(new URL("/api/v1/admin/owner/challenge", hostUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose }),
  });
  const value: unknown = await response.json();
  if (
    !response.ok || !isRecord(value) ||
    typeof value.challenge !== "string" ||
    !/^[A-Za-z0-9_-]{32}$/.test(value.challenge)
  ) throw new ValidationError("could not create owner challenge");
  return value.challenge;
}

async function addRoute(flags: Flags): Promise<void> {
  const state = await loadState(configPath(flags));
  const [, credentials] = selectHost(state, optionalString(flags, "host"));
  const client = clientFor(credentials, flags);
  const session = await client.session(credentials);
  const target = parseTarget(required(flags, "target"));
  const protocol = parseProtocol(required(flags, "protocol"));
  const route = await client.createRoute(session, {
    name: required(flags, "name"),
    protocol,
    targetHost: target.host,
    targetPort: target.port,
    hostname: required(flags, "hostname"),
    allowPrivateNetwork: flags["allow-private-network"] === true,
  });
  console.log(JSON.stringify(route, null, 2));
}

async function listRoutes(flags: Flags): Promise<void> {
  const state = await loadState(configPath(flags));
  const [, credentials] = selectHost(state, optionalString(flags, "host"));
  const session = await clientFor(credentials, flags).session(credentials);
  console.log(JSON.stringify({ routes: session.routes }, null, 2));
}

async function deleteRoute(id: string | undefined, flags: Flags): Promise<void> {
  if (!id) throw new UsageError("route ID is required");
  const state = await loadState(configPath(flags));
  const [, credentials] = selectHost(state, optionalString(flags, "host"));
  const client = clientFor(credentials, flags);
  await client.deleteRoute(await client.session(credentials), id);
}

async function connect(flags: Flags): Promise<void> {
  const state = await loadState(configPath(flags));
  const [, credentials] = selectHost(state, optionalString(flags, "host"));
  const client = clientFor(credentials, flags);
  const descriptor = await client.descriptor();
  const transport = (optionalString(flags, "transport") ??
    descriptor.connectorTransports[0] ?? "wss") as
      | "quic"
      | "tcp"
      | "websocket"
      | "wss";
  if (!["quic", "tcp", "websocket", "wss"].includes(transport)) {
    throw new UsageError("invalid transport");
  }
  if (transport !== "wss" && flags["local-development"] !== true) {
    throw new UsageError("production connectors require the wss transport");
  }
  const executable = Deno.env.get("BUNNY_HOLE_FRPC_PATH") ?? siblingExecutable("frpc");
  const controller = new AbortController();
  const stop = () => controller.abort();
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  let delay = 500;
  try {
    while (!controller.signal.aborted) {
      const started = Date.now();
      try {
        const session = await client.session(credentials);
        const directory = await Deno.makeTempDir({ prefix: "bunny-hole-frpc-" });
        const code = await runFrpc({
          executable,
          session,
          transport,
          workDirectory: directory,
          signal: controller.signal,
          allowInsecureTransport: flags["local-development"] === true,
        });
        if (!controller.signal.aborted) {
          console.error(`connector stopped with code ${code}; reconnecting`);
        }
      } catch {
        if (!controller.signal.aborted) {
          console.error("connector connection failed; reconnecting");
        }
      }
      if (controller.signal.aborted) break;
      if (Date.now() - started >= 60_000) delay = 500;
      await abortableDelay(jitter(delay), controller.signal);
      delay = Math.min(delay * 2, 30_000);
    }
  } finally {
    Deno.removeSignalListener("SIGINT", stop);
    Deno.removeSignalListener("SIGTERM", stop);
  }
}

async function check(flags: Flags): Promise<void> {
  const state = await loadState(configPath(flags));
  const [name, credentials] = selectHost(state, optionalString(flags, "host"));
  const client = clientFor(credentials, flags);
  const descriptor = await client.descriptor();
  if (descriptor.identityPublicKey !== credentials.identityPublicKey) {
    throw new ValidationError("host identity changed");
  }
  await client.session(credentials);
  console.log(
    JSON.stringify(
      {
        valid: true,
        host: name,
        url: credentials.url,
        enrollmentId: credentials.enrollmentId,
      },
      null,
      2,
    ),
  );
}

async function generateOwner(flags: Flags): Promise<void> {
  const output = required(flags, "output");
  const keys = await generateKeyPair();
  await Deno.mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(output, `${JSON.stringify(keys, null, 2)}\n`, {
    createNew: true,
    mode: 0o600,
  });
  console.log(
    `Owner key written to ${output}. Configure only this public key on the host:\n${keys.publicKey}`,
  );
}

async function addPasskey(flags: Flags): Promise<void> {
  const ownerKeyPath = required(flags, "owner-key");
  await assertPrivateFile(ownerKeyPath);
  const owner: unknown = JSON.parse(await Deno.readTextFile(ownerKeyPath));
  if (!isRecord(owner) || typeof owner.privateKey !== "string") {
    throw new ValidationError("invalid owner key file");
  }
  const ownerPrivateKey = owner.privateKey;
  const state = await loadState(configPath(flags));
  const [, credentials] = selectHost(state, optionalString(flags, "host"));
  const passkeyName = optionalString(flags, "name") ?? deviceName();
  const challenge = await ownerChallenge(credentials.url, "create-passkey-flow");
  const response = await fetch(
    new URL("/api/v1/admin/passkeys/registration/flows", credentials.url),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bunny-hole-owner-challenge": challenge,
        "x-bunny-hole-owner-signature": await sign(
          ownerPrivateKey,
          "create-passkey-flow",
          [
            credentials.identityPublicKey,
            passkeyName,
            challenge,
          ],
        ),
      },
      body: JSON.stringify({ name: passkeyName }),
    },
  );
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || typeof value.url !== "string") {
    throw new ValidationError("could not start passkey registration");
  }
  const url = validateCeremonyUrl(
    value.url,
    credentials.url,
    "/_bunny/admin/passkey",
  );
  console.log(`Open this one-use URL to register the passkey:\n${url.href}`);
}

async function prepareCluster(flags: Flags): Promise<void> {
  if (Deno.stdout.isTerminal()) {
    throw new UsageError(
      "refusing to print a cluster private key to a terminal; redirect stdout to a protected file",
    );
  }
  const url = required(flags, "url");
  const name = required(flags, "name");
  const namespace = required(flags, "namespace");
  const secretName = required(flags, "secret-name");
  for (
    const [label, value] of [["name", name], ["namespace", namespace], [
      "secret name",
      secretName,
    ]]
  ) {
    if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value)) {
      throw new UsageError(`invalid ${label}`);
    }
  }
  const client = new BunnyHoleClient(url, fetch, localDevelopment(flags));
  const descriptor = await client.descriptor();
  const keys = await generateKeyPair();
  const enrollment = await client.enroll(name, "cluster", keys.publicKey);
  const credentials = JSON.stringify({
    url: client.url.href,
    identityPublicKey: descriptor.identityPublicKey,
    enrollmentId: enrollment.id,
    ...keys,
  });
  console.log(`apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${namespace}
type: Opaque
data:
  config.json: ${standardBase64(credentials)}
---
apiVersion: bunny-hole.dev/v1alpha1
kind: BunnyHoleHost
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  url: ${JSON.stringify(client.url.href)}
  transport: wss
  credentialsSecretRef:
    name: ${secretName}`);
  console.error(
    `Pending enrollment ${enrollment.id}; verification ${enrollment.verificationPhrase}. Approve it on the host before deploying the controller.`,
  );
}

type Flags = Record<string, string | boolean>;

function flagsFrom(args: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    if (!raw.startsWith("--")) continue;
    const name = raw.slice(2);
    if (["private-key", "secret", "token"].includes(name)) {
      throw new UsageError(`--${name} is forbidden`);
    }
    if (name in flags) throw new UsageError(`duplicate flag --${name}`);
    if (
      ["allow-private-network", "local-development", "passkey", "yes"].includes(name)
    ) {
      flags[name] = true;
    } else {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new UsageError(`missing value for --${name}`);
      }
      flags[name] = value;
    }
  }
  return flags;
}

function required(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== "string") throw new UsageError(`--${name} is required`);
  return value;
}

function optionalString(flags: Flags, name: string): string | undefined {
  return typeof flags[name] === "string" ? flags[name] : undefined;
}

function configPath(flags: Flags): string {
  return optionalString(flags, "config") ?? Deno.env.get("BUNNY_HOLE_CONFIG") ??
    defaultStatePath();
}

function localDevelopment(flags: Flags): boolean {
  return flags["local-development"] === true ||
    Deno.env.get("BUNNY_HOLE_LOCAL_DEVELOPMENT") === "true";
}

function clientFor(credentials: HostCredentials, flags: Flags): BunnyHoleClient {
  return new BunnyHoleClient(credentials.url, fetch, localDevelopment(flags));
}

function parseTarget(value: string): { host: string; port: number } {
  try {
    const match = value.match(/^\[([^\]]+)\]:(\d+)$|^([^:]+):(\d+)$/);
    if (!match) throw new Error();
    return {
      host: match[1] ?? match[3],
      port: parsePort(Number(match[2] ?? match[4])),
    };
  } catch {
    throw new UsageError("target must be HOST:PORT");
  }
}

function deviceName(): string {
  return Deno.env.get("HOSTNAME") ?? `${Deno.build.os}-${Deno.build.arch}`;
}

function siblingExecutable(name: string): string {
  return join(
    dirname(Deno.execPath()),
    Deno.build.os === "windows" ? `${name}.exe` : name,
  );
}

async function assertPrivateFile(path: string): Promise<void> {
  const info = await Deno.stat(path);
  if (Deno.build.os !== "windows" && (info.mode ?? 0) & 0o077) {
    throw new ValidationError(`${path} must be mode 0600`);
  }
}

function jitter(delay: number): number {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] / 0xffff_ffff;
  return Math.round(delay * (0.8 + random * 0.4));
}

function standardBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function abortableDelay(delay: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delay);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export { frpcConfig };
