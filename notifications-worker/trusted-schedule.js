import { matches } from "../data.js";
import { getOfficialTrustedSchedule } from "../live-provider.js";

export const SCHEDULE_SERVICE_UID = "trusted-schedule-sync-2026-27";
export const SCHEDULE_STATE_KEY = "trusted_schedule_sync_v1";
const PROJECT = "ekstraklasa-typer-2026-27";
const API_KEY = "AIzaSyD3kgRWw3BROjcmulITWFXKcePgvhtpIDY";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const CLOSED_AT = "1970-01-01T00:00:00.000Z";
const HIDDEN_UNTIL = "9999-12-31T23:59:59.999Z";
const INTERVAL_MS = 5 * 60 * 1000;
const MATCHES = new Map(matches.map((match) => [match.id, match]));
const FINAL = new Set(["FT", "AWD"]);
const VALID_STATUS = new Set(["NS", "LIVE", "FT", "AWD", "PST", "SUSP", "CANC"]);
let authCache = null;
let authPromise = null;

function equalField(left, right) {
  if (right.timestampValue) return Date.parse(left?.timestampValue) === Date.parse(right.timestampValue);
  return JSON.stringify(left) === JSON.stringify(right);
}

export function planTrustedSchedule(fixtures, documents, now = Date.now()) {
  if (fixtures.length !== MATCHES.size || new Set(fixtures.map((fixture) => fixture.localMatchId)).size !== MATCHES.size) {
    throw new Error("schedule-incomplete");
  }
  const stored = new Map(documents.map((document) => [document.name.split("/").at(-1), document]));
  return fixtures.flatMap((fixture) => {
    const match = MATCHES.get(fixture.localMatchId);
    if (!match || fixture.matchday !== match.matchday || !VALID_STATUS.has(fixture.status)) {
      throw new Error("schedule-invalid-fixture");
    }
    const previous = stored.get(match.id);
    const previousResult = previous?.fields?.result?.stringValue || "";
    const previousStatus = previous?.fields?.status?.stringValue;
    // A final status is evidence that betting ended even if the score is still
    // unavailable. Retain it across regressed feeds so the next sync cannot
    // forget that evidence and reopen the fixture.
    const wasFinal = FINAL.has(previousStatus);
    const status = wasFinal && !FINAL.has(fixture.status) ? previousStatus : fixture.status;
    let kickoff = Date.parse(fixture.kickoffAt);
    const hasFinalResult = ["1", "X", "2"].includes(previousResult);
    const previousKickoff = Date.parse(previous?.fields?.closesAt?.timestampValue);
    const retainPastKickoff = (hasFinalResult || FINAL.has(status) || status === "LIVE")
      && (!fixture.kickoffConfirmed || !Number.isFinite(kickoff) || kickoff > now)
      && previousKickoff > 0 && previousKickoff <= now;
    if (retainPastKickoff) kickoff = previousKickoff;
    const confirmed = (retainPastKickoff || fixture.kickoffConfirmed === true) && Number.isFinite(kickoff)
      && status !== "CANC"
      && !((FINAL.has(status) || status === "LIVE" || hasFinalResult) && kickoff > now);
    const score = fixture.score;
    const result = FINAL.has(fixture.status) && Number.isInteger(score?.home) && score.home >= 0
      && Number.isInteger(score?.away) && score.away >= 0
      ? score.home > score.away ? "1" : score.home < score.away ? "2" : "X"
      : previousResult;
    const desired = {
      matchday: { integerValue: String(match.matchday) },
      closesAt: { timestampValue: confirmed ? new Date(kickoff).toISOString() : CLOSED_AT },
      revealsAt: { timestampValue: confirmed ? new Date(kickoff).toISOString() : HIDDEN_UNTIL },
      kickoffConfirmed: { booleanValue: confirmed },
      status: { stringValue: status },
      result: { stringValue: result },
      source: { stringValue: "ekstraklasa-match-center" }
    };
    const fields = Object.fromEntries(Object.entries(desired).filter(([key, value]) => !equalField(previous?.fields?.[key], value)));
    if (!Object.keys(fields).length) return [];
    if (previous && !previous.updateTime) throw new Error("schedule-missing-document-version");
    return [{
      id: match.id,
      expected: desired,
      write: {
        update: { name: `${ROOT}/seasons/2026-27/matches/${match.id}`, fields },
        updateMask: { fieldPaths: Object.keys(fields) },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
        currentDocument: previous ? { updateTime: previous.updateTime } : { exists: false }
      }
    }];
  });
}

