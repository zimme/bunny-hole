import {
  canonicalGrant,
  createId,
  type Enrollment,
  grantAllowsRoute,
  type HostDescriptor,
  isRecord,
  LIMITS,
  normalizeHostname,
  parseId,
  parseName,
  parsePort,
  parseProtocol,
  type Route,
  validateGrant,
  ValidationError,
} from "../../packages/api/mod.ts";
import {
  createChallenge,
  validatePublicKey,
  verificationPhrase,
  verify,
} from "../../packages/api/auth.ts";
import {
  assertHeaderLimits,
  secureRequestHeaders,
  secureResponseHeaders,
  validateOrigin,
} from "../../packages/api/security.ts";
import type { KeyPair } from "../../packages/api/auth.ts";
import type { HostConfig } from "./config.ts";
import type { Logger } from "../../packages/api/logger.ts";
import { FrpAuthorizer } from "./frp.ts";
import { bearerToken, issueSessionToken, verifySessionToken } from "./session.ts";
import { HostStore } from "./store.ts";
import { PasskeyService } from "./passkeys.ts";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

export class Host {
  #accepting = true;
  #frpReady = false;
  #frp: FrpAuthorizer;
  #passkeys: PasskeyService;
  #registrationFlows = new Map<string, { name: string; expiresAt: number }>();
  #approvalFlows = new Map<
    string,
    {
      enrollmentId: string;
      grants: ReturnType<typeof validateGrant>;
      expiresAt: number;
    }
  >();
  #ownerChallenges = new Map<string, { purpose: string; expiresAt: number }>();
  #inFlight = 0;
  #controlRequests = new Set<AbortController>();
  #publicRequests = new Set<AbortController>();
  #enrollmentAttempts: number[] = [];

  constructor(
    private config: HostConfig,
    private store: HostStore,
    private identity: KeyPair,
    private logger: Logger,
  ) {
    this.#frp = new FrpAuthorizer(store, identity.publicKey);
    this.#passkeys = new PasskeyService(store, config.publicUrl);
  }

  setFrpReady(value: boolean): void {
    this.#frpReady = value;
  }

