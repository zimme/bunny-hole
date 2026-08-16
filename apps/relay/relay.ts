import {
  createCorrelationId,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  FrameType,
  LIMITS,
  pairsToHeaders,
  parseResponseStart,
  PROTOCOL_VERSION,
  ProtocolError,
  sendFrame,
  SUBPROTOCOL,
  toWebSocketCloseCode,
} from "../../packages/protocol/mod.ts";
import {
  createNonce,
  createSecret,
  verifyProof,
} from "../../packages/protocol/auth.ts";
import {
  filterPublicRequestHeaders,
  normalizeHostname,
} from "../../packages/protocol/security.ts";
import { Logger } from "./logger.ts";
import { RelayConfig } from "./config.ts";

interface ConnectorSession {
  tunnelId: string;
  socket: WebSocket;
  authenticated: boolean;
  nonce: string;
  lastSeen: number;
  requests: Set<string>;
  authTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  heartbeatSending: boolean;
  messageQueue: Promise<void>;
  closed: boolean;
  cancelled: Map<string, CancelledRequest>;
}

interface CancelledRequest {
  responseStarted: boolean;
  bodyBytes: number;
  expiresAt: number;
}

interface PendingRequest {
  id: string;
  tunnelId: string;
  response: PromiseWithResolvers<Response>;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  responseStarted: boolean;
  bodyBytes: number;
  timer: ReturnType<typeof setTimeout>;
  sendAbort: AbortController;
}

export interface RelayRequestInfo {
  completed?: Promise<unknown>;
  remoteAddress?: string;
  remoteAddr?: { hostname?: string };
}

export type WebSocketUpgrader = (
  request: Request,
  protocol: string,
) => { socket: WebSocket; response: Response };

export class Relay {
  readonly sessions = new Map<string, ConnectorSession>();
  readonly pending = new Map<string, PendingRequest>();
  private readonly connecting = new Set<ConnectorSession>();
  private accepting = true;

  constructor(
    readonly config: RelayConfig,
    readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly upgradeWebSocket: WebSocketUpgrader = defaultWebSocketUpgrader,
  ) {}

