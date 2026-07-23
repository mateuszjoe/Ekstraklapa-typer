import { teams } from "../data.js";

export const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";
export const API_FOOTBALL_LEAGUE_ID = 106;
export const API_FOOTBALL_SEASON = 2026;
export const API_FOOTBALL_RATING_SOURCE = "api-football";
export const MAX_RECENT_PLAYER_RATINGS = 5;

const REQUEST_TIMEOUT_MS = 8_000;
const API_FOOTBALL_MEDIA_HOST = "media.api-sports.io";

const EXTRA_TEAM_ALIASES = Object.freeze({
  cracovia: ["Cracovia Krakow", "MKS Cracovia"],
  "gks-katowice": ["GKS Katowice"],
  "gornik-zabrze": ["Gornik Zabrze"],
  jagiellonia: ["Jagiellonia Bialystok"],
  korona: ["Korona Kielce"],
  lech: ["Lech Poznan"],
  legia: ["Legia Warszawa"],
  motor: ["Motor Lublin"],
  piast: ["Piast Gliwice"],
  pogon: ["Pogon Szczecin"],
  radomiak: ["Radomiak Radom"],
  rakow: ["Rakow Czestochowa"],
  slask: ["Slask Wroclaw"],
  widzew: ["Widzew Lodz"],
  wieczysta: ["Wieczysta Krakow"],
  "wisla-krakow": ["Wisla Krakow"],
  "wisla-plock": ["Wisla Plock"],
  zaglebie: ["Zaglebie Lubin", "KGHM Zaglebie Lubin"]
});