  shutdown(): void {
    this.#accepting = false;
    this.#frpReady = false;
    for (const request of this.#controlRequests) request.abort();
    for (const request of this.#publicRequests) request.abort();
    this.#publicRequests.clear();
  }

  async handle(request: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/healthz") return text("ok\n", this.#accepting ? 200 : 503);
      if (url.pathname === "/readyz") {
        return text("ready\n", this.#accepting && this.#frpReady ? 200 : 503);
      }
      if (url.pathname === "/internal/frp/plugin") {
        if (!isLoopback(info?.remoteAddr)) return json({ error: "not found" }, 404);
        const body = await this.readJson(request, 64 * 1024);
        return json(
          await this.#frp.authorize({
            op: url.searchParams.get("op"),
            content: isRecord(body) ? body.content : undefined,
          }),
        );
      }
      if (
        isReservedPath(url.pathname) &&
        requestHostname(request) !== this.config.publicUrl.hostname
      ) return json({ error: "not found" }, 404);
      if (!this.#accepting) return publicError(503);
      if (url.pathname === "/.well-known/bunny-hole") {
        return json(this.descriptor());
      }
      if (
        url.pathname === "/api/v1/admin/owner/challenge" && request.method === "POST"
      ) {
        const body = await this.readJson(request);
        if (!isRecord(body)) throw new ValidationError("invalid owner challenge");
        assertOnlyKeys(body, ["purpose"]);
        const purpose = body.purpose;
        if (
          ![
            "approve-enrollment",
            "revoke-enrollment",
            "create-passkey-flow",
            "revoke-passkey",
            "purge-enrollment",
            "list-passkeys",
          ].includes(
            String(purpose),
          )
        ) throw new ValidationError("invalid owner challenge");
        this.cleanFlows();
        if (this.#ownerChallenges.size >= 128) {
          throw new ValidationError("too many active owner challenges");
        }
        const challenge = createChallenge();
        this.#ownerChallenges.set(challenge, {
          purpose: purpose as string,
          expiresAt: Date.now() + 60_000,
        });
        return json({ challenge, expiresIn: 60 });
      }
      if (
        url.pathname === "/api/v1/admin/passkeys/registration/flows" &&
        request.method === "POST"
      ) {
        const body = await this.readJson(request);
        if (!isRecord(body)) throw new ValidationError("invalid registration request");
        assertOnlyKeys(body, ["name"]);
        const name = parseName(body.name);
        await this.requireOwnerProof(request, "create-passkey-flow", [name]);
        this.cleanFlows();
        if (this.#registrationFlows.size >= 16) {
          throw new ValidationError("too many active registration flows");
        }
        const token = createId("flow");
        this.#registrationFlows.set(token, {
          name,
          expiresAt: Date.now() + 5 * 60_000,
        });
        return json({
          url: new URL(`/_bunny/admin/passkey#${token}`, this.config.publicUrl).href,
        });
      }
      if (
        url.pathname === "/api/v1/admin/passkeys/registration/options" &&
        request.method === "POST"
      ) {
        const body = await this.readJson(request);
        if (!isRecord(body)) throw new ValidationError("invalid registration request");
        assertOnlyKeys(body, ["flowToken"]);
        const flow = this.registrationFlow(body, false);
        return json(await this.#passkeys.registrationOptions(flow.token));
      }
      if (
        url.pathname === "/api/v1/admin/passkeys/registration" &&
        request.method === "POST"
      ) {
        const body = await this.readJson(request);
        if (!isRecord(body) || !isRecord(body.response)) {
          throw new ValidationError("invalid registration response");
        }
        assertOnlyKeys(body, ["flowToken", "response"]);
        const flow = this.registrationFlow(body, true);
        try {
          await this.#passkeys.register(flow.name, body.response as never, flow.token);
        } finally {
          this.store.deleteAdminChallenges(`register:${flow.token}`);
        }
        return json({ registered: true });
      }
      if (
        url.pathname === "/api/v1/admin/enrollment-approvals" &&
        request.method === "POST"
      ) {
        const body = await this.readJson(request);
        if (!isRecord(body)) throw new ValidationError("invalid approval request");
        assertOnlyKeys(body, ["enrollmentId", "grants"]);
        const enrollmentId = parseId(body.enrollmentId, "enr");
        const enrollment = this.store.getEnrollment(enrollmentId);
        if (!enrollment || enrollment.state !== "pending") {
          throw new ValidationError("enrollment cannot be approved");
        }
        const grants = validateGrant(body.grants);
        this.cleanFlows();
        if (this.#approvalFlows.size >= 128) {
          throw new ValidationError("too many active approval flows");
        }
        const token = createId("flow");
        this.#approvalFlows.set(token, {
          enrollmentId,
          grants,
          expiresAt: Date.now() + 2 * 60_000,
        });
        return json({
          url: new URL(`/_bunny/admin/approve#${token}`, this.config.publicUrl).href,
        });
      }
      if (
        url.pathname === "/api/v1/admin/enrollment-approvals/options" &&
        request.method === "POST"
      ) {
        const body = await this.readJson(request);
        if (!isRecord(body)) throw new ValidationError("invalid approval request");
        assertOnlyKeys(body, ["flowToken"]);
        const flow = this.approvalFlow(body, false);
        return json({
          options: await this.#passkeys.authenticationOptions(flow.token),
          enrollment: publicEnrollment(flow.enrollment),
          grants: flow.grants,
        });
      }
      if (
        url.pathname === "/api/v1/admin/enrollment-approvals/complete" &&
        request.method === "POST"
      ) {
        const body = await this.readJson(request);
        if (!isRecord(body) || !isRecord(body.response)) {
          throw new ValidationError("invalid authentication response");
        }
        assertOnlyKeys(body, ["flowToken", "response"]);
        const flow = this.approvalFlow(body, true);
        try {
          await this.#passkeys.authenticate(body.response as never, flow.token);
        } finally {
          this.store.deleteAdminChallenges(`authenticate:${flow.token}`);
        }
        if (!this.store.approveEnrollment(flow.enrollmentId, flow.grants)) {
          throw new ValidationError("enrollment cannot be approved");
        }
        return json({ approved: true });
      }
      if (url.pathname === "/_bunny/admin/passkey" && request.method === "GET") {
        return passkeyPage();
      }
      if (url.pathname === "/_bunny/admin/approve" && request.method === "GET") {
        return approvalPage();
      }
      if (url.pathname === "/api/v1/admin/passkeys" && request.method === "GET") {
        await this.requireOwnerProof(request, "list-passkeys", []);
        return json({
          passkeys: this.store.listPasskeys().map(({ id, name }) => ({ id, name })),
        });
      }
      const passkeyPath = url.pathname.match(
        /^\/api\/v1\/admin\/passkeys\/([A-Za-z0-9_-]{1,1024})$/,
      );
      if (passkeyPath && request.method === "DELETE") {
        await this.requireOwnerProof(request, "revoke-passkey", [passkeyPath[1]]);
        return this.store.deletePasskey(passkeyPath[1])
          ? new Response(null, { status: 204 })
          : json({ error: "not found" }, 404);
      }
      const purgePath = url.pathname.match(
        /^\/api\/v1\/enrollments\/(enr_[A-Za-z0-9_-]{24})$/,
      );
      if (purgePath && request.method === "DELETE") {
        await this.requireOwnerProof(request, "purge-enrollment", [purgePath[1]]);
        return this.store.purgeEnrollment(purgePath[1])
          ? new Response(null, { status: 204 })
          : json({ error: "revoked enrollment required" }, 400);
      }
      if (url.pathname === "/api/v1/enrollments" && request.method === "POST") {
        return await this.createEnrollment(request);
      }
      const enrollmentPath = url.pathname.match(
        /^\/api\/v1\/enrollments\/(enr_[A-Za-z0-9_-]{24})(?:\/(approve|revoke))?$/,
      );
      if (enrollmentPath) {
        if (enrollmentPath[2] === "approve" && request.method === "POST") {
          return await this.approveEnrollment(request, enrollmentPath[1]);
        }
        if (enrollmentPath[2] === "revoke" && request.method === "POST") {
          return await this.revokeEnrollment(request, enrollmentPath[1]);
        }
        if (!enrollmentPath[2] && request.method === "GET") {
          const enrollment = this.store.getEnrollment(enrollmentPath[1]);
          return enrollment
            ? json(publicEnrollment(enrollment))
            : json({ error: "not found" }, 404);
        }
      }
      if (url.pathname === "/api/v1/session/challenge" && request.method === "POST") {
        return await this.createSessionChallenge(request);
      }
      if (url.pathname === "/api/v1/session" && request.method === "POST") {
        return await this.createSession(request);
      }
      if (url.pathname === "/api/v1/routes") {
        if (request.method === "POST") return await this.createRoute(request);
        if (request.method === "GET") return await this.listRoutes(request);
      }
      const routePath = url.pathname.match(
        /^\/api\/v1\/routes\/(rte_[A-Za-z0-9_-]{24})$/,
      );
      if (routePath && request.method === "DELETE") {
        const enrollment = await this.authenticate(request);
        return this.store.deleteRoute(routePath[1], enrollment.id)
          ? new Response(null, { status: 204 })
          : json({ error: "not found" }, 404);
      }
      if (isReservedPath(url.pathname)) {
        return json({ error: "not found" }, 404);
      }
      return await this.proxyPublic(request, info);
    } catch (error) {
      const expected = error instanceof ValidationError || error instanceof SyntaxError;
      this.logger.warn("request_rejected", {
        path: url.pathname,
        reason: expected ? error.message : "internal error",
      });
      const status = !expected
        ? 500
        : /authentication (?:required|failed)/.test(error.message)
        ? 401
        : error.message === "invalid owner proof"
        ? 403
        : 400;
      return json(
        { error: expected ? error.message : "request failed" },
        status,
      );
    }
  }

  descriptor(): HostDescriptor {
    return {
      apiVersion: 1,
      name: this.config.publicUrl.hostname,
      managementUrl: this.config.publicUrl.href,
      connectorHost: this.config.connectorHost,
      connectorPort: this.config.connectorPort,
      connectorTransports: this.config.connectorTransports,
      identityPublicKey: this.identity.publicKey,
      capabilities: ["http", "https"],
    };
  }

  private async readJson(request: Request, limit?: number): Promise<unknown> {
    if (!this.#accepting) throw new ValidationError("host is stopping");
    if (this.#controlRequests.size >= LIMITS.maxControlRequests) {
      throw new ValidationError("control requests temporarily unavailable");
    }
    const controller = new AbortController();
    this.#controlRequests.add(controller);
    const signal = AbortSignal.any([
      request.signal,
      controller.signal,
      AbortSignal.timeout(LIMITS.controlTimeoutMs),
    ]);
    try {
      return await readJson(request, limit, signal);
    } finally {
      this.#controlRequests.delete(controller);
    }
  }

  private async createEnrollment(request: Request): Promise<Response> {
    const now = Date.now();
    this.store.pruneExpiredEnrollments(new Date(now).toISOString());
    this.#enrollmentAttempts = this.#enrollmentAttempts.filter((at) =>
      at > now - 60_000
    );
    if (
      this.#enrollmentAttempts.length >= LIMITS.maxEnrollmentAttemptsPerMinute
    ) throw new ValidationError("enrollment temporarily unavailable");
    this.#enrollmentAttempts.push(now);
    const body = await this.readJson(request);
    if (!isRecord(body) || !["device", "cluster"].includes(String(body.kind))) {
      throw new ValidationError("invalid enrollment");
    }
    assertOnlyKeys(body, ["kind", "name", "publicKey"]);
    const publicKey = validatePublicKey(body.publicKey);
    const existing = this.store.getEnrollmentByPublicKey(publicKey);
    if (existing) return json(publicEnrollment(existing), 200);
    if (this.store.enrollmentCount() >= LIMITS.maxEnrollments) {
      throw new ValidationError("enrollment limit reached");
    }
    const createdAt = new Date().toISOString();
    const enrollment: Enrollment = {
      id: createId("enr"),
      kind: body.kind as Enrollment["kind"],
      name: parseName(body.name),
      publicKey,
      verificationPhrase: await verificationPhrase(publicKey),
      state: "pending",
      grants: emptyGrant(),
      createdAt,
      expiresAt: new Date(Date.now() + LIMITS.enrollmentLifetimeMs).toISOString(),
    };
    try {
      this.store.createEnrollment(enrollment);
    } catch (error) {
      const concurrent = this.store.getEnrollmentByPublicKey(publicKey);
      if (concurrent) return json(publicEnrollment(concurrent), 200);
      throw error;
    }
    return json(publicEnrollment(enrollment), 201);
  }

  private async approveEnrollment(request: Request, id: string): Promise<Response> {
    parseId(id, "enr");
    const enrollment = this.store.getEnrollment(id);
    if (!enrollment) return json({ error: "not found" }, 404);
    const body = await this.readJson(request);
    if (!isRecord(body)) throw new ValidationError("invalid approval");
    assertOnlyKeys(body, ["grants"]);
    const grants = validateGrant(body.grants);
    await this.requireOwnerProof(request, "approve-enrollment", [
      id,
      enrollment.publicKey,
      canonicalGrant(grants),
    ]);
    if (!this.store.approveEnrollment(id, grants)) {
      throw new ValidationError("enrollment cannot be approved");
    }
    return json({ approved: true });
  }

  private async revokeEnrollment(request: Request, id: string): Promise<Response> {
    parseId(id, "enr");
    const body = await this.readJson(request);
    if (!isRecord(body)) throw new ValidationError("invalid revocation request");
    assertOnlyKeys(body, []);
    await this.requireOwnerProof(request, "revoke-enrollment", [id]);
    if (!this.store.revokeEnrollment(id)) return json({ error: "not found" }, 404);
    return json({ revoked: true });
  }

  private async createSessionChallenge(request: Request): Promise<Response> {
    const body = await this.readJson(request);
    if (!isRecord(body)) throw new ValidationError("invalid challenge request");
    assertOnlyKeys(body, ["enrollmentId"]);
    const enrollment = this.requireActiveEnrollment(parseId(body.enrollmentId, "enr"));
    const id = createId("chl");
    const challenge = createChallenge();
    const expiresAt = Date.now() + 60_000;
    if (!this.store.saveChallenge(id, enrollment.id, challenge, expiresAt)) {
      return json({ error: "too many outstanding challenges" }, 429);
    }
    return json({
      challengeId: id,
      challenge,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  private async createSession(request: Request): Promise<Response> {
    const body = await this.readJson(request);
    if (!isRecord(body)) throw new ValidationError("invalid session request");
    assertOnlyKeys(body, ["enrollmentId", "challengeId", "signature"]);
    const enrollmentId = parseId(body.enrollmentId, "enr");
    const challengeId = parseId(body.challengeId, "chl");
    if (typeof body.signature !== "string") {
      throw new ValidationError("authentication failed");
    }
    const challenge = this.store.consumeChallenge(
      challengeId,
      enrollmentId,
      Date.now(),
    );
    if (!challenge) throw new ValidationError("authentication failed");
    const enrollment = this.requireActiveEnrollment(enrollmentId);
    if (
      !(await verify(enrollment.publicKey, "session", [
        enrollmentId,
        challengeId,
        challenge,
      ], body.signature))
    ) throw new ValidationError("authentication failed");
    const session = await issueSessionToken(this.identity.privateKey, enrollmentId);
    this.store.audit(enrollmentId, "session.issued", session.claims.jti, {
      expiresAt: session.claims.expiresAt,
    });
    return json({
      accessToken: session.token,
      expiresAt: new Date(session.claims.expiresAt).toISOString(),
      descriptor: this.descriptor(),
      routes: this.store.listRoutes(enrollmentId),
    });
  }

  private async authenticate(request: Request): Promise<Enrollment> {
    const claims = await verifySessionToken(
      this.identity.publicKey,
      bearerToken(request),
    );
    return this.requireActiveEnrollment(claims?.enrollmentId);
  }

  private requireActiveEnrollment(enrollmentId: string | undefined): Enrollment {
    const enrollment = enrollmentId
      ? this.store.getEnrollment(enrollmentId)
      : undefined;
    if (enrollment?.state !== "active") {
      throw new ValidationError("authentication failed");
    }
    return enrollment;
  }

  private async requireOwnerProof(
    request: Request,
    purpose: string,
    fields: string[],
  ): Promise<void> {
    const challenge = request.headers.get("x-bunny-hole-owner-challenge") ?? "";
    const signature = request.headers.get("x-bunny-hole-owner-signature") ?? "";
    const stored = this.#ownerChallenges.get(challenge);
    this.#ownerChallenges.delete(challenge);
    if (
      !stored || stored.purpose !== purpose || stored.expiresAt < Date.now() ||
      !(await verify(
        this.config.ownerPublicKey,
        purpose,
        [this.identity.publicKey, ...fields, challenge],
        signature,
      ))
    ) throw new ValidationError("invalid owner proof");
  }

  private registrationFlow(
    body: Record<string, unknown>,
    consume: boolean,
  ): { name: string; expiresAt: number; token: string } {
    const token = parseId(body.flowToken, "flow");
    const flow = this.#registrationFlows.get(token);
    if (consume) this.#registrationFlows.delete(token);
    if (!flow || flow.expiresAt < Date.now()) {
      throw new ValidationError("registration flow expired");
    }
    return { ...flow, token };
  }

  private approvalFlow(
    body: Record<string, unknown>,
    consume: boolean,
  ): {
    enrollmentId: string;
    grants: ReturnType<typeof validateGrant>;
    expiresAt: number;
    token: string;
    enrollment: Enrollment;
  } {
    const token = parseId(body.flowToken, "flow");
    const flow = this.#approvalFlows.get(token);
    if (consume) this.#approvalFlows.delete(token);
    if (!flow || flow.expiresAt < Date.now()) {
      throw new ValidationError("approval flow expired");
    }
    const enrollment = this.store.getEnrollment(flow.enrollmentId);
    if (
      enrollment?.state !== "pending" || !enrollment.expiresAt ||
      Date.parse(enrollment.expiresAt) <= Date.now()
    ) throw new ValidationError("enrollment cannot be approved");
    return { ...flow, token, enrollment };
  }

  private cleanFlows(): void {
    const now = Date.now();
    for (const [token, flow] of this.#registrationFlows) {
      if (flow.expiresAt < now) {
        this.#registrationFlows.delete(token);
        this.store.deleteAdminChallenges(`register:${token}`);
      }
    }
    for (const [token, flow] of this.#approvalFlows) {
      if (flow.expiresAt < now) {
        this.#approvalFlows.delete(token);
        this.store.deleteAdminChallenges(`authenticate:${token}`);
      }
    }
    for (const [challenge, value] of this.#ownerChallenges) {
      if (value.expiresAt < now) this.#ownerChallenges.delete(challenge);
    }
  }

  private async createRoute(request: Request): Promise<Response> {
    const enrollment = await this.authenticate(request);
    const body = await this.readJson(request);
    if (!isRecord(body)) throw new ValidationError("invalid route");
    assertOnlyKeys(body, [
      "name",
      "protocol",
      "hostname",
      "targetHost",
      "targetPort",
      "allowPrivateNetwork",
    ]);
    const protocol = parseProtocol(body.protocol);
    const hostname = body.hostname === undefined
      ? undefined
      : normalizeHostname(body.hostname);
    if (!hostname) throw new ValidationError("HTTP routes require a hostname");
    if (hostname === this.config.publicUrl.hostname) {
      throw new ValidationError("management hostname is reserved");
    }
    const route: Route = {
      id: createId("rte"),
      enrollmentId: enrollment.id,
      name: parseName(body.name),
      protocol,
      hostname,
      targetHost: parseName(body.targetHost),
      targetPort: parsePort(body.targetPort),
      allowPrivateNetwork: body.allowPrivateNetwork === true,
      active: true,
    };
    validateOrigin(
      `${protocol}://${
        route.targetHost.includes(":") ? `[${route.targetHost}]` : route.targetHost
      }:${route.targetPort}`,
      route.allowPrivateNetwork,
    );
    if (!grantAllowsRoute(enrollment.grants, route)) {
      throw new ValidationError("route is outside enrollment grant");
    }
    const created = this.store.createRoute(route, enrollment.grants.maxRoutes);
    if (created === "limit") {
      throw new ValidationError("route is outside enrollment grant");
    }
    if (created !== "created") {
      throw new ValidationError("public route is already assigned");
    }
    return json(route, 201);
  }

  private async listRoutes(request: Request): Promise<Response> {
    const enrollment = await this.authenticate(request);
    return json({ routes: this.store.listRoutes(enrollment.id) });
  }

  private async proxyPublic(
    request: Request,
    info?: Deno.ServeHandlerInfo,
  ): Promise<Response> {
    try {
      assertHeaderLimits(request.headers);
    } catch {
      return publicError(431);
    }
    if (
      !/^[A-Z]{1,20}$/.test(request.method) ||
      ["CONNECT", "TRACE"].includes(request.method)
    ) return publicError(405);
    const url = new URL(request.url);
    if (
      new TextEncoder().encode(`${url.pathname}${url.search}`).length >
        LIMITS.maxPathBytes
    ) {
      return publicError(414);
    }
    const declaredLength = request.headers.get("content-length");
    if (
      declaredLength &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > LIMITS.maxBodyBytes)
    ) {
      return publicError(413);
    }
    if (["GET", "HEAD"].includes(request.method) && request.body) {
      return publicError(400);
    }
    const rawHost = request.headers.get("host");
    if (!rawHost) return publicError(421);
    const hostname = requestHostname(request);
    if (!hostname) return publicError(421);
    const route = this.store.getRouteByHostname(hostname);
    if (!route || !route.active) return publicError(404);
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      return publicError(501);
    }
    const headers = secureRequestHeaders(
      request.headers,
      hostname,
      remoteAddress(info),
    );
    headers.set("x-forwarded-proto", this.config.publicUrl.protocol.slice(0, -1));
    headers.set("host", hostname);
    if (this.#inFlight >= LIMITS.maxConcurrentRequests) return publicError(503);
    this.#inFlight++;
    const shutdown = new AbortController();
    this.#publicRequests.add(shutdown);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.#inFlight--;
      this.#publicRequests.delete(shutdown);
    };
    try {
      return await proxyHttp(
        request,
        headers,
        this.config.frpHttpPort,
        this.config.requestTimeoutMs,
        shutdown.signal,
        info?.completed,
        finish,
      );
    } catch (error) {
      finish();
      if (error instanceof BodyLimitError) return publicError(413);
      return publicError(502);
    }
  }
}

