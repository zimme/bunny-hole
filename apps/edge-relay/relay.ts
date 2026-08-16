import { loadRelayConfig, redactedConfig, RelayConfig } from "../relay/config.ts";
import { createLogger, Logger } from "../relay/logger.ts";
import { Relay, RelayRequestInfo, WebSocketUpgrader } from "../relay/relay.ts";
import { timingSafeEqualText } from "../../packages/protocol/auth.ts";

const DIAGNOSTIC_PATH = "/_bunny/edge/diagnostics";
const DIAGNOSTIC_HEADER = "x-bunny-hole-diagnostic-token";
const INSTANCE_HEADER = "x-bunny-hole-edge-instance";

interface RelayRuntime {
  readonly sessions: Map<string, unknown>;
  readonly pending: Map<string, unknown>;
  handle(request: Request, info?: RelayRequestInfo): Promise<Response>;
}

export interface EdgeRelayEnvironment {
  get(name: string): string | undefined;
}

export interface EdgeRelayConfig {
  relay: RelayConfig;
  diagnosticToken?: string;
}

export interface EdgeRelayOptions {
  config: EdgeRelayConfig;
  instanceId?: string;
  startedAt?: string;
  logger?: Logger;
  relay?: RelayRuntime;
  upgradeWebSocket?: WebSocketUpgrader;
}

interface EdgeWebSocketRequest extends Request {
  upgradeWebSocket(options?: {
    protocol?: string;
    idleTimeout?: number;
  }): { socket: WebSocket; response: Response };
}

export function loadEdgeRelayConfig(env: EdgeRelayEnvironment): EdgeRelayConfig {
  const values = Object.fromEntries([
    "BUNNY_HOLE_LOCAL_DEVELOPMENT",
    "BUNNY_HOLE_LOG_FORMAT",
    "BUNNY_HOLE_TUNNELS",
  ].map((name) => [name, env.get(name)]));
  const diagnosticToken = env.get("BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN");
  if (
    diagnosticToken !== undefined &&
    (diagnosticToken.length < 32 || diagnosticToken.length > 512)
  ) {
    throw new Error(
      "BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN must contain 32-512 characters",
    );
  }
  return {
    relay: loadRelayConfig(values),
    diagnosticToken,
  };
}

export function edgeWebSocketUpgrader(
  request: Request,
  protocol: string,
): { socket: WebSocket; response: Response } {
  const upgrade = (request as EdgeWebSocketRequest).upgradeWebSocket;
  if (typeof upgrade !== "function") {
    throw new Error("Bunny Edge WebSocket upgrade API is unavailable");
  }
  return upgrade.call(request, {
    protocol,
    idleTimeout: 60,
  });
}

export function createEdgeRelayHandler(
  options: EdgeRelayOptions,
): (request: Request) => Promise<Response> {
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const startedAt = options.startedAt ?? new Date().toISOString();
  const baseLogger = options.logger ?? createLogger("json");
  const logger = withInstance(baseLogger, instanceId);
  const relay = options.relay ??
    new Relay(
      options.config.relay,
      logger,
      Date.now,
      options.upgradeWebSocket ?? edgeWebSocketUpgrader,
    );
  let requestsSeen = 0;

  logger.info("edge_relay_started", {
    config: redactedConfig(options.config.relay),
    diagnosticsEnabled: options.config.diagnosticToken !== undefined,
  });

  return async (request: Request): Promise<Response> => {
    requestsSeen++;
    const url = new URL(request.url);
    if (url.pathname === DIAGNOSTIC_PATH) {
      return await diagnosticResponse(
        request,
        options.config,
        relay,
        instanceId,
        startedAt,
        requestsSeen,
      );
    }

    const response = await relay.handle(request);
    if (
      options.config.diagnosticToken === undefined ||
      url.pathname === "/_bunny/connect"
    ) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set(INSTANCE_HEADER, instanceId);
    headers.set("cache-control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

async function diagnosticResponse(
  request: Request,
  config: EdgeRelayConfig,
  relay: RelayRuntime,
  instanceId: string,
  startedAt: string,
  requestsSeen: number,
): Promise<Response> {
  if (
    request.method !== "GET" ||
    config.diagnosticToken === undefined ||
    !(await timingSafeEqualText(
      config.diagnosticToken,
      request.headers.get(DIAGNOSTIC_HEADER) ?? "",
    ))
  ) {
    return noStoreJson({ error: "tunnel request failed" }, 404);
  }
  return noStoreJson(
    {
      product: "Bunny Hole",
      mode: "edge-script-experiment",
      instanceId,
      startedAt,
      requestsSeen,
      authenticatedConnectors: relay.sessions.size,
      pendingRequests: relay.pending.size,
      configuredTunnels: config.relay.tunnels.size,
    },
    200,
    { [INSTANCE_HEADER]: instanceId },
  );
}

function noStoreJson(
  value: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function withInstance(logger: Logger, instanceId: string): Logger {
  const fields = (input: Record<string, unknown> = {}) => ({
    edgeInstanceId: instanceId,
    ...input,
  });
  return {
    info: (event, input) => logger.info(event, fields(input)),
    warn: (event, input) => logger.warn(event, fields(input)),
    error: (event, input) => logger.error(event, fields(input)),
  };
}
