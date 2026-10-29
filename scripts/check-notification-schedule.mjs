import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matches, teams } from "../data.js";
const source = await readFile(new URL("../notifications-worker/index.js", import.meta.url), "utf8");
function loadFunction(name, bindings) {
  const code = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(code, `Missing worker function ${name}`);
  return Function(...Object.keys(bindings), `${code}; return ${name};`)(...Object.values(bindings));
}

const confirmedRounds = loadFunction("confirmedRounds", { matches });
assert.ok(confirmedRounds().some((round) => round.matchday === 1));
const roundOne = matches.filter((match) => match.matchday === 1).map((match) => ({
  localMatchId: match.id, kickoffAt: match.kickoffAt, kickoffConfirmed: true
}));
roundOne[0] = { ...roundOne[0], kickoffAt: null, kickoffConfirmed: false };
assert.equal(confirmedRounds(roundOne).some((round) => round.matchday === 1), false,
  "An official cancellation of the exact time must not fall back to bundled dates.");
roundOne[0].kickoffAt = matches[0].kickoffAt;
assert.equal(confirmedRounds(roundOne).some((round) => round.matchday === 1), false,
  "Explicitly unconfirmed must remain unconfirmed even if a timestamp is supplied.");

const leagueFixtureSnapshot = loadFunction("leagueFixtureSnapshot", { isOfficialMatchId: () => true });
const snapshot = leagueFixtureSnapshot({ matches: [{ localMatchId: "1-a-b", providerId: "provider", matchday: 1,
  kickoffAt: "2026-10-30T18:00:00+01:00", kickoffConfirmed: false }] });
assert.equal(snapshot[0].kickoffConfirmed, false);

const now = Date.now();
const kickoff = now + 60 * 60_000;
const row = { match_id: matches[0].id, provider_match_id: "provider", matchday: 1,
  kickoff_at: kickoff, published_at: now - 1000 };
const fixture = { localMatchId: row.match_id, providerId: row.provider_match_id,
  kickoffAt: new Date(kickoff).toISOString(), kickoffConfirmed: true,
  home: matches[0].home, away: matches[0].away };
const sent = [];
let audienceReads = 0;
const processPublished = loadFunction("processPublishedLineupNotifications", {
  subscriberUidsMissingEvent: async () => { audienceReads += 1; return ["test-player"]; },
  enqueueEvent: async (...args) => { sent.push(args); return true; },
  TEAM_BY_ID: new Map(teams.map((team) => [team.id, team])),
  appUrl: (_env, suffix) => `https://test.invalid/${suffix}`
});
const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [row] }) }) }) } };
for (const altered of [
  { kickoffAt: null, kickoffConfirmed: false },
  { kickoffAt: fixture.kickoffAt, kickoffConfirmed: false },
  { kickoffAt: new Date(kickoff + 30 * 60_000).toISOString() },
  { kickoffAt: new Date(now - 60_000).toISOString() },
  { providerId: "different-match" }
]) {
  await processPublished(env, [{ ...fixture, ...altered }], { remaining: 5 });
}
assert.equal(sent.length, 0, "Rescheduled, unconfirmed or started matches must not send obsolete lineup notices.");
assert.equal(audienceReads, 0, "Do not even select recipients for an obsolete lineup notice.");
await processPublished(env, [fixture], { remaining: 5 });
assert.equal(sent.length, 1, "An unchanged confirmed fixture still sends its lineup notice.");
assert.equal(sent[0][3].kickoffAt, fixture.kickoffAt);
console.log("OK: reminders respect unconfirmed times; lineup notices require the current confirmed kickoff.");
