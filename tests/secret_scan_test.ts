import { containsSecret } from "../scripts/secret_scan.ts";
import { assertEquals } from "./assert.ts";

Deno.test("secret scan recognizes serialized Bunny Hole private keys", () => {
  assertEquals(
    containsSecret(JSON.stringify({ privateKey: "A".repeat(43) })),
    true,
  );
  assertEquals(
    containsSecret(JSON.stringify({ publicKey: "A".repeat(43) })),
    false,
  );
});

Deno.test("secret scan recognizes GitHub refresh tokens", () => {
  assertEquals(containsSecret(`ghr_${"A".repeat(30)}`), true);
});
