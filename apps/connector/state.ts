import { dirname, join } from "node:path";
import { type HostCredentials, parseHostCredentials } from "./client.ts";
import { isRecord, ValidationError } from "../../packages/api/mod.ts";

export interface ConnectorState {
  version: 1;
  defaultHost?: string;
  hosts: Record<string, HostCredentials>;
}

export function defaultStatePath(env = Deno.env.toObject()): string {
  const configHome = env.XDG_CONFIG_HOME ??
    (env.HOME ? join(env.HOME, ".config") : undefined);
  if (!configHome) {
    throw new ValidationError("cannot determine configuration directory");
  }
  return join(configHome, "bunny-hole", "config.json");
}

export async function loadState(path = defaultStatePath()): Promise<ConnectorState> {
  const info = await Deno.stat(path);
  if (Deno.build.os !== "windows" && (info.mode ?? 0) & 0o077) {
    throw new ValidationError(
      "connector config must not be accessible by group or others",
    );
  }
  const value: unknown = JSON.parse(await Deno.readTextFile(path));
  if (
    !isRecord(value) || value.version !== 1 || !isRecord(value.hosts) ||
    Object.keys(value.hosts).length > 64
  ) {
    throw new ValidationError("invalid connector config");
  }
  const hosts: Record<string, HostCredentials> = {};
  for (const [name, raw] of Object.entries(value.hosts)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || !isRecord(raw)) {
      throw new ValidationError("invalid connector config");
    }
    try {
      hosts[name] = parseHostCredentials(raw);
    } catch {
      throw new ValidationError("invalid connector config");
    }
  }
  const defaultHost = value.defaultHost;
  if (
    defaultHost !== undefined &&
    (typeof defaultHost !== "string" || !hosts[defaultHost])
  ) throw new ValidationError("invalid default host");
  return { version: 1, defaultHost, hosts };
}

export async function loadStateOrEmpty(
  path = defaultStatePath(),
): Promise<ConnectorState> {
  try {
    return await loadState(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { version: 1, hosts: {} };
    throw error;
  }
}

export async function saveState(
  state: ConnectorState,
  path = defaultStatePath(),
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.new`;
  try {
    await Deno.writeTextFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      createNew: true,
      mode: 0o600,
    });
    if (Deno.build.os === "windows") {
      try {
        await Deno.remove(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    await Deno.rename(temporary, path);
  } finally {
    await Deno.remove(temporary).catch(() => {});
  }
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
}

export function selectHost(
  state: ConnectorState,
  name?: string,
): [string, HostCredentials] {
  const selected = name ?? state.defaultHost;
  if (!selected || !state.hosts[selected]) {
    throw new ValidationError("host is not configured");
  }
  return [selected, state.hosts[selected]];
}