export class ApiFootballError extends Error {
  constructor(code, { retryable = true, status = 0 } = {}) {
    super(`API-Football request failed (${code})`);
    this.name = "ApiFootballError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export function normalizedRatingPlayerKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[łŁ]/g, (character) => character === "Ł" ? "L" : "l")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function normalizedRatingPlayerFallbackKey(value) {
  const parts = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (parts.length < 2) return "";
  return normalizedRatingPlayerKey(`${parts[0].slice(0, 1)} ${parts.at(-1)}`);
}

const localTeamByAlias = new Map();
for (const team of teams) {
  for (const alias of [team.id, team.name, ...(EXTRA_TEAM_ALIASES[team.id] || [])]) {
    const key = normalizedRatingPlayerKey(alias);
    if (key) localTeamByAlias.set(key, team.id);
  }
}

function localTeamIdForApiName(value) {
  return localTeamByAlias.get(normalizedRatingPlayerKey(value)) || "";
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function finiteRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10
    ? Math.round(parsed * 100) / 100
    : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function compactText(value, limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.slice(0, limit);
}

function normalizedPlayerPhoto(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname !== API_FOOTBALL_MEDIA_HOST) return "";
    if (!url.pathname.startsWith("/football/players/")) return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function hasProviderErrors(payload) {
  if (Array.isArray(payload?.errors)) return payload.errors.length > 0;
  return Boolean(payload?.errors
    && typeof payload.errors === "object"
    && Object.keys(payload.errors).length);
}

export function apiFootballConfigured(value) {
  return typeof value === "string" && value.trim().length >= 16;
}

export async function apiFootballGet(
  pathname,
  parameters,
  {
    apiKey,
    fetchImpl = fetch
  } = {}
) {
  if (!apiFootballConfigured(apiKey)) {
    throw new ApiFootballError("not-configured", { retryable: false });
  }
  const path = String(pathname || "");
  if (!/^\/[a-z/]+$/i.test(path)) {
    throw new ApiFootballError("invalid-path", { retryable: false });
  }
  const url = new URL(path, API_FOOTBALL_BASE_URL);
  for (const [key, value] of Object.entries(parameters || {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-apisports-key": apiKey.trim()
      },
      signal: controller.signal
    });
  } catch (error) {
    const code = error?.name === "AbortError" ? "timeout" : "network";
    throw new ApiFootballError(code);
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    const code = status === 401 || status === 403
      ? "unauthorized"
      : status === 429
        ? "rate-limited"
        : `http-${status || "error"}`;
    throw new ApiFootballError(code, {
      // A corrected/rotated Worker secret should allow an automatic retry.
      retryable: true,
      status
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiFootballError("invalid-json");
  }
  if (!payload || typeof payload !== "object" || hasProviderErrors(payload)) {
    throw new ApiFootballError("provider-rejected");
  }
  if (!Array.isArray(payload.response)) {
    throw new ApiFootballError("invalid-payload");
  }
  return payload;
}

function warsawDate(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) {
    throw new ApiFootballError("invalid-kickoff", { retryable: false });
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function normalizedApiFixture(row) {
  const apiFixtureId = positiveInteger(row?.fixture?.id);
  const homeApiTeamId = positiveInteger(row?.teams?.home?.id);
  const awayApiTeamId = positiveInteger(row?.teams?.away?.id);
  const home = localTeamIdForApiName(row?.teams?.home?.name);
  const away = localTeamIdForApiName(row?.teams?.away?.name);
  if (!apiFixtureId || !homeApiTeamId || !awayApiTeamId || !home || !away) return null;
  return {
    apiFixtureId,
    homeApiTeamId,
    awayApiTeamId,
    home,
    away,
    kickoffAt: row?.fixture?.date || null
  };
}

export function resolveApiFootballFixture(payload, fixture) {
  const expectedHome = String(fixture?.home || "");
  const expectedAway = String(fixture?.away || "");
  if (!expectedHome || !expectedAway) return null;
  const expectedKickoff = new Date(fixture?.kickoffAt || 0).getTime();
  const candidates = (payload?.response || [])
    .filter((row) => {
      const leagueId = positiveInteger(row?.league?.id);
      const season = Number(row?.league?.season);
      return (!leagueId || leagueId === API_FOOTBALL_LEAGUE_ID)
        && (!Number.isInteger(season) || season === API_FOOTBALL_SEASON);
    })
    .map(normalizedApiFixture)
    .filter((row) => row && row.home === expectedHome && row.away === expectedAway)
    .sort((left, right) => {
      const leftKickoff = new Date(left.kickoffAt || 0).getTime();
      const rightKickoff = new Date(right.kickoffAt || 0).getTime();
      const leftDistance = Number.isFinite(expectedKickoff) && Number.isFinite(leftKickoff)
        ? Math.abs(leftKickoff - expectedKickoff)
        : Number.MAX_SAFE_INTEGER;
      const rightDistance = Number.isFinite(expectedKickoff) && Number.isFinite(rightKickoff)
        ? Math.abs(rightKickoff - expectedKickoff)
        : Number.MAX_SAFE_INTEGER;
      return leftDistance - rightDistance || left.apiFixtureId - right.apiFixtureId;
    });
  return candidates[0] || null;
}

export async function discoverApiFootballFixture(
  fixture,
  {
    apiKey,
    fetchImpl = fetch
  } = {}
) {
  const payload = await apiFootballGet("/fixtures", {
    league: API_FOOTBALL_LEAGUE_ID,
    season: API_FOOTBALL_SEASON,
    date: warsawDate(fixture?.kickoffAt),
    timezone: "Europe/Warsaw"
  }, { apiKey, fetchImpl });
  const resolved = resolveApiFootballFixture(payload, fixture);
  if (!resolved) throw new ApiFootballError("fixture-not-found");
  return resolved;
}

export function normalizeApiFootballPlayerRatings(payload, fixture) {
  const apiFixtureId = positiveInteger(fixture?.apiFixtureId);
  const homeApiTeamId = positiveInteger(fixture?.homeApiTeamId);
  const awayApiTeamId = positiveInteger(fixture?.awayApiTeamId);
  if (!apiFixtureId || !homeApiTeamId || !awayApiTeamId || !fixture?.home || !fixture?.away) {
    throw new ApiFootballError("invalid-fixture-map", { retryable: false });
  }
  const teamByProviderId = new Map([
    [homeApiTeamId, String(fixture.home)],
    [awayApiTeamId, String(fixture.away)]
  ]);
  const ratings = new Map();
  for (const teamRow of payload?.response || []) {
    const providerTeamId = positiveInteger(teamRow?.team?.id);
    const teamId = teamByProviderId.get(providerTeamId)
      || localTeamIdForApiName(teamRow?.team?.name);
    if (!teamId || ![fixture.home, fixture.away].includes(teamId)) continue;
    for (const row of Array.isArray(teamRow?.players) ? teamRow.players : []) {
      const apiPlayerId = positiveInteger(row?.player?.id);
      const firstName = compactText(row?.player?.firstname, 60);
      const lastName = compactText(row?.player?.lastname, 80);
      const fullName = compactText(`${firstName} ${lastName}`);
      const playerName = fullName || compactText(row?.player?.name);
      const playerKey = normalizedRatingPlayerKey(playerName);
      const fallbackKey = normalizedRatingPlayerFallbackKey(playerName)
        || normalizedRatingPlayerKey(row?.player?.name);
      if (!apiPlayerId || !playerName || !playerKey) continue;
      const statistics = Array.isArray(row?.statistics) ? row.statistics : [];
      const ratedStatistic = statistics.find((statistic) => finiteRating(statistic?.games?.rating) !== null);
      const rating = finiteRating(ratedStatistic?.games?.rating);
      if (rating === null) continue;
      ratings.set(`${teamId}:${apiPlayerId}`, {
        apiFixtureId,
        apiPlayerId,
        teamId,
        playerKey,
        fallbackKey,
        playerName,
        photoUrl: normalizedPlayerPhoto(row?.player?.photo),
        rating,
        minutes: nonNegativeInteger(ratedStatistic?.games?.minutes),
        position: compactText(ratedStatistic?.games?.position, 24)
      });
    }
  }
  return [...ratings.values()];
}

export async function fetchApiFootballFixtureRatings(
  fixture,
  {
    apiKey,
    fetchImpl = fetch
  } = {}
) {
  const payload = await apiFootballGet("/fixtures/players", {
    fixture: positiveInteger(fixture?.apiFixtureId)
  }, { apiKey, fetchImpl });
  const ratings = normalizeApiFootballPlayerRatings(payload, fixture);
  const ratedTeams = new Set(ratings.map((row) => row.teamId));
  if (!ratings.length
    || !ratedTeams.has(String(fixture?.home || ""))
    || !ratedTeams.has(String(fixture?.away || ""))) {
    throw new ApiFootballError("ratings-not-ready");
  }
  return ratings;
}
