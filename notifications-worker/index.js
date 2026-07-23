import webpushPackage from "web-push";
import { matches, teams } from "../data.js";
import { getOfficialLivePayload } from "../live-provider.js";
import {
  getOfficialLeaguePayload,
  getOfficialMatchLineup,
  isOfficialMatchId,
  isPublishedLineup
} from "../league-provider.js";

const webpush = webpushPackage?.default || webpushPackage;
const SEASON_ID = "2026-27";
const FIREBASE_PROJECT_ID = "ekstraklasa-typer-2026-27";
const PUBLIC_FIREBASE_API_KEY = "AIzaSyD3kgRWw3BROjcmulITWFXKcePgvhtpIDY";
const ADMIN_EMAIL = "mateuszjoe@gmail.com";
const VAPID_PUBLIC_KEY = "BHxWAMhHw3KJBpTqgJZK38Kr-fPA_dvKIYurfBjxTfuw9ie4D9I0cpYR8S9-5FEmzDYoLoBwdutcR_kLW7cADd0";
const VAPID_SUBJECT = "mailto:mateuszjoe@gmail.com";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SYNCED_PICKS = 10;
const MAX_SUBSCRIPTIONS_PER_USER = 5;
// Queue consumers have a separate CPU budget. Eighteen deliveries leave room
// below the 50-subrequest limit for D1 claims, delivery receipts and requeueing.
const MAX_PUSH_BATCH = 18;
// A full private group (roughly 20 players) should receive a newly published
// lineup during the same minute, while remaining below the tick subrequest cap.
const MAX_TICK_ENQUEUES = 24;
const MAX_TICK_DISPATCH_MESSAGES = 24;
const MAX_LINEUP_POLLS_PER_TICK = 3;
const EVENT_LEASE_MS = 90 * 1000;
const MAX_EVENT_ATTEMPTS = 4;
const QUEUE_RETRY_SECONDS = 30;
const RESULT_BASELINE_STATE_KEY = "notification_result_baseline_at";
const LEAGUE_FIXTURES_STATE_KEY = "official_league_fixtures_v1";
const NEXT_LEAGUE_REFRESH_STATE_KEY = "next_official_league_refresh_at";
const LEAGUE_REFRESH_MS = 5 * 60 * 1000;
const LINEUP_POLL_WINDOW_MS = 120 * 60 * 1000;
const FRESH_STORED_LINEUP_MS = 45 * 1000;
const ADMIN_NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FINAL_STATUSES = new Set(["FT", "AWD"]);
const VALID_PICKS = new Set(["1", "X", "2"]);
const ADMIN_NOTIFICATION_TYPES = new Set(["admin-name-request", "admin-name-changed"]);
const MATCH_BY_ID = new Map(matches.map((match) => [match.id, match]));
const TEAM_BY_ID = new Map(teams.map((team) => [team.id, team]));

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function compactText(value, limit = 160) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizedEmail(value) {
  const email = typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
  if (email.length < 3 || email.length > 254 || /[\u0000-\u0020\u007f]/.test(email)) return "";
  return /^[^@]+@[^@]+\.[^@]+$/.test(email) ? email : "";
}

function normalizedGoogleName(value) {
  const name = typeof value === "string"
    ? value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
  return (name || "Gracz").slice(0, 120);
}

function normalizedPlayerName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 40 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(409, "invalid-player-name", "Nazwa gracza zapisana w profilu jest nieprawidłowa.");
  }
  const name = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!name || name.length > 40) {
    throw new HttpError(409, "invalid-player-name", "Nazwa gracza zapisana w profilu jest nieprawidłowa.");
  }
  return name;
}

function appUrl(env, suffix = "") {
  const base = String(env.APP_URL || "https://mateuszjoe.github.io/Ekstraklapa-typer/").trim();
  return `${base.endsWith("/") ? base : `${base}/`}${suffix.replace(/^\//, "")}`;
}

function allowedOrigin(origin, env) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.origin === new URL(appUrl(env)).origin) return true;
    if (parsed.origin === "https://mateuszjoe.github.io") return true;
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      && ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  };
  if (allowedOrigin(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

function jsonResponse(request, env, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request, env), ...extraHeaders }
  });
}

async function jsonBody(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload-too-large", "Żądanie jest za duże.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload-too-large", "Żądanie jest za duże.");
  }
  try {
    const value = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw new HttpError(400, "invalid-json", "Nieprawidłowy JSON.");
  }
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~-]{100,5000})$/.exec(header);
  if (!match) throw new HttpError(401, "unauthenticated", "Zaloguj się przez Google.");
  return match[1];
}

async function firebaseUser(request, env) {
  const token = bearerToken(request);
  const apiKey = String(env.FIREBASE_API_KEY || PUBLIC_FIREBASE_API_KEY).trim();
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: token })
  });
  const payload = await response.json().catch(() => ({}));
  const user = payload?.users?.[0];
  const googleProvider = user?.providerUserInfo?.find((provider) => provider?.providerId === "google.com");
  const email = normalizedEmail(googleProvider?.email);
  const accountEmail = normalizedEmail(user?.email);
  if (!response.ok
    || !user?.localId
    || user.emailVerified !== true
    || !googleProvider
    || !email
    || (accountEmail && accountEmail !== email)
    || user.disabled === true) {
    throw new HttpError(401, "unauthenticated", "Sesja Google wygasła lub jest nieprawidłowa.");
  }
  const googleName = normalizedGoogleName(googleProvider.displayName || user.displayName);
  return {
    uid: String(user.localId),
    email,
    googleName,
    displayName: googleName,
    token
  };
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("arrayValue" in value) return (value.arrayValue?.values || []).map(decodeFirestoreValue);
  if ("mapValue" in value) return decodeFirestoreFields(value.mapValue?.fields || {});
  return null;
}

function decodeFirestoreFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

function safeDocumentSegment(value, label) {
  const segment = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(segment)) {
    throw new HttpError(400, "invalid-document-id", `Nieprawidłowe pole ${label}.`);
  }
  return segment;
}

async function firestoreDocument(env, token, segments, missingStatus = 403) {
  const path = segments.map((segment) => encodeURIComponent(safeDocumentSegment(segment, "identyfikatora"))).join("/");
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) {
    throw new HttpError(missingStatus, "document-not-found", "Nie znaleziono potwierdzającego dokumentu w bazie.");
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new HttpError(503, "firestore-unavailable", "Baza typera jest chwilowo niedostępna.");
    }
    throw new HttpError(response.status === 401 ? 401 : 403, "firestore-denied", "Nie udało się potwierdzić danych w bazie typera.");
  }
  const document = await response.json();
  return {
    id: decodeURIComponent(String(document.name || "").split("/").pop() || ""),
    data: decodeFirestoreFields(document.fields || {}),
    createTime: document.createTime || "",
    updateTime: document.updateTime || ""
  };
}

async function authenticatedParticipant(request, env) {
  const user = await firebaseUser(request, env);
  const participant = await firestoreDocument(env, user.token, ["seasons", SEASON_ID, "participants", user.uid]);
  if (participant.data.uid !== user.uid || participant.data.seasonId !== SEASON_ID) {
    throw new HttpError(403, "not-participant", "Konto nie jest uczestnikiem typera.");
  }
  const participantStatus = String(participant.data.status || "").trim().toLowerCase();
  if (participant.data.disabled === true
    || participant.data.blocked === true
    || participant.data.enabled === false
    || participant.data.active === false
    || ["disabled", "blocked", "banned", "suspended"].includes(participantStatus)) {
    throw new HttpError(403, "participant-disabled", "To konto zostało wyłączone z typera.");
  }
  return { ...user, participant };
}

function isAdminUser(user) {
  return user?.email === ADMIN_EMAIL;
}

async function authenticatedAdmin(request, env) {
  const user = await authenticatedParticipant(request, env);
  if (!isAdminUser(user)) {
    throw new HttpError(403, "admin-required", "Ten panel jest dostępny wyłącznie dla administratora.");
  }
  return user;
}

function exactBodyFields(body, fields) {
  const keys = Object.keys(body || {}).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new HttpError(400, "invalid-fields", "Żądanie zawiera nieprawidłowe pola.");
  }
}

function positiveNameVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1 || version > 1_000_000_000) {
    throw new HttpError(400, "invalid-name-version", "Nieprawidłowa wersja nazwy gracza.");
  }
  return version;
}

