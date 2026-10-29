import { matches as baseMatches, teams } from "./data.js";
import { correctedKickoffAt } from "./kickoff-corrections.js";
import { fetchOfficialPages } from "./official-api.js";
import { officialKickoff } from "./official-kickoff.js";

const PROVIDER = "ekstraklasa-match-center";
const API_BASE = "https://api.centrum-meczowe.ekstraklasa.org";
const LIVE_TTL_SECONDS = 45;
const BACKGROUND_TTL_SECONDS = 300;
const STALE_TTL_SECONDS = 300;
const MINIMUM_FINAL_MATCH_AGE_MS = 95 * 60 * 1000;

const STATUS_MAP = Object.freeze({
  fixture: "NS",
  playing: "LIVE",
  played: "FT",
  awarded: "AWD",
  postponed: "PST",
  suspended: "SUSP",
  cancelled: "CANC"
});

const normalizeCode = (value) => String(value || "").trim().toLocaleUpperCase("pl-PL");
const teamByCode = new Map(teams.map((team) => [normalizeCode(team.short), team]));
const localMatchByTeamsAndWeek = new Map(
  baseMatches.map((match) => [`${match.matchday}:${match.home}:${match.away}`, match])
);

let cachedPayload = null;
let cacheExpiresAt = 0;
let cachedAt = 0;
let inFlightRequest = null;
let cachedSchedule = null;
let scheduleExpiresAt = 0;
let scheduleRequest = null;

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizedOfficialMatchStatus(item, nowMs = Date.now()) {
  const providerStatus = String(item?.status || "").toLowerCase();
  const mappedStatus = STATUS_MAP[providerStatus] || String(item?.status || "NS").toUpperCase();
  if (mappedStatus !== "FT") return mappedStatus;

  const kickoffMs = new Date(correctedKickoffAt(item?.match_id, item?.postponed_datetime || item?.match_datetime || 0)).getTime();
  const hasScore = numberOrNull(item?.home_score) !== null && numberOrNull(item?.away_score) !== null;
  if (hasScore
    && Number.isFinite(kickoffMs)
    && Number.isFinite(nowMs)
    && nowMs >= kickoffMs
    && nowMs - kickoffMs < MINIMUM_FINAL_MATCH_AGE_MS) {
    return "LIVE";
  }
  return mappedStatus;
}

