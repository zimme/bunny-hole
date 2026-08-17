import {
  decodeBase64Url,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  Frame,
  framePayloadChunks,
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
export interface ConnectorRuntimeConfig {
  relayUrl: URL;
  tunnelId: string;
  secret: string;
  origin: URL;
}

export interface ConnectorLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

interface OriginRequest {
  id: string;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  abort: AbortController;
  ended: boolean;
  responseDone: boolean;
  requestBytes: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface RecentRequest {
  kind: "cancelled" | "completed";
  requestBytes: number;
  ended: boolean;
  expiresAt: number;
}

export class Connector {
  private socket?: WebSocket;
  private requests = new Map<string, OriginRequest>();
  private authenticated = false;
  private proofSent = false;
  private stopping = false;
  private lastSeen = Date.now();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatSending = false;
  private running = false;
  private recent = new Map<string, RecentRequest>();

  constructor(
    readonly config: ConnectorRuntimeConfig,
    readonly logger: ConnectorLogger,
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new ProtocolError("connector is already running");
    if (this.stopping) throw new ProtocolError("connector has been stopped");
    this.running = true;
    let attempt = 0;
    const stop = () => this.stop();
    signal?.addEventListener("abort", stop, { once: true });
    try {
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
        const delay = calculateBackoffDelay(base);
        await abortableDelay(delay, signal);
      }
    } finally {
      signal?.removeEventListener("abort", stop);
      this.running = false;
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const request of this.requests.values()) this.cancelRequest(request);
    this.recent.clear();
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
    this.heartbeatSending = false;
    const completion = Promise.withResolvers<void>();
    let messageQueue = Promise.resolve();
    let closed = false;
    let protocolFailed = false;
    let queuedMessageBytes = 0;
    let failureMessage: string | undefined;
    const authTimer = setTimeout(() => {
      failureMessage = "relay authentication timed out";
      socket.close(toWebSocketCloseCode(1008), "authentication timeout");
    }, LIMITS.authenticationTimeoutMs * 2);
    socket.onopen = () => {
      if (socket.protocol !== SUBPROTOCOL) {
        protocolFailed = true;
        failureMessage = "relay did not negotiate the tunnel subprotocol";
        socket.close(toWebSocketCloseCode(1003), "subprotocol required");
        return;
      }
      this.logger.info("connector_connected", { tunnelId: this.config.tunnelId });
    };
    socket.onmessage = (event) => {
      if (closed || protocolFailed) return;
      const messageBytes = event.data instanceof ArrayBuffer
        ? event.data.byteLength
        : typeof event.data === "string"
        ? event.data.length * 2
        : LIMITS.maxQueuedMessageBytes + 1;
      if (queuedMessageBytes + messageBytes > LIMITS.maxQueuedMessageBytes) {
        protocolFailed = true;
        failureMessage = "relay exceeded the message queue limit";
        socket.close(toWebSocketCloseCode(1009), "message queue limit");
        return;
      }
      queuedMessageBytes += messageBytes;
      messageQueue = messageQueue.then(async () => {
        if (closed || protocolFailed) return;
        try {
          const wasAuthenticated = this.authenticated;
          await this.onMessage(event);
          if (!wasAuthenticated && this.authenticated && !closed) {
            clearTimeout(authTimer);
            this.heartbeatTimer = setInterval(
              () => this.checkHeartbeat(socket),
              LIMITS.heartbeatIntervalMs,
            );
          }
        } catch (error) {
          protocolFailed = true;
          failureMessage = "relay sent invalid protocol traffic";
          this.logger.warn("protocol_error", {
            message: error instanceof Error ? error.message : "protocol error",
          });
          socket.close(
            toWebSocketCloseCode(
              error instanceof ProtocolError ? error.closeCode : 1011,
            ),
            "protocol error",
          );
        }
      }).finally(() => queuedMessageBytes -= messageBytes);
    };
    socket.onerror = () => {
      // The close event provides the stable reconnect path.
    };
    socket.onclose = (event) => {
      closed = true;
      clearTimeout(authTimer);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      this.heartbeatSending = false;
      void messageQueue.finally(() => {
        for (const request of this.requests.values()) this.cancelRequest(request);
        this.requests.clear();
        this.recent.clear();
        this.authenticated = false;
        if (this.stopping) completion.resolve();
        else {
          completion.reject(
            new Error(
              failureMessage ??
                (event.code === 4101
                  ? "connector was replaced"
                  : "relay connection closed"),
            ),
          );
        }
      });
    };
    return completion.promise;
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    if (!(event.data instanceof ArrayBuffer)) {
      throw new ProtocolError("text frames are not supported", 1003);
    }
    const frame = decodeFrame(event.data);
    this.lastSeen = Date.now();
    if (!this.authenticated) {
      if (this.proofSent) {
        if (frame.type !== FrameType.authenticated || frame.id !== "") {
          throw new ProtocolError("expected authentication response", 1008);
        }
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
        !isNonce(challenge.nonce)
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
      this.pruneRecent();
      if (this.requests.has(frame.id) || this.recent.has(frame.id)) {
        throw new ProtocolError("duplicate request");
      }
      if (this.requests.size >= LIMITS.maxConcurrentRequests) {
        this.rememberRecent(frame.id, "cancelled", 0, false);
        await this.send(encodeFrame(FrameType.cancel, frame.id));
        return;
      }
      const start = parseRequestStart(decodeControl(frame.payload));
      const abort = new AbortController();
      const context: OriginRequest = {
        id: frame.id,
        abort,
        ended: false,
        responseDone: false,
        requestBytes: 0,
        timeout: setTimeout(
          () => void this.timeoutRequest(frame.id),
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
      if (this.handleRecentFrame(frame)) return;
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
      this.rememberRecent(
        frame.id,
        "cancelled",
        context.requestBytes,
        context.ended,
      );
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
      const init: RequestInit & { duplex?: "half" } = {
        method,
        headers,
        body,
        redirect: "manual",
        signal: context.abort.signal,
      };
      if (body) init.duplex = "half";
      const response = await fetch(target, init);
      await this.send(encodeFrame(
        FrameType.responseStart,
        context.id,
        encodeControl({
          status: response.status,
          headers: filterOriginResponseHeaders(response.headers),
        }),
      ));
      let bodyBytes = 0;
      const responseBodyAllowed = method !== "HEAD" &&
        ![204, 205, 304].includes(response.status);
      if (responseBodyAllowed && response.body) {
        for await (const chunk of response.body) {
          bodyBytes += chunk.length;
          if (bodyBytes > LIMITS.maxBodyBytes) {
            throw new ProtocolError("origin response exceeds limit", 1009);
          }
          for (const payload of framePayloadChunks(chunk)) {
            await this.send(encodeFrame(FrameType.responseBody, context.id, payload));
          }
        }
      } else {
        await response.body?.cancel();
      }
      await this.send(encodeFrame(FrameType.responseEnd, context.id));
    } catch (error) {
      const notifyRelay = !context.abort.signal.aborted;
      if (this.requests.get(context.id) === context) {
        this.cancelRequest(context);
        this.requests.delete(context.id);
        this.rememberRecent(
          context.id,
          "cancelled",
          context.requestBytes,
          context.ended,
        );
      }
      if (notifyRelay) {
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
      if (context.ended && this.requests.get(context.id) === context) {
        this.finishRequest(context);
      }
    }
  }

  private async send(frame: Uint8Array): Promise<void> {
    if (!this.socket) throw new ProtocolError("connection is not open", 1001);
    await sendFrame(this.socket, frame);
  }

  private async timeoutRequest(id: string): Promise<void> {
    const request = this.requests.get(id);
    if (!request) return;
    this.cancelRequest(request);
    this.requests.delete(id);
    this.rememberRecent(id, "cancelled", request.requestBytes, request.ended);
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        await sendFrame(this.socket, encodeFrame(FrameType.cancel, id));
      } catch {
        // Connection close handles peer cleanup.
      }
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
    this.rememberRecent(
      request.id,
      "completed",
      request.requestBytes,
      request.ended,
    );
  }

  private rememberRecent(
    id: string,
    kind: RecentRequest["kind"],
    requestBytes: number,
    ended: boolean,
  ): void {
    this.pruneRecent();
    this.recent.set(id, {
      kind,
      requestBytes,
      ended,
      expiresAt: Date.now() + LIMITS.requestTimeoutMs,
    });
    while (this.recent.size > LIMITS.maxCancellationTombstones) {
      this.recent.delete(this.recent.keys().next().value!);
    }
  }

  private handleRecentFrame(frame: Frame): boolean {
    this.pruneRecent();
    const recent = this.recent.get(frame.id);
    if (!recent) return false;
    if (frame.type === FrameType.cancel) {
      this.recent.delete(frame.id);
      return true;
    }
    if (recent.kind !== "cancelled") return false;
    if (frame.type === FrameType.requestBody) {
      if (recent.ended) throw new ProtocolError("request body out of order");
      recent.requestBytes += frame.payload.length;
      if (recent.requestBytes > LIMITS.maxBodyBytes) {
        throw new ProtocolError("request body exceeds limit", 1009);
      }
      return true;
    }
    if (frame.type === FrameType.requestEnd) {
      if (recent.ended) throw new ProtocolError("duplicate request end");
      recent.ended = true;
      return true;
    }
    throw new ProtocolError("unexpected relay frame");
  }

  private pruneRecent(): void {
    const now = Date.now();
    for (const [id, request] of this.recent) {
      if (request.expiresAt <= now) this.recent.delete(id);
    }
  }

  private checkHeartbeat(socket: WebSocket): void {
    if (Date.now() - this.lastSeen > LIMITS.heartbeatTimeoutMs) {
      socket.close(toWebSocketCloseCode(1001), "heartbeat timeout");
      return;
    }
    if (this.heartbeatSending || socket.readyState !== WebSocket.OPEN) return;
    this.heartbeatSending = true;
    void sendFrame(
      socket,
      encodeFrame(FrameType.ping, "", encodeControl({ time: Date.now() })),
    ).catch(() => socket.close(toWebSocketCloseCode(1011), "heartbeat failed"))
      .finally(() => this.heartbeatSending = false);
  }
}

export function calculateBackoffDelay(
  baseMilliseconds: number,
  random: () => number = Math.random,
): number {
  const minimum = Math.floor(baseMilliseconds * 4 / 5);
  const maximum = Math.floor(baseMilliseconds * 6 / 5);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("random sample must be in the range [0, 1)");
  }
  // Reconnection jitter is not a security decision. An injectable ordinary
  // PRNG avoids misusing cryptographic random bytes and keeps tests deterministic.
  return minimum + Math.floor(sample * (maximum - minimum + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonce(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return decodeBase64Url(value).length === 24;
  } catch {
    return false;
  }
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}
