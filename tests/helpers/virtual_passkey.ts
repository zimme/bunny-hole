import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { HostStore } from "../../apps/host/store.ts";
import { decodeBase64Url, encodeBase64Url } from "../../packages/api/mod.ts";
const origin = new URL("https://hole.example.com");
const encoder = new TextEncoder();
// A local authenticator signs real WebAuthn assertions so these tests exercise
// challenge ownership, origin/RP checks, signature verification, and counters together.
export async function virtualPasskey(store?: HostStore) {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  const publicKey = new Uint8Array([
    0xa5,
    0x01,
    0x02,
    0x03,
    0x26,
    0x20,
    0x01,
    0x21,
    0x58,
    0x20,
    ...raw.subarray(1, 33),
    0x22,
    0x58,
    0x20,
    ...raw.subarray(33),
  ]);
  const id = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  store?.savePasskey({
    id,
    name: "test authenticator",
    publicKey,
    counter: 0,
    transports: ["internal"],
    deviceType: "singleDevice",
    backedUp: false,
  });
  return {
    id,
    async registration(challenge: string): Promise<RegistrationResponseJSON> {
      const clientData = encoder.encode(
        JSON.stringify({
          type: "webauthn.create",
          challenge,
          origin: origin.origin,
          crossOrigin: false,
        }),
      );
      const rpHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(origin.hostname)),
      );
      const idBytes = decodeBase64Url(id);
      const authData = new Uint8Array([
        ...rpHash,
        0x45,
        0,
        0,
        0,
        0,
        ...new Uint8Array(16),
        0,
        idBytes.length,
        ...idBytes,
        ...publicKey,
      ]);
      const text = (value: string) => [0x60 + value.length, ...encoder.encode(value)];
      const attestation = new Uint8Array([
        0xa3,
        ...text("fmt"),
        ...text("none"),
        ...text("attStmt"),
        0xa0,
        ...text("authData"),
        0x58,
        authData.length,
        ...authData,
      ]);
      return {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: encodeBase64Url(clientData),
          attestationObject: encodeBase64Url(attestation),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    async assertion(challenge: string): Promise<AuthenticationResponseJSON> {
      const clientData = encoder.encode(JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: origin.origin,
        crossOrigin: false,
      }));
      const clientHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", clientData),
      );
      const rpHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(origin.hostname)),
      );
      const authenticatorData = new Uint8Array([...rpHash, 0x05, 0, 0, 0, 1]);
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key.privateKey,
          new Uint8Array([...authenticatorData, ...clientHash]),
        ),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: encodeBase64Url(clientData),
          authenticatorData: encodeBase64Url(authenticatorData),
          signature: encodeBase64Url(derSignature(signature)),
        },
        clientExtensionResults: {},
      };
    },
  };
}

function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): number[] => {
    let offset = 0;
    while (offset < bytes.length - 1 && bytes[offset] === 0) offset++;
    const value = [...bytes.subarray(offset)];
    if (value[0] & 0x80) value.unshift(0);
    return [0x02, value.length, ...value];
  };
  const integers = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return new Uint8Array([0x30, integers.length, ...integers]);
}