function firestoreTimeMs(value, fallback = "") {
  const timestamp = new Date(value || fallback || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function requestOwnerUid(data) {
  const candidates = [data?.uid, data?.requesterUid]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) {
    throw new HttpError(409, "invalid-request-owner", "Wniosek nie ma jednoznacznego właściciela.");
  }
  return safeDocumentSegment(unique[0], "uid gracza");
}

async function upsertPlayerIdentity(env, user) {
  const now = Date.now();
  const statements = [
    env.DB.prepare(`
      INSERT INTO player_identities
        (uid, google_email, google_full_name, first_seen_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT(uid) DO UPDATE SET
        google_email = excluded.google_email,
        google_full_name = excluded.google_full_name,
        last_seen_at = excluded.last_seen_at
    `).bind(user.uid, user.email, user.googleName, now)
  ];
  if (isAdminUser(user)) {
    statements.push(env.DB.prepare(`
      INSERT INTO notification_admins
        (email, uid, verified_at, updated_at)
      VALUES (?1, ?2, ?3, ?3)
      ON CONFLICT(email) DO UPDATE SET
        uid = excluded.uid,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
    `).bind(ADMIN_EMAIL, user.uid, now));
    statements.push(env.DB.prepare(`
      UPDATE notification_events
      SET target_uid = ?1, updated_at = ?2
      WHERE kind IN ('admin-name-request', 'admin-name-changed')
        AND status IN ('pending', 'failed')
        AND target_uid != ?1
    `).bind(user.uid, now));
  }
  await env.DB.batch(statements);
  return now;
}

async function configuredAdminUid(env) {
  const row = await env.DB.prepare(`
    SELECT uid FROM notification_admins WHERE email = ?1 LIMIT 1
  `).bind(ADMIN_EMAIL).first();
  const uid = typeof row?.uid === "string" ? row.uid.trim() : "";
  if (!uid) {
    throw new HttpError(503, "admin-not-ready", "Kanał administratora nie jest jeszcze gotowy. Spróbuj ponownie za chwilę.");
  }
  return uid;
}

async function profileSync(request, env) {
  const user = await authenticatedParticipant(request, env);
  await consumeRateLimit(env, user.uid, "profile-sync", 20);
  await upsertPlayerIdentity(env, user);
  return { status: "synced", uid: user.uid, admin: isAdminUser(user) };
}

async function adminBootstrap(request, env) {
  const user = await authenticatedAdmin(request, env);
  await consumeRateLimit(env, user.uid, "admin-bootstrap", 12);
  await upsertPlayerIdentity(env, user);
  const pendingScheduled = await wakePendingAdminEvents(env, user.uid);
  return { status: "ready", uid: user.uid, pendingScheduled };
}

async function adminPlayers(request, env) {
  const user = await authenticatedAdmin(request, env);
  await consumeRateLimit(env, user.uid, "admin-players", 30);
  await upsertPlayerIdentity(env, user);
  const result = await env.DB.prepare(`
    SELECT uid, google_email, google_full_name, last_seen_at
    FROM player_identities
    ORDER BY google_full_name COLLATE NOCASE, google_email COLLATE NOCASE, uid
    LIMIT 500
  `).all();
  return {
    players: (result.results || []).map((row) => ({
      uid: String(row.uid || ""),
      email: String(row.google_email || ""),
      googleName: String(row.google_full_name || ""),
      lastSeenAt: new Date(Number(row.last_seen_at) || 0).toISOString()
    }))
  };
}

async function consumeRateLimit(env, uid, bucket, limit, windowMs = 60 * 1000) {
  const now = Date.now();
  const result = await env.DB.prepare(`
    INSERT INTO request_limits
      (uid, bucket, window_started_at, request_count, updated_at)
    VALUES (?1, ?2, ?3, 1, ?3)
    ON CONFLICT(uid, bucket) DO UPDATE SET
      window_started_at = CASE
        WHEN request_limits.window_started_at <= ?3 - ?4 THEN ?3
        ELSE request_limits.window_started_at
      END,
      request_count = CASE
        WHEN request_limits.window_started_at <= ?3 - ?4 THEN 1
        ELSE request_limits.request_count + 1
      END,
      updated_at = ?3
    WHERE request_limits.window_started_at <= ?3 - ?4
       OR request_limits.request_count < ?5
  `).bind(uid, bucket, now, windowMs, limit).run();
  if (result.meta?.changes !== 1) {
    throw new HttpError(429, "rate-limited", "Za dużo prób. Odczekaj chwilę i spróbuj ponownie.");
  }
}

function allowedPushEndpoint(endpoint) {
  try {
    if (typeof endpoint !== "string" || /[\u0000-\u0020\u007f]/.test(endpoint)) return false;
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    const trusted = host === "fcm.googleapis.com"
      || host === "android.googleapis.com"
      || host === "updates.push.services.mozilla.com"
      || host === "web.push.apple.com"
      || host.endsWith(".notify.windows.com");
    return trusted
      && url.protocol === "https:"
      && !url.username
      && !url.password
      && (!url.port || url.port === "443")
      && url.pathname.length > 1
      && url.pathname.length <= 1800
      && url.search.length <= 512
      && !url.hash
      && url.href.length <= 2048;
  } catch {
    return false;
  }
}

function normalizedSubscription(input) {
  const value = input?.subscription || input;
  const endpoint = typeof value?.endpoint === "string" ? value.endpoint.trim() : "";
  const p256dh = typeof value?.keys?.p256dh === "string" ? value.keys.p256dh.trim() : "";
  const auth = typeof value?.keys?.auth === "string" ? value.keys.auth.trim() : "";
  const p256dhBytes = decodedBase64Url(p256dh);
  const authBytes = decodedBase64Url(auth);
  if (!allowedPushEndpoint(endpoint)
    || p256dhBytes?.length !== 65
    || p256dhBytes[0] !== 0x04
    || authBytes?.length !== 16) {
    throw new HttpError(400, "invalid-subscription", "Nieprawidłowa subskrypcja Web Push.");
  }
  return { endpoint, keys: { p256dh, auth } };
}

function decodedBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function subscriptionId(endpoint) {
  return sha256(endpoint);
}

function validRotationToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function createRotationToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function registerSubscription(request, env) {
  const user = await authenticatedParticipant(request, env);
  await consumeRateLimit(env, user.uid, "push-register", 12);
  await upsertPlayerIdentity(env, user);
  const body = await jsonBody(request);
  const subscription = normalizedSubscription(body.subscription || body);
  const id = await subscriptionId(subscription.endpoint);
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT uid, rotation_token_hash FROM subscriptions WHERE id = ?1 OR endpoint = ?2 LIMIT 1")
    .bind(id, subscription.endpoint).first();
  if (existing?.uid && existing.uid !== user.uid) {
    throw new HttpError(409, "endpoint-owned", "Ta subskrypcja jest przypisana do innego konta.");
  }

  const suppliedToken = validRotationToken(body.rotationToken) ? body.rotationToken : "";
  const suppliedHash = suppliedToken ? await sha256(suppliedToken) : "";
  const rotationToken = existing?.uid === user.uid && suppliedHash === existing.rotation_token_hash
    ? suppliedToken
    : createRotationToken();
  const rotationTokenHash = await sha256(rotationToken);

  await env.DB.prepare(`
    INSERT INTO subscriptions (id, uid, endpoint, p256dh, auth_secret, rotation_token_hash, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(id) DO UPDATE SET
      endpoint = excluded.endpoint,
      p256dh = excluded.p256dh,
      auth_secret = excluded.auth_secret,
      rotation_token_hash = excluded.rotation_token_hash,
      updated_at = excluded.updated_at
    WHERE subscriptions.uid = excluded.uid
  `).bind(id, user.uid, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, rotationTokenHash, now).run();

  await env.DB.prepare(`
    DELETE FROM subscriptions
    WHERE uid = ?1 AND id NOT IN (
      SELECT id FROM subscriptions WHERE uid = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2
    )
  `).bind(user.uid, MAX_SUBSCRIPTIONS_PER_USER).run();
  const pendingScheduled = isAdminUser(user) ? await wakePendingAdminEvents(env, user.uid) : 0;
  return { status: "registered", subscriptionId: id, rotationToken, pendingScheduled };
}

async function unregisterSubscription(request, env) {
  const user = await authenticatedParticipant(request, env);
  await consumeRateLimit(env, user.uid, "push-unregister", 12);
  const body = await jsonBody(request);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!allowedPushEndpoint(endpoint)) throw new HttpError(400, "invalid-endpoint", "Nieprawidłowy endpoint Web Push.");
  const id = await subscriptionId(endpoint);
  await env.DB.prepare("DELETE FROM subscriptions WHERE id = ?1 AND uid = ?2 AND endpoint = ?3")
    .bind(id, user.uid, endpoint).run();
  return { status: "unregistered" };
}

async function rotateSubscription(request, env) {
  const requestBody = await jsonBody(request);
  const body = requestBody.data && typeof requestBody.data === "object" && !Array.isArray(requestBody.data)
    ? requestBody.data
    : requestBody;
  const oldEndpoint = typeof body.oldEndpoint === "string" ? body.oldEndpoint.trim() : "";
  if (!allowedPushEndpoint(oldEndpoint)) throw new HttpError(400, "invalid-old-endpoint", "Nieprawidłowy poprzedni endpoint.");
  const rotationToken = typeof body.rotationToken === "string" ? body.rotationToken : "";
  if (!validRotationToken(rotationToken)) throw new HttpError(403, "rotation-denied", "Nieprawidłowy token rotacji.");
  const subscription = normalizedSubscription(body.subscription);
  const [oldId, newId] = await Promise.all([subscriptionId(oldEndpoint), subscriptionId(subscription.endpoint)]);
  const oldRow = await env.DB.prepare("SELECT uid, rotation_token_hash, created_at FROM subscriptions WHERE id = ?1 AND endpoint = ?2")
    .bind(oldId, oldEndpoint).first();
  const suppliedTokenHash = await sha256(rotationToken);
  if (!oldRow || suppliedTokenHash !== oldRow.rotation_token_hash) {
    throw new HttpError(403, "rotation-denied", "Nie udało się potwierdzić poprzedniej subskrypcji.");
  }
  const uid = oldRow.uid;
  const newRow = await env.DB.prepare("SELECT uid FROM subscriptions WHERE id = ?1 OR endpoint = ?2 LIMIT 1")
    .bind(newId, subscription.endpoint).first();
  if (newRow?.uid && newRow.uid !== uid) {
    throw new HttpError(409, "endpoint-owned", "Nowy endpoint jest przypisany do innego konta.");
  }
  const now = Date.now();
  const originalCreatedAt = Number(oldRow.created_at) > 0 ? Number(oldRow.created_at) : now;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM subscriptions WHERE id = ?1 AND uid = ?2 AND rotation_token_hash = ?3")
      .bind(oldId, uid, oldRow.rotation_token_hash),
    env.DB.prepare(`
      INSERT INTO subscriptions (id, uid, endpoint, p256dh, auth_secret, rotation_token_hash, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(id) DO UPDATE SET
        endpoint = excluded.endpoint,
        p256dh = excluded.p256dh,
        auth_secret = excluded.auth_secret,
        rotation_token_hash = excluded.rotation_token_hash,
        created_at = MIN(subscriptions.created_at, excluded.created_at),
        updated_at = excluded.updated_at
      WHERE subscriptions.uid = excluded.uid
    `).bind(
      newId,
      uid,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      oldRow.rotation_token_hash,
      originalCreatedAt,
      now
    )
  ]);
  await env.DB.prepare(`
    DELETE FROM subscriptions
    WHERE uid = ?1 AND id NOT IN (
      SELECT id FROM subscriptions WHERE uid = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2
    )
  `).bind(uid, MAX_SUBSCRIPTIONS_PER_USER).run();
  const result = { status: "rotated", subscriptionId: newId, rotationToken };
  // `result` keeps already installed APK/service-worker versions compatible
  // while new clients use the same fields directly as a regular REST response.
  return { ...result, result };
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  }));
  return results;
}

