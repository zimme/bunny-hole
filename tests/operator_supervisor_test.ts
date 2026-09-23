import { connectorFingerprint, shouldRestartConnector } from "../apps/operator/main.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("operator does not restart a healthy connector for a freshly minted session", () => {
  const fingerprint = connectorFingerprint("enr_A", [{ id: "rte_A" }]);
  const supervisor = { fingerprint, renewAt: 10_000 };
  const freshSessionFingerprint = connectorFingerprint("enr_A", [{ id: "rte_A" }]);

  assertEquals(freshSessionFingerprint, fingerprint);
  assert(!shouldRestartConnector(supervisor, freshSessionFingerprint, 9_999));
  assert(shouldRestartConnector(supervisor, freshSessionFingerprint, 10_000));
});

Deno.test("operator restarts when the reconciled route set changes", () => {
  const current = {
    fingerprint: connectorFingerprint("enr_A", [{ id: "rte_A" }]),
    renewAt: 10_000,
  };
  const changed = connectorFingerprint("enr_A", [{ id: "rte_B" }]);
  assert(shouldRestartConnector(current, changed, 1));
});
