import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { PasskeyService } from "../apps/host/passkeys.ts";
import { HostStore } from "../apps/host/store.ts";
import { encodeBase64Url } from "../packages/api/mod.ts";
import { assertEquals, assertRejects } from "./assert.ts";

const origin = new URL("https://hole.example.com");
const encoder = new TextEncoder();

Deno.test("passkey authentication binds the signed challenge to one approval flow", async () => {
  const directory = await Deno.makeTempDir();
  try {
    using store = new HostStore(`${directory}/state.sqlite`);
    const authenticator = await virtualPasskey(store);
    const service = new PasskeyService(store, origin);
    const first = await service.authenticationOptions("flow-first");
    await service.authenticationOptions("flow-second");
    const response = await authenticator.assertion(first.challenge);
    await assertRejects(
      () => service.authenticate(response, "flow-second"),
      /ceremony expired/,
    );
    await service.authenticate(response, "flow-first");
    assertEquals(store.listPasskeys()[0].counter, 1);
    await assertRejects(
      () => service.authenticate(response, "flow-first"),
      /ceremony expired/,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("reissuing passkey options invalidates the flow's previous challenge", async () => {
  const directory = await Deno.makeTempDir();
  try {
    using store = new HostStore(`${directory}/state.sqlite`);
    const authenticator = await virtualPasskey(store);
    const service = new PasskeyService(store, origin);
    const previous = await service.authenticationOptions("flow-first");
    const current = await service.authenticationOptions("flow-first");
    await assertRejects(
      async () =>
        await service.authenticate(
          await authenticator.assertion(previous.challenge),
          "flow-first",
        ),
      /ceremony expired/,
    );
    await service.authenticate(
      await authenticator.assertion(current.challenge),
      "flow-first",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("registration challenges are bound to one flow and replaced on reissue", async () => {
  const directory = await Deno.makeTempDir();
  try {
    using store = new HostStore(`${directory}/state.sqlite`);
    const service = new PasskeyService(store, origin);
    const first = await service.registrationOptions("flow-first");
    await service.registrationOptions("flow-second");
    const purpose = "register:flow-first";
    assertEquals(
      store.consumeAdminChallenge(first.challenge, "register:flow-second", Date.now()),
      false,
    );
    await service.registrationOptions("flow-first");
    assertEquals(
      store.consumeAdminChallenge(first.challenge, purpose, Date.now()),
      false,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

// A local authenticator signs real WebAuthn assertions so these tests exercise
// challenge ownership, origin/RP checks, signature verification, and counters together.
async function virtualPasskey(store: HostStore) {
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
  store.savePasskey({
    id,
    name: "test authenticator",
    publicKey,
    counter: 0,
    transports: ["internal"],
    deviceType: "singleDevice",
    backedUp: false,
  });
  return {
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
