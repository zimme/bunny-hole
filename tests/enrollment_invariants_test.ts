import { DatabaseSync } from "node:sqlite";
import { HostStore } from "../apps/host/store.ts";
import type { Enrollment } from "../packages/api/mod.ts";
import { assertEquals, assertThrows } from "./assert.ts";

function enrollment(): Enrollment {
  return {
    id: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    name: "model",
    kind: "device",
    publicKey: "synthetic-model-key",
    verificationPhrase: "synthetic",
    state: "pending",
    grants: { exactHostnames: [], hostnameSuffixes: [], protocols: [], maxRoutes: 1 },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

Deno.test("enrollment invariants: all bounded approval and revocation sequences", () => {
  // The reference model only knows eligibility and terminal revocation. It does not
  // share SQL, guards, or transition helpers with the implementation.
  for (let sequence = 0; sequence < 64; sequence++) {
    using store = new HostStore(":memory:");
    const value = enrollment();
    store.createEnrollment(value);
    let approved = false;
    let revoked = false;
    for (let step = 0; step < 6; step++) {
      if ((sequence >> step) & 1) {
        assertEquals(store.revokeEnrollment(value.id), !revoked);
        revoked = true;
      } else {
        assertEquals(
          store.approveEnrollment(value.id, value.grants),
          !approved && !revoked,
        );
        if (!revoked) approved = true;
      }
      assertEquals(
        store.getEnrollment(value.id)?.state,
        revoked ? "revoked" : approved ? "active" : "pending",
      );
    }
  }
});

Deno.test("enrollment invariants: SQLite rejects impossible states and revoked resurrection", async () => {
  const directory = await Deno.makeTempDir();
  try {
    using store = new HostStore(`${directory}/state.sqlite`);
    const value = enrollment();
    assertThrows(
      () => store.createEnrollment({ ...value, expiresAt: null }),
      /invalid enrollment/,
    );
    store.createEnrollment(value);
    const database = new DatabaseSync(`${directory}/state.sqlite`);
    try {
      assertThrows(
        () => database.exec("UPDATE enrollments SET status='unknown'"),
        /invalid enrollment/,
      );
      assertThrows(
        () => database.exec("UPDATE enrollments SET status='active'"),
        /invalid enrollment/,
      );
      assertEquals(store.approveEnrollment(value.id, value.grants), true);
      assertThrows(
        () =>
          database.exec(
            "UPDATE enrollments SET status='pending',expires_at='2099-01-01'",
          ),
        /invalid enrollment/,
      );
      assertEquals(store.revokeEnrollment(value.id), true);
      assertThrows(
        () => database.exec("UPDATE enrollments SET status='active',expires_at=NULL"),
        /invalid enrollment/,
      );
      assertEquals(store.getEnrollment(value.id)?.state, "revoked");
    } finally {
      database.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