  async handle(request: Request, info?: RelayRequestInfo): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json(
        { status: this.accepting ? "ok" : "shutting_down" },
        200,
        { "cache-control": "no-store" },
      );
    }
    if (url.pathname === "/readyz") {
      return json(
        { status: this.accepting ? "ready" : "not_ready" },
        this.accepting ? 200 : 503,
        { "cache-control": "no-store" },
      );
    }
    if (url.pathname === "/_bunny/connect") {
      return this.handleConnector(request, url);
    }
    if (!this.accepting) return publicError(503);
    return await this.handlePublic(request, info);
  }

  shutdown(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const session of [...this.connecting]) {
      session.socket.close(toWebSocketCloseCode(1001), "relay shutting down");
      this.cleanupSession(session, 503);
    }
    for (const session of this.sessions.values()) {
      session.socket.close(toWebSocketCloseCode(1001), "relay shutting down");
      this.cleanupSession(session, 503);
    }
    for (const pending of this.pending.values()) this.failPending(pending, 503);
    this.logger.info("relay_shutdown");
  }

  private handleConnector(request: Request, url: URL): Response {
    if (!this.accepting) return publicError(503);
    if (this.connecting.size >= LIMITS.maxPendingAuthentications) {
      return publicError(503);
    }
    if (request.method !== "GET") return publicError(405);
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      !request.headers.get("sec-websocket-protocol")?.split(",").map((x) => x.trim())
        .includes(SUBPROTOCOL)
    ) return publicError(400);
    if (
      !this.config.localDevelopment &&
      request.headers.get("x-forwarded-proto") !== "https" &&
      new URL(request.url).protocol !== "https:"
    ) return publicError(400);
    const tunnelId = url.searchParams.get("id") ?? "";
    if (
      url.searchParams.size !== 1 ||
      !/^[a-z0-9][a-z0-9-]{2,62}$/.test(tunnelId)
    ) return publicError(400);
    const tunnel = this.config.tunnels.get(tunnelId);
    // Generate the per-connection decoy on every syntactically valid attempt so known
    // and unknown tunnel IDs perform the same random-key work before upgrading.
    const decoySecret = createSecret();
    const authenticationSecret = tunnel?.secret ?? decoySecret;

    let upgraded: { socket: WebSocket; response: Response };
    try {
      upgraded = this.upgradeWebSocket(request, SUBPROTOCOL);
    } catch {
      return publicError(400);
    }
    const { socket } = upgraded;
    socket.binaryType = "arraybuffer";
    const session: ConnectorSession = {
      tunnelId,
      socket,
      authenticated: false,
      nonce: createNonce(),
      lastSeen: this.now(),
      requests: new Set(),
      heartbeatSending: false,
      messageQueue: Promise.resolve(),
      closed: false,
      cancelled: new Map(),
    };
    this.connecting.add(session);
    session.authTimer = setTimeout(
      () => {
        socket.close(toWebSocketCloseCode(1008), "authentication timeout");
        this.cleanupSession(session, 502);
      },
      LIMITS.authenticationTimeoutMs,
    );
    socket.onopen = () => {
      if (session.closed) return;
      socket.send(encodeFrame(
        FrameType.challenge,
        "",
        encodeControl({ nonce: session.nonce, version: PROTOCOL_VERSION }),
      ));
    };
    socket.onmessage = (event) => {
      session.messageQueue = session.messageQueue.then(async () => {
        if (!session.closed) {
          await this.onConnectorMessage(session, authenticationSecret, event);
        }
      });
    };
    socket.onerror = () => this.logger.warn("connector_socket_error", { tunnelId });
    socket.onclose = () => {
      session.closed = true;
      void session.messageQueue.finally(() => this.cleanupSession(session, 502));
    };
    return upgraded.response;
  }

  private async onConnectorMessage(
    session: ConnectorSession,
    secret: string,
    event: MessageEvent,
  ): Promise<void> {
    try {
      if (!(event.data instanceof ArrayBuffer)) {
        throw new ProtocolError("text frames are not supported", 1003);
      }
      const frame = decodeFrame(event.data);
      session.lastSeen = this.now();
      if (!session.authenticated) {
        if (frame.type !== FrameType.authenticate || frame.id !== "") {
          throw new ProtocolError("authentication required", 1008);
        }
        const control = decodeControl(frame.payload);
        const validProof = isRecord(control) &&
          control.version === PROTOCOL_VERSION &&
          typeof control.proof === "string" &&
          await verifyProof(
            secret,
            session.tunnelId,
            session.nonce,
            PROTOCOL_VERSION,
            control.proof,
          );
        if (session.closed) return;
        if (!validProof) throw new ProtocolError("authentication failed", 1008);
        clearTimeout(session.authTimer);
        session.authenticated = true;
        this.connecting.delete(session);
        const replaced = this.sessions.get(session.tunnelId);
        if (replaced && replaced !== session) {
          replaced.socket.close(4101, "connector replaced");
          this.cleanupSession(replaced, 503);
        }
        this.sessions.set(session.tunnelId, session);
        await sendFrame(
          session.socket,
          encodeFrame(
            FrameType.authenticated,
            "",
            encodeControl({ version: PROTOCOL_VERSION }),
          ),
        );
        if (session.closed) return;
        session.heartbeatTimer = setInterval(
          () => this.heartbeat(session),
          LIMITS.heartbeatIntervalMs,
        );
        this.logger.info("connector_authenticated", { tunnelId: session.tunnelId });
        return;
      }
      await this.handleAuthenticatedFrame(session, frame);
    } catch (error) {
      const protocolError = error instanceof ProtocolError
        ? error
        : new ProtocolError("internal protocol error", 1011);
      this.logger.warn("protocol_error", {
        tunnelId: session.tunnelId,
        message: protocolError.message,
      });
      session.socket.close(
        toWebSocketCloseCode(protocolError.closeCode),
        "protocol error",
      );
      this.cleanupSession(session, 502);
    }
  }

  private async handleAuthenticatedFrame(
    session: ConnectorSession,
    frame: ReturnType<typeof decodeFrame>,
  ): Promise<void> {
    if (frame.type === FrameType.ping) {
      await sendFrame(session.socket, encodeFrame(FrameType.pong, "", frame.payload));
      return;
    }
    if (frame.type === FrameType.pong) return;
    const pending = this.pending.get(frame.id);
    if (!pending || pending.tunnelId !== session.tunnelId) {
      if (this.handleCancelledFrame(session, frame)) return;
      this.logger.warn("unknown_connector_request", {
        tunnelId: session.tunnelId,
        requestId: frame.id,
        frameType: frame.type,
      });
      throw new ProtocolError("unknown request");
    }
    if (frame.type === FrameType.responseStart) {
      if (pending.responseStarted) throw new ProtocolError("duplicate response start");
      const start = parseResponseStart(decodeControl(frame.payload));
      pending.responseStarted = true;
      const headers = pairsToHeaders(start.headers);
      headers.set("cache-control", "no-store");
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => pending.controller = controller,
        cancel: () => this.cancelPending(pending),
      });
      pending.response.resolve(
        new Response(requestMayHaveNoBody(start.status) ? null : stream, {
          status: start.status,
          headers,
        }),
      );
      return;
    }
    if (frame.type === FrameType.responseBody) {
      if (!pending.responseStarted || !pending.controller) {
        throw new ProtocolError("response body before response start");
      }
      pending.bodyBytes += frame.payload.length;
      if (pending.bodyBytes > LIMITS.maxBodyBytes) {
        throw new ProtocolError("response body exceeds limit", 1009);
      }
      pending.controller.enqueue(frame.payload.slice());
      return;
    }
    if (frame.type === FrameType.responseEnd) {
      if (!pending.responseStarted || !pending.controller) {
        throw new ProtocolError("response end before response start");
      }
      pending.controller.close();
      this.finishPending(pending);
      return;
    }
    if (frame.type === FrameType.cancel) {
      this.failPending(pending, 502, false);
      return;
    }
    throw new ProtocolError("unexpected connector frame");
  }

  private async handlePublic(
    request: Request,
    info?: RelayRequestInfo,
  ): Promise<Response> {
    let hostname: string;
    try {
      hostname = normalizeHostname(request.headers.get("host") ?? "");
    } catch {
      return publicError(400);
    }
    const tunnelId = this.config.hostnameToTunnel.get(hostname);
    if (!tunnelId) return publicError(404);
    const session = this.sessions.get(tunnelId);
    if (!session?.authenticated || session.socket.readyState !== WebSocket.OPEN) {
      return publicError(503);
    }
    if (session.requests.size >= LIMITS.maxConcurrentRequests) {
      return publicError(429);
    }
    const contentLength = request.headers.get("content-length");
    if (
      contentLength &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > LIMITS.maxBodyBytes)
    ) return publicError(413);
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (request.body !== null || Number(contentLength ?? "0") > 0)
    ) return publicError(400);

    const id = createCorrelationId();
    const response = Promise.withResolvers<Response>();
    const pending: PendingRequest = {
      id,
      tunnelId,
      response,
      responseStarted: false,
      bodyBytes: 0,
      sendAbort: new AbortController(),
      timer: setTimeout(() => this.failPendingById(id, 504), LIMITS.requestTimeoutMs),
    };
    this.pending.set(id, pending);
    session.requests.add(id);
    void info?.completed?.catch(() => this.cancelPending(pending));
    try {
      const remoteAddress = getRemoteAddress(info);
      const start = {
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers: filterPublicRequestHeaders(request.headers, hostname, remoteAddress),
        remoteAddress,
      };
      await sendFrame(
        session.socket,
        encodeFrame(FrameType.requestStart, id, encodeControl(start)),
        pending.sendAbort.signal,
      );
      let bodyBytes = 0;
      if (request.body) {
        const reader = request.body.getReader();
        const cancelReader = () => {
          void reader.cancel(pending.sendAbort.signal.reason).catch(() => {});
        };
        pending.sendAbort.signal.addEventListener("abort", cancelReader, {
          once: true,
        });
        try {
          while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            bodyBytes += chunk.length;
            if (bodyBytes > LIMITS.maxBodyBytes) {
              this.failPending(pending, 413);
              return publicError(413);
            }
            await sendFrame(
              session.socket,
              encodeFrame(FrameType.requestBody, id, chunk),
              pending.sendAbort.signal,
            );
          }
        } finally {
          pending.sendAbort.signal.removeEventListener("abort", cancelReader);
          reader.releaseLock();
        }
      }
      await sendFrame(
        session.socket,
        encodeFrame(FrameType.requestEnd, id),
        pending.sendAbort.signal,
      );
      return await response.promise;
    } catch (error) {
      this.logger.warn("public_request_failed", {
        tunnelId,
        requestId: id,
        message: error instanceof Error ? error.message : "unknown",
      });
      if (this.pending.get(id) === pending) this.failPending(pending, 502);
      return await response.promise;
    }
  }

  private heartbeat(session: ConnectorSession): void {
    if (this.now() - session.lastSeen > LIMITS.heartbeatTimeoutMs) {
      session.socket.close(toWebSocketCloseCode(1001), "heartbeat timeout");
      this.cleanupSession(session, 502);
      return;
    }
    if (session.heartbeatSending || session.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    session.heartbeatSending = true;
    void sendFrame(
      session.socket,
      encodeFrame(
        FrameType.ping,
        "",
        encodeControl({ time: this.now() }),
      ),
    ).catch(() => {
      session.socket.close(toWebSocketCloseCode(1011), "heartbeat failed");
      this.cleanupSession(session, 502);
    }).finally(() => session.heartbeatSending = false);
  }

  private async sendCancel(session: ConnectorSession, id: string): Promise<void> {
    if (session.socket.readyState === WebSocket.OPEN) {
      await sendFrame(session.socket, encodeFrame(FrameType.cancel, id));
    }
  }

  private cleanupSession(session: ConnectorSession, status: number): void {
    session.closed = true;
    this.connecting.delete(session);
    session.cancelled.clear();
    if (session.authTimer) clearTimeout(session.authTimer);
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    if (this.sessions.get(session.tunnelId) === session) {
      this.sessions.delete(session.tunnelId);
    }
    for (const id of [...session.requests]) {
      const pending = this.pending.get(id);
      if (pending) this.failPending(pending, status, false);
    }
  }

  private failPendingById(id: string, status: number): void {
    const pending = this.pending.get(id);
    if (pending) this.failPending(pending, status);
  }

  private failPending(
    pending: PendingRequest,
    status: number,
    notifyConnector = true,
    reason = "failed",
  ): void {
    if (this.pending.get(pending.id) !== pending) return;
    const error = new Error(`tunnel request ${reason}`);
    pending.sendAbort.abort(error);
    if (pending.responseStarted) {
      try {
        pending.controller?.error(error);
      } catch {
        // Stream may already be closed.
      }
    } else {
      pending.response.resolve(publicError(status));
    }
    if (notifyConnector) this.rememberCancellation(pending);
    if (notifyConnector) this.notifyConnectorOfCancellation(pending);
    this.finishPending(pending);
  }

  private cancelPending(pending: PendingRequest): void {
    this.failPending(pending, 502, true, "cancelled");
  }

  private notifyConnectorOfCancellation(pending: PendingRequest): void {
    const session = this.sessions.get(pending.tunnelId);
    if (session) void this.sendCancel(session, pending.id).catch(() => {});
  }

  private finishPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    this.pending.delete(pending.id);
    this.sessions.get(pending.tunnelId)?.requests.delete(pending.id);
  }

  private rememberCancellation(pending: PendingRequest): void {
    const session = this.sessions.get(pending.tunnelId);
    if (!session || session.closed) return;
    this.pruneCancellations(session);
    session.cancelled.set(pending.id, {
      responseStarted: pending.responseStarted,
      bodyBytes: pending.bodyBytes,
      expiresAt: this.now() + LIMITS.originTimeoutMs,
    });
    while (session.cancelled.size > LIMITS.maxCancellationTombstones) {
      session.cancelled.delete(session.cancelled.keys().next().value!);
    }
  }

  private handleCancelledFrame(
    session: ConnectorSession,
    frame: ReturnType<typeof decodeFrame>,
  ): boolean {
    this.pruneCancellations(session);
    const cancelled = session.cancelled.get(frame.id);
    if (!cancelled) return false;
    if (frame.type === FrameType.cancel) {
      session.cancelled.delete(frame.id);
      return true;
    }
    if (frame.type === FrameType.responseStart) {
      if (cancelled.responseStarted) {
        throw new ProtocolError("duplicate response start");
      }
      parseResponseStart(decodeControl(frame.payload));
      cancelled.responseStarted = true;
      return true;
    }
    if (frame.type === FrameType.responseBody) {
      if (!cancelled.responseStarted) {
        throw new ProtocolError("response body before response start");
      }
      cancelled.bodyBytes += frame.payload.length;
      if (cancelled.bodyBytes > LIMITS.maxBodyBytes) {
        throw new ProtocolError("response body exceeds limit", 1009);
      }
      return true;
    }
    if (frame.type === FrameType.responseEnd) {
      if (!cancelled.responseStarted) {
        throw new ProtocolError("response end before response start");
      }
      session.cancelled.delete(frame.id);
      return true;
    }
    throw new ProtocolError("unexpected connector frame");
  }

  private pruneCancellations(session: ConnectorSession): void {
    const now = this.now();
    for (const [id, cancelled] of session.cancelled) {
      if (cancelled.expiresAt <= now) session.cancelled.delete(id);
    }
  }
}

function getRemoteAddress(info?: RelayRequestInfo): string {
  return info?.remoteAddress ?? info?.remoteAddr?.hostname ?? "";
}

function defaultWebSocketUpgrader(
  request: Request,
  protocol: string,
): { socket: WebSocket; response: Response } {
  return Deno.upgradeWebSocket(request, { protocol });
}

function requestMayHaveNoBody(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

function publicError(status: number): Response {
  return json({ error: "tunnel request failed" }, status, {
    "cache-control": "no-store",
  });
}

function json(
  value: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