async function syncPicks(request, env) {
  const user = await authenticatedParticipant(request, env);
  await consumeRateLimit(env, user.uid, "picks-sync", 30);
  const body = await jsonBody(request);
  if (!Array.isArray(body.picks) || body.picks.length < 1 || body.picks.length > MAX_SYNCED_PICKS) {
    throw new HttpError(400, "invalid-picks", `Wyślij od 1 do ${MAX_SYNCED_PICKS} typów naraz.`);
  }
  const seen = new Set();
  const rejected = [];
  const requested = [];
  body.picks.forEach((item) => {
    const rawMatchId = typeof item?.matchId === "string" ? item.matchId.trim() : "";
    const matchId = /^[A-Za-z0-9_-]{1,180}$/.test(rawMatchId) ? rawMatchId : "";
    const pick = typeof item?.pick === "string" ? item.pick.toUpperCase() : "";
    const match = MATCH_BY_ID.get(matchId);
    let code = "";
    let reason = "";
    if (!matchId) {
      code = "invalid-match-id";
      reason = "Nieprawidłowy identyfikator meczu.";
    } else if (!match) {
      code = "unknown-match";
      reason = "Mecz nie należy do rundy jesiennej typera.";
    } else if (!VALID_PICKS.has(pick)) {
      code = "invalid-pick";
      reason = "Typ musi mieć wartość 1, X albo 2.";
    } else if (seen.has(matchId)) {
      code = "duplicate-match";
      reason = "Ten sam mecz występuje w paczce więcej niż raz.";
    }
    if (code) {
      rejected.push({ matchId: matchId || compactText(rawMatchId, 180), code, reason, retryable: false });
      return;
    }
    seen.add(matchId);
    requested.push({ matchId, pick, matchday: match.matchday });
  });

  const verificationResults = await mapWithConcurrency(requested, 8, async (item) => {
    try {
      const document = await firestoreDocument(env, user.token, [
        "seasons", SEASON_ID, "players", user.uid, "picks", item.matchId
      ]);
      if (document.id !== item.matchId || document.data.pick !== item.pick) {
        return {
          rejected: {
            matchId: item.matchId,
            code: "pick-mismatch",
            reason: "Typ nie zgadza się z zapisem w bazie typera.",
            retryable: false
          }
        };
      }
      return { verified: item };
    } catch (error) {
      const httpError = error instanceof HttpError ? error : null;
      return {
        rejected: {
          matchId: item.matchId,
          code: httpError?.code || "verification-failed",
          reason: httpError?.message || "Nie udało się teraz potwierdzić typu.",
          retryable: !httpError || httpError.status >= 500 || httpError.status === 429
        }
      };
    }
  });
  const verified = verificationResults.flatMap((result) => result.verified ? [result.verified] : []);
  rejected.push(...verificationResults.flatMap((result) => result.rejected ? [result.rejected] : []));
  const now = Date.now();
  if (verified.length) {
    await env.DB.batch(verified.map((item) => env.DB.prepare(`
      INSERT INTO picks (uid, match_id, matchday, pick, verified_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(uid, match_id) DO UPDATE SET
        matchday = excluded.matchday,
        pick = excluded.pick,
        verified_at = excluded.verified_at
    `).bind(user.uid, item.matchId, item.matchday, item.pick, now)));
  }
  return {
    status: rejected.length ? (verified.length ? "partial" : "rejected") : "synced",
    count: verified.length,
    rejected
  };
}

function notificationBodyForChat(message) {
  const text = compactText(message.text, 160);
  if (text && message.image) return `${text} · 📷`;
  if (text) return text;
  return "Wysłano zdjęcie do szatni graczy.";
}

function storedPayload(payload) {
  const serialized = JSON.stringify(payload);
  if (serialized.length < 2 || serialized.length > 4096) throw new Error("Notification payload is too large");
  return serialized;
}

async function eventClaim(env, eventKey, kind, payload, recipientFilter) {
  const now = Date.now();
  const leaseToken = createRotationToken();
  const payloadJson = storedPayload(payload);
  const targetUid = recipientFilter.uid || "";
  const excludeUid = recipientFilter.excludeUid || "";
  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO notification_events
      (event_key, kind, payload_json, target_uid, exclude_uid, status,
       lease_until, lease_token, attempts, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'processing', ?6, ?7, 1, ?8, ?8)
  `).bind(eventKey, kind, payloadJson, targetUid, excludeUid, now + EVENT_LEASE_MS, leaseToken, now).run();
  if (inserted.meta?.changes === 1) return { claimed: true, attempts: 1, leaseToken };

  const current = await env.DB.prepare(`
    SELECT status, lease_until, attempts FROM notification_events WHERE event_key = ?1
  `).bind(eventKey).first();
  if (!current || current.status === "completed" || (current.status === "failed" && Number(current.attempts) >= MAX_EVENT_ATTEMPTS)) {
    return { claimed: false, status: current?.status || "missing" };
  }
  if (current.status === "processing" && Number(current.lease_until) > now) {
    return { claimed: false, status: "busy" };
  }
  const renewed = await env.DB.prepare(`
    UPDATE notification_events
    SET status = 'processing', lease_until = ?2, lease_token = ?3,
        attempts = CASE WHEN status = 'failed' THEN attempts + 1 ELSE attempts END,
        updated_at = ?4
    WHERE event_key = ?1
      AND status != 'completed'
      AND (status != 'failed' OR attempts < ?5)
      AND (status IN ('pending', 'failed') OR lease_until <= ?4)
  `).bind(eventKey, now + EVENT_LEASE_MS, leaseToken, now, MAX_EVENT_ATTEMPTS).run();
  return {
    claimed: renewed.meta?.changes === 1,
    attempts: Number(current.attempts) + 1,
    leaseToken: renewed.meta?.changes === 1 ? leaseToken : ""
  };
}

async function markEvent(env, eventKey, status, leaseToken) {
  const now = Date.now();
  return env.DB.prepare(`
    UPDATE notification_events
    SET status = ?2, lease_until = 0, updated_at = ?3,
        completed_at = CASE WHEN ?2 = 'completed' THEN ?3 ELSE completed_at END
    WHERE event_key = ?1 AND status = 'processing' AND lease_token = ?4
  `).bind(eventKey, status, now, leaseToken).run();
}

async function enqueueEvent(env, eventKey, kind, payload, recipientFilter = {}) {
  if (eventKey.length > 220) throw new Error("Event key is too long");
  const now = Date.now();
  const leaseToken = createRotationToken();
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO notification_events
      (event_key, kind, payload_json, target_uid, exclude_uid, status,
       lease_until, lease_token, attempts, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, 1, ?7, ?7)
  `).bind(
    eventKey,
    kind,
    storedPayload(payload),
    recipientFilter.uid || "",
    recipientFilter.excludeUid || "",
    leaseToken,
    now
  ).run();
  return result.meta?.changes === 1;
}

function requireNotificationQueue(env) {
  if (!env.NOTIFICATION_QUEUE || typeof env.NOTIFICATION_QUEUE.send !== "function") {
    throw new Error("Missing NOTIFICATION_QUEUE binding");
  }
  return env.NOTIFICATION_QUEUE;
}

async function scheduleEventDispatch(env, eventKey, delaySeconds = 0) {
  const queue = requireNotificationQueue(env);
  const options = delaySeconds > 0 ? { delaySeconds } : undefined;
  await queue.send({ type: "dispatch", eventKey }, options);
}

async function wakePendingAdminEvents(env, adminUid) {
  if (!env.VAPID_PRIVATE_KEY) return 0;
  const result = await env.DB.prepare(`
    SELECT event_key
    FROM notification_events
    WHERE target_uid = ?1
      AND kind IN ('admin-name-request', 'admin-name-changed')
      AND (
        status = 'pending'
        OR (status = 'processing' AND lease_until <= ?2)
        OR (status = 'failed' AND attempts < ?3)
      )
    ORDER BY updated_at, created_at, event_key
    LIMIT 12
  `).bind(adminUid, Date.now(), MAX_EVENT_ATTEMPTS).all();
  const eventKeys = (result.results || [])
    .map((row) => row.event_key)
    .filter((eventKey) => typeof eventKey === "string" && eventKey.length <= 220);
  if (!eventKeys.length) return 0;
  const queue = requireNotificationQueue(env);
  if (typeof queue.sendBatch === "function") {
    await queue.sendBatch(eventKeys.map((eventKey) => ({ body: { type: "dispatch", eventKey } })));
  } else {
    for (const eventKey of eventKeys) await scheduleEventDispatch(env, eventKey);
  }
  return eventKeys.length;
}

async function enqueueAndScheduleEvent(env, eventKey, kind, payload, recipientFilter = {}) {
  const inserted = await enqueueEvent(env, eventKey, kind, payload, recipientFilter);
  if (!env.VAPID_PRIVATE_KEY) {
    return { status: "pending-vapid", eventKey };
  }
  // Send even for a duplicate. It recovers a D1 event whose earlier Queue write
  // failed, while the claim/delivery tables still prevent a duplicate push.
  await scheduleEventDispatch(env, eventKey);
  return { status: inserted ? "queued" : "already-queued", eventKey };
}

