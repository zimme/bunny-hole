import { DatabaseSync } from "node:sqlite";
import { LIMITS } from "../../packages/api/mod.ts";
import type {
  Enrollment,
  EnrollmentGrant,
  EnrollmentKind,
  Route,
} from "../../packages/api/mod.ts";

export class HostStore implements Disposable {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS enrollments (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        public_key TEXT NOT NULL UNIQUE, verification_phrase TEXT NOT NULL,
        status TEXT NOT NULL, grants TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
        name TEXT NOT NULL, protocol TEXT NOT NULL, hostname TEXT NOT NULL,
        target_host TEXT NOT NULL, target_port INTEGER NOT NULL,
        allow_private INTEGER NOT NULL,
        active INTEGER NOT NULL, UNIQUE(enrollment_id, name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
        value TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, subject TEXT NOT NULL, details TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL,
        counter INTEGER NOT NULL, transports TEXT NOT NULL,
        device_type TEXT NOT NULL, backed_up INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS admin_challenges (
        challenge TEXT PRIMARY KEY, purpose TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS routes_hostname ON routes(hostname);
      CREATE UNIQUE INDEX IF NOT EXISTS routes_hostname_unique ON routes(hostname);
      CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges(expires_at);
    `);
  }

  [Symbol.dispose](): void {
    this.#db.close();
  }

  createEnrollment(value: Enrollment): void {
    this.#db.prepare(`INSERT INTO enrollments
      (id,name,kind,public_key,verification_phrase,status,grants,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      value.id,
      value.name,
      value.kind,
      value.publicKey,
      value.verificationPhrase,
      value.state,
      JSON.stringify(value.grants),
      value.createdAt,
      value.expiresAt,
    );
    this.audit("public", "enrollment.created", value.id, { kind: value.kind });
  }

  pruneExpiredEnrollments(now: string): void {
    this.#db.prepare(
      "DELETE FROM enrollments WHERE status='pending' AND expires_at<?",
    ).run(now);
  }

  getEnrollment(id: string): Enrollment | undefined {
    const row = this.#db.prepare("SELECT * FROM enrollments WHERE id=?").get(id);
    return row ? enrollmentFromRow(row) : undefined;
  }

  getEnrollmentByPublicKey(publicKey: string): Enrollment | undefined {
    const row = this.#db.prepare("SELECT * FROM enrollments WHERE public_key=?").get(
      publicKey,
    );
    return row ? enrollmentFromRow(row) : undefined;
  }

