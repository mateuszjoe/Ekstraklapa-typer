import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { matches as baseMatches, teamById } from "./data.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const localEnv = await loadLocalEnv(join(root, ".env"));
const port = Number(process.env.PORT || 5173);
const adminToken = process.env.ADMIN_RESULT_TOKEN || localEnv.ADMIN_RESULT_TOKEN || "";
const providerBaseUrl = "https://api.centrum-meczowe.ekstraklasa.org";
const requestedPollInterval = Number(process.env.LIVE_POLL_INTERVAL_MS || localEnv.LIVE_POLL_INTERVAL_MS || 55_000);
const pollIntervalMs = Math.min(60_000, Math.max(45_000, requestedPollInterval));
const seasonRefreshMs = 60 * 60_000;
const scheduleRefreshMs = 6 * 60 * 60_000;
const backgroundLiveRefreshMs = 5 * 60_000;
const staleLiveMaxAgeMs = 5 * 60_000;
const requestTimeoutMs = 12_000;
const runtimeDir = join(root, ".cache");
const stateFile = join(runtimeDir, "ekstraklasa-match-center-state.json");
const manualResultsFile = join(root, "manual-results.json");

const NO_LONGER_LIVE = new Set(["FT", "AWD", "CANC", "PST"]);
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json; charset=utf-8"
};

let providerState = {
  seasonId: null,
  seasonName: null,
  currentWeek: null,
  weeksNumber: null,
  schedule: [],
  seasonUpdatedAt: null,
  fullScheduleUpdatedAt: null,
  scheduleUpdatedAt: null,
  lastLiveCheckAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextPollAt: null,
  error: null
};
let pollInFlight = null;

async function loadLocalEnv(path) {
  try {
    const content = await readFile(path, "utf8");
    return Object.fromEntries(content.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
        return [key, value];
      }));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Nie udało się odczytać .env:", error.message);
    return {};
  }
}

const nowIso = () => new Date().toISOString();
const safeJson = (value) => JSON.stringify(value, null, 2);

const teamByOfficialCode = {
  CRA: "cracovia",
  GKS: "gks-katowice",
  GOR: "gornik-zabrze",
  JAG: "jagiellonia",
  KOR: "korona",
  LPO: "lech",
  LEG: "legia",
  MOT: "motor",
  PIA: "piast",
  POG: "pogon",
  RAD: "radomiak",
  RCZ: "rakow",
  SLA: "slask",
  WID: "widzew",
  WIE: "wieczysta",
  WIS: "wisla-krakow",
  WPL: "wisla-plock",
  ZAG: "zaglebie"
};

const teamAliases = {
  "cracovia": ["cracovia"],
  "gks-katowice": ["gkskatowice"],
  "gornik-zabrze": ["gornikzabrze"],
  "jagiellonia": ["jagielloniabialystok", "jagiellonia"],
  "korona": ["koronakielce", "korona", "kielce"],
  "lech": ["lechpoznan", "lech"],
  "legia": ["legiawarszawa", "legia"],
  "motor": ["motorlublin", "motor"],
  "piast": ["piastgliwice", "piast"],
  "pogon": ["pogonszczecin", "pogon"],
  "radomiak": ["radomiakradom", "radomiak"],
  "rakow": ["rakowczestochowa", "rakow"],
  "slask": ["slaskwroclaw", "slask"],
  "widzew": ["widzewlodz", "widzew"],
  "wieczysta": ["wieczystakrakow", "wieczysta"],
  "wisla-krakow": ["wislakrakow"],
  "wisla-plock": ["wislaplock"],
  "zaglebie": ["kghmzaglebielubin", "zaglebielubin", "zaglebie"]
};

async function writeJsonAtomic(path, value) {
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, safeJson(value), "utf8");
  await rename(temporary, path);
}

async function loadProviderState() {
  try {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    providerState = { ...providerState, ...saved };
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Nie udało się odczytać cache Centrum Meczowego:", error.message);
  }
}

async function saveProviderState() {
  await writeJsonAtomic(stateFile, providerState);
}

