import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const API_FOOTBALL_RATING_SOURCE = "api-football";
export const MAX_RECENT_PLAYER_RATINGS = 5;

const FINISHED_FIXTURE_STATUSES = new Set(["FT", "AET", "PEN"]);
const DEFAULT_FIXTURE_LIST_TTL_MS = 6 * 60 * 60_000;
const INCOMPLETE_FIXTURE_RATINGS_TTL_MS = 2 * 60 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_DAILY_REQUEST_LIMIT = 60;
const DEFAULT_MAX_TEAM_FIXTURES = 24;
const CACHE_VERSION = 1;

function normalizedText(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("pl-PL")
    .replace(/[łŁ]/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactText(value) {
  return normalizedText(value).replace(/\s+/g, "");
}

function finiteRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating : null;
}

function candidateNameKeys(person) {
  const name = compactText(person?.name);
  const firstName = compactText(person?.firstName || person?.firstname);
  const lastName = compactText(person?.lastName || person?.lastname);
  return new Set([
    name,
    firstName && lastName ? `${firstName}${lastName}` : "",
    firstName && lastName ? `${lastName}${firstName}` : ""
  ].filter(Boolean));
}

function personNameParts(person) {
  const tokens = normalizedText(person?.name).split(/\s+/).filter(Boolean);
  const firstName = compactText(person?.firstName || person?.firstname) || tokens[0] || "";
  const lastName = compactText(person?.lastName || person?.lastname) || tokens.at(-1) || "";
  return { firstInitial: firstName[0] || "", lastName };
}

function sameTeamName(providerName, localName) {
  const provider = compactText(providerName);
  const local = compactText(localName);
  return Boolean(provider && local && (
    provider === local
    || provider.includes(local)
    || local.includes(provider)
  ));
}

function normalizedFixture(row) {
  const id = String(row?.fixture?.id || "").trim();
  const status = String(row?.fixture?.status?.short || "").trim().toUpperCase();
  const date = String(row?.fixture?.date || "").trim();
  const timestamp = Number(row?.fixture?.timestamp) * 1000 || new Date(date || 0).getTime();
  const homeName = String(row?.teams?.home?.name || "").trim();
  const awayName = String(row?.teams?.away?.name || "").trim();
  if (!id || !homeName || !awayName || !Number.isFinite(timestamp)) return null;
  return {
    id,
    status,
    date,
    timestamp,
    home: {
      id: String(row?.teams?.home?.id || "").trim(),
      name: homeName
    },
    away: {
      id: String(row?.teams?.away?.id || "").trim(),
      name: awayName
    }
  };
}

function normalizedFixturePlayer(row) {
  const player = row?.player || {};
  const statistics = Array.isArray(row?.statistics) ? row.statistics : [];
  const ratings = statistics
    .map((entry) => finiteRating(entry?.games?.rating))
    .filter((rating) => rating !== null);
  const rating = ratings.length
    ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length
    : null;
  if (rating === null) return null;
  const name = String(player?.name || "").trim();
  if (!name) return null;
  return {
    providerPlayerId: String(player?.id || "").trim(),
    name,
    firstName: String(player?.firstname || "").trim(),
    lastName: String(player?.lastname || "").trim(),
    rating
  };
}

function normalizedFixtureTeamRatings(responseRows) {
  return (Array.isArray(responseRows) ? responseRows : [])
    .map((row) => ({
      providerTeamId: String(row?.team?.id || "").trim(),
      teamName: String(row?.team?.name || "").trim(),
      players: (Array.isArray(row?.players) ? row.players : [])
        .map(normalizedFixturePlayer)
        .filter(Boolean)
    }))
    .filter((team) => team.teamName);
}

function playersForTeam(entry, localTeamName) {
  if (Array.isArray(entry?.teams)) {
    return entry.teams.find((team) => sameTeamName(team?.teamName, localTeamName))?.players || [];
  }
  // Compatibility with the first local cache format used during development.
  return sameTeamName(entry?.teamName, localTeamName) && Array.isArray(entry?.players)
    ? entry.players
    : [];
}

function matchProviderPlayer(squadPlayer, providerPlayers) {
  const squadKeys = candidateNameKeys(squadPlayer);
  const exact = providerPlayers.filter((providerPlayer) => {
    const providerKeys = candidateNameKeys(providerPlayer);
    return [...squadKeys].some((key) => providerKeys.has(key));
  });
  if (exact.length === 1) return exact[0];

  const squadParts = personNameParts(squadPlayer);
  if (!squadParts.lastName) return null;
  const conservative = providerPlayers.filter((providerPlayer) => {
    const providerParts = personNameParts(providerPlayer);
    return providerParts.lastName === squadParts.lastName
      && (!squadParts.firstInitial
        || !providerParts.firstInitial
        || providerParts.firstInitial === squadParts.firstInitial);
  });
  return conservative.length === 1 ? conservative[0] : null;
}

function emptyPlayerRating() {
  return { average: null, appearances: 0 };
}

function roundedDataAverage(values) {
  if (!values.length) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.round(average * 1000) / 1000;
}

function cacheShape(raw) {
  return {
    version: CACHE_VERSION,
    leagueFixtures: {
      fetchedAt: Number(raw?.leagueFixtures?.fetchedAt) || 0,
      items: Array.isArray(raw?.leagueFixtures?.items) ? raw.leagueFixtures.items : []
    },
    fixtureRatings: raw?.fixtureRatings && typeof raw.fixtureRatings === "object"
      ? raw.fixtureRatings
      : {},
    requestBudget: {
      date: String(raw?.requestBudget?.date || ""),
      count: Math.max(0, Number(raw?.requestBudget?.count) || 0)
    }
  };
}

export function createLocalPlayerRatingsProvider({
  apiKey = "",
  apiBaseUrl = "https://v3.football.api-sports.io",
  leagueId = 106,
  season = 2026,
  cacheFile,
  fetchImpl = fetch,
  fixtureListTtlMs = DEFAULT_FIXTURE_LIST_TTL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  dailyRequestLimit = DEFAULT_DAILY_REQUEST_LIMIT,
  maxTeamFixtures = DEFAULT_MAX_TEAM_FIXTURES,
  logger = console
} = {}) {
  const normalizedApiKey = String(apiKey || "").trim();
  const configured = Boolean(normalizedApiKey);
  const safeFixtureListTtlMs = Number.isFinite(Number(fixtureListTtlMs))
    ? Math.max(60_000, Number(fixtureListTtlMs))
    : DEFAULT_FIXTURE_LIST_TTL_MS;
  const safeRequestTimeoutMs = Number.isFinite(Number(requestTimeoutMs))
    ? Math.max(1_000, Number(requestTimeoutMs))
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const safeDailyRequestLimit = Number.isInteger(Number(dailyRequestLimit))
    ? Math.max(1, Number(dailyRequestLimit))
    : DEFAULT_DAILY_REQUEST_LIMIT;
  const safeMaxTeamFixtures = Number.isInteger(Number(maxTeamFixtures))
    ? Math.max(MAX_RECENT_PLAYER_RATINGS, Number(maxTeamFixtures))
    : DEFAULT_MAX_TEAM_FIXTURES;
  let cache = cacheShape();
  let cacheLoaded = false;
  let persistTail = Promise.resolve();
  const fixtureRequestsInFlight = new Map();

  async function ensureCache() {
    if (cacheLoaded) return cache;
    cacheLoaded = true;
    if (!cacheFile) return cache;
    try {
      cache = cacheShape(JSON.parse(await readFile(cacheFile, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger.warn?.("API-Football local cache could not be read:", error?.message || error);
      }
    }
    return cache;
  }

  function persistCache() {
    if (!cacheFile) return Promise.resolve();
    const serialized = JSON.stringify(cache, null, 2);
    persistTail = persistTail
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(cacheFile), { recursive: true });
        const temporary = `${cacheFile}.tmp`;
        await writeFile(temporary, serialized, "utf8");
        await rename(temporary, cacheFile);
      });
    return persistTail;
  }

  async function consumeLocalBudget() {
    await ensureCache();
    const today = new Date().toISOString().slice(0, 10);
    if (cache.requestBudget.date !== today) {
      cache.requestBudget = { date: today, count: 0 };
    }
    if (cache.requestBudget.count >= safeDailyRequestLimit) {
      const error = new Error("API-Football local daily safety limit reached");
      error.code = "api-football-local-limit";
      throw error;
    }
    cache.requestBudget.count += 1;
    await persistCache();
  }

  async function apiFootballFetch(path, searchParams = {}) {
    if (!configured) throw new Error("API-Football is not configured");
    await consumeLocalBudget();
    const url = new URL(path, `${String(apiBaseUrl).replace(/\/+$/, "")}/`);
    Object.entries(searchParams).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), safeRequestTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          "x-apisports-key": normalizedApiKey
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`API-Football HTTP ${response.status}`);
      const payload = await response.json();
      const providerErrors = payload?.errors;
      if ((Array.isArray(providerErrors) && providerErrors.length)
        || (providerErrors && typeof providerErrors === "object" && Object.keys(providerErrors).length)) {
        throw new Error("API-Football rejected the request");
      }
      if (!Array.isArray(payload?.response)) throw new Error("API-Football returned an invalid response");
      return payload.response;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("API-Football request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function leagueFixtures() {
    await ensureCache();
    const cached = cache.leagueFixtures;
    if (cached.items.length && Date.now() - cached.fetchedAt < safeFixtureListTtlMs) {
      return cached.items;
    }
    try {
      const rows = await apiFootballFetch("fixtures", { league: leagueId, season });
      const items = rows.map(normalizedFixture).filter(Boolean);
      if (!items.length) throw new Error("API-Football returned no league fixtures");
      cache.leagueFixtures = { fetchedAt: Date.now(), items };
      await persistCache();
      return items;
    } catch (error) {
      if (cached.items.length) {
        logger.warn?.("API-Football fixture refresh failed; using local cache:", error?.message || error);
        return cached.items;
      }
      throw error;
    }
  }

  async function fixtureRatings(fixture) {
    await ensureCache();
    const cacheKey = String(fixture.id);
    const cached = cache.fixtureRatings[cacheKey];
    const complete = Array.isArray(cached?.teams)
      && cached.teams.length >= 2
      && cached.teams.every((team) => Array.isArray(team?.players) && team.players.length > 0);
    const recentlyFetched = Number.isFinite(Number(cached?.fetchedAt))
      && Date.now() - Number(cached.fetchedAt) < INCOMPLETE_FIXTURE_RATINGS_TTL_MS;
    if (cached && (complete || recentlyFetched)) return cached;
    if (!fixtureRequestsInFlight.has(cacheKey)) {
      const request = apiFootballFetch("fixtures/players", { fixture: fixture.id })
        .then(async (rows) => {
          const entry = {
            fetchedAt: Date.now(),
            teams: normalizedFixtureTeamRatings(rows)
          };
          cache.fixtureRatings[cacheKey] = entry;
          await persistCache();
          return entry;
        })
        .finally(() => fixtureRequestsInFlight.delete(cacheKey));
      fixtureRequestsInFlight.set(cacheKey, request);
    }
    return fixtureRequestsInFlight.get(cacheKey);
  }

  async function recentRatingsForSquad(squad, localTeamName) {
    const fixtures = (await leagueFixtures())
      .filter((fixture) => FINISHED_FIXTURE_STATUSES.has(fixture.status))
      .filter((fixture) => (
        sameTeamName(fixture.home?.name, localTeamName)
        || sameTeamName(fixture.away?.name, localTeamName)
      ))
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, safeMaxTeamFixtures);

    const fixtureEntries = [];
    for (let index = 0; index < fixtures.length; index += 4) {
      const batch = await Promise.allSettled(
        fixtures.slice(index, index + 4).map((fixture) => fixtureRatings(fixture))
      );
      batch.forEach((result) => {
        if (result.status === "fulfilled") fixtureEntries.push(result.value);
        else logger.warn?.("API-Football fixture ratings are unavailable:", result.reason?.message || result.reason);
      });
    }

    const ratingsByPlayerId = new Map();
    const players = Array.isArray(squad?.players) ? squad.players : [];
    for (const player of players) {
      const values = [];
      for (const entry of fixtureEntries) {
        if (values.length >= MAX_RECENT_PLAYER_RATINGS) break;
        const providerPlayer = matchProviderPlayer(player, playersForTeam(entry, localTeamName));
        if (providerPlayer) values.push(providerPlayer.rating);
      }
      ratingsByPlayerId.set(String(player.id), {
        average: roundedDataAverage(values),
        appearances: values.length
      });
    }
    return ratingsByPlayerId;
  }

  function withRatings(squad, ratingsByPlayerId = new Map()) {
    const enrichPlayer = (player) => ({
      ...player,
      rating: ratingsByPlayerId.get(String(player?.id)) || emptyPlayerRating()
    });
    return {
      ...squad,
      ratingSource: API_FOOTBALL_RATING_SOURCE,
      ratingsConfigured: configured,
      players: (Array.isArray(squad?.players) ? squad.players : []).map(enrichPlayer),
      groups: (Array.isArray(squad?.groups) ? squad.groups : []).map((group) => ({
        ...group,
        players: (Array.isArray(group?.players) ? group.players : []).map(enrichPlayer)
      }))
    };
  }

  async function enrichTeamSquad(squad, localTeamName) {
    if (!configured) return withRatings(squad);
    try {
      const ratings = await recentRatingsForSquad(squad, localTeamName);
      return withRatings(squad, ratings);
    } catch (error) {
      logger.warn?.("API-Football player ratings are unavailable:", error?.message || error);
      return withRatings(squad);
    }
  }

  return {
    configured,
    enrichTeamSquad
  };
}