async function readJson(
  request: Request,
  limit = 128 * 1024,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    (request.headers.get("content-type") ?? "").split(";", 1)[0].trim()
      .toLowerCase() !== "application/json"
  ) throw new ValidationError("application/json required");
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)
  ) throw new ValidationError("request body too large");
  if (!request.body) throw new ValidationError("request body required");
  const reader = request.body.getReader();
  const abort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ValidationError("request body too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (signal?.aborted) {
      throw new ValidationError("control request cancelled or timed out");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const names = new Set(allowed);
  if (Object.keys(value).some((name) => !names.has(name))) {
    throw new ValidationError("unknown request field");
  }
}

function publicEnrollment(value: Enrollment): Record<string, unknown> {
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    publicKey: value.publicKey,
    state: value.state,
    verificationPhrase: value.verificationPhrase,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function emptyGrant() {
  return {
    hostnameSuffixes: [],
    exactHostnames: [],
    protocols: [],
    maxRoutes: 1,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function text(value: string, status: number): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function publicError(status: number): Response {
  return new Response("tunnel unavailable\n", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isLoopback(address?: Deno.Addr): boolean {
  return address?.transport === "tcp" &&
    ["127.0.0.1", "::1"].includes(address.hostname);
}

function remoteAddress(info?: Deno.ServeHandlerInfo): string {
  return info?.remoteAddr.transport === "tcp" ? info.remoteAddr.hostname : "unknown";
}

function requestHostname(request: Request): string {
  try {
    const raw = request.headers.get("host") ?? "";
    if (/[@/\\\s\0]/.test(raw)) return "";
    const url = new URL(`http://${raw}`);
    if (
      url.username || url.password || url.pathname !== "/" || url.search || url.hash
    ) {
      return "";
    }
    return normalizeHostname(url.hostname);
  } catch {
    return "";
  }
}

function isReservedPath(path: string): boolean {
  return ["/api", "/.well-known", "/_bunny"].some((prefix) =>
    path === prefix || path.startsWith(`${prefix}/`)
  );
}

class BodyLimitError extends Error {}

function limitedBody(
  body: ReadableStream<Uint8Array>,
  maximum: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maximum) throw new BodyLimitError();
        controller.enqueue(chunk);
      },
    }),
  );
}

