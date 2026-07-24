import { decodeBase64Url, encodeBase64Url, ProtocolError } from "./mod.ts";

const encoder = new TextEncoder();

export function createSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function createNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function createProof(
  secret: string,
  tunnelId: string,
  nonce: string,
  version: number,
): Promise<string> {
  const keyBytes = decodeBase64Url(secret);
  if (keyBytes.length < 32) throw new ProtocolError("secret is too short");
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = encoder.encode(`bunny-hole\0${version}\0${tunnelId}\0${nonce}`);
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, message)),
  );
}

export async function verifyProof(
  expectedSecret: string,
  tunnelId: string,
  nonce: string,
  version: number,
  suppliedProof: string,
): Promise<boolean> {
  try {
    const expected = decodeBase64Url(
      await createProof(expectedSecret, tunnelId, nonce, version),
    );
    const supplied = decodeBase64Url(suppliedProof);
    if (expected.length !== supplied.length) {
      await crypto.subtle.digest(
        "SHA-256",
        new Uint8Array(supplied).buffer as ArrayBuffer,
      );
      return false;
    }
    let difference = 0;
    for (let index = 0; index < expected.length; index++) {
      difference |= expected[index] ^ supplied[index];
    }
    return difference === 0;
  } catch {
    return false;
  }
}
