import assert from "node:assert/strict";
import { normalizedOfficialMatchStatus } from "../live-provider.js";

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

console.log("OK: status LIVE nie jest przedwcześnie zamieniany na wynik końcowy.");
