import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import worker from "../notifications-worker/index.js";
import { firestorePickVersion, PICK_PROJECTION_SQL, pickProjectionBindings } from "../notifications-worker/pick-projection.js";

const db = new DatabaseSync(":memory:");
db.exec(await readFile(new URL("../notifications-worker/schema.sql", import.meta.url), "utf8"));
const bindObject = (values) => Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
function statement(sql, values = []) {
  return {
    bind: (...bound) => statement(sql, bound),
    run: async () => ({ meta: { changes: db.prepare(sql).run(bindObject(values)).changes } }),
    first: async () => db.prepare(sql).get(bindObject(values)) || null,
    all: async () => ({ results: db.prepare(sql).all(bindObject(values)) })
  };
}
const env = { DB: {
  prepare: statement,
  batch: async (statements) => {
    db.exec("BEGIN");
    try {
      const results = [];
      for (const item of statements) results.push(await item.run());
      db.exec("COMMIT");
      return results;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
} };

const uid = "player-one";
const actorUid = "administrator";
const matchId = "14-motor-wisla-plock";
const correctionId = "correction-first";
const base = "seasons/2026-27";
const canonicalPath = `${base}/players/${uid}/picks/${matchId}`;
const auditPath = `${base}/adminPickCorrections/${correctionId}`;
const before = "2026-11-07T12:00:00.123456Z";
const after = "2026-11-07T12:00:00.123457Z";
const afterAgain = "2026-11-07T12:00:00.123458Z";
const documents = new Map();
let identityEmail = "mateuszjoe@gmail.com";
let identityUid = actorUid;
let identityVerified = true;
let identityProvider = "google.com";
function encode(value, key) {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (["createdAt", "updatedAt"].includes(key)) return { timestampValue: value };
  return { stringValue: value };
}
function setDocument(path, data, updateTime = after) {
  documents.set(path, {
    name: `projects/ekstraklasa-typer-2026-27/databases/(default)/documents/${path}`,
    fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value, key)])),
    createTime: before, updateTime
  });
}
function setAudit(overrides = {}) {
  setDocument(auditPath, { uid, matchId, actorUid, oldPick: "", newPick: "1", reason: "Awaria aplikacji", createdAt: after, ...overrides });
}
setDocument(`${base}/participants/${actorUid}`, { uid: actorUid, seasonId: "2026-27", status: "active" });
setDocument(`${base}/participants/${uid}`, { uid, seasonId: "2026-27", status: "active" });
setDocument(`${base}/matches/${matchId}`, { matchday: 14 });
setDocument(canonicalPath, { pick: "1", correctionId, updatedAt: after });
setAudit();

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).startsWith("https://identitytoolkit.googleapis.com/")) {
    return Response.json({ users: [{ localId: identityUid, email: identityEmail,
      emailVerified: identityVerified,
      providerUserInfo: [{ providerId: identityProvider, email: identityEmail, displayName: "Test user" }] }] });
  }
  const prefix = "https://firestore.googleapis.com/v1/projects/ekstraklasa-typer-2026-27/databases/(default)/documents/";
  assert.ok(String(url).startsWith(prefix), "No unexpected outbound requests");
  const document = documents.get(decodeURIComponent(String(url).slice(prefix.length)));
  return document ? Response.json(document) : Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
};
async function request(body = { uid, matchId, correctionId }, { authenticated = true, path = "/api/admin/picks/sync" } = {}) {
  const response = await worker.fetch(new Request(`https://example.test${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${"testtoken".repeat(15)}` } : {}) },
    body: JSON.stringify(body)
  }), env);
  return { status: response.status, body: await response.json() };
}
function stored() { return db.prepare("SELECT * FROM picks WHERE uid=? AND match_id=?").get(uid, matchId); }

try {
  assert.equal((await request(undefined, { authenticated: false })).status, 401);
  identityEmail = "ordinary@example.test";
  assert.equal((await request()).status, 403, "A participant cannot call admin sync");
  identityEmail = "mateuszjoe@gmail.com";
  identityVerified = false;
  assert.equal((await request()).status, 401, "Unverified admin email is insufficient");
  identityVerified = true;
  identityProvider = "password";
  assert.equal((await request()).status, 401, "Google provider remains mandatory");
  identityProvider = "google.com";
  assert.equal(stored(), undefined);

  assert.equal((await request({ uid, matchId, correctionId, pick: "2" })).status, 400, "Client cannot inject a pick");
  assert.equal((await request({ uid, matchId: "unregistered-match", correctionId })).status, 400);
  setAudit({ actorUid: "another-admin" });
  assert.equal((await request()).status, 409);
  setAudit({ uid: "someone-else" });
  assert.equal((await request()).status, 409);
  setAudit({ newPick: "2" });
  assert.equal((await request()).status, 409, "Canonical/audit mismatch is rejected");
  setAudit();
  setDocument(`${base}/participants/${uid}`, { uid, seasonId: "2026-27", status: "removed", disabled: true });
  assert.equal((await request()).status, 403);
  setDocument(`${base}/participants/${uid}`, { uid, seasonId: "2026-27", status: "active" });
  assert.equal(stored(), undefined);

  let result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "synced");
  assert.equal(stored().pick, "1");
  assert.equal(stored().firestore_updated_at, firestorePickVersion(after));
  const receiptTime = stored().verified_at;
  assert.equal((await request()).status, 200);
  assert.equal(stored().verified_at, receiptTime, "Equal version is an idempotent no-op");

  // An older player sync that finishes after the admin request cannot revert it.
  const stale = { matchId, matchday: 14, pick: "2", updateTime: before };
  db.prepare(PICK_PROJECTION_SQL).run(bindObject(pickProjectionBindings(uid, stale, receiptTime + 1000)));
  assert.equal(stored().pick, "1");
  assert.equal(stored().firestore_updated_at, firestorePickVersion(after));

  // Same-millisecond writes retain all fractional timestamp digits.
  setDocument(canonicalPath, { pick: "X", updatedAt: afterAgain }, afterAgain);
  result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "superseded");
  assert.equal(result.body.pick, "X");
  assert.equal(stored().pick, "X", "Retry projects latest canonical value, never old audit content");

  // Normal owner sync uses exactly the same ordering guard and still rejects mismatches.
  identityUid = uid;
  identityEmail = "ordinary@example.test";
  result = await request({ picks: [{ matchId, pick: "1" }] }, { path: "/api/picks/sync" });
  assert.equal(result.body.status, "rejected");
  assert.equal(stored().pick, "X");
  result = await request({ picks: [{ matchId, pick: "X" }] }, { path: "/api/picks/sync" });
  assert.equal(result.body.status, "synced");
  assert.equal(stored().pick, "X");
  assert.equal(stored().firestore_updated_at, firestorePickVersion(afterAgain));

  // Report supersession accurately even if this handler's Firestore read was
  // overtaken before its guarded upsert reached D1.
  identityUid = actorUid;
  identityEmail = "mateuszjoe@gmail.com";
  setDocument(canonicalPath, { pick: "1", correctionId, updatedAt: after }, after);
  result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "superseded");
  assert.equal(result.body.pick, "X");
  assert.equal(stored().pick, "X");

  assert.equal(firestorePickVersion("2026-11-07T12:00:00Z"), "2026-11-07T12:00:00.000000000Z");
  assert.throws(() => firestorePickVersion(""));
  console.log("Admin pick sync: authentication, audit, inactive players, canonical-only writes, idempotency and out-of-order SQL writes passed.");
} finally {
  globalThis.fetch = originalFetch;
  db.close();
}
