import { generateKeyPair, sign, verify } from "../../packages/api/auth.ts";
import type { KeyPair } from "../../packages/api/auth.ts";
import { dirname } from "node:path";
import { decodeBase64Url, isRecord, ValidationError } from "../../packages/api/mod.ts";

export async function loadOrCreateIdentity(path: string): Promise<KeyPair> {
  try {
    const info = await Deno.stat(path);
    if (info.mode !== null && (info.mode & 0o077) !== 0) {
      throw new ValidationError("host identity file permissions are too broad");
    }
    const identity = parseIdentity(JSON.parse(await Deno.readTextFile(path)));
    const proof = await sign(identity.privateKey, "identity-check", [
      identity.publicKey,
    ]);
    if (
      !(await verify(identity.publicKey, "identity-check", [identity.publicKey], proof))
    ) {
      throw new ValidationError("host identity key pair does not match");
    }
    return identity;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const identity = await generateKeyPair();
  await Deno.mkdir(dirname(path), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${path}.${crypto.randomUUID()}.new`;
  try {
    await Deno.writeTextFile(temporary, `${JSON.stringify(identity)}\n`, {
      createNew: true,
      mode: 0o600,
    });
    await Deno.rename(temporary, path);
  } finally {
    await Deno.remove(temporary).catch(() => {});
  }
  return identity;
}

function parseIdentity(value: unknown): KeyPair {
  if (
    !isRecord(value) || typeof value.publicKey !== "string" ||
    typeof value.privateKey !== "string" ||
    decodeBase64Url(value.publicKey).length !== 32 ||
    decodeBase64Url(value.privateKey).length !== 32
  ) throw new ValidationError("invalid host identity file");
  return { publicKey: value.publicKey, privateKey: value.privateKey };
}
