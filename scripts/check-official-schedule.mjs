import assert from "node:assert/strict";
import { fetchOfficialPages } from "../official-api.js";
import { officialKickoff } from "../official-kickoff.js";
import { getOfficialTrustedSchedule, getOfficialLivePayload } from "../live-provider.js";
import { getOfficialLeaguePayload } from "../league-provider.js";
import { matches, teams, teamById } from "../data.js";

const calls = [];
const paged = await fetchOfficialPages("/v1/matches?season_id=test&status=played,awarded", async (path) => {
  calls.push(path);
  return calls.length === 1
    ? { data: [{ id: 1 }], meta: { page_token: "opaque+/=", per_page: 1 } }
    : { data: [{ id: 2 }], meta: { page_token: null, per_page: 1 } };
});
assert.deepEqual(paged.data, [{ id: 1 }, { id: 2 }]);
assert.equal(calls[1], "/v1/matches?season_id=test&status=played,awarded&page_token=opaque%2B%2F%3D");
await assert.rejects(fetchOfficialPages("/x", async () => ({ data: [1], meta: { page_token: "same" } })), /repeated/);
await assert.rejects(fetchOfficialPages("/x", async () => ({ data: [], meta: { page_token: "next" } })), /invalid/);
await assert.rejects(fetchOfficialPages("/x", async () => ({ data: {} })), /invalid page/);
await assert.rejects(fetchOfficialPages("/x", async () => ({ data: [1, 2] }), { maxItems: 1 }), /expected size/);
let infinitePage = 0;
await assert.rejects(fetchOfficialPages("/x", async () => ({ data: [1], meta: { page_token: String(++infinitePage) } }), { maxPages: 2 }), /page limit/);

assert.equal(officialKickoff({ match_datetime: "2026-10-24T18:00:00+02:00", local_time: "18:00:00" }).kickoffAt,
  "2026-10-24T18:00:00+02:00");
const winter = officialKickoff({ match_datetime: "2026-10-30T18:00:00+01:00", local_time: "18:00:00" });
assert.equal(Date.parse(winter.kickoffAt), Date.parse("2026-10-30T17:00:00Z"), "Keep the winter UTC offset.");
for (const value of [
  { match_datetime: null, local_time: "None", date: "2026-11-28" },
  { match_datetime: "2026-10-30T18:00:00", local_time: "18:00:00" },
  { match_datetime: "2026-10-30T18:00:00+01:00", local_time: "None" },
  { match_datetime: "2026-10-30T00:00:00+01:00", local_time: "00:00:00" },
  { postponed: true, match_datetime: "2026-08-16T17:30:00+02:00", postponed_datetime: null },
  { postponed: true, match_datetime: "2026-08-16T17:30:00+02:00", postponed_datetime: "2026-12-16T00:00:00+01:00", postponed_local_time: "00:00:00" }
]) {
  assert.equal(officialKickoff(value).kickoffAt, null);
  assert.equal(officialKickoff(value).kickoffConfirmed, false);
}

const seasonId = "22222222-2222-4222-8222-222222222222";
const fixtures = [...matches, ...matches.map((match) => ({ ...match, home: match.away, away: match.home, matchday: match.matchday + 17 }))]
  .map((match, index) => ({
    match_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    season_id: seasonId,
    week: match.matchday,
    home_team_code: teamById[match.home].short,
    away_team_code: teamById[match.away].short,
    status: "fixture",
    match_datetime: match.matchday <= 15 ? "2026-10-30T18:00:00+01:00" : null,
    local_time: match.matchday <= 15 ? "18:00:00" : "None"
  }));
const requests = [];
function fakeFetch(url) {
  requests.push(url);
  const parsed = new URL(url);
  let body;
  if (parsed.pathname.endsWith("/seasons/current")) {
    body = { data: { season_id: seasonId, name: "2026/2027" }, meta: { current_week_number: 13 } };
  } else if (parsed.pathname.endsWith("/team_season_standings")) {
    body = { data: teams.map((team, index) => ({ team_id: `team-${index}`, team_code: team.short, rank: index + 1 })) };
  } else if (parsed.searchParams.has("week")) {
    body = { data: fixtures.filter((fixture) => fixture.week === Number(parsed.searchParams.get("week")))
      .map((fixture) => ({ ...fixture, match_datetime: "2026-10-30T20:30:00+01:00", local_time: "20:30:00" })) };
  } else if (parsed.searchParams.get("status") === "playing") {
    body = { data: [] };
  } else {
    const offset = Number(parsed.searchParams.get("page_token") || 0);
    body = { data: fixtures.slice(offset, offset + 50), meta: { page_token: offset + 50 < fixtures.length ? String(offset + 50) : null, per_page: 50 } };
  }
  return Promise.resolve({ ok: true, json: async () => body });
}
const schedule = await getOfficialTrustedSchedule({ force: true, fetchImpl: fakeFetch });
assert.equal(schedule.fixtures.length, 153, "Read all autumn matches, not the first 50.");
assert.equal(requests.filter((url) => url.includes("/matches?")).length, 7);
assert.equal(schedule.fixtures.filter((fixture) => fixture.matchday >= 13 && fixture.matchday <= 15 && fixture.kickoffConfirmed).length, 27);
assert.equal(schedule.fixtures.filter((fixture) => fixture.matchday >= 16 && !fixture.kickoffConfirmed).length, 18);
const requestCount = requests.length;
assert.equal(await getOfficialTrustedSchedule({ fetchImpl: fakeFetch }), schedule);
assert.equal(requests.length, requestCount, "The complete schedule is cached between live polls.");
const live = await getOfficialLivePayload({ force: true, fetchImpl: fakeFetch });
assert.equal(live.fixtures.length, 153);
assert.equal(requests.length - requestCount, 3, "Warm live polling must not redownload seven schedule pages.");
assert.equal(live.fixtures.find((fixture) => fixture.matchday === 13).kickoffAt, "2026-10-30T20:30:00+01:00",
  "Current round updates override the cached full schedule.");
assert.equal(live.fixtures.filter((fixture) => fixture.matchday === 15 && fixture.kickoffConfirmed).length, 9,
  "Confirmed next rounds remain available alongside live updates.");
assert.equal(schedule.fixtures.find((fixture) => fixture.matchday === 13).kickoffAt, "2026-10-30T18:00:00+01:00",
  "Live overlays must not mutate the trusted schedule snapshot.");
const league = await getOfficialLeaguePayload({ force: true, fetchImpl: fakeFetch });
assert.equal(league.matches.length, 306, "League page follows the same pagination contract.");
await assert.rejects(getOfficialTrustedSchedule({ force: true, fetchImpl: async (url) => {
  if (url.includes("/seasons/current")) return fakeFetch(url);
  return { ok: true, json: async () => ({ data: fixtures.slice(0, 50) }) };
} }), /incomplete/, "An unexpectedly truncated schedule must not be trusted.");

console.log("OK: full paginated schedule, future rounds, postponed placeholders, DST offsets and cache bounds.");