async function recipients(env, eventKey, {
  uid = "",
  excludeUid = "",
  createdBefore = 0
} = {}, maxRecipients = MAX_PUSH_BATCH) {
  const limit = Math.max(1, Math.min(MAX_PUSH_BATCH, Number(maxRecipients) || MAX_PUSH_BATCH));
  const cutoff = Number.isFinite(Number(createdBefore)) && Number(createdBefore) > 0
    ? Math.floor(Number(createdBefore))
    : 0;
  let statement;
  if (uid) {
    statement = env.DB.prepare(`
      SELECT s.id, s.uid, s.endpoint, s.p256dh, s.auth_secret
      FROM subscriptions s
      WHERE s.uid = ?1
        AND (?3 = 0 OR s.created_at <= ?3)
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries d
          WHERE d.event_key = ?2 AND d.subscription_id = s.id
        )
      ORDER BY s.updated_at DESC LIMIT ?4
    `).bind(uid, eventKey, cutoff, limit + 1);
  } else if (excludeUid) {
    statement = env.DB.prepare(`
      SELECT s.id, s.uid, s.endpoint, s.p256dh, s.auth_secret
      FROM subscriptions s
      WHERE s.uid != ?1
        AND (?3 = 0 OR s.created_at <= ?3)
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries d
          WHERE d.event_key = ?2 AND d.subscription_id = s.id
        )
      ORDER BY s.updated_at DESC LIMIT ?4
    `).bind(excludeUid, eventKey, cutoff, limit + 1);
  } else {
    statement = env.DB.prepare(`
      SELECT s.id, s.uid, s.endpoint, s.p256dh, s.auth_secret
      FROM subscriptions s
      WHERE (?2 = 0 OR s.created_at <= ?2)
        AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries d
        WHERE d.event_key = ?1 AND d.subscription_id = s.id
      )
      ORDER BY s.updated_at DESC LIMIT ?3
    `).bind(eventKey, cutoff, limit + 1);
  }
  const result = await statement.all();
  const rows = result.results || [];
  return { rows: rows.slice(0, limit), capped: rows.length > limit };
}

async function pushTopic(eventKey) {
  // Web Push topics collapse notifications with the same value. Hashing the
  // complete event key prevents different event kinds for one uid colliding.
  return (await sha256(`push-topic:${String(eventKey)}`)).slice(0, 32);
}

function pushPayload(env, payload) {
  const {
    recipientBefore: _recipientBefore,
    expiresAt: _expiresAt,
    ...publicPayload
  } = payload;
  return {
    ...publicPayload,
    title: compactText(payload.title, 80),
    body: compactText(payload.body, 180),
    url: payload.url || appUrl(env),
    icon: appUrl(env, "assets/brand/app-icon-192.png?v=14"),
    badge: appUrl(env, "assets/brand/favicon-32.png?v=14")
  };
}

function pushTtlSeconds(payload) {
  if (ADMIN_NOTIFICATION_TYPES.has(payload.type)
    || ["name-change-approved", "name-change-rejected", "name-change-admin-edited"].includes(payload.type)) {
    return 7 * 24 * 60 * 60;
  }
  if (["match-result", "matchday-summary"].includes(payload.type)) return 72 * 60 * 60;
  if (["chat-message", "player-joined"].includes(payload.type)) return 24 * 60 * 60;
  if (payload.type === "lineup-published") {
    const kickoffAt = new Date(payload.kickoffAt || 0).getTime();
    if (Number.isFinite(kickoffAt)) {
      return Math.max(1, Math.min(2 * 60 * 60, Math.floor((kickoffAt - Date.now()) / 1000)));
    }
  }
  if (payload.type === "matchday-reminder") {
    const startsAt = new Date(payload.startsAt || 0).getTime();
    if (Number.isFinite(startsAt)) {
      return Math.max(60, Math.min(24 * 60 * 60, Math.floor((startsAt - Date.now()) / 1000)));
    }
  }
  return 24 * 60 * 60;
}

async function dispatchEvent(env, eventKey, kind, payload, recipientFilter = {}, budget = null) {
  if (eventKey.length > 220) throw new Error("Event key is too long");
  const available = budget ? Math.max(0, Number(budget.remaining) || 0) : MAX_PUSH_BATCH;
  if (available <= 0) return { status: "budget-exhausted", sent: 0 };
  const claim = await eventClaim(env, eventKey, kind, payload, recipientFilter);
  if (!claim.claimed) return { status: claim.status || "duplicate", sent: 0 };
  try {
    if (!env.VAPID_PRIVATE_KEY || typeof env.VAPID_PRIVATE_KEY !== "string") {
      throw new Error("Missing VAPID_PRIVATE_KEY secret");
    }
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY.trim());
    const selected = await recipients(env, eventKey, recipientFilter, Math.min(MAX_PUSH_BATCH, available));
    const pending = selected.rows;
    if (budget) budget.remaining = Math.max(0, budget.remaining - pending.length);
    const body = JSON.stringify(pushPayload(env, payload));
    const topic = await pushTopic(eventKey);
    const outcomes = await Promise.all(pending.map(async (row) => {
      try {
        await webpush.sendNotification({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth_secret }
        }, body, { TTL: pushTtlSeconds(payload), urgency: "high", topic });
        await env.DB.prepare(`
          INSERT OR REPLACE INTO notification_deliveries
            (event_key, subscription_id, status, updated_at)
          VALUES (?1, ?2, 'sent', ?3)
        `).bind(eventKey, row.id, Date.now()).run();
        return { row, status: "sent" };
      } catch (error) {
        const statusCode = Number(error?.statusCode || 0);
        if ([400, 404, 410].includes(statusCode)) {
          await env.DB.batch([
            env.DB.prepare(`
              INSERT OR REPLACE INTO notification_deliveries
                (event_key, subscription_id, status, updated_at)
              VALUES (?1, ?2, 'invalid', ?3)
            `).bind(eventKey, row.id, Date.now()),
            env.DB.prepare("DELETE FROM subscriptions WHERE id = ?1 AND endpoint = ?2")
              .bind(row.id, row.endpoint)
          ]);
          return { row, status: "invalid" };
        }
        console.error("Web Push delivery failed", { eventKey, subscriptionId: row.id, statusCode });
        return { row, status: "failed" };
      }
    }));

    const invalid = outcomes.filter((outcome) => outcome.status === "invalid");
    if (outcomes.some((outcome) => outcome.status === "failed")) {
      await markEvent(env, eventKey, "failed", claim.leaseToken);
      throw new Error("One or more Web Push deliveries failed");
    }
    const sent = outcomes.filter((outcome) => outcome.status === "sent").length;
    const waitingForAdmin = ADMIN_NOTIFICATION_TYPES.has(payload.type) && sent === 0 && !selected.capped;
    const nextStatus = waitingForAdmin || selected.capped ? "pending" : "completed";
    const completed = await markEvent(env, eventKey, nextStatus, claim.leaseToken);
    if (completed.meta?.changes !== 1) throw new Error("Notification event lease was lost");
    return {
      status: waitingForAdmin ? "waiting-recipient" : nextStatus,
      sent,
      invalid: invalid.length,
      capped: selected.capped
    };
  } catch (error) {
    await markEvent(env, eventKey, "failed", claim.leaseToken).catch(() => {});
    throw error;
  }
}

async function playerJoined(request, env) {
  const user = await authenticatedParticipant(request, env);
  await consumeRateLimit(env, user.uid, "player-joined", 4, 10 * 60 * 1000);
  const body = await jsonBody(request);
  if (body.uid && body.uid !== user.uid) throw new HttpError(403, "uid-mismatch", "Nie możesz zgłosić innego gracza.");
  const joinedAt = new Date(user.participant.data.joinedAt || user.participant.createTime || 0).getTime();
  if (!Number.isFinite(joinedAt)
    || joinedAt < Date.now() - 15 * 60 * 1000
    || joinedAt > Date.now() + 2 * 60 * 1000) {
    return { status: "ignored", reason: "existing-player" };
  }
  const profile = await firestoreDocument(env, user.token, ["profiles", user.uid]);
  if (profile.data.uid !== user.uid) throw new HttpError(403, "invalid-profile", "Profil gracza jest nieprawidłowy.");
  const name = compactText(profile.data.displayName || user.displayName || "Nowy gracz", 60) || "Nowy gracz";
  const joinedMarker = String(user.participant.data.joinedAt || user.participant.createTime || "joined").slice(0, 40);
  const marker = (await sha256(joinedMarker)).slice(0, 16);
  return enqueueAndScheduleEvent(env, `player-joined:${user.uid}:${marker}`, "player-joined", {
    type: "player-joined",
    playerUid: user.uid,
    title: "Nowy gracz w typerze",
    body: `${name} dołącza do gry. Powodzenia!`,
    url: appUrl(env, `?player=${encodeURIComponent(user.uid)}#ranking`)
  }, { excludeUid: user.uid });
}

async function chatMessage(request, env) {
  const user = await authenticatedParticipant(request, env);
  await consumeRateLimit(env, user.uid, "chat-message", 15);
  const body = await jsonBody(request);
  const messageId = safeDocumentSegment(body.messageId, "messageId");
  const message = await firestoreDocument(env, user.token, ["chat", messageId], 404);
  if (message.id !== messageId || message.data.uid !== user.uid) {
    throw new HttpError(403, "message-owner-mismatch", "Wiadomość nie należy do zalogowanego gracza.");
  }
  const createdAt = new Date(message.data.createdAt || 0).getTime();
  if (!Number.isFinite(createdAt) || createdAt < Date.now() - 10 * 60 * 1000 || createdAt > Date.now() + 2 * 60 * 1000) {
    throw new HttpError(409, "stale-message", "Powiadomienie można wysłać tylko dla nowej wiadomości.");
  }
  const profile = await firestoreDocument(env, user.token, ["profiles", user.uid]);
  if (profile.data.uid !== user.uid) throw new HttpError(403, "invalid-profile", "Profil gracza jest nieprawidłowy.");
  const senderName = compactText(profile.data.displayName || user.displayName || "Gracz", 60) || "Gracz";
  return enqueueAndScheduleEvent(env, `chat:${messageId}`, "chat-message", {
    type: "chat-message",
    messageId,
    senderUid: user.uid,
    title: senderName,
    body: notificationBodyForChat(message.data),
    url: appUrl(env, "?chat=open#matches")
  }, { excludeUid: user.uid });
}

