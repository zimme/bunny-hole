import { createSecret } from "../../packages/protocol/auth.ts";
import { normalizeHostname } from "../../packages/protocol/security.ts";
import { loadConnectorConfig, redactedConnectorConfig } from "./config.ts";
import { Connector } from "./connector.ts";
import { createLogger } from "../relay/logger.ts";

export const VERSION = "0.1.0";

const HELP = `Bunny Hole connector ${VERSION}

Usage:
  bunny-hole connect [options]
  bunny-hole check [options]
  bunny-hole generate [--tunnel NAME] [--hostname HOST]
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

The secret is read from BUNNY_HOLE_TUNNEL_SECRET or the restricted config file.
It is intentionally not accepted as a command-line argument.
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
    const flags = parseFlags(rawArgs);
    if (command === "generate") {
      const tunnelId = typeof flags.tunnel === "string" ? flags.tunnel : "my-tunnel";
      if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(tunnelId)) {
        throw new Error("invalid tunnel ID");
      }
      const hostname = normalizeHostname(
        typeof flags.hostname === "string" ? flags.hostname : "tunnel.example.com",
      );
      console.log(JSON.stringify(
        {
          id: tunnelId,
          secret: createSecret(),
          hostnames: [hostname],
        },
        null,
        2,
      ));
      console.error(
        "Store this output in a mode-0600 file or secret manager. It will not be shown again.",
      );
      Deno.exit(0);
    }
    if (command !== "connect" && command !== "check") {
      console.error("unknown command; use --help");
      Deno.exit(64);
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
    const connector = new Connector(config, logger);
    const abort = new AbortController();
    const stop = () => {
      abort.abort();
      connector.stop();
    };
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
    await connector.run(abort.signal);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "connector configuration failed",
    );
    Deno.exit(78);
  }
}

export function parseFlags(args: string[]): Record<string, string | boolean> {
  const output: Record<string, string | boolean> = {};
  const booleanFlags = new Set(["allow-private-network", "local-development"]);
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const name = item.slice(2);
    if (name === "secret") {
      throw new Error("--secret is forbidden; use protected input");
    }
    if (booleanFlags.has(name)) {
      output[name] = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    output[name] = value;
  }
  return output;
}
