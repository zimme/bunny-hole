import { calculateBackoffDelay } from "../apps/connector/connector.ts";
import { assertEquals } from "./assert.ts";

Deno.test("connector backoff jitter is bounded and deterministically injectable", () => {
  assertEquals(calculateBackoffDelay(500, () => 0), 400);
  assertEquals(calculateBackoffDelay(500, () => 200 / 201), 600);
  assertEquals(calculateBackoffDelay(30_000, () => 0), 24_000);
  assertEquals(calculateBackoffDelay(30_000, () => 12_000 / 12_001), 36_000);
});
