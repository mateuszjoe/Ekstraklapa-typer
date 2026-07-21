import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { matches as baseMatches, teamById } from "./data.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const localEnv = await loadLocalEnv(join(root, ".env"));
const port = Number(process.env.PORT || 5173);
const apiKey = process.env.API_FOOTBALL_KEY || localEnv.API_FOOTBALL_KEY || "";
const adminToken = process.env.ADMIN_RESULT_TOKEN || localEnv.ADMIN_RESULT_TOKEN || "";
const leagueId = Number(process.env.API_FOOTBALL_LEAGUE_ID || 106);
const season = Number(process.env.API_FOOTBALL_SEASON || 2026);
const pollIntervalMs = Math.max(5 * 60_000, Number(process.env.LIVE_POLL_INTERVAL_MS || 6 * 60_000));
const requestBudget = Math.min(95, Math.max(1, Number(process.env.API_DAILY_REQUEST_BUDGET || 95)));
const scheduleRefreshMs = 7 * 24 * 60 * 60_000;
const runtimeDir = join(root, ".cache");
const stateFile = join(runtimeDir, "api-football-state.json");
const manualResultsFile = join(root, "manual-results.json");

const FINAL = new Set(["FT", "AET", "PEN", "AWD", "WO"]);
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json; charset=utf-8"
};

let providerState = {
  schedule: [],
  scheduleUpdatedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextPollAt: null,
  requestTimestamps: [],
  quotaDate: null,
  providerLimit: 100,
  providerRemaining: null,
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
const sleepSafeJson = (value) => JSON.stringify(value, null, 2);
const teamAliases = {
  "cracovia": ["cracovia"],
  "gks-katowice": ["gkskatowice"],
  "gornik-zabrze": ["gornikzabrze"],
  "jagiellonia": ["jagielloniabialystok", "jagiellonia"],
  "korona": ["koronakielce", "korona"],
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
  "zaglebie": ["zaglebielubin", "zaglebie"]
};

async function writeJsonAtomic(path, value) {
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, sleepSafeJson(value), "utf8");
  await rename(temporary, path);
}

async function loadProviderState() {
  try {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    providerState = { ...providerState, ...saved };
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Nie udało się odczytać cache API-Football:", error.message);
  }
  pruneRequestHistory();
}

async function saveProviderState() {
  await writeJsonAtomic(stateFile, providerState);
}

function pruneRequestHistory(at = Date.now()) {
  const today = warsawDate(new Date(at));
  if (providerState.quotaDate !== today) {
    providerState.quotaDate = today;
    providerState.requestTimestamps = [];
    providerState.providerRemaining = null;
    return;
  }
  providerState.requestTimestamps = (providerState.requestTimestamps || []).filter(Number.isFinite);
}

function requestsUsed() {
  pruneRequestHistory();
  return providerState.requestTimestamps.length;
}

function canCallProvider() {
  return Boolean(apiKey) && requestsUsed() < requestBudget;
}

async function apiFetch(path) {
  if (!canCallProvider()) throw new Error("Dzienny budżet API został wyczerpany");

  // Nieudane wywołania również mogą być policzone przez dostawcę.
  providerState.requestTimestamps.push(Date.now());
  providerState.lastAttemptAt = nowIso();
  await saveProviderState();

  const response = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { "x-apisports-key": apiKey }
  });
  const limit = Number(response.headers.get("x-ratelimit-requests-limit"));
  const remaining = Number(response.headers.get("x-ratelimit-requests-remaining"));
  if (Number.isFinite(limit)) providerState.providerLimit = limit;
  if (Number.isFinite(remaining)) providerState.providerRemaining = remaining;
  if (!response.ok) throw new Error(`API-Football HTTP ${response.status}`);

  const payload = await response.json();
  if (payload.errors && Object.keys(payload.errors).length) throw new Error(JSON.stringify(payload.errors));
  return payload.response || [];
}

const normalizeFixture = (item) => {
  const homeId = resolveLocalTeamId(item.teams.home.name);
  const awayId = resolveLocalTeamId(item.teams.away.name);
  const localMatch = baseMatches.find((match) => match.home === homeId && match.away === awayId);
  return {
    providerId: item.fixture.id,
    localMatchId: localMatch?.id || null,
    kickoffAt: item.fixture.date,
    status: item.fixture.status.short,
    elapsed: item.fixture.status.elapsed,
    home: { id: item.teams.home.id, name: item.teams.home.name, logo: item.teams.home.logo },
    away: { id: item.teams.away.id, name: item.teams.away.name, logo: item.teams.away.logo },
    score: { home: item.goals.home, away: item.goals.away },
    source: "api-football"
  };
};