async function nameChangeRequest(request, env) {
  const user = await authenticatedParticipant(request, env);
  await consumeRateLimit(env, user.uid, "name-change-request", 5, 24 * 60 * 60 * 1000);
  const body = await jsonBody(request);
  exactBodyFields(body, ["requestId"]);
  const requestId = safeDocumentSegment(body.requestId, "requestId");
  const requestDocument = await firestoreDocument(env, user.token, ["nameChangeRequests", requestId], 404);
  const ownerUid = requestOwnerUid(requestDocument.data);
  if (requestDocument.id !== requestId || ownerUid !== user.uid) {
    throw new HttpError(403, "request-owner-mismatch", "Wniosek nie należy do zalogowanego gracza.");
  }
  if (String(requestDocument.data.status || "").trim().toLowerCase() !== "pending") {
    throw new HttpError(409, "request-not-pending", "Ten wniosek nie oczekuje już na decyzję.");
  }
  const createdAt = firestoreTimeMs(requestDocument.data.createdAt, requestDocument.createTime);
  if (!createdAt
    || createdAt < Date.now() - ADMIN_NOTIFICATION_RETENTION_MS
    || createdAt > Date.now() + 2 * 60 * 1000) {
    throw new HttpError(409, "stale-name-request", "Wniosek jest zbyt stary albo ma nieprawidłową datę.");
  }
  const requestedName = normalizedPlayerName(requestDocument.data.requestedName);
  const profile = await firestoreDocument(env, user.token, ["profiles", user.uid]);
  if (profile.data.uid !== user.uid) {
    throw new HttpError(409, "invalid-profile", "Profil gracza jest nieprawidłowy.");
  }
  const currentName = normalizedPlayerName(profile.data.displayName);
  await upsertPlayerIdentity(env, user);
  const adminUid = await configuredAdminUid(env);
  return enqueueAndScheduleEvent(env, `admin-name-request:${requestId}`, "admin-name-request", {
    type: "admin-name-request",
    requestId,
    playerUid: user.uid,
    title: "Nowy wniosek o zmianę nicku",
    body: `${currentName} prosi o zmianę nazwy na „${requestedName}”.`,
    url: appUrl(env, "#admin"),
    expiresAt: Date.now() + ADMIN_NOTIFICATION_RETENTION_MS
  }, { uid: adminUid });
}

async function playerNameChanged(request, env) {
  const user = await authenticatedParticipant(request, env);
  await consumeRateLimit(env, user.uid, "player-name-changed", 5, 24 * 60 * 60 * 1000);
  const body = await jsonBody(request);
  exactBodyFields(body, ["nameVersion"]);
  const nameVersion = positiveNameVersion(body.nameVersion);
  const profile = await firestoreDocument(env, user.token, ["profiles", user.uid]);
  if (profile.data.uid !== user.uid
    || Number(profile.data.nameVersion) !== nameVersion
    || profile.data.selfRenameUsed !== true) {
    throw new HttpError(409, "name-version-mismatch", "Profil nie potwierdza tej zmiany nazwy.");
  }
  const displayName = normalizedPlayerName(profile.data.displayName);
  await upsertPlayerIdentity(env, user);
  const adminUid = await configuredAdminUid(env);
  return enqueueAndScheduleEvent(
    env,
    `admin-name-changed:${user.uid}:${nameVersion}`,
    "admin-name-changed",
    {
      type: "admin-name-changed",
      playerUid: user.uid,
      nameVersion,
      title: "Gracz zmienił swój nick",
      body: `Nowa nazwa gracza: „${displayName}”.`,
      url: appUrl(env, "#admin"),
      expiresAt: Date.now() + ADMIN_NOTIFICATION_RETENTION_MS
    },
    { uid: adminUid }
  );
}

async function nameChangeDecision(request, env) {
  const user = await authenticatedAdmin(request, env);
  await consumeRateLimit(env, user.uid, "name-change-decision", 30);
  const body = await jsonBody(request);
  exactBodyFields(body, ["requestId"]);
  const requestId = safeDocumentSegment(body.requestId, "requestId");
  const requestDocument = await firestoreDocument(env, user.token, ["nameChangeRequests", requestId], 404);
  const status = String(requestDocument.data.status || "").trim().toLowerCase();
  if (!["approved", "rejected"].includes(status)) {
    throw new HttpError(409, "request-not-resolved", "Wniosek nie został jeszcze rozstrzygnięty.");
  }
  const ownerUid = requestOwnerUid(requestDocument.data);
  const resolvedBy = typeof requestDocument.data.resolvedBy === "string"
    ? requestDocument.data.resolvedBy.trim()
    : "";
  if (!resolvedBy || resolvedBy !== user.uid) {
    throw new HttpError(409, "decision-owner-mismatch", "Decyzja nie została jednoznacznie potwierdzona przez administratora.");
  }
  const requestedName = status === "approved"
    ? normalizedPlayerName(requestDocument.data.requestedName)
    : "";
  await upsertPlayerIdentity(env, user);
  const approved = status === "approved";
  return enqueueAndScheduleEvent(
    env,
    `name-change-decision:${requestId}:${status}`,
    approved ? "name-change-approved" : "name-change-rejected",
    {
      type: approved ? "name-change-approved" : "name-change-rejected",
      requestId,
      nameVersion: Number(requestDocument.data.nameVersion) || undefined,
      title: approved ? "Zmiana nicku zaakceptowana" : "Zmiana nicku odrzucona",
      body: approved
        ? `Twój nick został zmieniony na „${requestedName}”.`
        : "Administrator odrzucił Twój wniosek o zmianę nicku.",
      url: appUrl(env, "#settings"),
      expiresAt: Date.now() + ADMIN_NOTIFICATION_RETENTION_MS
    },
    { uid: ownerUid }
  );
}

async function adminNameEdited(request, env) {
  const user = await authenticatedAdmin(request, env);
  await consumeRateLimit(env, user.uid, "admin-name-edited", 30);
  const body = await jsonBody(request);
  exactBodyFields(body, ["uid", "nameVersion"]);
  const targetUid = safeDocumentSegment(body.uid, "uid gracza");
  const nameVersion = positiveNameVersion(body.nameVersion);
  const profile = await firestoreDocument(env, user.token, ["profiles", targetUid], 404);
  if (profile.data.uid !== targetUid || Number(profile.data.nameVersion) !== nameVersion) {
    throw new HttpError(409, "name-version-mismatch", "Profil nie potwierdza tej zmiany nazwy.");
  }
  const displayName = normalizedPlayerName(profile.data.displayName);
  await upsertPlayerIdentity(env, user);
  return enqueueAndScheduleEvent(
    env,
    `name-change-admin-edited:${targetUid}:${nameVersion}`,
    "name-change-admin-edited",
    {
      type: "name-change-admin-edited",
      playerUid: targetUid,
      nameVersion,
      title: "Administrator zmienił Twój nick",
      body: `Twoja aktualna nazwa gracza to „${displayName}”.`,
      url: appUrl(env, "#settings"),
      expiresAt: Date.now() + ADMIN_NOTIFICATION_RETENTION_MS
    },
    { uid: targetUid }
  );
}

function resultForScore(home, away) {
  if (home > away) return "1";
  if (home < away) return "2";
  return "X";
}

function scoreText(fixture) {
  const home = Number(fixture.score?.home);
  const away = Number(fixture.score?.away);
  return `${home}:${away}`;
}

function normalizedFinalFixture(fixture) {
  const match = MATCH_BY_ID.get(fixture.localMatchId);
  const homeScore = Number(fixture.score?.home);
  const awayScore = Number(fixture.score?.away);
  if (!match || !Number.isInteger(homeScore) || homeScore < 0 || !Number.isInteger(awayScore) || awayScore < 0) return null;
  return { match, homeScore, awayScore, result: resultForScore(homeScore, awayScore), status: fixture.status };
}

async function storeChangedFinalMatches(env, fixtures) {
  const existingResult = await env.DB.prepare(`
    SELECT match_id, home_score, away_score, status FROM match_results
  `).all();
  const existing = new Map((existingResult.results || []).map((row) => [row.match_id, row]));
  const changed = fixtures
    .filter((fixture) => FINAL_STATUSES.has(fixture.status))
    .map(normalizedFinalFixture)
    .filter(Boolean)
    .filter(({ match, homeScore, awayScore, status }) => {
      const previous = existing.get(match.id);
      return !previous
        || Number(previous.home_score) !== homeScore
        || Number(previous.away_score) !== awayScore
        || previous.status !== status;
    });
  if (!changed.length) return 0;
  const now = Date.now();
  await env.DB.batch(changed.map(({ match, homeScore, awayScore, result, status }) => env.DB.prepare(`
    INSERT INTO match_results
      (match_id, matchday, result, home_score, away_score, status, finalized_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(match_id) DO UPDATE SET
      matchday = excluded.matchday,
      result = excluded.result,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      status = excluded.status,
      updated_at = excluded.updated_at
    WHERE match_results.result != excluded.result
       OR match_results.home_score != excluded.home_score
       OR match_results.away_score != excluded.away_score
       OR match_results.status != excluded.status
  `).bind(match.id, match.matchday, result, homeScore, awayScore, status, now)));
  return changed.length;
}

async function enqueuePendingMatchResults(env, enqueueBudget, baselineAt) {
  if (enqueueBudget.remaining <= 0 || !Number.isFinite(baselineAt) || baselineAt <= 0) return;
  const pendingMatch = await env.DB.prepare(`
    SELECT r.match_id, r.matchday, r.result, r.home_score, r.away_score, r.finalized_at
    FROM match_results r
    WHERE r.finalized_at > ?1
      AND EXISTS (
      SELECT 1 FROM picks p
      WHERE p.match_id = r.match_id
        AND NOT EXISTS (
          SELECT 1 FROM notification_events e
          WHERE e.event_key = 'match-result:' || r.match_id || ':'
            || r.home_score || '-' || r.away_score || ':' || p.uid
        )
    )
    ORDER BY r.updated_at, r.match_id
    LIMIT 1
  `).bind(baselineAt).first();
  if (!pendingMatch) return;
  const match = MATCH_BY_ID.get(pendingMatch.match_id);
  if (!match) return;
  const homeScore = Number(pendingMatch.home_score);
  const awayScore = Number(pendingMatch.away_score);
  const result = pendingMatch.result;
  const eventPrefix = `match-result:${match.id}:${homeScore}-${awayScore}:`;
  const picksResult = await env.DB.prepare(`
    SELECT p.uid, p.pick
    FROM picks p
    WHERE p.match_id = ?1
      AND NOT EXISTS (
        SELECT 1 FROM notification_events e WHERE e.event_key = ?2 || p.uid
      )
    ORDER BY p.uid LIMIT ?3
  `).bind(match.id, eventPrefix, enqueueBudget.remaining).all();
  const picked = picksResult.results || [];
  const homeName = TEAM_BY_ID.get(match.home)?.name || match.home;
  const awayName = TEAM_BY_ID.get(match.away)?.name || match.away;
  for (const row of picked) {
    const point = row.pick === result;
    const eventKey = `${eventPrefix}${row.uid}`;
    const inserted = await enqueueEvent(env, eventKey, "match-result", {
      type: "match-result",
      matchId: match.id,
      matchday: match.matchday,
      title: `${homeName} ${homeScore}:${awayScore} ${awayName}`,
      body: point ? "Twój typ był trafiony — zdobywasz 1 punkt!" : `Twój typ (${row.pick}) był nietrafiony — tym razem bez punktu.`,
      url: appUrl(env, `?matchday=${match.matchday}&match=${encodeURIComponent(match.id)}#matches`),
      points: point ? 1 : 0,
      recipientBefore: Number(pendingMatch.finalized_at)
    }, { uid: row.uid });
    if (inserted) enqueueBudget.remaining -= 1;
    if (enqueueBudget.remaining <= 0) break;
  }
}