export function verifyTrustedSchedule(changes, documents) {
  const stored = new Map(documents.map((document) => [document.name.split("/").at(-1), document]));
  for (const change of changes) {
    if (Object.entries(change.expected).some(([key, value]) => !equalField(stored.get(change.id)?.fields?.[key], value))) {
      throw new Error(`schedule-verification-failed:${change.id}`);
    }
  }
}

async function serviceToken(env) {
  const refreshToken = env.FIREBASE_SCHEDULE_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("schedule-service-not-configured");
  if (authCache?.secret === refreshToken && authCache.expiresAt > Date.now() + 60000) return authCache.token;
  if (authPromise) return authPromise;
  authPromise = (async () => {
    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(12000)
    });
    const payload = await response.json();
    if (!response.ok || payload.user_id !== SCHEDULE_SERVICE_UID || !payload.id_token) {
      throw new Error(`schedule-auth-failed:${response.status}`);
    }
    authCache = { secret: refreshToken, token: payload.id_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
    return authCache.token;
  })().finally(() => { authPromise = null; });
  return authPromise;
}

async function firestore(env, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${await serviceToken(env)}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    if (response.status === 401) authCache = null;
    throw new Error(`schedule-firestore-failed:${response.status}`);
  }
  return response.json();
}

async function readDocuments(env) {
  const documents = [];
  let cursor = "";
  for (let page = 0; page < 3; page += 1) {
    const payload = await firestore(env, `/seasons/2026-27/matches?pageSize=300${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`);
    documents.push(...(payload.documents || []));
    cursor = payload.nextPageToken || "";
    if (!cursor) return documents;
  }
  throw new Error("schedule-too-many-documents");
}

export async function readScheduleState(env) {
  const row = await env.DB.prepare("SELECT value FROM worker_state WHERE key = ?1").bind(SCHEDULE_STATE_KEY).first();
  try { return JSON.parse(row?.value || "{}"); } catch { return {}; }
}

async function saveState(env, value) {
  await env.DB.prepare(`INSERT INTO worker_state (key, value, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(SCHEDULE_STATE_KEY, JSON.stringify(value), Date.now()).run();
}

export async function syncTrustedSchedule(env, { force = false } = {}) {
  const previous = await readScheduleState(env);
  if (!force && Number(previous.nextAttemptAt) > Date.now()) return { status: "not-due" };
  const lease = crypto.randomUUID();
  const acquired = await env.DB.prepare(`INSERT INTO worker_state (key, value, updated_at) VALUES ('trusted_schedule_sync_lease', ?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE worker_state.updated_at < ?3 RETURNING value`)
    .bind(lease, Date.now(), Date.now() - 120000).first();
  if (acquired?.value !== lease) return { status: "busy" };
  try {
    // A complete fresh official snapshot is required before any database write.
    const schedule = await getOfficialTrustedSchedule({ force: true });
    const documents = await readDocuments(env);
    const changes = planTrustedSchedule(schedule.fixtures, documents);
    if (changes.length) {
      await firestore(env, ":commit", { writes: changes.map((change) => change.write) });
      verifyTrustedSchedule(changes, await readDocuments(env));
    }
    const summary = {
      status: "ok", lastSuccessAt: new Date().toISOString(), nextAttemptAt: Date.now() + INTERVAL_MS,
      currentWeek: schedule.currentWeek, matchCount: schedule.fixtures.length, changed: changes.length,
      confirmedByRound: {}, waitingForTime: []
    };
    for (const fixture of schedule.fixtures) {
      if (fixture.kickoffConfirmed) summary.confirmedByRound[fixture.matchday] = (summary.confirmedByRound[fixture.matchday] || 0) + 1;
      else summary.waitingForTime.push(fixture.localMatchId);
    }
    await saveState(env, summary);
    return summary;
  } catch (error) {
    // Do not include request/response bodies: they can contain service tokens.
    const code = /^schedule-[a-z0-9:-]+$/.test(error?.message || "") ? error.message : "schedule-upstream-error";
    await saveState(env, { ...previous, status: "error", lastError: code, lastAttemptAt: new Date().toISOString(), nextAttemptAt: Date.now() + 60000 });
    throw new Error(code);
  } finally {
    await env.DB.prepare("DELETE FROM worker_state WHERE key = 'trusted_schedule_sync_lease' AND value = ?1").bind(lease).run();
  }
}
