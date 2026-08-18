import {
  createNonce,
  generateTunnelKeyPair,
  signChallenge,
  verifyChallengeSignature,
} from "../packages/protocol/auth.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("challenge response authenticates without exposing the private key", async () => {
  const keys = await generateTunnelKeyPair();
  const nonce = createNonce();
  const signature = await signChallenge(keys.privateKey, "my-tunnel", nonce, 1);
  assert(!signature.includes(keys.privateKey));
  assert(
    await verifyChallengeSignature(keys.publicKey, "my-tunnel", nonce, 1, signature),
  );
  assertEquals(
    await verifyChallengeSignature(keys.publicKey, "other", nonce, 1, signature),
    false,
  );
  assertEquals(
    await verifyChallengeSignature(
      keys.publicKey,
      "my-tunnel",
      createNonce(),
      1,
      signature,
    ),
    false,
  );
  const other = await generateTunnelKeyPair();
  assertEquals(
    await verifyChallengeSignature(other.publicKey, "my-tunnel", nonce, 1, signature),
    false,
  );
  assertEquals(
    await verifyChallengeSignature(keys.publicKey, "my-tunnel", nonce, 2, signature),
    false,
  );
  assertEquals(
    await verifyChallengeSignature(keys.publicKey, "my-tunnel", nonce, 1, "malformed"),
    false,
  );
});

Deno.test("generated tunnel keys and nonces are unique and correctly sized", async () => {
  const pairs = await Promise.all(
    Array.from({ length: 20 }, () => generateTunnelKeyPair()),
  );
  const nonces = new Set(Array.from({ length: 50 }, createNonce));
  assertEquals(new Set(pairs.map((pair) => pair.publicKey)).size, 20);
  assertEquals(new Set(pairs.map((pair) => pair.privateKey)).size, 20);
  assertEquals(nonces.size, 50);
  assert(pairs.every((pair) => pair.publicKey.length === 43));
  assert(pairs.every((pair) => pair.privateKey.length === 43));
});
