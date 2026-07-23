import { matches as localMatches, teams as localTeams } from "./data.js";

export const OFFICIAL_LEAGUE_API_BASE = "https://api.centrum-meczowe.ekstraklasa.org";
export const OFFICIAL_LEAGUE_SOURCE = "ekstraklasa-match-center";
export const LEAGUE_CACHE_TTL_MS = 5 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 12_000;
const OFFICIAL_PAGE_TIMEOUT_MS = 7_000;
const LINEUP_CACHE_TTL_MS = 45_000;
const TEAM_SQUAD_CACHE_TTL_MS = 15 * 60 * 1000;
const OFFICIAL_SITE_BASE = "https://ekstraklasa.org";
const OFFICIAL_MEDIA_HOST = "media.cms.ekstraklasa.org";
const MAX_OFFICIAL_TEAM_PAGE_BYTES = 4 * 1024 * 1024;
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

const OFFICIAL_CLUB_SLUGS = Object.freeze({
  cracovia: "cracovia",
  "gks-katowice": "gks-katowice",
  "gornik-zabrze": "gornik-zabrze",
  jagiellonia: "jagiellonia-bialystok",
  korona: "korona-kielce",
  lech: "lech-poznan",
  legia: "legia-warszawa",
  motor: "motor-lublin",
  piast: "piast-gliwice",
  pogon: "pogon-szczecin",
  radomiak: "radomiak-radom",
  rakow: "rakow-czestochowa",
  slask: "slask-wroclaw",
  widzew: "widzew-lodz",
  wieczysta: "wieczysta-krakow",
  "wisla-krakow": "wisla-krakow",
  "wisla-plock": "wisla-plock",
  zaglebie: "zagebie-lubin"
});

const PLAYER_POSITION_GROUPS = Object.freeze({
  goalkeeper: { id: "goalkeepers", label: "Bramkarze", singular: "Bramkarz", order: 0 },
  defender: { id: "defenders", label: "Obrońcy", singular: "Obrońca", order: 1 },
  midfielder: { id: "midfielders", label: "Pomocnicy", singular: "Pomocnik", order: 2 },
  attacker: { id: "forwards", label: "Napastnicy", singular: "Napastnik", order: 3 },
  forward: { id: "forwards", label: "Napastnicy", singular: "Napastnik", order: 3 }
});

const PLAYER_STAT_ALIASES = Object.freeze({
  appearances: ["appearances", "games_played", "matches_played", "matches"],
  goals: ["goals"],
  assists: ["goal_assists", "goal_assist", "assists"],
  cleanSheets: ["clean_sheets", "clean_sheet"],
  yellowCards: ["yellow_cards", "yellow_card", "yellow_cards_count"],
  redCards: ["total_red_cards", "straight_red_cards", "red_card", "red_cards", "red_cards_count"]
});

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
const cachedTeamSquads = new Map();
const teamSquadRequestsInFlight = new Map();

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

async function fetchOfficialText(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OFFICIAL_PAGE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Official Ekstraklasa site returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers?.get?.("content-length")) || 0;
    if (declaredLength > MAX_OFFICIAL_TEAM_PAGE_BYTES) throw new Error("Official team page is unexpectedly large");
    const text = await response.text();
    if (text.length > MAX_OFFICIAL_TEAM_PAGE_BYTES) throw new Error("Official team page is unexpectedly large");
    return text;
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

function finiteStatNumber(value) {
  if (value && typeof value === "object") {
    for (const key of ["total", "value", "count", "amount"]) {
      const nested = Number(value[key]);
      if (Number.isFinite(nested)) return nested;
    }
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedStatsRecord(value) {
  const record = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const key = String(item?.key || item?.name || item?.stat || "").trim().toLowerCase();
      const number = finiteStatNumber(item?.value ?? item?.total ?? item?.count);
      if (key && number !== null) record[key] = number;
    }
    return record;
  }
  if (value && typeof value === "object") {
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = String(rawKey || "").trim().toLowerCase();
      const number = finiteStatNumber(rawValue);
      if (key && number !== null) record[key] = number;
    }
  }
  return record;
}

