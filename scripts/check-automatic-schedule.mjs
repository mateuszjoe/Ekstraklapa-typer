import assert from "node:assert/strict";
import { matches, teamById } from "../data.js";
import {
  planTrustedSchedule,
  verifyTrustedSchedule,
  syncTrustedSchedule,
  SCHEDULE_SERVICE_UID,
  SCHEDULE_STATE_KEY
} from "../notifications-worker/trusted-schedule.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const ROOT = "projects/ekstraklasa-typer-2026-27/databases/(default)/documents";
const fixtures = matches.map((match) => ({
  localMatchId: match.id, matchday: match.matchday,
  kickoffConfirmed: match.matchday <= 15,
  kickoffAt: match.matchday <= 12 ? "2026-10-24T18:15:00+02:00"
    : match.matchday <= 15 ? "2026-10-30T18:00:00+01:00" : null,
  status: match.matchday <= 12 ? "FT" : "NS",
  score: match.matchday <= 12 ? { home: 2, away: 1 } : { home: null, away: null }
}));
const postponed = fixtures.find((fixture) => fixture.localMatchId === "4-jagiellonia-pogon");
Object.assign(postponed, { kickoffConfirmed: false, kickoffAt: null, status: "PST", score: { home: null, away: null } });
const secondPostponed = fixtures.find((fixture) => fixture.localMatchId === "4-wisla-plock-lech");
Object.assign(secondPostponed, { kickoffConfirmed: false, kickoffAt: null, status: "PST", score: { home: null, away: null } });
const pristineFixtures = structuredClone(fixtures);

function applyWrites(documents, changes, now = NOW) {
  const stored = new Map(documents.map((document) => [document.name, structuredClone(document)]));
  for (const { write } of changes) {
    assert.ok(!write.delete, "A schedule synchronization must never delete data.");
    assert.match(write.update.name, /\/seasons\/2026-27\/matches\//,
      "No operation may target players, predictions, scores or chat.");
    assert.deepEqual(write.updateTransforms, [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]);
    assert.deepEqual(write.updateMask.fieldPaths.sort(), Object.keys(write.update.fields).sort());
    const previous = stored.get(write.update.name);
    if (previous) assert.equal(write.currentDocument.updateTime, previous.updateTime);
    else assert.equal(write.currentDocument.exists, false);
    stored.set(write.update.name, {
      name: write.update.name,
      fields: {
        ...previous?.fields, ...structuredClone(write.update.fields),
        updatedAt: { timestampValue: new Date(now).toISOString() }
      },
      updateTime: new Date(now).toISOString()
    });
  }
  return [...stored.values()];
}

const initial = planTrustedSchedule(fixtures, [], NOW);
assert.equal(initial.length, 153, "Synchronization must cover all autumn rounds, not just this weekend.");
assert.deepEqual(fixtures, pristineFixtures, "Planning must not mutate the fetched official snapshot.");
const saved = applyWrites([], initial);
verifyTrustedSchedule(initial, saved);
assert.equal(planTrustedSchedule(fixtures, saved, NOW).length, 0, "Identical snapshots must be idempotent.");

for (const round of [13, 14, 15]) {
  const changes = initial.filter((change) => change.expected.matchday.integerValue === String(round));
  assert.equal(changes.length, 9);
  assert.ok(changes.every((change) => change.expected.kickoffConfirmed.booleanValue
    && Date.parse(change.expected.closesAt.timestampValue) > NOW), `All nine confirmed fixtures in round ${round} must open.`);
}
for (const round of [16, 17]) {
  const changes = initial.filter((change) => change.expected.matchday.integerValue === String(round));
  assert.equal(changes.length, 9);
  assert.ok(changes.every((change) => !change.expected.kickoffConfirmed.booleanValue
    && Date.parse(change.expected.closesAt.timestampValue) === 0
    && Date.parse(change.expected.revealsAt.timestampValue) > Date.parse("2100-01-01")),
  "A framework date must neither open betting nor reveal private selections.");
}
const postponedSaved = saved.find((document) => document.name.endsWith(`/${postponed.localMatchId}`));
assert.equal(postponedSaved.fields.matchday.integerValue, "4", "Postponements keep the original saved-pick ID and round.");
assert.equal(postponedSaved.fields.kickoffConfirmed.booleanValue, false);
assert.equal(Date.parse(postponedSaved.fields.closesAt.timestampValue), 0);
assert.ok(Date.parse(postponedSaved.fields.revealsAt.timestampValue) > NOW);

