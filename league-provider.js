import { matches as localMatches, teams as localTeams } from "./data.js";

export const OFFICIAL_LEAGUE_API_BASE = "https://api.centrum-meczowe.ekstraklasa.org";
export const OFFICIAL_LEAGUE_SOURCE = "ekstraklasa-match-center";
export const LEAGUE_CACHE_TTL_MS = 5 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 12_000;
const LINEUP_CACHE_TTL_MS = 45_000;
const EXPECTED_MATCH_COUNT = 306;
const EXPECTED_TEAM_COUNT = 18;
const EXPECTED_MATCHDAY_COUNT = 34;
const EXPECTED_MATCHES_PER_MATCHDAY = EXPECTED_TEAM_COUNT / 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STATUS_MAP = Object.freeze({
  fixture: "NS",
  playing: "LIVE",
  played: "FT",
  awarded: "AWD",
  postponed: "PST",
  suspended: "SUSP",
  cancelled: "CANC"
});

const NO_SCORE_STATUSES = new Set(["NS", "PST", "SUSP", "CANC"]);
const FINAL_STATUSES = new Set(["FT", "AWD"]);

function comparable(value) {
  return String(value || "")
    .replace(/[łŁ]/g, (character) => character === "Ł" ? "L" : "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

const localTeamById = new Map(localTeams.map((team) => [team.id, team]));
const localTeamByCode = new Map(localTeams.map((team) => [comparable(team.short), team]));
const localTeamByName = new Map(localTeams.flatMap((team) => [
  [comparable(team.name), team],
  [comparable(team.id), team]
]));

const TEAM_CODE_ALIASES = new Map([
  ["gor", "gornik-zabrze"],
  ["gornik", "gornik-zabrze"],
  ["sla", "slask"],
  ["slask", "slask"],
  ["wpl", "wisla-plock"],
  ["wislaplock", "wisla-plock"]
]);

const localMatchByTeamsAndWeek = new Map(localMatches.map((match) => [
  `${match.matchday}:${match.home}:${match.away}`,
  match
]));

let cachedLeaguePayload = null;
let cachedLeagueUntil = 0;
let leagueRequestInFlight = null;
const cachedLineups = new Map();

export function isOfficialMatchId(value) {
  return UUID_PATTERN.test(String(value || "").trim());
}

export function resolveLocalTeamId(value = {}) {
  const input = typeof value === "object" && value !== null ? value : { name: value };
  const code = comparable(input.team_code || input.code || input.short || "");
  const byCode = localTeamByCode.get(code);
  if (byCode) return byCode.id;
  const aliased = TEAM_CODE_ALIASES.get(code);
  if (aliased) return aliased;

  const candidates = [
    input.team_name,
    input.name,
    input.team_short_name,
    input.shortName,
    input.team_official_name,
    input.officialName
  ].map(comparable).filter(Boolean);
  for (const candidate of candidates) {
    const direct = localTeamByName.get(candidate);
    if (direct) return direct.id;
    for (const team of localTeams) {
      const teamName = comparable(team.name);
      const teamId = comparable(team.id);
      if (candidate === teamName || candidate === teamId || candidate.includes(teamName) || teamName.includes(candidate)) {
        return team.id;
      }
    }
  }
  return null;
}

function normalizedStatus(item) {
  if (item?.postponed === true && String(item?.status || "").toLowerCase() === "fixture") return "PST";
  return STATUS_MAP[String(item?.status || "").toLowerCase()] || String(item?.status || "NS").toUpperCase();
}

function normalizedVenue(venue) {
  if (!venue || typeof venue !== "object") return null;
  return {
    id: venue.id ? String(venue.id) : null,
    name: venue.name ? String(venue.name) : "",
    city: venue.city ? String(venue.city) : "",
    capacity: integerOrNull(venue.capacity)
  };
}

export function normalizeOfficialLeagueMatch(item) {
  if (!item || !isOfficialMatchId(item.match_id)) return null;
  const home = resolveLocalTeamId({
    team_code: item.home_team_code,
    team_name: item.home_team_name,
    team_short_name: item.home_team_short_name,
    team_official_name: item.home_team_official_name
  });
  const away = resolveLocalTeamId({
    team_code: item.away_team_code,
    team_name: item.away_team_name,
    team_short_name: item.away_team_short_name,
    team_official_name: item.away_team_official_name
  });
  const matchday = integerOrNull(item.postponed_week) || integerOrNull(item.week);
  if (!home || !away || home === away || !matchday || matchday < 1 || matchday > EXPECTED_MATCHDAY_COUNT) return null;

  const localMatch = localMatchByTeamsAndWeek.get(`${matchday}:${home}:${away}`) || null;
  const providerId = String(item.match_id);
  const status = normalizedStatus(item);
  const kickoffAt = item.postponed_datetime || item.match_datetime || null;
  const hasScore = !NO_SCORE_STATUSES.has(status);
  return {
    id: localMatch?.id || `official-${providerId}`,
    providerId,
    localMatchId: localMatch?.id || null,
    matchday,
    kickoffAt,
    status,
    home,
    away,
    homeScore: hasScore ? integerOrNull(item.home_score) : null,
    awayScore: hasScore ? integerOrNull(item.away_score) : null,
    venue: normalizedVenue(item.venue)
  };
}

function validateSeasonFixtures(matches) {
  const providerIds = new Set();
  const logicalMatches = new Set();
  const leagueTeams = new Set();
  const matchdays = new Map();
  const unorderedPairings = new Map();

  for (const match of matches) {
    if (providerIds.has(match.providerId)) {
      throw new Error(`Official league API duplicated provider match ${match.providerId}`);
    }
    providerIds.add(match.providerId);

    const logicalKey = `${match.matchday}:${match.home}:${match.away}`;
    if (logicalMatches.has(logicalKey)) {
      throw new Error(`Official league API duplicated logical match ${logicalKey}`);
    }
    logicalMatches.add(logicalKey);
    leagueTeams.add(match.home);
    leagueTeams.add(match.away);

    const matchdayTeams = matchdays.get(match.matchday) || [];
    matchdayTeams.push(match.home, match.away);
    matchdays.set(match.matchday, matchdayTeams);

    const pairingKey = [match.home, match.away].sort().join(":");
    const directions = unorderedPairings.get(pairingKey) || new Set();
    directions.add(`${match.home}:${match.away}`);
    unorderedPairings.set(pairingKey, directions);
  }

  if (providerIds.size !== EXPECTED_MATCH_COUNT || logicalMatches.size !== EXPECTED_MATCH_COUNT) {
    throw new Error(`Official league API returned ${logicalMatches.size}/${EXPECTED_MATCH_COUNT} unique logical matches`);
  }
  if (leagueTeams.size !== EXPECTED_TEAM_COUNT
    || localTeams.some((team) => !leagueTeams.has(team.id))) {
    throw new Error(`Official league API returned fixtures for ${leagueTeams.size}/${EXPECTED_TEAM_COUNT} teams`);
  }
  if (matchdays.size !== EXPECTED_MATCHDAY_COUNT) {
    throw new Error(`Official league API returned ${matchdays.size}/${EXPECTED_MATCHDAY_COUNT} matchdays`);
  }
  for (let matchday = 1; matchday <= EXPECTED_MATCHDAY_COUNT; matchday += 1) {
    const teamIds = matchdays.get(matchday) || [];
    if (teamIds.length !== EXPECTED_MATCHES_PER_MATCHDAY * 2
      || new Set(teamIds).size !== EXPECTED_TEAM_COUNT) {
      throw new Error(`Official league API returned an invalid matchday ${matchday}`);
    }
  }

  const expectedPairings = EXPECTED_TEAM_COUNT * (EXPECTED_TEAM_COUNT - 1) / 2;
  if (unorderedPairings.size !== expectedPairings
    || [...unorderedPairings.values()].some((directions) => directions.size !== 2)) {
    throw new Error("Official league API returned an invalid round-robin fixture set");
  }
}

function matchFormForTeam(match, teamId) {
  if (!FINAL_STATUSES.has(match.status)
    || !Number.isInteger(match.homeScore)
    || !Number.isInteger(match.awayScore)) return null;
  if (match.homeScore === match.awayScore) return "D";
  const won = match.home === teamId ? match.homeScore > match.awayScore : match.awayScore > match.homeScore;
  return won ? "W" : "L";
}

function computedForms(matches) {
  const result = new Map(localTeams.map((team) => [team.id, []]));
  [...matches]
    .filter((match) => FINAL_STATUSES.has(match.status))
    .sort((left, right) => new Date(left.kickoffAt || 0).getTime() - new Date(right.kickoffAt || 0).getTime())
    .forEach((match) => {
      for (const teamId of [match.home, match.away]) {
        const form = matchFormForTeam(match, teamId);
        if (form) result.get(teamId)?.push(form);
      }
    });
  return new Map([...result].map(([teamId, form]) => [teamId, form.slice(-5)]));
}

function normalizeOfficialStanding(row, forms) {
  const teamId = resolveLocalTeamId(row);
  if (!teamId || !row?.team_id) return null;
  return {
    teamId,
    providerTeamId: String(row.team_id),
    rank: integerOrNull(row.rank),
    points: integerOrNull(row.points) ?? 0,
    played: integerOrNull(row.matches_played) ?? 0,
    wins: integerOrNull(row.matches_won) ?? 0,
    draws: integerOrNull(row.matches_drawn) ?? 0,
    losses: integerOrNull(row.matches_lost) ?? 0,
    goalsFor: integerOrNull(row.goals_for) ?? 0,
    goalsAgainst: integerOrNull(row.goals_against) ?? 0,
    goalDifference: integerOrNull(row.goals_difference) ?? 0,
    form: forms.get(teamId) || []
  };
}

export function normalizeOfficialLeaguePayload({ seasonPayload, matchesPayload, standingsPayload }, updatedAt = new Date().toISOString()) {
  const seasonData = seasonPayload?.data;
  const currentWeek = integerOrNull(seasonPayload?.meta?.current_week_number);
  if (!isOfficialMatchId(seasonData?.season_id)
    || !seasonData?.name
    || !currentWeek
    || currentWeek < 1
    || currentWeek > EXPECTED_MATCHDAY_COUNT) {
    throw new Error("Official league API returned an invalid current season");
  }
  if (!Array.isArray(matchesPayload?.data) || !Array.isArray(standingsPayload?.data)) {
    throw new Error("Official league API returned an invalid league payload");
  }

  const matches = matchesPayload.data.map(normalizeOfficialLeagueMatch).filter(Boolean);
  if (matchesPayload.data.length !== EXPECTED_MATCH_COUNT || matches.length !== EXPECTED_MATCH_COUNT) {
    throw new Error(`Official league API returned ${matches.length}/${EXPECTED_MATCH_COUNT} valid matches`);
  }
  validateSeasonFixtures(matches);
  const normalizedMatches = [...matches].sort((left, right) => (
    left.matchday - right.matchday
    || new Date(left.kickoffAt || 0).getTime() - new Date(right.kickoffAt || 0).getTime()
    || left.providerId.localeCompare(right.providerId)
  ));
  const forms = computedForms(normalizedMatches);
  const standings = standingsPayload.data
    .map((row) => normalizeOfficialStanding(row, forms))
    .filter(Boolean)
    .sort((left, right) => (left.rank ?? 999) - (right.rank ?? 999));
  if (standingsPayload.data.length !== EXPECTED_TEAM_COUNT
    || standings.length !== EXPECTED_TEAM_COUNT
    || new Set(standings.map((standing) => standing.teamId)).size !== EXPECTED_TEAM_COUNT
    || localTeams.some((team) => !standings.some((standing) => standing.teamId === team.id))
    || new Set(standings.map((standing) => standing.rank)).size !== EXPECTED_TEAM_COUNT
    || standings.some((standing) => (
      !Number.isInteger(standing.rank)
      || standing.rank < 1
      || standing.rank > EXPECTED_TEAM_COUNT
      || standing.played < 0
      || standing.played > EXPECTED_MATCHDAY_COUNT
      || standing.wins + standing.draws + standing.losses !== standing.played
      || standing.goalDifference !== standing.goalsFor - standing.goalsAgainst
    ))) {
    throw new Error(`Official league API returned ${standings.length}/${EXPECTED_TEAM_COUNT} valid standings`);
  }

  return {
    season: {
      id: String(seasonData.season_id),
      name: String(seasonData.name),
      currentWeek
    },
    standings,
    matches: normalizedMatches,
    updatedAt,
    source: OFFICIAL_LEAGUE_SOURCE
  };
}

async function fetchOfficialJson(path, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${OFFICIAL_LEAGUE_API_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Official league API returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function loadOfficialLeaguePayload(fetchImpl) {
  const seasonPayload = await fetchOfficialJson("/v1/seasons/current", fetchImpl);
  const seasonId = seasonPayload?.data?.season_id;
  if (!seasonId) throw new Error("Official league API did not return current season id");
  const encodedSeasonId = encodeURIComponent(seasonId);
  const [matchesPayload, standingsPayload] = await Promise.all([
    fetchOfficialJson(`/v1/matches?season_id=${encodedSeasonId}`, fetchImpl),
    fetchOfficialJson(`/v1/team_season_standings?standing_type=total&season_id=${encodedSeasonId}`, fetchImpl)
  ]);
  return normalizeOfficialLeaguePayload({ seasonPayload, matchesPayload, standingsPayload });
}

export async function getOfficialLeaguePayload({ fetchImpl = fetch, force = false } = {}) {
  const now = Date.now();
  if (!force && cachedLeaguePayload && now < cachedLeagueUntil) return cachedLeaguePayload;
  if (!leagueRequestInFlight) {
    leagueRequestInFlight = loadOfficialLeaguePayload(fetchImpl)
      .then((payload) => {
        cachedLeaguePayload = payload;
        cachedLeagueUntil = Date.now() + LEAGUE_CACHE_TTL_MS;
        return payload;
      })
      .finally(() => {
        leagueRequestInFlight = null;
      });
  }
  try {
    return await leagueRequestInFlight;
  } catch (error) {
    // A short provider outage must not blank the table or break lineup polling.
    // Keep the expired value expired so the next call still attempts a refresh.
    if (cachedLeaguePayload) {
      console.warn("Official league refresh failed; serving the last valid payload", error);
      return cachedLeaguePayload;
    }
    throw error;
  }
}

function normalizedPlayer(player) {
  const formationPlace = integerOrNull(player?.formation_place);
  const fullName = String(player?.known_name || `${player?.first_name || ""} ${player?.last_name || ""}`.trim() || player?.match_name || "").trim();
  if (!player?.person_id || !fullName) return null;
  return {
    id: String(player.person_id),
    name: fullName,
    shirtNumber: integerOrNull(player.shirt_number),
    isCaptain: player.is_captain === true,
    position: player.position ? String(player.position) : "",
    formationPlace
  };
}

function uniquePlayers(players) {
  const unique = new Map();
  for (const player of players) {
    if (player && !unique.has(player.id)) unique.set(player.id, player);
  }
  return [...unique.values()];
}

function normalizeLineupTeam(row) {
  const teamId = resolveLocalTeamId(row);
  const side = String(row?.team_type || "").toLowerCase();
  if (!teamId || !["home", "away"].includes(side)) return null;
  const players = uniquePlayers((row.players || []).map(normalizedPlayer).filter(Boolean));
  const starters = players
    .filter((player) => Number.isInteger(player.formationPlace) && player.formationPlace >= 1 && player.formationPlace <= 11)
    .sort((left, right) => left.formationPlace - right.formationPlace);
  const starterIds = new Set(starters.map((player) => player.id));
  const substitutes = players.filter((player) => !starterIds.has(player.id));
  return {
    teamId,
    side,
    name: String(row.team_name || localTeamById.get(teamId)?.name || teamId),
    formation: row.formation ? String(row.formation) : "",
    starters,
    substitutes
  };
}

export function isPublishedLineup(teams) {
  if (!Array.isArray(teams) || teams.length !== 2) return false;
  if (new Set(teams.map((team) => team.teamId)).size !== 2
    || new Set(teams.map((team) => team.side)).size !== 2
    || !teams.some((team) => team.side === "home")
    || !teams.some((team) => team.side === "away")) return false;
  return teams.every((team) => {
    if (team.starters.length !== 11 || new Set(team.starters.map((player) => player.id)).size !== 11) return false;
    const places = new Set(team.starters.map((player) => player.formationPlace));
    return places.size === 11 && Array.from({ length: 11 }, (_, index) => index + 1).every((place) => places.has(place));
  });
}

export function normalizeOfficialMatchLineup(payload, providerMatchId, fallbackUpdatedAt = new Date().toISOString()) {
  if (!isOfficialMatchId(providerMatchId)) throw new Error("Invalid official match id");
  const rawTeams = Array.isArray(payload?.data) ? payload.data : [];
  const teams = rawTeams.map(normalizeLineupTeam).filter(Boolean).sort((left, right) => left.side === "home" ? -1 : 1);
  const providerUpdatedAt = rawTeams
    .map((team) => new Date(team?.updated_at || 0).getTime())
    .filter(Number.isFinite)
    .reduce((latest, timestamp) => Math.max(latest, timestamp), 0);
  return {
    providerMatchId: String(providerMatchId),
    published: isPublishedLineup(teams),
    updatedAt: providerUpdatedAt > 0 ? new Date(providerUpdatedAt).toISOString() : fallbackUpdatedAt,
    teams
  };
}

export async function getOfficialMatchLineup(providerMatchId, { fetchImpl = fetch, force = false } = {}) {
  const normalizedId = String(providerMatchId || "").trim();
  if (!isOfficialMatchId(normalizedId)) throw new Error("Invalid official match id");
  const cached = cachedLineups.get(normalizedId);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.payload;
  const raw = await fetchOfficialJson(`/v1/match_details/lineups/${encodeURIComponent(normalizedId)}`, fetchImpl);
  const payload = normalizeOfficialMatchLineup(raw, normalizedId);
  cachedLineups.set(normalizedId, { payload, expiresAt: Date.now() + LINEUP_CACHE_TTL_MS });
  return payload;
}