function statValue(record, aliases, fallback = 0) {
  for (const alias of aliases) {
    const value = Number(record?.[alias]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function nonNegativeIntegerStat(record, aliases) {
  return Math.max(0, Math.round(statValue(record, aliases, 0)));
}

function normalizedSquadPosition(value) {
  const key = String(value || "").trim().toLowerCase();
  return PLAYER_POSITION_GROUPS[key] ? key === "forward" ? "attacker" : key : "";
}

function normalizedOfficialMediaUrl(value) {
  const raw = String(value || "")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/&amp;/gi, "&")
    .trim();
  if (!raw || raw === "$undefined") return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:"
      || url.hostname !== OFFICIAL_MEDIA_HOST
      || url.username
      || url.password) return "";
    url.searchParams.set("width", "360");
    url.searchParams.set("format", "webp");
    return url.toString();
  } catch {
    return "";
  }
}

export function extractOfficialPlayerPhotos(html) {
  const text = String(html || "");
  const chunks = [];
  const chunkPattern = /<script[^>]*>\s*self\.__next_f\.push\((\[[\s\S]*?\])\)\s*<\/script>/gi;
  for (const match of text.matchAll(chunkPattern)) {
    try {
      const payload = JSON.parse(match[1]);
      if (payload?.[0] === 1 && typeof payload[1] === "string") chunks.push(payload[1]);
    } catch {
      // An unrelated or partial RSC chunk must not invalidate the whole page.
    }
  }
  const rsc = chunks.join("");
  const marker = '"initialPlayerStats":';
  const markerIndex = rsc.indexOf(marker);
  const startIndex = markerIndex >= 0 ? rsc.indexOf("[", markerIndex + marker.length) : -1;
  if (startIndex < 0) return new Map();
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let serialized = "";
  for (let index = startIndex; index < rsc.length; index += 1) {
    const character = rsc[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        serialized = rsc.slice(startIndex, index + 1);
        break;
      }
    }
  }
  if (!serialized) return new Map();
  let players;
  try {
    players = JSON.parse(serialized);
  } catch {
    return new Map();
  }
  const photosBySlug = new Map();
  const playerLinkPattern = /<a\b[^>]*href="\/kluby\/([^/"?#]+)\/zawodnik\/([^/"?#]+)\/"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const linkMatch of text.matchAll(playerLinkPattern)) {
    const slug = String(linkMatch[2] || "").trim();
    if (!slug) continue;
    let visiblePhoto = "";
    const imagePattern = /<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
    for (const imageMatch of linkMatch[3].matchAll(imagePattern)) {
      const tag = imageMatch[0];
      const alt = tag.match(/\balt="([^"]*)"/i)?.[1]?.trim() || "";
      const candidate = normalizedOfficialMediaUrl(imageMatch[1]);
      if (alt && candidate) visiblePhoto = candidate;
    }
    if (visiblePhoto) photosBySlug.set(slug, visiblePhoto);
  }
  const photos = new Map();
  for (const player of Array.isArray(players) ? players : []) {
    const id = String(player?.person_id || "").trim();
    const photoUrl = normalizedOfficialMediaUrl(player?.photo_url)
      || photosBySlug.get(String(player?.slug || "").trim())
      || "";
    if (UUID_PATTERN.test(id) && photoUrl) photos.set(id, photoUrl);
  }
  return photos;
}

function normalizedSquadPlayer(row, photoByPersonId = new Map()) {
  const person = row?.person && typeof row.person === "object" ? row.person : row;
  const id = String(row?.person_id || person?.id || "").trim();
  const position = normalizedSquadPosition(person?.formation || row?.position);
  const firstName = String(person?.first_name || "").trim();
  const lastName = String(person?.last_name || "").trim();
  const name = String(person?.known_name || `${firstName} ${lastName}`.trim() || person?.match_name || "").trim();
  if (!UUID_PATTERN.test(id) || !position || !name) return null;
  const rawStats = normalizedStatsRecord(row?.stat);
  return {
    id,
    name,
    firstName,
    lastName,
    position,
    positionLabel: PLAYER_POSITION_GROUPS[position].singular,
    photoUrl: photoByPersonId.get(id) || "",
    stats: {
      appearances: nonNegativeIntegerStat(rawStats, PLAYER_STAT_ALIASES.appearances),
      goals: nonNegativeIntegerStat(rawStats, PLAYER_STAT_ALIASES.goals),
      assists: nonNegativeIntegerStat(rawStats, PLAYER_STAT_ALIASES.assists),
      cleanSheets: nonNegativeIntegerStat(rawStats, PLAYER_STAT_ALIASES.cleanSheets),
      yellowCards: nonNegativeIntegerStat(rawStats, PLAYER_STAT_ALIASES.yellowCards),
      redCards: nonNegativeIntegerStat(rawStats, PLAYER_STAT_ALIASES.redCards),
      recentRating: null,
      ratedAppearances: 0
    }
  };
}

