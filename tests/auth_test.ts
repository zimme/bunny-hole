import {
  createNonce,
  createProof,
  createSecret,
  verifyProof,
} from "../packages/protocol/auth.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("challenge response authenticates without transmitting the secret", async () => {
  const secret = createSecret();
  const nonce = createNonce();
  const proof = await createProof(secret, "my-tunnel", nonce, 1);
  assert(!proof.includes(secret));
  assert(await verifyProof(secret, "my-tunnel", nonce, 1, proof));
  assertEquals(await verifyProof(secret, "other", nonce, 1, proof), false);
  assertEquals(await verifyProof(secret, "my-tunnel", createNonce(), 1, proof), false);
  assertEquals(await verifyProof(createSecret(), "my-tunnel", nonce, 1, proof), false);
  assertEquals(await verifyProof(secret, "my-tunnel", nonce, 2, proof), false);
  assertEquals(await verifyProof(secret, "my-tunnel", nonce, 1, "malformed"), false);
});

Deno.test("generated secrets and nonces are unique and sufficiently strong", () => {
  const secrets = new Set(Array.from({ length: 50 }, createSecret));
  const nonces = new Set(Array.from({ length: 50 }, createNonce));
  assertEquals(secrets.size, 50);
  assertEquals(nonces.size, 50);
  assert([...secrets].every((secret) => secret.length >= 43));
});