const offsetFixtures = structuredClone(fixtures);
offsetFixtures.find((fixture) => fixture.matchday === 12).kickoffAt = "2026-10-24T16:15:00Z";
assert.equal(planTrustedSchedule(offsetFixtures, saved, NOW).length, 0,
  "Equivalent UTC and summer-time offsets must not change a deadline.");
const dstFixture = offsetFixtures.find((fixture) => fixture.matchday === 13);
dstFixture.kickoffAt = "2026-10-30T17:00:00Z";
assert.equal(planTrustedSchedule(offsetFixtures, saved, NOW).length, 0,
  "The UTC winter-time offset must apply exactly once.");

const changedFixtures = structuredClone(fixtures);
const moved = changedFixtures.find((fixture) => fixture.matchday === 13);
moved.kickoffAt = "2026-10-30T18:30:00+01:00";
const changes = planTrustedSchedule(changedFixtures, saved, NOW);
assert.equal(changes.length, 1);
assert.deepEqual(changes[0].write.updateMask.fieldPaths.sort(), ["closesAt", "revealsAt"],
  "A rescheduled kickoff should change only the two deadlines.");
assert.equal(changes[0].id, moved.localMatchId);
const movedSaved = applyWrites(saved, changes, NOW + 1000);
verifyTrustedSchedule(changes, movedSaved);
assert.throws(() => verifyTrustedSchedule(changes, saved), /schedule-verification-failed/);
assert.throws(() => verifyTrustedSchedule(initial, saved.slice(1)), /schedule-verification-failed/,
  "Verification must check every document, not just a count or metadata marker.");

for (const badFixtures of [
  fixtures.slice(1),
  [...fixtures.slice(1), fixtures[1]],
  fixtures.map((fixture, index) => index === 0 ? { ...fixture, localMatchId: "unknown" } : fixture),
  fixtures.map((fixture, index) => index === 0 ? { ...fixture, matchday: 18 } : fixture),
  fixtures.map((fixture, index) => index === 0 ? { ...fixture, status: "UNRECOGNIZED" } : fixture)
]) assert.throws(() => planTrustedSchedule(badFixtures, saved, NOW), /schedule-(incomplete|invalid-fixture)/);

const oldWithoutVersion = saved.map((document) => ({ ...document }));
delete oldWithoutVersion.find((document) => document.name.endsWith(`/${moved.localMatchId}`)).updateTime;
assert.throws(() => planTrustedSchedule(changedFixtures, oldWithoutVersion, NOW), /schedule-missing-document-version/);
const withExtra = [...saved, { name: `${ROOT}/seasons/2026-27/matches/legacy`, fields: {}, updateTime: new Date(NOW).toISOString() }];
assert.equal(planTrustedSchedule(fixtures, withExtra, NOW).length, 0, "Legacy documents must be retained.");

const regressed = structuredClone(fixtures);
const historical = regressed.find((fixture) => fixture.matchday === 1);
Object.assign(historical, { status: "NS", kickoffAt: "2026-11-30T18:00:00+01:00", score: { home: null, away: null } });
const regressedSaved = applyWrites(saved, planTrustedSchedule(regressed, saved, NOW));
const regressedFields = regressedSaved.find((document) => document.name.endsWith(`/${historical.localMatchId}`)).fields;
assert.equal(regressedFields.result.stringValue, "1", "A temporary missing/live score must not erase a final result.");
assert.ok(Date.parse(regressedFields.closesAt.timestampValue) <= NOW,
  "A bad future timestamp must never reopen a completed match.");