export function normalizeOfficialTeamSquad(
  payload,
  {
    teamId,
    providerTeamId,
    seasonId,
    photoByPersonId = new Map(),
    ratingByPersonId = new Map(),
    updatedAt = new Date().toISOString(),
    photoSourcePage = ""
  } = {}
) {
  if (!localTeamById.has(teamId)
    || !isOfficialMatchId(providerTeamId)
    || !isOfficialMatchId(seasonId)
    || !Array.isArray(payload?.data)) {
    throw new Error("Official league API returned an invalid team squad");
  }
  const eligibleRows = payload.data
    .filter((row) => {
      const rowTeamId = String(row?.team_id || row?.team?.id || "").trim();
      const rowSeasonId = String(row?.season_id || "").trim();
      return (!rowTeamId || rowTeamId === providerTeamId) && (!rowSeasonId || rowSeasonId === seasonId);
    });
  const players = eligibleRows
    .map((row) => normalizedSquadPlayer(row, photoByPersonId))
    .filter(Boolean);
  const uniquePlayers = new Map(players.map((player) => [player.id, player]));
  if (uniquePlayers.size < 10 || uniquePlayers.size > 70) {
    throw new Error(`Official league API returned ${uniquePlayers.size}/${eligibleRows.length} valid squad players`);
  }
  for (const player of uniquePlayers.values()) {
    const rating = ratingByPersonId.get(player.id);
    if (rating && Number.isFinite(rating.average)) {
      player.stats.recentRating = Math.round(rating.average * 10) / 10;
      player.stats.ratedAppearances = Math.max(1, Math.min(3, Number(rating.appearances) || 1));
    }
  }
  const groups = Object.values(PLAYER_POSITION_GROUPS)
    .filter((group, index, values) => values.findIndex((candidate) => candidate.id === group.id) === index)
    .sort((left, right) => left.order - right.order)
    .map((group) => ({
      id: group.id,
      label: group.label,
      players: [...uniquePlayers.values()]
        .filter((player) => PLAYER_POSITION_GROUPS[player.position].id === group.id)
        .sort((left, right) => (
          left.lastName.localeCompare(right.lastName, "pl")
          || left.name.localeCompare(right.name, "pl")
        ))
    }));
  return {
    teamId,
    providerTeamId,
    seasonId,
    players: groups.flatMap((group) => group.players),
    groups,
    updatedAt,
    source: OFFICIAL_LEAGUE_SOURCE,
    photoSource: photoByPersonId.size ? "official-ekstraklasa-cdn" : "",
    photoSourcePage,
    ratingSource: "ekstraklapa-typer-model-v1"
  };
}