  enrollmentCount(): number {
    const row = this.#db.prepare(
      "SELECT COUNT(*) AS count FROM enrollments WHERE status='active' OR (status='pending' AND expires_at>=?)",
    ).get(new Date().toISOString()) as Record<string, unknown>;
    return Number(row.count);
  }

  approveEnrollment(id: string, grants: EnrollmentGrant): boolean {
    const result = this.#db.prepare(
      "UPDATE enrollments SET status='active',grants=?,expires_at=NULL WHERE id=? AND status='pending' AND expires_at>=?",
    ).run(JSON.stringify(grants), id, new Date().toISOString());
    if (result.changes) this.audit("owner", "enrollment.approved", id, { grants });
    return result.changes === 1;
  }

  revokeEnrollment(id: string): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db.prepare(
        "UPDATE enrollments SET status='revoked' WHERE id=? AND status!='revoked'",
      ).run(id);
      if (result.changes) {
        this.#db.prepare("DELETE FROM routes WHERE enrollment_id=?").run(id);
        this.#db.prepare("DELETE FROM challenges WHERE enrollment_id=?").run(id);
        this.audit("owner", "enrollment.revoked", id, {});
      }
      this.#db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  saveChallenge(
    id: string,
    enrollmentId: string,
    value: string,
    expiresAt: number,
  ): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      this.#db.prepare("DELETE FROM challenges WHERE expires_at<? OR used=1").run(now);
      const count = this.#db.prepare(
        "SELECT COUNT(*) AS count FROM challenges WHERE enrollment_id=? AND used=0 AND expires_at>=?",
      ).get(enrollmentId, now) as Record<string, unknown>;
      if (Number(count.count) >= LIMITS.maxOutstandingChallengesPerEnrollment) {
        this.#db.exec("ROLLBACK");
        return false;
      }
      this.#db.prepare(
        "INSERT INTO challenges (id,enrollment_id,value,expires_at,used) VALUES (?,?,?,?,0)",
      ).run(id, enrollmentId, value, expiresAt);
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  consumeChallenge(id: string, enrollmentId: string, now: number): string | undefined {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare(
        "SELECT value FROM challenges WHERE id=? AND enrollment_id=? AND used=0 AND expires_at>=?",
      ).get(id, enrollmentId, now) as Record<string, unknown> | undefined;
      if (!row) {
        this.#db.exec("ROLLBACK");
        return undefined;
      }
      this.#db.prepare("UPDATE challenges SET used=1 WHERE id=?").run(id);
      this.#db.exec("COMMIT");
      return String(row.value);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  createRoute(
    route: Route,
    maximum: number = LIMITS.maxRoutesPerEnrollment,
  ): "created" | "limit" | "name-conflict" | "hostname-conflict" {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const count = this.#db.prepare(
        "SELECT COUNT(*) AS count FROM routes WHERE enrollment_id=?",
      ).get(route.enrollmentId) as Record<string, unknown>;
      if (Number(count.count) >= maximum) {
        this.#db.exec("ROLLBACK");
        return "limit";
      }
      if (
        this.#db.prepare(
          "SELECT 1 FROM routes WHERE enrollment_id=? AND name=? LIMIT 1",
        ).get(route.enrollmentId, route.name)
      ) {
        this.#db.exec("ROLLBACK");
        return "name-conflict";
      }
      if (
        this.#db.prepare(
          "SELECT 1 FROM routes WHERE hostname=? LIMIT 1",
        ).get(route.hostname)
      ) {
        this.#db.exec("ROLLBACK");
        return "hostname-conflict";
      }
      this.#db.prepare(`INSERT INTO routes
        (id,enrollment_id,name,protocol,hostname,target_host,target_port,
         allow_private,active)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        route.id,
        route.enrollmentId,
        route.name,
        route.protocol,
        route.hostname,
        route.targetHost,
        route.targetPort,
        route.allowPrivateNetwork ? 1 : 0,
        route.active ? 1 : 0,
      );
      this.audit(route.enrollmentId, "route.created", route.id, {
        protocol: route.protocol,
        hostname: route.hostname,
      });
      this.#db.exec("COMMIT");
      return "created";
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listRoutes(enrollmentId?: string): Route[] {
    const rows = enrollmentId
      ? this.#db.prepare("SELECT * FROM routes WHERE enrollment_id=? ORDER BY id").all(
        enrollmentId,
      )
      : this.#db.prepare("SELECT * FROM routes ORDER BY id").all();
    return rows.map(routeFromRow);
  }

  deleteRoute(id: string, enrollmentId: string): boolean {
    const result = this.#db.prepare(
      "DELETE FROM routes WHERE id=? AND enrollment_id=?",
    ).run(id, enrollmentId);
    if (result.changes) this.audit(enrollmentId, "route.deleted", id, {});
    return result.changes === 1;
  }

  getRouteByHostname(hostname: string): Route | undefined {
    const row = this.#db.prepare(
      `SELECT routes.* FROM routes
       JOIN enrollments ON enrollments.id=routes.enrollment_id
       WHERE routes.hostname=? AND routes.active=1
         AND routes.protocol IN ('http','https') AND enrollments.status='active'`,
    ).get(hostname);
    return row ? routeFromRow(row) : undefined;
  }

  audit(actor: string, action: string, subject: string, details: unknown): void {
    this.#db.prepare(
      "INSERT INTO audit_events (at,actor,action,subject,details) VALUES (?,?,?,?,?)",
    ).run(new Date().toISOString(), actor, action, subject, JSON.stringify(details));
    this.#db.exec(`DELETE FROM audit_events WHERE id < COALESCE(
      (SELECT id FROM audit_events ORDER BY id DESC LIMIT 1 OFFSET 9999), 0
    )`);
  }

  saveAdminChallenge(challenge: string, purpose: string, expiresAt: number): void {
    this.#db.prepare(
      "DELETE FROM admin_challenges WHERE expires_at<? OR used=1",
    ).run(Date.now());
    this.#db.prepare(
      "INSERT INTO admin_challenges (challenge,purpose,expires_at,used) VALUES (?,?,?,0)",
    ).run(challenge, purpose, expiresAt);
  }

  consumeAdminChallenge(challenge: string, purpose: string, now: number): boolean {
    const result = this.#db.prepare(
      "UPDATE admin_challenges SET used=1 WHERE challenge=? AND purpose=? AND used=0 AND expires_at>=?",
    ).run(challenge, purpose, now);
    return result.changes === 1;
  }

  listPasskeys(): Array<{
    id: string;
    name: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
    deviceType: string;
    backedUp: boolean;
  }> {
    return this.#db.prepare("SELECT * FROM passkeys ORDER BY created_at").all().map((
      row,
    ) => ({
      id: String(row.id),
      name: String(row.name),
      publicKey: Uint8Array.from(
        atob(String(row.public_key)),
        (value) => value.charCodeAt(0),
      ),
      counter: Number(row.counter),
      transports: JSON.parse(String(row.transports)) as string[],
      deviceType: String(row.device_type),
      backedUp: Number(row.backed_up) === 1,
    }));
  }

  savePasskey(value: {
    id: string;
    name: string;
    publicKey: Uint8Array;
    counter: number;
    transports?: string[];
    deviceType: string;
    backedUp: boolean;
  }): void {
    let binary = "";
    for (const byte of value.publicKey) binary += String.fromCharCode(byte);
    this.#db.prepare(`INSERT INTO passkeys
      (id,name,public_key,counter,transports,device_type,backed_up,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      value.id,
      value.name,
      btoa(binary),
      value.counter,
      JSON.stringify(value.transports ?? []),
      value.deviceType,
      value.backedUp ? 1 : 0,
      new Date().toISOString(),
    );
    this.audit("owner", "passkey.registered", value.id, { name: value.name });
  }

  updatePasskeyCounter(id: string, counter: number): void {
    this.#db.prepare("UPDATE passkeys SET counter=? WHERE id=?").run(counter, id);
  }
}

function enrollmentFromRow(row: Record<string, unknown>): Enrollment {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind) as EnrollmentKind,
    publicKey: String(row.public_key),
    verificationPhrase: String(row.verification_phrase),
    state: String(row.status) as Enrollment["state"],
    grants: JSON.parse(String(row.grants)) as EnrollmentGrant,
    createdAt: String(row.created_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
  };
}

function routeFromRow(row: Record<string, unknown>): Route {
  return {
    id: String(row.id),
    enrollmentId: String(row.enrollment_id),
    name: String(row.name),
    protocol: String(row.protocol) as Route["protocol"],
    hostname: String(row.hostname),
    targetHost: String(row.target_host),
    targetPort: Number(row.target_port),
    allowPrivateNetwork: Number(row.allow_private) === 1,
    active: Number(row.active) === 1,
  };
}