async function proxyHttp(
  request: Request,
  headers: Headers,
  port: number,
  requestTimeoutMs: number,
  shutdownSignal: AbortSignal,
  clientCompleted: Promise<void> | undefined,
  finish: () => void,
): Promise<Response> {
  const url = new URL(request.url);
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(headers),
  });
  const requestReader = request.body?.getReader();
  let completed = false;
  let rejectCancellation!: (reason: Error) => void;
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  cancellationPromise.catch(() => {});
  const abort = () => {
    if (!completed) {
      upstream.destroy();
      requestReader?.cancel().catch(() => {});
      rejectCancellation(new Error("public request cancelled"));
    }
  };
  if (clientCompleted) clientCompleted.then(abort, abort);
  else request.signal.addEventListener("abort", abort, { once: true });
  shutdownSignal.addEventListener("abort", abort, { once: true });
  let rejectTimeout!: (reason: Error) => void;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  timeoutPromise.catch(() => {});
  const timeout = setTimeout(() => {
    const error = new Error("public request timed out");
    upstream.destroy();
    rejectTimeout(error);
  }, requestTimeoutMs);
  const responsePromise = new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      upstream.once("response", resolve);
      upstream.once("error", reject);
    },
  );
  responsePromise.catch(() => {});
  const complete = () => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    if (!clientCompleted) request.signal.removeEventListener("abort", abort);
    shutdownSignal.removeEventListener("abort", abort);
    requestReader?.cancel().catch(() => {});
    finish();
  };
  const upload = (async () => {
    if (requestReader) {
      let size = 0;
      try {
        while (true) {
          const { done, value } = await requestReader.read();
          if (done) break;
          size += value.byteLength;
          if (size > LIMITS.maxBodyBytes) {
            throw new BodyLimitError();
          }
          if (!upstream.write(value)) await once(upstream, "drain");
        }
      } finally {
        requestReader.releaseLock();
      }
    }
    upstream.end();
    return await new Promise<never>(() => {});
  })();
  upload.catch(() => {});
  try {
    const response = await Promise.race([
      responsePromise,
      timeoutPromise,
      cancellationPromise,
      upload,
    ]);
    const responseHeaders = new Headers();
    for (const [name, values] of Object.entries(response.headersDistinct)) {
      for (const value of values ?? []) responseHeaders.append(name, value);
    }
    response.once("end", complete);
    response.once("close", complete);
    const status = response.statusCode ?? 502;
    const safeHeaders = secureResponseHeaders(responseHeaders);
    if (request.method === "HEAD" || [204, 205, 304].includes(status)) {
      upstream.destroy();
      response.destroy();
      complete();
      return new Response(null, { status, headers: safeHeaders });
    }
    return new Response(
      limitedBody(
        Readable.toWeb(response) as ReadableStream<Uint8Array>,
        LIMITS.maxBodyBytes,
      ),
      {
        status,
        headers: safeHeaders,
      },
    );
  } catch (error) {
    upstream.destroy();
    requestReader?.cancel().catch(() => {});
    complete();
    throw error;
  }
}

