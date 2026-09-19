import { decodeBase64Url, encodeBase64Url, ValidationError } from "./mod.ts";

const encoder = new TextEncoder();
const privateKeyPrefix = new Uint8Array([
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
]);

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!("publicKey" in pair)) throw new ValidationError("key generation failed");
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const privateDer = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  if (publicKey.length !== 32 || privateDer.length !== 48) {
    throw new ValidationError("unexpected key format");
  }
  return {
    publicKey: encodeBase64Url(publicKey),
    privateKey: encodeBase64Url(privateDer.subarray(privateKeyPrefix.length)),
  };
}

export function createChallenge(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function sign(
  privateKey: string,
  purpose: string,
  fields: string[],
): Promise<string> {
  const seed = decodeBase64Url(privateKey);
  if (seed.length !== 32) throw new ValidationError("invalid private key");
  const der = new Uint8Array(privateKeyPrefix.length + seed.length);
  der.set(privateKeyPrefix);
  der.set(seed, privateKeyPrefix.length);
  const key = await crypto.subtle.importKey("pkcs8", der, "Ed25519", false, ["sign"]);
  return encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key,
        buffer(signedMessage(purpose, fields)),
      ),
    ),
  );
}

export async function verify(
  publicKey: string,
  purpose: string,
  fields: string[],
  signature: string,
): Promise<boolean> {
  try {
    const raw = decodeBase64Url(publicKey);
    const signatureBytes = decodeBase64Url(signature);
    if (raw.length !== 32 || signatureBytes.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      buffer(raw),
      "Ed25519",
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      buffer(signatureBytes),
      buffer(signedMessage(purpose, fields)),
    );
  } catch {
    return false;
  }
}

export function validatePublicKey(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("invalid public key");
  try {
    if (decodeBase64Url(value).length === 32) return value;
  } catch {
    // Return one normalized configuration error.
  }
  throw new ValidationError("invalid public key");
}

export async function fingerprint(publicKey: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", buffer(decodeBase64Url(publicKey))),
  );
  return [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0"))
    .join(":");
}

export async function verificationPhrase(publicKey: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", buffer(decodeBase64Url(publicKey))),
  );
  const words = [
    "amber",
    "birch",
    "coral",
    "drift",
    "ember",
    "frost",
    "grove",
    "harbor",
    "indigo",
    "juniper",
    "kestrel",
    "lumen",
    "meadow",
    "north",
    "opal",
    "pine",
  ];
  return [...digest.subarray(0, 5)].map((byte) => words[byte & 15]).join("-");
}

function signedMessage(purpose: string, fields: string[]): Uint8Array {
  if (
    !/^[a-z0-9-]{1,64}$/.test(purpose) || fields.some((field) => field.includes("\0"))
  ) {
    throw new ValidationError("invalid signature context");
  }
  return encoder.encode(`bunny-hole\0${purpose}\0${fields.join("\0")}`);
}

function buffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