assert.equal(regressedFields.closesAt.timestampValue,
  saved.find((document) => document.name.endsWith(`/${historical.localMatchId}`)).fields.closesAt.timestampValue);
assert.ok(Date.parse(regressedFields.revealsAt.timestampValue) <= NOW,
  "A bad future timestamp must not hide selections that were already revealed.");
const endedWithoutScore = structuredClone(saved);
const noScoreDocument = endedWithoutScore.find((document) => document.name.endsWith(`/${historical.localMatchId}`));
noScoreDocument.fields.result.stringValue = "";
noScoreDocument.fields.status.stringValue = "FT";
// Force a legitimate metadata update so the regression exercises repeated writes,
// not just an unchanged document. The final status must survive the first write.
noScoreDocument.fields.source.stringValue = "legacy-source";
let noScoreSaved = endedWithoutScore;
for (let attempt = 1; attempt <= 2; attempt += 1) {
  const noScoreChanges = planTrustedSchedule(regressed, noScoreSaved, NOW + attempt * 1000);
  noScoreSaved = applyWrites(noScoreSaved, noScoreChanges, NOW + attempt * 1000);
  const retained = noScoreSaved.find((document) => document.name === noScoreDocument.name);
  assert.equal(retained.fields.status.stringValue, "FT", "The final status must survive both syncs without a score.");
  assert.equal(retained.fields.result.stringValue, "", "Do not invent a score for a finished fixture.");
  assert.ok(Date.parse(retained.fields.closesAt.timestampValue) <= NOW,
    `A finished fixture without a result must not reopen on sync ${attempt}.`);
  assert.ok(Date.parse(retained.fields.revealsAt.timestampValue) <= NOW);
}
for (const status of ["LIVE", "FT"]) {
  const impossible = structuredClone(fixtures);
  impossible[0] = { ...impossible[0], status, kickoffAt: "2026-11-30T18:00:00+01:00" };
  const staleChange = planTrustedSchedule(impossible, [], NOW).find((change) => change.id === impossible[0].localMatchId);
  assert.equal(Date.parse(staleChange.expected.closesAt.timestampValue), 0,
    "A future kickoff on a live/final fixture must fail closed even without previous state.");
}
// A valid official correction may replace the result only when the match is final.
const corrected = structuredClone(fixtures);
corrected[0].score = { home: 0, away: 0 };
assert.equal(planTrustedSchedule(corrected, saved, NOW)[0].expected.result.stringValue, "X");

