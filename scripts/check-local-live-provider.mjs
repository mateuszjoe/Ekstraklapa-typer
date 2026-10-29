import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matches as baseMatches } from "../data.js";
const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const functionSource = (name) => {
  const code = source.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(code, `Missing server function ${name}`);
  return code;
};
const expected = {
  currentWeek: 13,
  updatedAt: new Date().toISOString(),
  scheduleUpdatedAt: new Date().toISOString(),
  nextPollAt: new Date(Date.now() + 300_000).toISOString(),
  error: null,
  fixtures: baseMatches.map((match) => ({
    localMatchId: match.id, matchday: match.matchday,
    kickoffAt: match.matchday < 16 ? "2026-10-30T18:00:00+01:00" : null,
    kickoffConfirmed: match.matchday < 16, status: "NS"
  }))
};
let calls = 0;
const harness = Function("getOfficialLivePayload", "baseMatches", `
  let providerState = { schedule: baseMatches.slice(0, 50), nextPollAt: new Date(Date.now() + 999999).toISOString(), error: null };
  let pollInFlight = null;
  const pollIntervalMs = 45000;
  const backgroundLiveRefreshMs = 300000;
  const staleLiveMaxAgeMs = 300000;
  const saveProviderState = async () => {};
  const isInMatchWindow = () => false;
  const millisecondsSince = value => Date.now() - Date.parse(value);
  const fixturesWithManualResults = async () => providerState.schedule;
  ${functionSource("runPollingCycle")}
  ${functionSource("publicPayload")}
  return { publicPayload, state: () => providerState };
`)(async () => { calls += 1; return structuredClone(expected); }, baseMatches);

const payload = await harness.publicPayload();
assert.equal(calls, 1, "The old 50-match disk cache must be replaced even when its poll deadline has not elapsed.");
assert.equal(payload.currentWeek, 13, "Local transport must expose the same top-level currentWeek as the browser provider.");
assert.equal(payload.fixtures.length, 153);
assert.deepEqual(payload.fixtures, expected.fixtures);
assert.equal(payload.fixtures.filter((fixture) => fixture.matchday === 13 && fixture.kickoffConfirmed).length, 9);
assert.equal(payload.fixtures.filter((fixture) => fixture.matchday >= 16 && !fixture.kickoffConfirmed).length, 18);
assert.equal(payload.fixtures[0].kickoffAt, "2026-10-30T18:00:00+01:00", "Keep the provider's winter timezone offset.");
await harness.publicPayload();
assert.equal(calls, 1, "Requests before the next poll reuse the shared provider's data.");
console.log("OK: local /api/live uses the complete shared provider with currentWeek, confirmed dates and DST offsets.");
