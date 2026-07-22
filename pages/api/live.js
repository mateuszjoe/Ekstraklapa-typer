import { matches as baseMatches, teams } from "../../data.js";

const PROVIDER = "ekstraklasa-match-center";
const API_BASE = "https://api.centrum-meczowe.ekstraklasa.org";
const RESPONSE_TTL_SECONDS = 45;
const BACKGROUND_TTL_SECONDS = 300;
const STALE_TTL_SECONDS = 300;
const RESULTS_TTL_SECONDS = 300;

const STATUS_MAP = {
  fixture: "NS",
  playing: "LIVE",
  played: "FT",
  awarded: "AWD",
  postponed: "PST",
  suspended: "SUSP",
  cancelled: "CANC"
};

const normalizeCode = (value) => String(value || "").trim().toLocaleUpperCase("pl-PL");
const teamByCode = new Map(teams.map((team) => [normalizeCode(team.short), team]));
const localMatchByTeamsAndWeek = new Map(
  baseMatches.map((match) => [`${match.matchday}:${match.home}:${match.away}`, match])
);

let cachedPayload = null;
let cacheExpiresAt = 0;
let cachedAt = 0;
let inFlightRequest = null;

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function fetchOfficialJson(path, cacheTtl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Ekstraklapa-Typer/1.0"
      },
      signal: controller.signal,
      cf: {
        cacheEverything: true,
        cacheTtl
      }
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Official match center returned HTTP ${response.status}`);
  }

  return response.json();
}

function normalizeFixture(item) {
  const home = teamByCode.get(normalizeCode(item.home_team_code));
  const away = teamByCode.get(normalizeCode(item.away_team_code));
  const week = Number(item.week);
  if (!home || !away || !Number.isInteger(week)) return null;

  const localMatch = localMatchByTeamsAndWeek.get(`${week}:${home.id}:${away.id}`);
  if (!localMatch) return null;
  const kickoffAt = item.postponed_datetime || item.match_datetime || null;
  const status = STATUS_MAP[item.status] || String(item.status || "NS").toUpperCase();

  return {
    providerId: String(item.match_id),
    localMatchId: localMatch.id,
    kickoffAt,
    status,
    elapsed: null,
    score: {
      home: status === "NS" ? null : numberOrNull(item.home_score),
      away: status === "NS" ? null : numberOrNull(item.away_score)
    },
    home: {
      id: home.id,
      name: home.name,
      logo: home.crest
    },
    away: {
      id: away.id,
      name: away.name,
      logo: away.crest
    },
    source: PROVIDER
  };
}

async function loadLivePayload() {
  const season = await fetchOfficialJson("/v1/seasons/current", 300);
  const seasonId = season?.data?.season_id;
  const currentWeek = Number(season?.meta?.current_week_number);

  if (!seasonId || !Number.isInteger(currentWeek)) {
    throw new Error("Official match center returned an invalid current season");
  }

  const queryPrefix = `/v1/matches?season_id=${encodeURIComponent(seasonId)}`;
  const previousWeekRequest = currentWeek > 1
    ? fetchOfficialJson(`${queryPrefix}&week=${currentWeek - 1}`, BACKGROUND_TTL_SECONDS)
    : Promise.resolve({ data: [] });
  const [resultsResponse, previousWeekResponse, weekResponse, liveResponse] = await Promise.all([
    fetchOfficialJson(`${queryPrefix}&status=played,awarded`, RESULTS_TTL_SECONDS),
    previousWeekRequest,
    fetchOfficialJson(`${queryPrefix}&week=${currentWeek}`, RESPONSE_TTL_SECONDS),
    fetchOfficialJson(`${queryPrefix}&status=playing`, RESPONSE_TTL_SECONDS)
  ]);

  const matchesById = new Map();
  [
    ...(resultsResponse?.data || []),
    ...(previousWeekResponse?.data || []),
    ...(weekResponse?.data || []),
    ...(liveResponse?.data || [])
  ].forEach((match) => {
    if (match?.match_id) matchesById.set(String(match.match_id), match);
  });

  const fixtures = [...matchesById.values()].map(normalizeFixture).filter(Boolean);
  const isLive = fixtures.some((fixture) => fixture.status === "LIVE");
  const nowMs = Date.now();
  const isNearKickoff = fixtures.some((fixture) => {
    if (fixture.status !== "NS") return false;
    const kickoff = new Date(fixture.kickoffAt || 0).getTime();
    return Number.isFinite(kickoff) && nowMs >= kickoff - 10 * 60_000 && nowMs <= kickoff + 180 * 60_000;
  });
  const pollIntervalSeconds = isLive || isNearKickoff
    ? RESPONSE_TTL_SECONDS
    : BACKGROUND_TTL_SECONDS;
  const now = new Date(nowMs).toISOString();

  return {
    configured: true,
    provider: PROVIDER,
    mode: isLive ? "live-polling" : "waiting",
    updatedAt: now,
    scheduleUpdatedAt: now,
    nextPollAt: new Date(nowMs + pollIntervalSeconds * 1000).toISOString(),
    pollIntervalSeconds,
    currentWeek,
    error: null,
    fixtures
  };
}

async function getLivePayload() {
  if (cachedPayload && Date.now() < cacheExpiresAt) return cachedPayload;

  if (!inFlightRequest) {
    inFlightRequest = loadLivePayload()
      .then((payload) => {
        cachedPayload = payload;
        cachedAt = Date.now();
        cacheExpiresAt = cachedAt + payload.pollIntervalSeconds * 1000;
        return payload;
      })
      .finally(() => {
        inFlightRequest = null;
      });
  }

  try {
    return await inFlightRequest;
  } catch {
    const cacheAge = Date.now() - cachedAt;
    if (cachedPayload && cacheAge <= STALE_TTL_SECONDS * 1000) {
      return {
        ...cachedPayload,
        mode: "stale",
        nextPollAt: new Date(Date.now() + RESPONSE_TTL_SECONDS * 1000).toISOString(),
        pollIntervalSeconds: RESPONSE_TTL_SECONDS,
        error: "official-source-temporarily-unavailable"
      };
    }

    if (cachedPayload) {
      return {
        ...cachedPayload,
        mode: "degraded",
        nextPollAt: new Date(Date.now() + RESPONSE_TTL_SECONDS * 1000).toISOString(),
        pollIntervalSeconds: RESPONSE_TTL_SECONDS,
        error: "official-source-temporarily-unavailable",
        fixtures: cachedPayload.fixtures.map((fixture) => fixture.status === "LIVE"
          ? { ...fixture, status: "SUSP" }
          : fixture)
      };
    }

    return {
      configured: true,
      provider: PROVIDER,
      mode: "degraded",
      updatedAt: null,
      scheduleUpdatedAt: null,
      nextPollAt: new Date(Date.now() + RESPONSE_TTL_SECONDS * 1000).toISOString(),
      pollIntervalSeconds: RESPONSE_TTL_SECONDS,
      currentWeek: null,
      error: "official-source-temporarily-unavailable",
      fixtures: []
    };
  }
}

export default async function handler(_request, response) {
  const payload = await getLivePayload();
  const responseTtl = Number(payload.pollIntervalSeconds) || RESPONSE_TTL_SECONDS;
  response.setHeader(
    "Cache-Control",
    `public, max-age=${Math.min(30, responseTtl)}, s-maxage=${responseTtl}, stale-while-revalidate=${STALE_TTL_SECONDS}`
  );
  response.status(200).json(payload);
}