export function officialMatchPlayerRating(row, position) {
  const stats = normalizedStatsRecord(row?.stat);
  const minutes = statValue(stats, ["mins_played", "minutes_played", "minutes"], 0);
  if (minutes < 15) return null;
  const goals = statValue(stats, ["goals"], 0);
  const assists = statValue(stats, ["goal_assists", "goal_assist", "assists"], 0);
  const yellowCards = statValue(stats, ["yellow_cards", "yellow_card"], 0);
  const redCards = statValue(stats, ["total_red_cards", "red_cards", "red_card"], 0);
  const ownGoals = statValue(stats, ["own_goals", "own_goal"], 0);
  const missedPenalties = statValue(stats, ["penalties_missed", "penalty_missed"], 0);
  const errorsLeadingToGoal = statValue(stats, ["errors_leading_to_goal", "error_lead_to_goal"], 0);
  const isGoalkeeper = position === "goalkeeper";
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  let rating = 6;
  rating += goals * (position === "goalkeeper" || position === "defender" ? 1.3 : position === "midfielder" ? 1.1 : 1);
  rating += assists * 0.7;
  rating -= yellowCards * 0.2;
  rating -= redCards * 1.2;
  rating -= ownGoals;
  rating -= missedPenalties * 0.8;
  rating -= errorsLeadingToGoal * 0.7;
  if (isGoalkeeper) {
    const saves = statValue(stats, ["saves", "saves_made"], 0);
    const goalsConceded = statValue(stats, ["goals_conceded"], 0);
    const expectedGoalsConceded = statValue(stats, ["expected_goals_conceded"], 0);
    const highClaims = statValue(stats, ["good_high_claim", "total_high_claim"], 0);
    rating += minutes >= 60 && goalsConceded === 0 ? 0.45 : 0;
    rating += Math.min(0.56, saves * 0.08);
    rating += Math.min(0.18, highClaims * 0.05);
    rating += expectedGoalsConceded > 0 ? clamp((expectedGoalsConceded - goalsConceded) * 0.32, -0.45, 0.55) : 0;
    rating -= Math.min(0.45, goalsConceded * 0.12);
  } else {
    const shotsOnTarget = statValue(stats, ["ontarget_scoring_att", "shots_on_target"], 0);
    const chancesCreated = statValue(stats, ["big_chance_created"], 0);
    const keyPasses = statValue(stats, ["total_att_assist", "key_passes"], 0);
    const tacklesWon = statValue(stats, ["won_tackle", "tackles_won"], 0);
    const interceptions = statValue(stats, ["interception", "interceptions"], 0);
    const clearances = statValue(stats, ["total_clearance", "clearances"], 0);
    const blocks = statValue(stats, ["outfielder_block", "blocked_shots"], 0);
    const recoveries = statValue(stats, ["ball_recovery", "recoveries"], 0);
    const duelsWon = statValue(stats, ["duel_won"], 0);
    const duelsLost = statValue(stats, ["duel_lost"], 0);
    const totalPasses = statValue(stats, ["total_pass"], 0);
    const accuratePasses = statValue(stats, ["accurate_pass"], 0);
    const fouls = statValue(stats, ["fouls"], 0);
    const possessionLost = statValue(stats, ["poss_lost_all"], 0);
    const dispossessed = statValue(stats, ["dispossessed"], 0);
    const errorsLeadingToShot = statValue(stats, ["error_lead_to_shot"], 0);
    rating += Math.min(0.24, Math.max(0, shotsOnTarget - goals) * 0.08);
    rating += Math.min(0.5, chancesCreated * 0.25);
    rating += Math.min(0.32, keyPasses * 0.08);
    rating += Math.min(0.32, tacklesWon * 0.08);
    rating += Math.min(0.24, interceptions * 0.08);
    rating += Math.min(0.2, clearances * 0.025);
    rating += Math.min(0.2, blocks * 0.08);
    rating += Math.min(0.2, recoveries * 0.02);
    if (duelsWon + duelsLost >= 5) rating += clamp((duelsWon / (duelsWon + duelsLost) - 0.5) * 0.7, -0.22, 0.22);
    if (totalPasses >= 10) rating += clamp((accuratePasses / totalPasses - 0.78) * 1.2, -0.25, 0.25);
    rating -= Math.min(0.2, fouls * 0.04);
    rating -= Math.min(0.2, Math.max(0, possessionLost - 12) * 0.015);
    rating -= Math.min(0.2, dispossessed * 0.05);
    rating -= errorsLeadingToShot * 0.35;
  }
  return clamp(Math.round(rating * 10) / 10, 3, 10);
}

export function formatPlayerRating(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(1).replace(".", ",") : "—";
}

async function recentTeamPlayerRatings(league, teamId, providerTeamId, positionByPersonId, fetchImpl) {
  const recentMatches = (league?.matches || [])
    .filter((match) => FINAL_STATUSES.has(match.status) && (match.home === teamId || match.away === teamId))
    .sort((left, right) => new Date(right.kickoffAt || 0).getTime() - new Date(left.kickoffAt || 0).getTime())
    .slice(0, 3);
  if (!recentMatches.length) return new Map();
  const payloadResults = await Promise.allSettled(recentMatches.map((match) => (
    fetchOfficialJson(`/v1/match_details/team_players/${encodeURIComponent(match.providerId)}`, fetchImpl)
  )));
  const payloads = payloadResults
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  for (const result of payloadResults) {
    if (result.status === "rejected") {
      console.warn("One recent match payload is unavailable; calculating ratings from the remaining matches", result.reason);
    }
  }
  const ratings = new Map();
  for (const payload of payloads) {
    for (const row of Array.isArray(payload?.data) ? payload.data : []) {
      if (String(row?.team_id || "").trim() !== providerTeamId) continue;
      const personId = String(row?.person_id || row?.person?.id || "").trim();
      if (!UUID_PATTERN.test(personId)) continue;
      const rating = officialMatchPlayerRating(row, positionByPersonId.get(personId));
      if (rating === null) continue;
      const values = ratings.get(personId) || [];
      values.push(rating);
      ratings.set(personId, values);
    }
  }
  return new Map([...ratings].map(([personId, values]) => [
    personId,
    {
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
      appearances: values.length
    }
  ]));
}

