import assert from "node:assert/strict";
import { normalizeOfficialFixture, normalizedOfficialMatchStatus } from "../live-provider.js";

const fixture = {
  status: "played",
  match_datetime: "2026-07-29T18:00:00Z",
  home_score: 1,
  away_score: 0
};

assert.equal(
  normalizedOfficialMatchStatus(fixture, Date.parse("2026-07-29T18:50:00Z")),
  "LIVE",
  "Przedwczesny status played w trakcie meczu musi pozostać LIVE."
);
assert.equal(
  normalizedOfficialMatchStatus(fixture, Date.parse("2026-07-29T19:36:00Z")),
  "FT",
  "Status played po minimalnym czasie meczu musi zostać uznany za końcowy."
);
assert.equal(
  normalizedOfficialMatchStatus({ ...fixture, status: "playing" }, Date.parse("2026-07-29T19:36:00Z")),
  "LIVE",
  "Oficjalny status playing zawsze musi pozostać LIVE."
);

const koronaLegia = normalizeOfficialFixture({
  match_id: "live-kor-leg",
  week: 3,
  status: "playing",
  match_datetime: "2026-08-08T20:15:00+02:00",
  home_team_code: "KOR",
  away_team_code: "LEG",
  home_score: 0,
  away_score: 1
});
assert.deepEqual(
  {
    localMatchId: koronaLegia?.localMatchId,
    status: koronaLegia?.status,
    score: koronaLegia?.score
  },
  {
    localMatchId: "3-korona-legia",
    status: "LIVE",
    score: { home: 0, away: 1 }
  },
  "Korona–Legia z oficjalnym statusem playing musi trafić do właściwego meczu LIVE."
);

console.log("OK: status LIVE nie jest przedwcześnie zamieniany na wynik końcowy.");
