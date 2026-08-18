import { normalizeHostname } from "../../packages/protocol/security.ts";
import { loadConnectorConfig, redactedConnectorConfig } from "./config.ts";
import {
  createConnector,
  generateConnectorKeyPair,
  validateConnectorOptions,
} from "./library.ts";
import { createLogger } from "../relay/logger.ts";

export const VERSION = "0.1.0";

class UsageError extends Error {}

const HELP = `Bunny Hole connector ${VERSION}

Usage:
  bunny-hole connect [options]
  bunny-hole check [options]
  bunny-hole generate [--tunnel NAME] [--hostname HOST] [options]
  bunny-hole --help
  bunny-hole --version

Options:
  --config PATH                  Read a JSON config file (must be mode 0600)
  --relay WSS_URL                Relay base URL
  --tunnel ID                    Configured tunnel ID
  --origin HTTP_URL              Local origin (default http://127.0.0.1:3000)
  --allow-private-network        Permit a non-loopback origin
  --local-development            Permit ws:// relay URLs
  --log-format json|pretty       Log format

The private key is read from BUNNY_HOLE_TUNNEL_PRIVATE_KEY or the restricted config
file. It is intentionally not accepted as a command-line argument. The generate command
writes the private connector config to stdout and the public relay record to stderr;
redirect both streams to separate files under umask 077.
`;

if (import.meta.main) {
  const [command = "--help", ...rawArgs] = Deno.args;
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    Deno.exit(0);
  }
  if (command === "--version" || command === "-V") {
    console.log(`bunny-hole ${VERSION}`);
    Deno.exit(0);
  }
  try {
    if (!["connect", "check", "generate"].includes(command)) {
      throw new UsageError("unknown command; use --help");
    }
    const flags = parseFlags(
      rawArgs,
      command === "generate"
        ? [
          "tunnel",
          "hostname",
          "relay",
          "origin",
          "allow-private-network",
          "local-development",
        ]
        : [
          "config",
          "relay",
          "tunnel",
          "origin",
          "allow-private-network",
          "local-development",
          "log-format",
        ],
    );
    if (command === "generate") {
      if (Deno.stdout.isTerminal()) {
        throw new UsageError(
          "refusing to print a private key to a terminal; redirect stdout to a mode-0600 config file",
        );
      }
      const tunnelId = typeof flags.tunnel === "string" ? flags.tunnel : "my-tunnel";
      if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(tunnelId)) {
        throw new Error("invalid tunnel ID");
      }
      const hostname = normalizeHostname(
        typeof flags.hostname === "string" ? flags.hostname : "tunnel.example.com",
      );
      const { publicKey, privateKey } = await generateConnectorKeyPair();
      const relayUrl = typeof flags.relay === "string"
        ? flags.relay
        : `wss://${
          hostname.startsWith("[") || !hostname.includes(":")
            ? hostname
            : `[${hostname}]`
        }`;
      const origin = typeof flags.origin === "string"
        ? flags.origin
        : "http://127.0.0.1:3000";
      const allowPrivateNetwork = flags["allow-private-network"] === true;
      const localDevelopment = flags["local-development"] === true;
      const validated = validateConnectorOptions({
        relayUrl,
        tunnelId,
        privateKey,
        origin,
        allowPrivateNetwork,
        localDevelopment,
      });
      console.log(JSON.stringify(
        {
          relayUrl: validated.relayUrl.href,
          tunnelId,
          privateKey,
          origin: validated.origin.href,
          allowPrivateNetwork,
          localDevelopment,
        },
        null,
        2,
      ));
      console.error(JSON.stringify(
        [{ id: tunnelId, publicKey, hostnames: [hostname] }],
        null,
        2,
      ));
      Deno.exit(0);
    }
    const config = await loadConnectorConfig(flags);
    if (command === "check") {
      console.log(JSON.stringify(
        {
          valid: true,
          config: redactedConnectorConfig(config),
        },
        null,
        2,
      ));
      Deno.exit(0);
    }
    const logger = createLogger(config.logFormat);
    logger.info("connector_starting", {
      version: VERSION,
      config: redactedConnectorConfig(config),
    });
    const connector = createConnector({ ...config, logger });
    const abort = new AbortController();
    const stop = () => {
      abort.abort();
      connector.stop();
    };
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
    try {
      await connector.run(abort.signal);
    } finally {
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "connector configuration failed",
    );
    Deno.exit(error instanceof UsageError ? 64 : 78);
  }
}

export function parseFlags(
  args: string[],
  allowed: string[],
): Record<string, string | boolean> {
  const output: Record<string, string | boolean> = {};
  const allowedNames = new Set(allowed);
  const booleanFlags = new Set(["allow-private-network", "local-development"]);
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (!item.startsWith("--")) throw new UsageError(`unexpected argument: ${item}`);
    const name = item.slice(2);
    if (name === "secret" || name === "private-key") {
      throw new UsageError(`--${name} is forbidden; use protected input`);
    }
    if (!allowedNames.has(name)) throw new UsageError(`unknown flag: --${name}`);
    if (name in output) throw new UsageError(`duplicate flag: --${name}`);
    if (booleanFlags.has(name)) {
      output[name] = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      throw new UsageError(`missing value for --${name}`);
    }
    output[name] = value;
  }
  return output;
}