async function subscriberUidsMissingEvent(env, eventPrefix, limit, createdBefore = 0) {
  if (limit <= 0) return [];
  const cutoff = Number.isFinite(Number(createdBefore)) && Number(createdBefore) > 0
    ? Math.floor(Number(createdBefore))
    : 0;
  const result = await env.DB.prepare(`
    SELECT s.uid, MAX(s.updated_at) AS last_seen
    FROM subscriptions s
    WHERE (?3 = 0 OR s.created_at <= ?3)
      AND NOT EXISTS (
      SELECT 1 FROM notification_events e WHERE e.event_key = ?1 || s.uid
    )
    GROUP BY s.uid ORDER BY last_seen DESC LIMIT ?2
  `).bind(eventPrefix, limit, cutoff).all();
  return (result.results || []).map((row) => row.uid);
}

async function processMatchdaySummaries(env, enqueueBudget, baselineAt) {
  if (!Number.isFinite(baselineAt) || baselineAt <= 0) return;
  const complete = await env.DB.prepare(`
    SELECT matchday, COUNT(*) AS completed, MAX(finalized_at) AS completed_at
    FROM match_results
    GROUP BY matchday
    HAVING completed = 9 AND MAX(finalized_at) > ?1
    ORDER BY matchday DESC
    LIMIT 2
  `).bind(baselineAt).all();
  if (!(complete.results || []).length) return;
  for (const round of complete.results) {
    if (enqueueBudget.remaining <= 0) break;
    const matchday = Number(round.matchday);
    const completedAt = Number(round.completed_at);
    const results = await env.DB.prepare(`
      SELECT match_id, result, home_score, away_score
      FROM match_results WHERE matchday = ?1 ORDER BY match_id
    `).bind(matchday).all();
    if ((results.results || []).length !== 9) continue;
    const signature = (await sha256(JSON.stringify(results.results))).slice(0, 18);
    const eventPrefix = `matchday-summary:${matchday}:${signature}:`;
    const uids = await subscriberUidsMissingEvent(env, eventPrefix, enqueueBudget.remaining, completedAt);
    for (const uid of uids) {
      const score = await env.DB.prepare(`
        SELECT COUNT(*) AS typed,
          COALESCE(SUM(CASE WHEN p.pick = r.result THEN 1 ELSE 0 END), 0) AS points
        FROM picks p JOIN match_results r ON r.match_id = p.match_id
        WHERE p.uid = ?1 AND p.matchday = ?2
      `).bind(uid, matchday).first();
      const points = Number(score?.points || 0);
      const typed = Number(score?.typed || 0);
      const inserted = await enqueueEvent(env, `${eventPrefix}${uid}`, "matchday-summary", {
        type: "matchday-summary",
        matchday,
        title: `Podsumowanie ${matchday}. kolejki`,
        body: `Zdobyte punkty: ${points}. Ocenione typy: ${typed}/9.`,
        url: appUrl(env, `?matchday=${matchday}&summary=open#matches`),
        points,
        typed,
        recipientBefore: completedAt
      }, { uid });
      if (inserted) enqueueBudget.remaining -= 1;
      if (enqueueBudget.remaining <= 0) break;
    }
  }
}

function confirmedRounds(fixtures = []) {
  const officialById = new Map(fixtures.map((fixture) => [fixture.localMatchId, fixture]));
  const grouped = new Map();
  matches.forEach((match) => {
    if (!grouped.has(match.matchday)) grouped.set(match.matchday, []);
    const official = officialById.get(match.id);
    grouped.get(match.matchday).push({
      ...match,
      kickoffAt: official?.kickoffAt || match.kickoffAt,
      kickoffConfirmed: Boolean(official?.kickoffAt) || match.kickoffConfirmed
    });
  });
  return [...grouped.entries()]
    .filter(([, roundMatches]) => roundMatches.length === 9 && roundMatches.every((match) => match.kickoffConfirmed))
    .map(([matchday, roundMatches]) => ({
      matchday,
      startsAt: Math.min(...roundMatches.map((match) => new Date(match.kickoffAt).getTime()))
    }))
    .filter((round) => Number.isFinite(round.startsAt));
}