async function loadOfficialTeamSquad(teamId, fetchImpl) {
  const league = await getOfficialLeaguePayload({ fetchImpl });
  const standing = league.standings.find((row) => row.teamId === teamId);
  if (!standing || !isOfficialMatchId(standing.providerTeamId)) {
    throw new Error("Official league API did not return the selected team");
  }
  const seasonId = league.season.id;
  const providerTeamId = standing.providerTeamId;
  const encodedSeasonId = encodeURIComponent(seasonId);
  const encodedTeamId = encodeURIComponent(providerTeamId);
  const squadPayload = await fetchOfficialJson(
    `/v1/team_season_squad?season_id=${encodedSeasonId}&team_id=${encodedTeamId}`,
    fetchImpl
  );
  const clubSlug = OFFICIAL_CLUB_SLUGS[teamId];
  const photoSourcePage = clubSlug ? `${OFFICIAL_SITE_BASE}/kluby/${clubSlug}/?tab=squad` : "";
  const baseSquad = normalizeOfficialTeamSquad(squadPayload, {
    teamId,
    providerTeamId,
    seasonId,
    photoSourcePage
  });
  const positionByPersonId = new Map(baseSquad.players.map((player) => [player.id, player.position]));
  const [photoResult, ratingResult] = await Promise.allSettled([
    photoSourcePage
      ? fetchOfficialText(photoSourcePage, fetchImpl).then(extractOfficialPlayerPhotos)
      : Promise.resolve(new Map()),
    recentTeamPlayerRatings(
      league,
      teamId,
      providerTeamId,
      positionByPersonId,
      fetchImpl
    )
  ]);
  const photoByPersonId = photoResult.status === "fulfilled" ? photoResult.value : new Map();
  const ratingByPersonId = ratingResult.status === "fulfilled" ? ratingResult.value : new Map();
  if (photoResult.status === "rejected") {
    console.warn("Official player photos are temporarily unavailable", { teamId, error: photoResult.reason });
  }
  if (ratingResult.status === "rejected") {
    console.warn("Official match statistics for recent player ratings are temporarily unavailable", {
      teamId,
      error: ratingResult.reason
    });
  }
  return normalizeOfficialTeamSquad(squadPayload, {
    teamId,
    providerTeamId,
    seasonId,
    photoByPersonId,
    ratingByPersonId,
    photoSourcePage
  });
}

export async function getOfficialTeamSquad(teamId, { fetchImpl = fetch, force = false } = {}) {
  const normalizedTeamId = String(teamId || "").trim();
  if (!localTeamById.has(normalizedTeamId)) throw new Error("Invalid local team id");
  const now = Date.now();
  const cached = cachedTeamSquads.get(normalizedTeamId);
  if (!force && cached && cached.expiresAt > now) return cached.payload;
  if (!teamSquadRequestsInFlight.has(normalizedTeamId)) {
    const request = loadOfficialTeamSquad(normalizedTeamId, fetchImpl)
      .then((payload) => {
        cachedTeamSquads.set(normalizedTeamId, {
          payload,
          expiresAt: Date.now() + TEAM_SQUAD_CACHE_TTL_MS
        });
        return payload;
      })
      .finally(() => {
        teamSquadRequestsInFlight.delete(normalizedTeamId);
      });
    teamSquadRequestsInFlight.set(normalizedTeamId, request);
  }
  try {
    return await teamSquadRequestsInFlight.get(normalizedTeamId);
  } catch (error) {
    if (cached?.payload) {
      console.warn("Official team squad refresh failed; serving the last valid payload", { teamId: normalizedTeamId, error });
      return cached.payload;
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