// Exercise the unattended orchestration with isolated fake official/Firebase/D1
// services. This performs no real requests and submits no player prediction.
const realFetch = globalThis.fetch;
const RealDate = globalThis.Date;
let serverDocuments = [];
let commitCount = 0;
let corruptVerification = false;
let truncatedOfficial = false;
let heldLease = null;
let stateJson = "{}";
const rawRows = matches.map((match) => {
  const fixture = fixtures.find((candidate) => candidate.localMatchId === match.id);
  return {
    match_id: `test-${match.id}`, season_id: "test-season", week: match.matchday,
    home_team_code: teamById[match.home].short, away_team_code: teamById[match.away].short,
    match_datetime: fixture.kickoffAt, status: fixture.status === "FT" ? "played" : fixture.status === "PST" ? "postponed" : "fixture",
    home_score: fixture.score.home, away_score: fixture.score.away
  };
});
const allRows = [...rawRows, ...rawRows.map((row) => ({ ...row, match_id: `${row.match_id}-spring`, week: row.week + 17 }))];
const env = {
  FIREBASE_SCHEDULE_REFRESH_TOKEN: "isolated-test-refresh-token",
  DB: {
    prepare(sql) {
      let parameters;
      return {
        bind(...args) { parameters = args; return this; },
        async first() {
          if (sql.startsWith("SELECT value")) {
            assert.equal(parameters[0], SCHEDULE_STATE_KEY);
            return { value: stateJson };
          }
          assert.match(sql, /trusted_schedule_sync_lease/);
          if (heldLease) return null;
          heldLease = parameters[0];
          return { value: heldLease };
        },
        async run() {
          if (sql.startsWith("DELETE")) {
            if (heldLease === parameters[0]) heldLease = null;
          } else {
            assert.equal(parameters[0], SCHEDULE_STATE_KEY);
            stateJson = parameters[1];
          }
          return { success: true };
        }
      };
    }
  }
};
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.hostname === "api.centrum-meczowe.ekstraklasa.org") {
    if (url.pathname === "/v1/seasons/current") {
      return Response.json({ data: { season_id: "test-season", name: "2026/2027" }, meta: { current_week_number: 13 } });
    }
    assert.equal(url.pathname, "/v1/matches");
    return Response.json({ data: truncatedOfficial ? allRows.slice(0, 50) : allRows, meta: { page_token: null } });
  }
  if (url.hostname === "securetoken.googleapis.com") {
    assert.equal(options.method, "POST");
    return Response.json({ user_id: SCHEDULE_SERVICE_UID, id_token: "isolated-test-id-token", expires_in: "3600" });
  }
  assert.equal(url.hostname, "firestore.googleapis.com");
  assert.equal(options.headers.Authorization, "Bearer isolated-test-id-token");
  if (url.pathname.endsWith(":commit")) {
    commitCount += 1;
    const body = JSON.parse(options.body);
    serverDocuments = applyWrites(serverDocuments, body.writes.map((write) => ({ write })));
    return Response.json({ writeResults: body.writes.map(() => ({ updateTime: new Date().toISOString() })) });
  }
  assert.match(url.pathname, /\/seasons\/2026-27\/matches$/);
  const documents = structuredClone(serverDocuments);
  if (corruptVerification && documents.length) documents[0].fields.source.stringValue = "incorrect";
  return Response.json({ documents });
};
try {
  const run = await syncTrustedSchedule(env, { force: true });
  assert.equal(run.status, "ok");
  assert.equal(run.matchCount, 153);
  assert.equal(run.currentWeek, 13);
  assert.equal(run.changed, 153);
  assert.equal(run.confirmedByRound[13], 9);
  assert.equal(run.confirmedByRound[14], 9);
  assert.equal(run.confirmedByRound[15], 9);
  assert.equal(run.confirmedByRound[16], undefined);
  assert.equal(run.waitingForTime.length, 20);
  assert.equal(heldLease, null);
  assert.equal(commitCount, 1);
  assert.equal((await syncTrustedSchedule(env)).status, "not-due");
  assert.equal(commitCount, 1, "The five-minute gate avoids unnecessary writes and requests.");
  assert.equal((await syncTrustedSchedule(env, { force: true })).changed, 0);
  assert.equal(commitCount, 1, "A fresh unchanged snapshot does not consume a Firestore write.");
  heldLease = "another-worker";
  assert.equal((await syncTrustedSchedule(env, { force: true })).status, "busy");
  assert.equal(heldLease, "another-worker");
  heldLease = null;
  truncatedOfficial = true;
  await assert.rejects(syncTrustedSchedule(env, { force: true }), /schedule-upstream-error/);
  assert.equal(commitCount, 1, "An incomplete page must fail before any database write.");
  assert.equal(JSON.parse(stateJson).status, "error");
  assert.equal(heldLease, null, "The failure path must release its lease for recovery.");
  truncatedOfficial = false;
  serverDocuments[0].fields.source.stringValue = "incorrect";
  corruptVerification = true;
  await assert.rejects(syncTrustedSchedule(env, { force: true }), /schedule-verification-failed/);
  assert.equal(JSON.parse(stateJson).status, "error");
  assert.equal(heldLease, null);
} finally {
  globalThis.fetch = realFetch;
  globalThis.Date = RealDate;
}
console.log("OK: automatic schedule sync covers 153 fixtures, protects unknown/postponed times and results, verifies every write, handles DST, retries failures and serializes workers.");