async function fetchOfficialJson(path, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(`${API_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Official match center returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeOfficialFixture(item) {
  const home = teamByCode.get(normalizeCode(item.home_team_code));
  const away = teamByCode.get(normalizeCode(item.away_team_code));
  const week = Number(item.week);
  if (!home || !away || !Number.isInteger(week)) return null;

  const localMatch = localMatchByTeamsAndWeek.get(`${week}:${home.id}:${away.id}`);
  if (!localMatch) return null;
  const kickoff = officialKickoff(item, localMatch.id);
  const status = normalizedOfficialMatchStatus(item);

  return {
    providerId: String(item.match_id),
    localMatchId: localMatch.id,
    matchday: localMatch.matchday,
    ...kickoff,
    status,
    elapsed: null,
    score: {
      home: status === "NS" ? null : numberOrNull(item.home_score),
      away: status === "NS" ? null : numberOrNull(item.away_score)
    },
    home: { id: home.id, name: home.name, logo: home.crest },
    away: { id: away.id, name: away.name, logo: away.crest },
    source: PROVIDER
  };
}

export async function getOfficialTrustedSchedule({ force = false, fetchImpl = fetch } = {}) {
  if (!force && cachedSchedule && Date.now() < scheduleExpiresAt) return cachedSchedule;
  if (!scheduleRequest) {
    scheduleRequest = loadTrustedSchedule(fetchImpl).then((payload) => {
      cachedSchedule = payload;
      scheduleExpiresAt = Date.now() + BACKGROUND_TTL_SECONDS * 1000;
      return payload;
    }).finally(() => { scheduleRequest = null; });
  }
  return scheduleRequest;
}

async function loadTrustedSchedule(fetchImpl) {
  const season = await fetchOfficialJson("/v1/seasons/current", fetchImpl);
  const seasonId = season?.data?.season_id;
  const currentWeek = Number(season?.meta?.current_week_number);
  if (!seasonId || season?.data?.name !== "2026/2027" || !Number.isInteger(currentWeek) || currentWeek < 1 || currentWeek > 34) {
    throw new Error("Official match center returned an invalid current season");
  }
  const response = await fetchOfficialPages(`/v1/matches?season_id=${encodeURIComponent(seasonId)}`,
    (path) => fetchOfficialJson(path, fetchImpl));
  const fixtures = response.data.map(normalizeOfficialFixture).filter(Boolean);
  if (response.data.length !== 306 || fixtures.length !== baseMatches.length
    || new Set(response.data.map((match) => match.match_id)).size !== 306
    || new Set(fixtures.map((fixture) => fixture.localMatchId)).size !== baseMatches.length
    || response.data.some((match) => match.season_id && match.season_id !== seasonId)) {
    throw new Error("Official match center returned an incomplete or inconsistent season schedule");
  }
  return { seasonId, currentWeek, updatedAt: new Date().toISOString(), fixtures };
}

async function loadLivePayload(fetchImpl) {
  const schedule = await getOfficialTrustedSchedule({ fetchImpl });
  const { seasonId, currentWeek } = schedule;

  const queryPrefix = `/v1/matches?season_id=${encodeURIComponent(seasonId)}`;
  const previousWeekRequest = currentWeek > 1
    ? fetchOfficialJson(`${queryPrefix}&week=${currentWeek - 1}`, fetchImpl)
    : Promise.resolve({ data: [] });
  const [previousWeekResponse, weekResponse, liveResponse] = await Promise.all([
    previousWeekRequest,
    fetchOfficialJson(`${queryPrefix}&week=${currentWeek}`, fetchImpl),
    fetchOfficialJson(`${queryPrefix}&status=playing`, fetchImpl)
  ]);

  const matchesById = new Map(schedule.fixtures.map((fixture) => [fixture.providerId, fixture]));
  [
    ...(previousWeekResponse?.data || []),
    ...(weekResponse?.data || []),
    ...(liveResponse?.data || [])
  ].forEach((match) => {
    const fixture = normalizeOfficialFixture(match);
    if (fixture) matchesById.set(fixture.providerId, fixture);
  });

  const fixtures = [...matchesById.values()];
  const isLive = fixtures.some((fixture) => fixture.status === "LIVE");
  const nowMs = Date.now();
  const isNearKickoff = fixtures.some((fixture) => {
    if (fixture.status !== "NS") return false;
    const kickoff = new Date(fixture.kickoffAt || 0).getTime();
    return Number.isFinite(kickoff) && nowMs >= kickoff - 10 * 60_000 && nowMs <= kickoff + 180 * 60_000;
  });
  const pollIntervalSeconds = isLive || isNearKickoff ? LIVE_TTL_SECONDS : BACKGROUND_TTL_SECONDS;
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

export async function getOfficialLivePayload({ force = false, fetchImpl = fetch } = {}) {
  if (!force && cachedPayload && Date.now() < cacheExpiresAt) return cachedPayload;

  if (force && !inFlightRequest) {
    cacheExpiresAt = 0;
  }

  if (!inFlightRequest) {
    inFlightRequest = loadLivePayload(fetchImpl)
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
  } catch (error) {
    if (cachedPayload && Date.now() - cachedAt <= STALE_TTL_SECONDS * 1000) {
      return {
        ...cachedPayload,
        mode: "stale",
        pollIntervalSeconds: LIVE_TTL_SECONDS,
        error: "official-source-temporarily-unavailable"
      };
    }
    throw error;
  }
}
