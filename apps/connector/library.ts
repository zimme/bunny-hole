import { ProtocolError } from "../../packages/protocol/mod.ts";
import { validateTunnelPrivateKey } from "../../packages/protocol/auth.ts";
/** Generates a new Ed25519 identity for one tunnel. */
export {
  generateTunnelKeyPair as generateConnectorKeyPair,
} from "../../packages/protocol/auth.ts";
export type { TunnelKeyPair } from "../../packages/protocol/auth.ts";
import { validateOrigin } from "../../packages/protocol/security.ts";
import {
  Connector,
  type ConnectorLogger,
  type ConnectorRuntimeConfig,
} from "./connector.ts";

/**
 * Options for a connector embedded in a Deno or Node.js application.
 *
 * `privateKey` is retained in memory for authentication. Applications must source it
 * from a secret manager or protected file and must never log this object.
 */
export interface ConnectorOptions {
  relayUrl: string | URL;
  tunnelId: string;
  privateKey: string;
  origin?: string | URL;
  allowPrivateNetwork?: boolean;
  localDevelopment?: boolean;
  logger?: ConnectorLogger;
}

/** The lifecycle surface exposed by an embedded connector. */
export interface ConnectorHandle {
  run(signal?: AbortSignal): Promise<void>;
  stop(): void;
}

/** Validates secure connector settings without opening a network connection. */
export function validateConnectorOptions(
  options: ConnectorOptions,
): ConnectorRuntimeConfig {
  const localDevelopment = options.localDevelopment ?? false;
  let relayUrl: URL;
  try {
    relayUrl = new URL(options.relayUrl);
  } catch {
    throw new ProtocolError("invalid relay URL");
  }
  if (
    !["wss:", ...(localDevelopment ? ["ws:"] : [])].includes(relayUrl.protocol) ||
    relayUrl.username || relayUrl.password || relayUrl.pathname !== "/" ||
    relayUrl.search || relayUrl.hash
  ) {
    throw new ProtocolError(
      localDevelopment
        ? "relay URL must use WSS or local-development WS and contain only an origin"
        : "relay URL must use WSS and contain only an origin",
    );
  }

  const tunnelId = options.tunnelId;
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(tunnelId)) {
    throw new ProtocolError("invalid tunnel ID");
  }
  validateTunnelPrivateKey(options.privateKey);
  const origin = validateOrigin(
    options.origin?.toString() ?? "http://127.0.0.1:3000",
    options.allowPrivateNetwork ?? false,
  );
  return { relayUrl, tunnelId, privateKey: options.privateKey, origin };
}

/**
 * Creates an embedded Bunny Hole connector.
 *
 * Calling this function performs validation only. The persistent connection starts when
 * `run()` is awaited and ends when its signal aborts or `stop()` is called.
 */
export function createConnector(options: ConnectorOptions): ConnectorHandle {
  return new Connector(
    validateConnectorOptions(options),
    options.logger ?? NULL_LOGGER,
  );
}

const NULL_LOGGER: ConnectorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