async function apiFetch(path) {
  providerState.lastAttemptAt = nowIso();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(`${providerBaseUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Centrum Meczowe HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Centrum Meczowe: przekroczono czas odpowiedzi");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/ł/g, "l").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function resolveLocalTeamId(providerName, providerCode) {
  const byCode = teamByOfficialCode[normalizeName(providerCode).toUpperCase()];
  if (byCode) return byCode;

  const normalized = normalizeName(providerName);
  return Object.entries(teamAliases).find(([, aliases]) => aliases.some((alias) => {
    const candidate = normalizeName(alias);
    return normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized);
  }))?.[0] || null;
}

function normalizeProviderStatus(status, postponed = false) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "fixture" && postponed) return "PST";
  return ({
    fixture: "NS",
    playing: "LIVE",
    cancelled: "CANC",
    postponed: "PST",
    suspended: "SUSP",
    awarded: "AWD",
    played: "FT"
  })[normalized] || String(status || "NS").toUpperCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeFixture(item) {
  const homeId = resolveLocalTeamId(item.home_team_name, item.home_team_code);
  const awayId = resolveLocalTeamId(item.away_team_name, item.away_team_code);
  const localMatch = baseMatches.find((match) => match.home === homeId && match.away === awayId);
  const kickoffAt = item.postponed && item.postponed_datetime
    ? item.postponed_datetime
    : item.match_datetime || (item.date && item.local_time ? `${item.date}T${item.local_time}+02:00` : null);

  return {
    providerId: item.match_id,
    localMatchId: localMatch?.id || null,
    kickoffAt,
    status: normalizeProviderStatus(item.status, item.postponed),
    elapsed: null,
    home: {
      id: item.home_team_id,
      name: item.home_team_name,
      logo: homeId ? teamById[homeId].crest : null
    },
    away: {
      id: item.away_team_id,
      name: item.away_team_name,
      logo: awayId ? teamById[awayId].crest : null
    },
    score: {
      home: numberOrNull(item.home_score),
      away: numberOrNull(item.away_score)
    },
    source: "ekstraklasa-match-center"
  };
}

function mergeFixtures(fixtures) {
  const byId = new Map(providerState.schedule.map((fixture) => [String(fixture.providerId), fixture]));
  fixtures.forEach((fixture) => byId.set(String(fixture.providerId), fixture));
  providerState.schedule = [...byId.values()].sort((a, b) => {
    const first = new Date(a.kickoffAt || 0).getTime();
    const second = new Date(b.kickoffAt || 0).getTime();
    return first - second;
  });
}

function staticSchedule() {
  return baseMatches.filter((match) => match.kickoffConfirmed).map((match) => ({
    providerId: `local-${match.id}`,
    localMatchId: match.id,
    kickoffAt: match.kickoffAt,
    status: match.status,
    elapsed: null,
    home: { id: match.home, name: teamById[match.home].name, logo: teamById[match.home].crest },
    away: { id: match.away, name: teamById[match.away].name, logo: teamById[match.away].crest },
    score: { home: match.homeScore, away: match.awayScore },
    source: "official-fixture"
  }));
}

function scheduleForPolling() {
  const currentWeekFixtures = providerState.schedule.filter((fixture) => {
    const match = baseMatches.find((item) => item.id === fixture.localMatchId);
    return fixture.status === "LIVE"
      || !providerState.currentWeek
      || match?.matchday === providerState.currentWeek;
  });
  return currentWeekFixtures.length ? currentWeekFixtures : staticSchedule();
}

function isInMatchWindow(now = Date.now()) {
  return scheduleForPolling().some((fixture) => {
    if (fixture.status === "LIVE") return true;
    if (NO_LONGER_LIVE.has(fixture.status)) return false;
    const kickoff = new Date(fixture.kickoffAt).getTime();
    return Number.isFinite(kickoff) && now >= kickoff - 10 * 60_000 && now <= kickoff + 180 * 60_000;
  });
}

function nextMatchWindow(now = Date.now()) {
  return scheduleForPolling()
    .filter((fixture) => !NO_LONGER_LIVE.has(fixture.status))
    .map((fixture) => new Date(fixture.kickoffAt).getTime() - 10 * 60_000)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now)
    .sort((a, b) => a - b)[0] || null;
}

async function refreshCurrentSeason() {
  const payload = await apiFetch("/v1/seasons/current");
  const season = payload?.data;
  const currentWeek = Number(payload?.meta?.current_week_number);
  if (!season?.season_id || !Number.isInteger(currentWeek)) {
    throw new Error("Centrum Meczowe zwróciło niepełne dane sezonu");
  }

  const changed = providerState.seasonId !== season.season_id || providerState.currentWeek !== currentWeek;
  if (providerState.seasonId && providerState.seasonId !== season.season_id) providerState.schedule = [];
  providerState.seasonId = season.season_id;
  providerState.seasonName = season.name || null;
  providerState.currentWeek = currentWeek;
  providerState.weeksNumber = numberOrNull(payload?.meta?.weeks_number);
  providerState.seasonUpdatedAt = nowIso();
  return changed;
}

async function refreshFullSchedule() {
  if (!providerState.seasonId) throw new Error("Brak bieżącego sezonu");
  const params = new URLSearchParams({ season_id: providerState.seasonId });
  const payload = await apiFetch(`/v1/matches?${params}`);
  if (!Array.isArray(payload?.data)) throw new Error("Centrum Meczowe zwróciło nieprawidłową listę meczów");
  providerState.schedule = payload.data.map(normalizeFixture);
  providerState.fullScheduleUpdatedAt = nowIso();
  providerState.scheduleUpdatedAt = nowIso();
  providerState.lastSuccessAt = nowIso();
}

async function pollCurrentWeek() {
  if (!providerState.seasonId || !providerState.currentWeek) {
    throw new Error("Brak bieżącego sezonu lub kolejki");
  }

  const params = new URLSearchParams({
    season_id: providerState.seasonId,
    week: String(providerState.currentWeek)
  });
  const payload = await apiFetch(`/v1/matches?${params}`);
  if (!Array.isArray(payload?.data)) throw new Error("Centrum Meczowe zwróciło nieprawidłową listę meczów");
  mergeFixtures(payload.data.map(normalizeFixture));
  providerState.scheduleUpdatedAt = nowIso();
  providerState.lastSuccessAt = nowIso();
}

async function pollPlayingMatches() {
  if (!providerState.seasonId) throw new Error("Brak bieżącego sezonu");
  const params = new URLSearchParams({ season_id: providerState.seasonId, status: "playing" });
  const payload = await apiFetch(`/v1/matches?${params}`);
  if (!Array.isArray(payload?.data)) throw new Error("Centrum Meczowe zwróciło nieprawidłową listę meczów LIVE");

  const liveFixtures = payload.data.map(normalizeFixture);
  const liveIds = new Set(liveFixtures.map((fixture) => String(fixture.providerId)));
  const previouslyLive = providerState.schedule.filter((fixture) => (
    fixture.status === "LIVE" && !liveIds.has(String(fixture.providerId))
  ));
  const settledFixtures = await Promise.all(previouslyLive.map(async (fixture) => {
    const match = await apiFetch(`/v1/matches/${encodeURIComponent(fixture.providerId)}`);
    return match?.data ? normalizeFixture(match.data) : null;
  }));

  mergeFixtures([...liveFixtures, ...settledFixtures.filter(Boolean)]);
  providerState.lastLiveCheckAt = nowIso();
  providerState.lastSuccessAt = nowIso();
}

function millisecondsSince(isoDate) {
  const timestamp = new Date(isoDate || 0).getTime();
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

function planNextPoll(inWindow = isInMatchWindow()) {
  const now = Date.now();
  if (inWindow) return now + pollIntervalMs;
  const backgroundRefresh = now + backgroundLiveRefreshMs;
  const nextWindow = nextMatchWindow(now);
  return nextWindow ? Math.min(backgroundRefresh, nextWindow) : backgroundRefresh;
}

async function runPollingCycle() {
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    try {
      const plannedPoll = new Date(providerState.nextPollAt || 0).getTime();
      const needsBootstrap = !providerState.seasonId
        || !providerState.schedule.length
        || !providerState.fullScheduleUpdatedAt;
      if (!needsBootstrap && Number.isFinite(plannedPoll) && Date.now() < plannedPoll) return;

      let seasonChanged = false;
      if (!providerState.seasonId || millisecondsSince(providerState.seasonUpdatedAt) >= seasonRefreshMs) {
        seasonChanged = await refreshCurrentSeason();
      }

      const fullScheduleDue = !providerState.schedule.length
        || seasonChanged
        || millisecondsSince(providerState.fullScheduleUpdatedAt) >= scheduleRefreshMs;
      if (fullScheduleDue) await refreshFullSchedule();

      const inWindow = isInMatchWindow();
      if (!fullScheduleDue && inWindow && millisecondsSince(providerState.scheduleUpdatedAt) >= pollIntervalMs) {
        await pollCurrentWeek();
      }

      const liveRefreshAfter = inWindow ? pollIntervalMs : backgroundLiveRefreshMs;
      if (millisecondsSince(providerState.lastLiveCheckAt) >= liveRefreshAfter) {
        await pollPlayingMatches();
      }

      providerState.error = null;
      providerState.nextPollAt = new Date(planNextPoll(isInMatchWindow())).toISOString();
    } catch (error) {
      providerState.error = error.message;
      providerState.nextPollAt = new Date(Date.now() + pollIntervalMs).toISOString();
      console.warn("Centrum Meczowe Ekstraklasy:", error.message);
    } finally {
      await saveProviderState().catch(() => {});
      pollInFlight = null;
    }
  })();
  return pollInFlight;
}

function providerFixtureForBase(match) {
  const direct = providerState.schedule.find((fixture) => fixture.localMatchId === match.id);
  if (direct) return direct;
  const homeName = normalizeName(teamById[match.home].name);
  const awayName = normalizeName(teamById[match.away].name);
  return providerState.schedule.find((fixture) => {
    const home = normalizeName(fixture.home.name);
    const away = normalizeName(fixture.away.name);
    return (home.includes(homeName) || homeName.includes(home)) && (away.includes(awayName) || awayName.includes(away));
  });
}

async function readManualResults() {
  try {
    return JSON.parse(await readFile(manualResultsFile, "utf8"));
  } catch {
    return { results: {} };
  }
}

async function fixturesWithManualResults() {
  const manual = await readManualResults();
  const fixtures = [...providerState.schedule];
  for (const [matchId, result] of Object.entries(manual.results || {})) {
    const match = baseMatches.find((item) => item.id === matchId);
    if (!match) continue;
    const existing = providerFixtureForBase(match);
    const override = {
      ...(existing || staticSchedule().find((item) => item.localMatchId === matchId)),
      providerId: existing?.providerId || `manual-${matchId}`,
      localMatchId: matchId,
      kickoffAt: existing?.kickoffAt || match.kickoffAt,
      status: result.status || "FT",
      elapsed: null,
      home: existing?.home || { id: match.home, name: teamById[match.home].name, logo: teamById[match.home].crest },
      away: existing?.away || { id: match.away, name: teamById[match.away].name, logo: teamById[match.away].crest },
      score: { home: result.homeScore, away: result.awayScore },
      source: "manual"
    };
    const index = fixtures.findIndex((item) => String(item.providerId) === String(override.providerId));
    if (index >= 0) fixtures[index] = override;
    else fixtures.push(override);
  }
  return fixtures;
}

async function publicPayload() {
  await runPollingCycle();
  const inWindow = isInMatchWindow();
  const staleLive = Boolean(providerState.error)
    && millisecondsSince(providerState.lastLiveCheckAt) > staleLiveMaxAgeMs;
  const fixtures = await fixturesWithManualResults();
  return {
    configured: true,
    provider: "ekstraklasa-match-center",
    mode: providerState.error ? "stale" : inWindow ? "live-polling" : "waiting",
    updatedAt: providerState.lastSuccessAt,
    scheduleUpdatedAt: providerState.scheduleUpdatedAt,
    nextPollAt: providerState.nextPollAt,
    pollIntervalSeconds: (inWindow ? pollIntervalMs : backgroundLiveRefreshMs) / 1000,
    stale: Boolean(providerState.error),
    error: providerState.error,
    season: {
      id: providerState.seasonId,
      name: providerState.seasonName,
      currentWeek: providerState.currentWeek,
      weeksNumber: providerState.weeksNumber
    },
    fixtures: staleLive
      ? fixtures.map((fixture) => fixture.status === "LIVE" ? { ...fixture, status: "SUSP" } : fixture)
      : fixtures
  };
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error("Payload too large");
  }
  return JSON.parse(body || "{}");
}

async function updateManualResult(req) {
  if (!adminToken || req.headers["x-admin-token"] !== adminToken) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
  const body = await readBody(req);
  const match = baseMatches.find((item) => item.id === body.matchId);
  if (!match) throw new Error("Nieprawidłowe matchId");
  const homeScore = Number(body.homeScore);
  const awayScore = Number(body.awayScore);
  if (!Number.isInteger(homeScore) || homeScore < 0 || !Number.isInteger(awayScore) || awayScore < 0) {
    throw new Error("Wyniki muszą być nieujemnymi liczbami całkowitymi");
  }
  const manual = await readManualResults();
  manual.results ||= {};
  manual.results[match.id] = { status: "FT", homeScore, awayScore, updatedAt: nowIso() };
  const temporary = `${manualResultsFile}.tmp`;
  await writeFile(temporary, safeJson(manual), "utf8");
  await rename(temporary, manualResultsFile);
  return manual.results[match.id];
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/live") {
      res.writeHead(200, { "content-type": mime[".json"], "cache-control": "no-store" });
      res.end(JSON.stringify(await publicPayload()));
      return;
    }
    if (url.pathname === "/api/admin/result" && req.method === "POST") {
      const result = await updateManualResult(req);
      res.writeHead(200, { "content-type": mime[".json"] });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = normalize(resolve(root, `.${pathname.replace(/\\/g, "/")}`));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      const error = new Error("Forbidden");
      error.status = 403;
      throw error;
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Not found");
    res.writeHead(200, { "content-type": mime[extname(target)] || "application/octet-stream" });
    res.end(await readFile(target));
  } catch (error) {
    const status = error.status || 404;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: status === 404 ? "Nie znaleziono" : error.message }));
  }
});

await loadProviderState();
server.listen(port, () => {
  console.log(`Ekstraklasa Typer: http://localhost:${port}`);
  console.log(`Centrum Meczowe Ekstraklasy: aktywne, cache LIVE ${pollIntervalMs / 1000} s, bez klucza API`);
  runPollingCycle();
});

setInterval(runPollingCycle, 30_000).unref();
