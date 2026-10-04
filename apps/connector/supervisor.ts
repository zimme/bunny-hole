import { BunnyHoleClient, type HostCredentials, type Session } from "./client.ts";
import { runFrpc } from "./frpc.ts";

export type ConnectorState =
  | "idle"
  | "authenticating"
  | "running"
  | "backoff"
  | "stopped";
export type ConnectorEvent = "start" | "authenticated" | "failed" | "retry" | "stop";
const transitions = {
  idle: {
    start: "authenticating",
    authenticated: null,
    failed: null,
    retry: null,
    stop: "stopped",
  },
  authenticating: {
    start: null,
    authenticated: "running",
    failed: "backoff",
    retry: null,
    stop: "stopped",
  },
  running: {
    start: null,
    authenticated: null,
    failed: "backoff",
    retry: null,
    stop: "stopped",
  },
  backoff: {
    start: null,
    authenticated: null,
    failed: null,
    retry: "authenticating",
    stop: "stopped",
  },
  stopped: {
    start: null,
    authenticated: null,
    failed: null,
    retry: null,
    stop: "stopped",
  },
} as const satisfies Record<
  ConnectorState,
  Record<ConnectorEvent, ConnectorState | null>
>;

export function transition(
  state: ConnectorState,
  event: ConnectorEvent,
): ConnectorState {
  const next = transitions[state][event];
  if (!next) throw new Error(`illegal connector transition: ${state}/${event}`);
  return next;
}

export async function superviseConnector(options: {
  client: BunnyHoleClient;
  credentials: HostCredentials;
  signal: AbortSignal;
  executable: string;
  transport: "quic" | "tcp" | "websocket" | "wss";
  allowInsecureTransport?: boolean;
  trustedCaFile?: string;
  originCaFile?: string;
  acquire?: () => Promise<Session>;
}, effects: {
  run?: typeof runFrpc;
  wait?: typeof abortableDelay;
} = {}): Promise<void> {
  let state: ConnectorState = transition("idle", "start");
  let delay = 500;
  while (!options.signal.aborted) {
    const started = Date.now();
    try {
      const session = await (options.acquire?.() ??
        options.client.session(options.credentials, options.signal));
      if (options.signal.aborted) break;
      state = transition(state, "authenticated");
      await (effects.run ?? runFrpc)({ ...options, session });
    } catch {
      if (options.signal.aborted) break;
      console.error("connector interrupted; retrying with fresh authentication");
    }
    state = transition(state, "failed");
    if (Date.now() - started >= 60_000) delay = 500;
    await (effects.wait ?? abortableDelay)(
      Math.round(delay * (0.8 + Math.random() * 0.4)),
      options.signal,
    );
    delay = Math.min(delay * 2, 30_000);
    if (!options.signal.aborted) state = transition(state, "retry");
  }
  transition(state, "stop");
}

export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
