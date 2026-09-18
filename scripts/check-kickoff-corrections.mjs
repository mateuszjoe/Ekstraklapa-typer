import assert from "node:assert/strict";
import { matches } from "../data.js";
import { withCorrectedKickoff } from "../kickoff-corrections.js";
import { normalizeOfficialFixture, normalizedOfficialMatchStatus } from "../live-provider.js";
import { normalizeOfficialLeagueMatch } from "../league-provider.js";

const item = {
  match_id: "1434a4dc-50b9-4587-ac17-20fe74a6fd83",
  week: 9,
  home_team_code: "WID",
  away_team_code: "WIE",
  status: "fixture",
  match_datetime: "2026-09-18T18:00:00+02:00",
  postponed_datetime: null,
  home_score: 0,
  away_score: 0
};
const kickoffAt = "2026-09-18T18:30:00+02:00";
const base = matches.find((match) => match.id === "9-widzew-wieczysta");
assert.equal(base.kickoffAt, kickoffAt, "Offline and trusted-schedule sync must use the corrected time.");
assert.equal(base.kickoffConfirmed, true);

for (const normalize of [normalizeOfficialFixture, normalizeOfficialLeagueMatch]) {
  for (const feedTime of [item.match_datetime, kickoffAt, null]) {
    const fixture = normalize({ ...item, match_datetime: feedTime });
    assert.equal(fixture.kickoffAt, kickoffAt, "Repeated polls must not restore the stale kickoff.");
    assert.equal(fixture.status, "NS");
    assert.ok(Date.parse("2026-09-18T18:15:00+02:00") < Date.parse(fixture.kickoffAt));
    assert.equal(Date.parse(fixture.kickoffAt), Date.parse("2026-09-18T16:30:00Z"));
  }
}

const cached = { localMatchId: base.id, kickoffAt: item.match_datetime, status: "LIVE", score: { home: 1, away: 0 } };
assert.deepEqual(withCorrectedKickoff(cached), { ...cached, kickoffAt });
assert.equal(cached.kickoffAt, item.match_datetime, "Do not mutate the shared transport cache.");
assert.equal(withCorrectedKickoff({ providerId: item.match_id, kickoffAt: item.match_datetime }).kickoffAt, kickoffAt);
const unrelated = { id: "9-lech-radomiak", kickoffAt: "2026-09-20T17:30:00+02:00", status: "NS" };
assert.deepEqual(withCorrectedKickoff(unrelated), unrelated, "Other matches must keep their own time.");

const played = { ...item, status: "played", home_score: 1 };
assert.equal(normalizedOfficialMatchStatus(played, Date.parse("2026-09-18T19:50:00+02:00")), "LIVE",
  "The final-result guard must measure match age from the delayed kickoff.");
assert.equal(normalizedOfficialMatchStatus(played, Date.parse("2026-09-18T20:05:00+02:00")), "FT");

console.log("OK: delayed kickoff survives stale feeds, caches and offline fallback; final-result timing follows the correction.");
