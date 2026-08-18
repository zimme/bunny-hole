import { decodeBase64Url, encodeBase64Url, ProtocolError } from "./mod.ts";

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

export interface TunnelKeyPair {
  publicKey: string;
  privateKey: string;
}

export async function timingSafeEqualText(
  expected: string,
  supplied: string,
): Promise<boolean> {
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const left = new Uint8Array(expectedDigest);
  const right = new Uint8Array(suppliedDigest);
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function createNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function generateTunnelKeyPair(): Promise<TunnelKeyPair> {
  const pair = await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in pair)) throw new ProtocolError("key generation failed");
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const encodedPrivateKey = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  if (
    publicKey.length !== 32 || encodedPrivateKey.length !== 48 ||
    !privateKeyPrefix.every((byte, index) => encodedPrivateKey[index] === byte)
  ) throw new ProtocolError("key generation returned an unexpected format");
  return {
    publicKey: encodeBase64Url(publicKey),
    privateKey: encodeBase64Url(encodedPrivateKey.subarray(privateKeyPrefix.length)),
  };
}

export function validateTunnelPublicKey(value: string): void {
  try {
    if (decodeBase64Url(value).length === 32) return;
  } catch {
    // Normalize encoding and length failures for configuration diagnostics.
  }
  throw new ProtocolError("invalid tunnel public key");
}

export function validateTunnelPrivateKey(value: string): void {
  try {
    if (decodeBase64Url(value).length === 32) return;
  } catch {
    // Normalize encoding and length failures for configuration diagnostics.
  }
  throw new ProtocolError("invalid tunnel private key");
}

export async function signChallenge(
  privateKey: string,
  tunnelId: string,
  nonce: string,
  version: number,
): Promise<string> {
  const seed = decodeBase64Url(privateKey);
  if (seed.length !== 32) throw new ProtocolError("invalid tunnel private key");
  const encodedPrivateKey = new Uint8Array(privateKeyPrefix.length + seed.length);
  encodedPrivateKey.set(privateKeyPrefix);
  encodedPrivateKey.set(seed, privateKeyPrefix.length);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    encodedPrivateKey.buffer as ArrayBuffer,
    "Ed25519",
    false,
    ["sign"],
  );
  const message = authenticationMessage(tunnelId, nonce, version);
  return encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", key, message.buffer as ArrayBuffer),
    ),
  );
}

export async function verifyChallengeSignature(
  publicKey: string,
  tunnelId: string,
  nonce: string,
  version: number,
  signature: string,
): Promise<boolean> {
  try {
    const publicKeyBytes = decodeBase64Url(publicKey);
    if (publicKeyBytes.length !== 32) return false;
    const signatureBytes = decodeBase64Url(signature);
    if (signatureBytes.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes.buffer as ArrayBuffer,
      "Ed25519",
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      signatureBytes.buffer as ArrayBuffer,
      authenticationMessage(tunnelId, nonce, version).buffer as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

function authenticationMessage(
  tunnelId: string,
  nonce: string,
  version: number,
): Uint8Array {
  return encoder.encode(
    `bunny-hole\0connector-auth\0${version}\0${tunnelId}\0${nonce}`,
  );
}