function polishKickoff(timestamp) {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

async function processReminders(env, fixtures = [], enqueueBudget) {
  const now = Date.now();
  const upcoming = confirmedRounds(fixtures).filter((round) => now >= round.startsAt - 24 * 60 * 60 * 1000 && now < round.startsAt);
  if (!upcoming.length) return;
  for (const round of upcoming) {
    if (enqueueBudget.remaining <= 0) break;
    const eventPrefix = `matchday-reminder:${round.matchday}:${round.startsAt}:`;
    const uids = await subscriberUidsMissingEvent(env, eventPrefix, enqueueBudget.remaining);
    for (const uid of uids) {
      const inserted = await enqueueEvent(env, `${eventPrefix}${uid}`, "matchday-reminder", {
        type: "matchday-reminder",
        matchday: round.matchday,
        startsAt: new Date(round.startsAt).toISOString(),
        title: `Nadchodzi ${round.matchday}. kolejka`,
        body: `Pierwszy mecz: ${polishKickoff(round.startsAt)}. Pamiętaj o zapisaniu wszystkich typów.`,
        url: appUrl(env, `?matchday=${round.matchday}#matches`)
      }, { uid });
      if (inserted) enqueueBudget.remaining -= 1;
      if (enqueueBudget.remaining <= 0) break;
    }
  }
}

function leagueFixtureSnapshot(payload) {
  return (payload?.matches || [])
    .filter((match) => match.localMatchId
      && Number.isInteger(Number(match.matchday))
      && Number(match.matchday) >= 1
      && Number(match.matchday) <= 17
      && isOfficialMatchId(match.providerId))
    .map((match) => ({
      providerId: String(match.providerId),
      localMatchId: String(match.localMatchId),
      matchday: Number(match.matchday),
      kickoffAt: match.kickoffAt || null,
      status: String(match.status || "NS"),
      home: String(match.home || ""),
      away: String(match.away || "")
    }));
}

function parsedStoredFixtures(value) {
  try {
    const fixtures = JSON.parse(value || "[]");
    if (!Array.isArray(fixtures)) return [];
    return fixtures.filter((fixture) => fixture
      && MATCH_BY_ID.has(fixture.localMatchId)
      && isOfficialMatchId(fixture.providerId)
      && Number(fixture.matchday) >= 1
      && Number(fixture.matchday) <= 17);
  } catch {
    return [];
  }
}

async function refreshOfficialLeagueFixtures(env) {
  let fixtures = parsedStoredFixtures(await stateValue(env, LEAGUE_FIXTURES_STATE_KEY));
  const nextRefreshAt = Number(await stateValue(env, NEXT_LEAGUE_REFRESH_STATE_KEY)) || 0;
  if (fixtures.length && Date.now() < nextRefreshAt) return fixtures;
  try {
    const league = await getOfficialLeaguePayload();
    const refreshed = leagueFixtureSnapshot(league);
    if (refreshed.length !== matches.length) {
      throw new Error(`Expected ${matches.length} local fixtures, received ${refreshed.length}`);
    }
    fixtures = refreshed;
    await setStateValue(env, LEAGUE_FIXTURES_STATE_KEY, JSON.stringify(fixtures));
    await setStateValue(env, NEXT_LEAGUE_REFRESH_STATE_KEY, Date.now() + LEAGUE_REFRESH_MS);
  } catch (error) {
    console.error("Official league fixture refresh failed", error);
    await setStateValue(env, NEXT_LEAGUE_REFRESH_STATE_KEY, Date.now() + 2 * 60 * 1000);
  }
  return fixtures;
}

function lineupMatchesFixture(lineup, fixture, { requireBoth = Boolean(lineup?.published) } = {}) {
  if (!lineup || !fixture || String(lineup.providerMatchId || "") !== String(fixture.providerId || "")) return false;
  if (!Array.isArray(lineup.teams)) return false;
  const seenSides = new Set();
  for (const team of lineup.teams) {
    const side = String(team?.side || "");
    if (!["home", "away"].includes(side)
      || seenSides.has(side)
      || String(team?.teamId || "") !== String(fixture[side] || "")) return false;
    seenSides.add(side);
  }
  return !requireBoth || (
    seenSides.has("home")
    && seenSides.has("away")
    && seenSides.size === 2
    && isPublishedLineup(lineup.teams)
  );
}

function parsedStoredLineup(row, fixture) {
  if (!row?.payload_json) return null;
  try {
    const lineup = JSON.parse(row.payload_json);
    const published = Number(row.published || 0) === 1;
    if (Boolean(lineup?.published) !== published
      || !lineupMatchesFixture(lineup, fixture, { requireBoth: published })) return null;
    return lineup;
  } catch {
    return null;
  }
}

async function touchMatchLineupPoll(env, fixture) {
  const kickoffAt = new Date(fixture.kickoffAt || 0).getTime();
  if (!Number.isFinite(kickoffAt) || kickoffAt <= 0) return;
  const now = Date.now();
  const emptyPayload = JSON.stringify({
    providerMatchId: fixture.providerId,
    published: false,
    updatedAt: new Date(now).toISOString(),
    teams: []
  });
  await env.DB.prepare(`
    INSERT OR IGNORE INTO match_lineups
      (match_id, provider_match_id, matchday, kickoff_at, payload_json,
       published, published_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6)
  `).bind(
    fixture.localMatchId,
    fixture.providerId,
    fixture.matchday,
    kickoffAt,
    emptyPayload,
    now
  ).run();
  await env.DB.prepare(`
    UPDATE match_lineups
    SET kickoff_at = ?3, updated_at = ?4
    WHERE match_id = ?1 AND provider_match_id = ?2 AND published = 0
  `).bind(fixture.localMatchId, fixture.providerId, kickoffAt, now).run();
}

async function persistMatchLineup(env, fixture, lineup) {
  const kickoffAt = new Date(fixture.kickoffAt || 0).getTime();
  if (!Number.isFinite(kickoffAt) || kickoffAt <= 0) return { firstPublication: false };
  if (!lineupMatchesFixture(lineup, fixture, { requireBoth: Boolean(lineup?.published) })) {
    throw new Error(`Official lineup does not match fixture ${fixture.localMatchId}`);
  }
  const now = Date.now();
  const payloadJson = JSON.stringify(lineup);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO match_lineups
      (match_id, provider_match_id, matchday, kickoff_at, payload_json,
       published, published_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6)
  `).bind(
    fixture.localMatchId,
    fixture.providerId,
    fixture.matchday,
    kickoffAt,
    payloadJson,
    now
  ).run();

  if (!lineup.published) {
    await env.DB.prepare(`
      UPDATE match_lineups
      SET kickoff_at = ?3, payload_json = ?4, updated_at = ?5
      WHERE match_id = ?1 AND provider_match_id = ?2 AND published = 0
    `).bind(fixture.localMatchId, fixture.providerId, kickoffAt, payloadJson, now).run();
    return { firstPublication: false };
  }

  const firstPublication = await env.DB.prepare(`
    UPDATE match_lineups
    SET kickoff_at = ?3, payload_json = ?4, published = 1,
        published_at = ?5, updated_at = ?6
    WHERE match_id = ?1 AND provider_match_id = ?2 AND published = 0
  `).bind(fixture.localMatchId, fixture.providerId, kickoffAt, payloadJson, now, now).run();
  if (firstPublication.meta?.changes !== 1) {
    await env.DB.prepare(`
      UPDATE match_lineups
      SET kickoff_at = ?3, payload_json = ?4, updated_at = ?5
      WHERE match_id = ?1 AND provider_match_id = ?2 AND published = 1
    `).bind(fixture.localMatchId, fixture.providerId, kickoffAt, payloadJson, now).run();
  }
  return { firstPublication: firstPublication.meta?.changes === 1 };
}

async function pollUpcomingLineups(env, fixtures) {
  const now = Date.now();
  const candidates = fixtures
    .filter((fixture) => ["NS", "PST"].includes(fixture.status))
    .map((fixture) => ({ ...fixture, kickoffMs: new Date(fixture.kickoffAt || 0).getTime() }))
    .filter((fixture) => Number.isFinite(fixture.kickoffMs)
      && now >= fixture.kickoffMs - LINEUP_POLL_WINDOW_MS
      && now < fixture.kickoffMs)
    .sort((left, right) => left.kickoffMs - right.kickoffMs);
  if (!candidates.length) return 0;

  const storedResult = await env.DB.prepare("SELECT match_id, published, updated_at FROM match_lineups").all();
  const stored = new Map((storedResult.results || []).map((row) => [row.match_id, row]));
  const pending = candidates
    .filter((fixture) => Number(stored.get(fixture.localMatchId)?.published || 0) !== 1)
    .sort((left, right) => (
      Number(stored.get(left.localMatchId)?.updated_at || 0) - Number(stored.get(right.localMatchId)?.updated_at || 0)
      || left.kickoffMs - right.kickoffMs
    ))
    .slice(0, MAX_LINEUP_POLLS_PER_TICK);
  const publications = await Promise.all(pending.map(async (fixture) => {
    try {
      // Touch every attempted candidate before the external request. Failed
      // requests therefore rotate behind untouched/older candidates instead
      // of starving the fourth and subsequent simultaneous fixtures.
      await touchMatchLineupPoll(env, fixture);
      const lineup = await getOfficialMatchLineup(fixture.providerId, { force: true });
      const stored = await persistMatchLineup(env, fixture, lineup);
      return stored.firstPublication ? 1 : 0;
    } catch (error) {
      console.error("Official lineup poll failed", {
        localMatchId: fixture.localMatchId,
        providerMatchId: fixture.providerId,
        error
      });
      return 0;
    }
  }));
  return publications.reduce((total, value) => total + value, 0);
}

async function processPublishedLineupNotifications(env, fixtures, enqueueBudget) {
  if (enqueueBudget.remaining <= 0) return;
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.localMatchId, fixture]));
  const result = await env.DB.prepare(`
    SELECT match_id, provider_match_id, matchday, kickoff_at, published_at
    FROM match_lineups
    WHERE published = 1 AND kickoff_at > ?1
    ORDER BY kickoff_at, match_id
  `).bind(Date.now()).all();
  for (const row of result.results || []) {
    if (enqueueBudget.remaining <= 0) break;
    const fixture = fixturesById.get(row.match_id);
    const publishedAt = Number(row.published_at) || 0;
    if (!fixture || publishedAt <= 0) continue;
    const eventPrefix = `lineup-published:${row.match_id}:`;
    const uids = await subscriberUidsMissingEvent(env, eventPrefix, enqueueBudget.remaining, publishedAt);
    const homeName = TEAM_BY_ID.get(fixture.home)?.name || fixture.home;
    const awayName = TEAM_BY_ID.get(fixture.away)?.name || fixture.away;
    for (const uid of uids) {
      const inserted = await enqueueEvent(env, `${eventPrefix}${uid}`, "lineup-published", {
        type: "lineup-published",
        localMatchId: row.match_id,
        matchId: row.match_id,
        providerMatchId: row.provider_match_id,
        matchday: Number(row.matchday),
        kickoffAt: new Date(Number(row.kickoff_at)).toISOString(),
        title: "Składy zostały podane",
        body: `${homeName} – ${awayName}. Sprawdź wyjściowe jedenastki przed pierwszym gwizdkiem.`,
        url: appUrl(env, `#ekstraklasa/mecz/${encodeURIComponent(row.match_id)}`),
        recipientBefore: publishedAt
      }, { uid });
      if (inserted) enqueueBudget.remaining -= 1;
      if (enqueueBudget.remaining <= 0) break;
    }
  }
}

function validStoredEventKey(eventKey) {
  return typeof eventKey === "string"
    && eventKey.length <= 220
    && /^[A-Za-z0-9:_-]+$/.test(eventKey);
}

async function pendingEventKeys(env, limit = MAX_TICK_DISPATCH_MESSAGES) {
  const now = Date.now();
  const queued = await env.DB.prepare(`
    SELECT event_key
    FROM notification_events
    WHERE status = 'pending'
       OR (status = 'failed' AND attempts < ?3)
       OR (status = 'processing' AND lease_until <= ?1)
    ORDER BY updated_at, created_at, event_key
    LIMIT ?2
  `).bind(now, Math.max(1, Math.min(MAX_TICK_DISPATCH_MESSAGES, limit)), MAX_EVENT_ATTEMPTS).all();
  return (queued.results || []).map((event) => event.event_key).filter(validStoredEventKey);
}

async function publishPendingEventKeys(env) {
  if (!env.VAPID_PRIVATE_KEY) return 0;
  const eventKeys = await pendingEventKeys(env);
  if (!eventKeys.length) return 0;
  const queue = requireNotificationQueue(env);
  if (typeof queue.sendBatch === "function") {
    await queue.sendBatch(eventKeys.map((eventKey) => ({ body: { type: "dispatch", eventKey } })));
  } else {
    for (const eventKey of eventKeys) await scheduleEventDispatch(env, eventKey);
  }
  return eventKeys.length;
}

async function dispatchStoredEvent(env, eventKey) {
  if (!validStoredEventKey(eventKey)) return { status: "invalid-message" };
  const event = await env.DB.prepare(`
    SELECT event_key, kind, payload_json, target_uid, exclude_uid,
           status, lease_until, attempts
    FROM notification_events WHERE event_key = ?1
  `).bind(eventKey).first();
  if (!event) return { status: "missing" };
  if (event.status === "completed") return { status: "completed" };
  if (event.status === "failed" && Number(event.attempts) >= MAX_EVENT_ATTEMPTS) {
    return { status: "exhausted" };
  }
  if (event.status === "processing" && Number(event.lease_until) > Date.now()) {
    return {
      status: "busy",
      retryAfterSeconds: Math.max(1, Math.ceil((Number(event.lease_until) - Date.now()) / 1000))
    };
  }
  if (!env.VAPID_PRIVATE_KEY || typeof env.VAPID_PRIVATE_KEY !== "string") {
    throw new Error("Missing VAPID_PRIVATE_KEY secret");
  }
  let payload;
  try {
    payload = JSON.parse(event.payload_json);
  } catch {
    const now = Date.now();
    await env.DB.prepare(`
      UPDATE notification_events
      SET status = 'completed', lease_until = 0, completed_at = ?2, updated_at = ?2
      WHERE event_key = ?1
    `).bind(eventKey, now).run();
    console.error("Dropped event with invalid stored payload", { eventKey });
    return { status: "invalid-payload" };
  }
  if (ADMIN_NOTIFICATION_TYPES.has(payload.type)) {
    const expiresAt = Number(payload.expiresAt) || 0;
    if (!expiresAt || expiresAt <= Date.now()) {
      const now = Date.now();
      await env.DB.prepare(`
        UPDATE notification_events
        SET status = 'completed', lease_until = 0, completed_at = ?2, updated_at = ?2
        WHERE event_key = ?1
      `).bind(eventKey, now).run();
      return { status: "expired" };
    }
  }
  if (payload.type === "matchday-reminder") {
    const startsAt = new Date(payload.startsAt || 0).getTime();
    if (Number.isFinite(startsAt) && startsAt <= Date.now()) {
      const now = Date.now();
      await env.DB.prepare(`
        UPDATE notification_events
        SET status = 'completed', lease_until = 0, completed_at = ?2, updated_at = ?2
        WHERE event_key = ?1
      `).bind(eventKey, now).run();
      return { status: "expired" };
    }
  }
  if (payload.type === "lineup-published") {
    const kickoffAt = new Date(payload.kickoffAt || 0).getTime();
    if (Number.isFinite(kickoffAt) && kickoffAt <= Date.now()) {
      const now = Date.now();
      await env.DB.prepare(`
        UPDATE notification_events
        SET status = 'completed', lease_until = 0, completed_at = ?2, updated_at = ?2
        WHERE event_key = ?1
      `).bind(eventKey, now).run();
      return { status: "expired" };
    }
  }
  const result = await dispatchEvent(env, event.event_key, event.kind, payload, {
    uid: event.target_uid || "",
    excludeUid: event.exclude_uid || "",
    createdBefore: Number(payload.recipientBefore) || 0
  });
  if (result.status === "pending") await scheduleEventDispatch(env, eventKey, 1);
  return result;
}

