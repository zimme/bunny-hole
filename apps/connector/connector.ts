import {
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  Frame,
  FrameType,
  LIMITS,
  pairsToHeaders,
  parseRequestStart,
  PROTOCOL_VERSION,
  ProtocolError,
  sendFrame,
  SUBPROTOCOL,
  toWebSocketCloseCode,
} from "../../packages/protocol/mod.ts";
import { createProof } from "../../packages/protocol/auth.ts";
import { filterOriginResponseHeaders } from "../../packages/protocol/security.ts";
import { ConnectorConfig } from "./config.ts";

export interface ConnectorLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

interface OriginRequest {
  id: string;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  abort: AbortController;
  started: boolean;
  ended: boolean;
  responseDone: boolean;
  requestBytes: number;
  timeout: ReturnType<typeof setTimeout>;
}

export class Connector {
  private socket?: WebSocket;
  private requests = new Map<string, OriginRequest>();
  private authenticated = false;
  private proofSent = false;
  private stopping = false;
  private lastSeen = Date.now();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    readonly config: ConnectorConfig,
    readonly logger: ConnectorLogger,
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    let attempt = 0;
    signal?.addEventListener("abort", () => this.stop(), { once: true });
    while (!this.stopping && !signal?.aborted) {
      try {
        await this.connectOnce();
        attempt = 0;
      } catch (error) {
        if (this.stopping || signal?.aborted) break;
        this.logger.warn("connector_disconnected", {
          message: error instanceof Error ? error.message : "connection failed",
          attempt,
        });
      }
      if (this.stopping || signal?.aborted) break;
      const base = Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6));
      const jitter = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
      const delay = Math.floor(base * (0.8 + 0.4 * jitter));
      await abortableDelay(delay, signal);
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const request of this.requests.values()) this.cancelRequest(request);
    this.socket?.close(1000, "connector stopping");
  }

  private connectOnce(): Promise<void> {
    const url = new URL(this.config.relayUrl);
    url.pathname = "/_bunny/connect";
    url.search = new URLSearchParams({ id: this.config.tunnelId }).toString();
    const socket = new WebSocket(url, SUBPROTOCOL);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.authenticated = false;
    this.proofSent = false;
    this.lastSeen = Date.now();
    const completion = Promise.withResolvers<void>();
    const authTimer = setTimeout(() => {
      socket.close(toWebSocketCloseCode(1008), "authentication timeout");
      completion.reject(new Error("relay authentication timed out"));
    }, LIMITS.authenticationTimeoutMs * 2);
    socket.onopen = () =>
      this.logger.info("connector_connected", { tunnelId: this.config.tunnelId });
    socket.onmessage = (event) =>
      void this.onMessage(event).catch((error) => {
        this.logger.warn("protocol_error", {
          message: error instanceof Error ? error.message : "protocol error",
        });
        socket.close(
          toWebSocketCloseCode(
            error instanceof ProtocolError ? error.closeCode : 1011,
          ),
          "protocol error",
        );
      });
    socket.onerror = () => {
      // The close event provides the stable reconnect path.
    };
    socket.onclose = (event) => {
      clearTimeout(authTimer);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      for (const request of this.requests.values()) this.cancelRequest(request);
      this.requests.clear();
      this.authenticated = false;
      if (this.stopping) completion.resolve();
      else {
        completion.reject(
          new Error(
            event.code === 4101 ? "connector was replaced" : "relay connection closed",
          ),
        );
      }
    };
    const waitForAuth = setInterval(() => {
      if (!this.authenticated) return;
      clearInterval(waitForAuth);
      clearTimeout(authTimer);
      this.heartbeatTimer = setInterval(
        () => this.checkHeartbeat(socket),
        LIMITS.heartbeatIntervalMs,
      );
    }, 10);
    void completion.promise.then(
      () => clearInterval(waitForAuth),
      () => clearInterval(waitForAuth),
    );
    return completion.promise;
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    if (!(event.data instanceof ArrayBuffer)) {
      throw new ProtocolError("text frames are not supported", 1003);
    }
    const frame = decodeFrame(event.data);
    this.lastSeen = Date.now();
    if (!this.authenticated) {
      if (frame.type === FrameType.authenticated && this.proofSent) {
        const accepted = decodeControl(frame.payload);
        if (!isRecord(accepted) || accepted.version !== PROTOCOL_VERSION) {
          throw new ProtocolError("invalid authentication response", 1008);
        }
        this.authenticated = true;
        this.logger.info("connector_authenticated", {
          tunnelId: this.config.tunnelId,
        });
        return;
      }
      if (frame.type !== FrameType.challenge || frame.id !== "") {
        throw new ProtocolError("expected authentication challenge", 1008);
      }
      const challenge = decodeControl(frame.payload);
      if (
        !isRecord(challenge) || challenge.version !== PROTOCOL_VERSION ||
        typeof challenge.nonce !== "string"
      ) throw new ProtocolError("invalid authentication challenge", 1008);
      const proof = await createProof(
        this.config.secret,
        this.config.tunnelId,
        challenge.nonce,
        PROTOCOL_VERSION,
      );
      await this.send(encodeFrame(
        FrameType.authenticate,
        "",
        encodeControl({ version: PROTOCOL_VERSION, proof }),
      ));
      this.proofSent = true;
      return;
    }
    await this.handleFrame(frame);
  }

  private async handleFrame(frame: Frame): Promise<void> {
    if (frame.type === FrameType.authenticated) {
      throw new ProtocolError("duplicate authentication");
    }
    if (frame.type === FrameType.ping) {
      await this.send(encodeFrame(FrameType.pong, "", frame.payload));
      return;
    }
    if (frame.type === FrameType.pong) return;
    if (frame.type === FrameType.requestStart) {
      if (this.requests.has(frame.id)) throw new ProtocolError("duplicate request");
      if (this.requests.size >= LIMITS.maxConcurrentRequests) {
        await this.send(encodeFrame(FrameType.cancel, frame.id));
        return;
      }
      const start = parseRequestStart(decodeControl(frame.payload));
      const abort = new AbortController();
      const context: OriginRequest = {
        id: frame.id,
        abort,
        started: true,
        ended: false,
        responseDone: false,
        requestBytes: 0,
        timeout: setTimeout(
          () => this.timeoutRequest(frame.id),
          LIMITS.originTimeoutMs,
        ),
      };
      this.requests.set(frame.id, context);
      const bodyAllowed = !["GET", "HEAD"].includes(start.method);
      const body = bodyAllowed
        ? new ReadableStream<Uint8Array>({
          start: (controller) => context.controller = controller,
          cancel: () => abort.abort(),
        })
        : undefined;
      const target = new URL(start.path, this.config.origin);
      if (target.origin !== this.config.origin.origin) {
        throw new ProtocolError("request escaped configured origin");
      }
      void this.proxyOrigin(context, target, start.method, start.headers, body);
      return;
    }
    const context = this.requests.get(frame.id);
    if (!context) {
      this.logger.warn("unknown_relay_request", {
        requestId: frame.id,
        frameType: frame.type,
      });
      throw new ProtocolError("unknown request");
    }
    if (frame.type === FrameType.requestBody) {
      if (context.ended || !context.controller) {
        throw new ProtocolError("request body out of order");
      }
      context.requestBytes += frame.payload.length;
      if (context.requestBytes > LIMITS.maxBodyBytes) {
        throw new ProtocolError("request body exceeds limit", 1009);
      }
      context.controller.enqueue(frame.payload.slice());
      return;
    }
    if (frame.type === FrameType.requestEnd) {
      if (context.ended) throw new ProtocolError("duplicate request end");
      context.ended = true;
      context.controller?.close();
      if (context.responseDone) this.finishRequest(context);
      return;
    }
    if (frame.type === FrameType.cancel) {
      this.cancelRequest(context);
      this.requests.delete(frame.id);
      return;
    }
    throw new ProtocolError("unexpected relay frame");
  }

  private async proxyOrigin(
    context: OriginRequest,
    target: URL,
    method: string,
    headerPairs: { name: string; value: string }[],
    body?: ReadableStream<Uint8Array>,
  ): Promise<void> {
    try {
      const headers = pairsToHeaders(headerPairs);
      headers.delete("host");
      const response = await fetch(target, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: context.abort.signal,
      });
      await this.send(encodeFrame(
        FrameType.responseStart,
        context.id,
        encodeControl({
          status: response.status,
          headers: filterOriginResponseHeaders(response.headers),
        }),
      ));
      let bodyBytes = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          bodyBytes += chunk.length;
          if (bodyBytes > LIMITS.maxBodyBytes) {
            throw new ProtocolError("origin response exceeds limit", 1009);
          }
          await this.send(encodeFrame(FrameType.responseBody, context.id, chunk));
        }
      }
      await this.send(encodeFrame(FrameType.responseEnd, context.id));
    } catch (error) {
      if (!context.abort.signal.aborted) {
        this.logger.warn("origin_request_failed", {
          requestId: context.id,
          message: error instanceof Error ? error.message : "origin failed",
        });
        try {
          await this.send(encodeFrame(FrameType.cancel, context.id));
        } catch {
          // Connection close handles cleanup.
        }
      }
    } finally {
      context.responseDone = true;
      if (context.ended) this.finishRequest(context);
    }
  }

  private async send(frame: Uint8Array): Promise<void> {
    if (!this.socket) throw new ProtocolError("connection is not open", 1001);
    await sendFrame(this.socket, frame);
  }

  private timeoutRequest(id: string): void {
    const request = this.requests.get(id);
    if (!request) return;
    this.cancelRequest(request);
    this.requests.delete(id);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeFrame(FrameType.cancel, id));
    }
  }

  private cancelRequest(request: OriginRequest): void {
    clearTimeout(request.timeout);
    request.abort.abort();
    try {
      request.controller?.error(new Error("request cancelled"));
    } catch {
      // Stream may already be closed.
    }
  }

  private finishRequest(request: OriginRequest): void {
    this.cancelRequest(request);
    this.requests.delete(request.id);
  }

  private checkHeartbeat(socket: WebSocket): void {
    if (Date.now() - this.lastSeen > LIMITS.heartbeatTimeoutMs) {
      socket.close(toWebSocketCloseCode(1001), "heartbeat timeout");
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        encodeFrame(FrameType.ping, "", encodeControl({ time: Date.now() })),
      );
    }
  }
}

export function markAuthenticatedForTest(connector: Connector): void {
  (connector as unknown as { authenticated: boolean }).authenticated = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