function passkeyPage(): Response {
  return ceremonyPage(
    "Register a Bunny Hole passkey",
    `
const options=await post('/api/v1/admin/passkeys/registration/options',{flowToken:token});
options.challenge=decode(options.challenge);options.user.id=decode(options.user.id);
options.excludeCredentials=(options.excludeCredentials||[]).map(item=>({...item,id:decode(item.id)}));
return options;`,
    `
const credential=await navigator.credentials.create({publicKey:options});
await post('/api/v1/admin/passkeys/registration',{flowToken:token,response:registration(credential)});
status.textContent='Passkey registered. You may close this page.';`,
  );
}

function approvalPage(): Response {
  return ceremonyPage(
    "Approve a Bunny Hole enrollment",
    `
const value=await post('/api/v1/admin/enrollment-approvals/options',{flowToken:token});
const enrollment=value.enrollment;const grants=value.grants;
details.textContent=[
'Enrollment: '+enrollment.name,
'Identity: '+enrollment.id,
'Verification phrase: '+enrollment.verificationPhrase,
'Exact hostnames: '+(grants.exactHostnames.join(', ')||'None'),
'Hostname suffixes: '+(grants.hostnameSuffixes.join(', ')||'None'),
'Origin protocols: '+grants.protocols.join(', '),
'Maximum routes: '+grants.maxRoutes,
'Public viewers do not need Bunny Hole credentials. Your application must protect private content.'
].join('\\n');
const options=value.options;options.challenge=decode(options.challenge);
options.allowCredentials=(options.allowCredentials||[]).map(item=>({...item,id:decode(item.id)}));
return options;`,
    `
const credential=await navigator.credentials.get({publicKey:options});
await post('/api/v1/admin/enrollment-approvals/complete',{flowToken:token,response:authentication(credential)});
status.textContent='Enrollment approved. You may close this page.';`,
  );
}