async function stateValue(env, key) {
  const row = await env.DB.prepare("SELECT value FROM worker_state WHERE key = ?1").bind(key).first();
  return row?.value || "";
}

async function setStateValue(env, key, value) {
  await env.DB.prepare(`
    INSERT INTO worker_state (key, value, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, String(value), Date.now()).run();
}

async function runQueueTick(env) {
  let payload = null;
  const enqueueBudget = { remaining: MAX_TICK_ENQUEUES };
  let leagueFixtures = [];
  try {
    leagueFixtures = await refreshOfficialLeagueFixtures(env);
    await pollUpcomingLineups(env, leagueFixtures);
    await processPublishedLineupNotifications(env, leagueFixtures, enqueueBudget);
  } catch (error) {
    console.error("Lineup notification cycle failed", error);
  }
  let baselineAt = Number(await stateValue(env, RESULT_BASELINE_STATE_KEY)) || 0;
  const nextPollAt = Number(await stateValue(env, "next_live_poll_at")) || 0;
  if (Date.now() >= nextPollAt) {
    try {
      payload = await getOfficialLivePayload();
      const requestedNext = new Date(payload.nextPollAt || 0).getTime();
      const next = Number.isFinite(requestedNext) && requestedNext > Date.now()
        ? requestedNext
        : Date.now() + Math.max(45, Number(payload.pollIntervalSeconds) || 300) * 1000;
      await setStateValue(env, "next_live_poll_at", next);
      await storeChangedFinalMatches(env, payload.fixtures || []);
      if (baselineAt <= 0) {
        // The first successful poll establishes a baseline. Results already in
        // D1 (for example after a mid-season deploy) must not flood players.
        baselineAt = Date.now();
        await setStateValue(env, RESULT_BASELINE_STATE_KEY, baselineAt);
      } else {
        await processMatchdaySummaries(env, enqueueBudget, baselineAt);
      }
    } catch (error) {
      console.error("Official live poll failed", error);
      await setStateValue(env, "next_live_poll_at", Date.now() + 2 * 60 * 1000);
    }
  }
  await enqueuePendingMatchResults(env, enqueueBudget, baselineAt);
  await processReminders(env, payload?.fixtures || [], enqueueBudget);
  const nextCleanupAt = Number(await stateValue(env, "next_notification_cleanup_at")) || 0;
  if (Date.now() >= nextCleanupAt) {
    const cleanupBefore = Date.now() - 90 * 24 * 60 * 60 * 1000;
    await env.DB.batch([
      env.DB.prepare(`
        DELETE FROM notification_events
        WHERE updated_at < ?1 AND kind IN ('chat-message', 'player-joined')
      `).bind(cleanupBefore),
      env.DB.prepare("DELETE FROM request_limits WHERE updated_at < ?1")
        .bind(Date.now() - 24 * 60 * 60 * 1000)
    ]);
    await setStateValue(env, "next_notification_cleanup_at", Date.now() + 24 * 60 * 60 * 1000);
  }
  await publishPendingEventKeys(env);
}

function health(env) {
  return {
    ok: true,
    service: "ekstraklasa-typer-notifications",
    season: SEASON_ID,
    databaseConfigured: Boolean(env.DB),
    vapidConfigured: Boolean(env.VAPID_PRIVATE_KEY),
    queueConfigured: Boolean(env.NOTIFICATION_QUEUE),
    officialProvider: "ekstraklasa-match-center",
    now: new Date().toISOString()
  };
}

async function currentSeasonFixture(providerMatchId) {
  const league = await getOfficialLeaguePayload();
  return (league.matches || []).find((match) => match.providerId === providerMatchId) || null;
}

async function storedLineupForFixture(env, fixture) {
  try {
    const row = await env.DB.prepare(`
      SELECT match_id, provider_match_id, payload_json, published, updated_at
      FROM match_lineups
      WHERE provider_match_id = ?1
      LIMIT 1
    `).bind(fixture.providerId).first();
    if (!row
      || (fixture.localMatchId && row.match_id !== fixture.localMatchId)
      || row.provider_match_id !== fixture.providerId) return null;
    const lineup = parsedStoredLineup(row, fixture);
    if (!lineup) return null;
    if (Number(row.published || 0) === 1
      || Number(row.updated_at || 0) >= Date.now() - FRESH_STORED_LINEUP_MS) return lineup;
  } catch (error) {
    // A missing table during a rolling deployment must not make the public
    // endpoint unavailable; fall through to the official provider.
    console.error("Stored lineup lookup failed", { providerMatchId: fixture.providerId, error });
  }
  return null;
}

async function publicMatchLineup(env, providerMatchId) {
  const fixture = await currentSeasonFixture(providerMatchId);
  if (!fixture) {
    throw new HttpError(404, "provider-match-not-in-current-season", "Mecz nie naleĹĽy do bieĹĽÄ…cego sezonu.");
  }

  const stored = await storedLineupForFixture(env, fixture);
  if (stored) return stored;

  const lineup = await getOfficialMatchLineup(providerMatchId);
  if (!lineupMatchesFixture(lineup, fixture, { requireBoth: Boolean(lineup?.published) })) {
    throw new HttpError(502, "provider-lineup-mismatch", "SkĹ‚ad nie odpowiada wybranemu meczowi.");
  }
  if (fixture.localMatchId && MATCH_BY_ID.has(fixture.localMatchId)) {
    await persistMatchLineup(env, fixture, lineup);
  }
  return lineup;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  if (request.method === "OPTIONS") {
    if (!allowedOrigin(origin, env)) return jsonResponse(request, env, { error: "origin-not-allowed" }, 403);
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (origin && !allowedOrigin(origin, env)) {
    throw new HttpError(403, "origin-not-allowed", "Ta domena nie może korzystać z API.");
  }
  if (request.method === "GET" && url.pathname === "/health") return jsonResponse(request, env, await health(env));
  if (request.method === "GET" && url.pathname === "/api/league") {
    return jsonResponse(request, env, await getOfficialLeaguePayload(), 200, {
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=300"
    });
  }
  if (request.method === "GET" && url.pathname === "/api/league/lineups") {
    const providerMatchId = String(url.searchParams.get("provider") || "").trim();
    if (!isOfficialMatchId(providerMatchId)) {
      throw new HttpError(400, "invalid-provider-match-id", "Nieprawidłowy identyfikator meczu.");
    }
    return jsonResponse(request, env, await publicMatchLineup(env, providerMatchId), 200, {
      "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=30"
    });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/players") {
    return jsonResponse(request, env, await adminPlayers(request, env));
  }
  if (request.method !== "POST") throw new HttpError(404, "not-found", "Nie znaleziono endpointu.");

  const routes = {
    "/api/profile/sync": profileSync,
    "/api/admin/bootstrap": adminBootstrap,
    "/api/push/register": registerSubscription,
    "/api/push/unregister": unregisterSubscription,
    "/api/push/rotate": rotateSubscription,
    "/api/events/player-joined": playerJoined,
    "/api/events/chat-message": chatMessage,
    "/api/events/name-change-request": nameChangeRequest,
    "/api/events/player-name-changed": playerNameChanged,
    "/api/events/name-change-decision": nameChangeDecision,
    "/api/events/admin-name-edited": adminNameEdited,
    "/api/picks/sync": syncPicks
  };
  const handler = routes[url.pathname];
  if (!handler) throw new HttpError(404, "not-found", "Nie znaleziono endpointu.");
  return jsonResponse(request, env, await handler(request, env));
}

async function consumeQueueMessage(message, env) {
  const body = message?.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    console.error("Dropping malformed notification Queue message");
    return { status: "invalid-message" };
  }
  if (body.type === "tick") {
    await runQueueTick(env);
    return { status: "tick-completed" };
  }
  if (body.type === "dispatch") return dispatchStoredEvent(env, body.eventKey);
  console.error("Dropping unknown notification Queue message", { type: body.type });
  return { status: "unknown-message" };
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal-error";
      if (status >= 500) console.error("Notification worker request failed", error);
      return jsonResponse(request, env, {
        error: code,
        message: error instanceof HttpError ? error.message : "Wewnętrzny błąd usługi powiadomień."
      }, status);
    }
  },

  async scheduled(controller, env, context) {
    context.waitUntil(requireNotificationQueue(env).send({
      type: "tick",
      scheduledAt: new Date(controller.scheduledTime || Date.now()).toISOString()
    }).catch((error) => console.error("Notification tick enqueue failed", error)));
  },

  async queue(batch, env) {
    for (const message of batch.messages || []) {
      try {
        const result = await consumeQueueMessage(message, env);
        if (result?.status === "busy") {
          message.retry({
            delaySeconds: Math.max(1, Math.min(60, Number(result.retryAfterSeconds) || QUEUE_RETRY_SECONDS))
          });
        } else {
          message.ack();
        }
      } catch (error) {
        console.error("Notification Queue message failed", {
          messageId: message.id,
          type: message.body?.type,
          error
        });
        message.retry({ delaySeconds: QUEUE_RETRY_SECONDS });
      }
    }
  }
};
