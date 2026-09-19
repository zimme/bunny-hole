import { isForbiddenTrackedArtifact } from "../scripts/generated_check.ts";
import { assertEquals } from "./assert.ts";

Deno.test("generated-file policy permits templates but rejects artifacts and secrets", () => {
  for (const path of [".env.example", "fixtures/demo/.env.example", "docs/env.md"]) {
    assertEquals(isForbiddenTrackedArtifact(path), false);
  }
  for (
    const path of [
      ".env",
      ".env.local",
      "apps/relay/.env.production",
      "coverage/report.json",
      "apps/relay/dist/relay.js",
      "CHANGELOG.md",
    ]
  ) {
    assertEquals(isForbiddenTrackedArtifact(path), true);
  }
});