function mergeFixtures(fixtures) {
  const byId = new Map(providerState.schedule.map((fixture) => [String(fixture.providerId), fixture]));
  fixtures.forEach((fixture) => byId.set(String(fixture.providerId), fixture));
  providerState.schedule = [...byId.values()].sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt));
}

function warsawDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
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
  return providerState.schedule.length ? providerState.schedule : staticSchedule();
}

function isInMatchWindow(now = Date.now()) {
  return scheduleForPolling().some((fixture) => {
    if (FINAL.has(fixture.status)) return false;
    const kickoff = new Date(fixture.kickoffAt).getTime();
    return Number.isFinite(kickoff) && now >= kickoff - 10 * 60_000 && now <= kickoff + 180 * 60_000;
  });
}

function nextMatchWindow(now = Date.now()) {
  return scheduleForPolling()
    .filter((fixture) => !FINAL.has(fixture.status))
    .map((fixture) => new Date(fixture.kickoffAt).getTime() - 10 * 60_000)
    .filter((timestamp) => timestamp > now)
    .sort((a, b) => a - b)[0] || null;
}

async function refreshSchedule() {
  const fixtures = await apiFetch(`/fixtures?league=${leagueId}&season=${season}&timezone=Europe%2FWarsaw`);
  providerState.schedule = fixtures.map(normalizeFixture);
  providerState.scheduleUpdatedAt = nowIso();
  providerState.lastSuccessAt = nowIso();
  providerState.error = null;
  await saveProviderState();
}

async function pollMatchDay() {
  const date = warsawDate();
  const fixtures = await apiFetch(`/fixtures?league=${leagueId}&season=${season}&date=${date}&timezone=Europe%2FWarsaw`);
  mergeFixtures(fixtures.map(normalizeFixture));
  providerState.lastSuccessAt = nowIso();
  providerState.nextPollAt = new Date(Date.now() + pollIntervalMs).toISOString();
  providerState.error = null;
  await saveProviderState();
}

async function runPollingCycle() {
  if (!apiKey || pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    try {
      const scheduleAge = Date.now() - new Date(providerState.scheduleUpdatedAt || 0).getTime();
      if ((!providerState.schedule.length || scheduleAge >= scheduleRefreshMs) && canCallProvider()) {
        await refreshSchedule();
      }

      const due = !providerState.nextPollAt || Date.now() >= new Date(providerState.nextPollAt).getTime();
      if (due && isInMatchWindow() && canCallProvider()) await pollMatchDay();

      if (!isInMatchWindow()) {
        const nextWindow = nextMatchWindow();
        providerState.nextPollAt = nextWindow ? new Date(nextWindow).toISOString() : null;
      }
    } catch (error) {
      providerState.error = error.message;
      providerState.nextPollAt = new Date(Date.now() + pollIntervalMs).toISOString();
      console.warn("API-Football:", error.message);
    } finally {
      await saveProviderState().catch(() => {});
      pollInFlight = null;
    }
  })();
  return pollInFlight;
}

function normalizeName(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function resolveLocalTeamId(providerName) {
  const normalized = normalizeName(providerName);
  return Object.entries(teamAliases).find(([, aliases]) => aliases.some((alias) => {
    const candidate = normalizeName(alias);
    return normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized);
  }))?.[0] || null;
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
  const used = requestsUsed();
  const inWindow = isInMatchWindow();
  const quotaExhausted = !canCallProvider() && Boolean(apiKey);
  return {
    configured: Boolean(apiKey),
    provider: "api-football",
    mode: !apiKey ? "not-configured" : quotaExhausted ? "quota-exhausted" : inWindow ? "live-polling" : "waiting",
    updatedAt: providerState.lastSuccessAt,
    scheduleUpdatedAt: providerState.scheduleUpdatedAt,
    nextPollAt: providerState.nextPollAt,
    pollIntervalSeconds: pollIntervalMs / 1000,
    quota: {
      usedToday: used,
      localBudget: requestBudget,
      providerLimit: providerState.providerLimit,
      providerRemaining: providerState.providerRemaining
    },
    error: providerState.error,
    fixtures: await fixturesWithManualResults()
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
  await writeFile(temporary, sleepSafeJson(manual), "utf8");
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
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root)) throw new Error("Forbidden");
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
  console.log(apiKey
    ? `API-Football: aktywne, polling co ${pollIntervalMs / 60_000} min, budżet ${requestBudget}/24h`
    : "API-Football: brak API_FOOTBALL_KEY — terminarz i typowanie działają bez LIVE");
  runPollingCycle();
});

setInterval(runPollingCycle, 30_000).unref();