function ceremonyPage(title: string, prepare: string, action: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:system-ui;max-width:48rem;margin:1rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{min-height:44px;padding:.5rem 1rem}</style></head><body><main><h1>${title}</h1><p>Verify the management hostname and the details below before continuing.</p><pre id="details" tabindex="0" aria-label="Enrollment and grant details"></pre><button id="continue" disabled aria-describedby="status">Continue with passkey</button><p id="status" role="status" aria-live="polite" aria-atomic="true">Loading ceremony details…</p><noscript>JavaScript is required to use a passkey. Open this link in a browser with JavaScript enabled.</noscript></main><script>
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const status=document.querySelector('#status'),details=document.querySelector('#details');
const encode=value=>{const bytes=new Uint8Array(value);let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')};
const decode=value=>{const normalized=value.replaceAll('-','+').replaceAll('_','/');return Uint8Array.from(atob(normalized+'='.repeat((4-normalized.length%4)%4)),character=>character.charCodeAt(0))};
const post=async(path,body)=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error('The host rejected this ceremony');return await response.json()};
const registration=credential=>({id:credential.id,rawId:encode(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment,response:{clientDataJSON:encode(credential.response.clientDataJSON),attestationObject:encode(credential.response.attestationObject),transports:credential.response.getTransports?.()||[]},clientExtensionResults:credential.getClientExtensionResults()});
const authentication=credential=>({id:credential.id,rawId:encode(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment,response:{clientDataJSON:encode(credential.response.clientDataJSON),authenticatorData:encode(credential.response.authenticatorData),signature:encode(credential.response.signature),userHandle:credential.response.userHandle?encode(credential.response.userHandle):undefined},clientExtensionResults:credential.getClientExtensionResults()});
const button=document.querySelector('#continue');let options;
const failed=error=>{status.textContent=error instanceof Error?error.message:'Ceremony failed'};
const prepare=async()=>{${prepare}};
(async()=>{try{if(!token)throw new Error('This ceremony link is incomplete');options=await prepare();status.textContent='Ready. Verify the details before continuing.';button.disabled=false}catch(error){failed(error)}})();
button.onclick=async()=>{button.disabled=true;status.textContent='Waiting for passkey verification…';try{${action}}catch(error){failed(error);if(error?.name==='NotAllowedError'||error?.name==='AbortError'){button.disabled=false;status.textContent='Passkey verification cancelled. You can try again.'}else{status.textContent+=' Request a new ceremony link from the CLI.'}}};
</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
