export {
  type ConnectorHandle,
  type ConnectorOptions,
  createConnector,
  generateConnectorKeyPair,
} from "./library.ts";
export type { TunnelKeyPair } from "../../packages/protocol/auth.ts";
export type { ConnectorLogger } from "./connector.ts";

/** Bunny Hole library version. */
export const VERSION = "0.1.0";
