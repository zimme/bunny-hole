import { sign, verify } from "../../packages/api/auth.ts";
import {
  createId,
  decodeBase64Url,
  encodeBase64Url,
  isRecord,
  ValidationError,
} from "../../packages/api/mod.ts";

export interface SessionClaims {
  enrollmentId: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

export async function issueSessionToken(
  privateKey: string,
  enrollmentId: string,
  now = Date.now(),
  lifetimeMs = 5 * 60_000,
): Promise<{ token: string; claims: SessionClaims }> {
  const claims: SessionClaims = {
    enrollmentId,
    jti: createId("ses"),
    issuedAt: now,
    expiresAt: now + lifetimeMs,
  };
  const body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  return {
    token: `${body}.${await sign(privateKey, "session-token", [body])}`,
    claims,
  };
}

export async function verifySessionToken(
  publicKey: string,
  token: string,
  now = Date.now(),
): Promise<SessionClaims | undefined> {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra || body.length > 512 || signature.length > 128) {
    return undefined;
  }
  if (!(await verify(publicKey, "session-token", [body], signature))) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(body)));
    if (
      !isRecord(value) || typeof value.enrollmentId !== "string" ||
      typeof value.jti !== "string" || typeof value.issuedAt !== "number" ||
      typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.issuedAt) ||
      !Number.isSafeInteger(value.expiresAt) || value.issuedAt > now + 30_000 ||
      value.expiresAt < now || value.expiresAt - value.issuedAt > 10 * 60_000
    ) return undefined;
    return value as unknown as SessionClaims;
  } catch {
    return undefined;
  }
}

export function bearerToken(request: Request): string {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ") || value.length > 1_024) {
    throw new ValidationError("authentication required");
  }
  return value.slice(7);
}
