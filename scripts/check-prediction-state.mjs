import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `Find ${name} in the application.`);
  return source.slice(source.slice(start - 6, start) === "async " ? start - 6 : start, end);
}
const match = {
  id: "13-motor-widzew", matchday: 13, home: "home", away: "away",
  kickoffAt: "2026-10-30T18:00:00+01:00", kickoffConfirmed: true, status: "NS"
};
const user = { uid: "test-player", email: "player@example.test", provider: "google.com" };
const requests = [];
const notifications = [];
const renders = [];
const context = {
  Date: class extends Date { static now() { return Date.parse("2026-10-29T12:00:00Z"); } },
  Intl, Boolean, Number, Map, Set, Promise,
  console: { error() {} },
  state: {
    user, auth: { currentUser: { uid: user.uid } }, participantReady: true, userDataReady: true,
    predictions: {}, confirmedPredictions: {}, matches: [match], db: {}, firebaseModules: {}
  },
  predictionWriteQueues: new Map(), predictionWriteVersions: new Map(), trustedMatchesSyncPromise: null,
  typerMatchIds: new Set([match.id]), LAST_MATCHDAY: 17,
  LIVE: new Set(["LIVE", "HT"]), FINAL: new Set(["FT", "AWD"]),
  teamById: {
    home: { id: "home", name: "Home", short: "H", crest: "home.png" },
    away: { id: "away", name: "Away", short: "A", crest: "away.png" }
  },
  icon: () => "", teamRouteHref: () => "#", livePickOverviewHtml: () => "",
  openAuthDialog: () => { throw new Error("Unexpected login"); },
  notify: (message) => notifications.push(message),
  refreshPredictionUi: () => renders.push(context.matchCard(match)),
  saveRemotePrediction: (uid, matchId, pick) => new Promise((resolve, reject) => {
    requests.push({ uid, matchId, pick, resolve, reject });
  })
};
vm.createContext(context);
vm.runInContext([
  functionSource("formatDay", "formatTime"),
  functionSource("formatTime", "resultOf"),
  functionSource("hasConfirmedKickoff", "isLocked"),
  functionSource("isLocked", "isPredictionOpen"),
  functionSource("isPredictionOpen", "pointsFor"),
  functionSource("matchCard", "liveMatchesSection"),
  functionSource("setPrediction", "matchPicksHtml"),
  functionSource("syncTrustedMatchTimes", "normalizeName")
].join("\n"), context);
const flush = () => new Promise((resolve) => setImmediate(resolve));

context.setPrediction(match.id, "1");
assert.match(renders.at(-1), /zapisywanie typu/);
assert.doesNotMatch(renders.at(-1), /typ zapisany/,
  "An optimistic selection must never be presented as a confirmed save.");
assert.match(renders.at(-1), /aria-busy="true"/);
await flush();
assert.equal(requests.length, 1);
requests[0].resolve();
await flush();
assert.equal(context.state.confirmedPredictions[match.id], "1");
assert.match(renders.at(-1), /typ zapisany/);
assert.match(renders.at(-1), /aria-busy="false"/);
assert.equal(context.predictionWriteQueues.size, 0);

// Rapid edits are serialized. An earlier save must not clear the pending state
// or claim that a later choice has reached the server.
context.setPrediction(match.id, "X");
context.setPrediction(match.id, "2");
await flush();
assert.equal(requests.length, 2, "Only the first queued write starts immediately.");
assert.equal(requests[1].pick, "X");
requests[1].resolve();
await flush();
assert.equal(requests.length, 3);
assert.equal(requests[2].pick, "2");
assert.match(context.matchCard(match), /zapisywanie typu/);
assert.doesNotMatch(context.matchCard(match), /typ zapisany/);
requests[2].reject(Object.assign(new Error("Denied"), { code: "permission-denied" }));
await flush();
assert.equal(context.state.predictions[match.id], "X", "Restore the last actual server save after failure.");
assert.equal(context.state.confirmedPredictions[match.id], "X");
assert.equal(context.predictionWriteQueues.size, 0);
assert.match(renders.at(-1), /typ zapisany/);
assert.match(notifications.at(-1), /Serwer nie przyjął typu/);
assert.ok(!notifications.includes("Typ 2 zapisany"));

for (const kickoffAt of [null, "", "invalid"]) {
  const invalid = { ...match, kickoffAt };
  assert.equal(context.isPredictionOpen(invalid), false);
  assert.equal(context.formatTime(invalid), "godz. do ustalenia");
  assert.match(context.matchCard(invalid), /czeka na termin/);
}
for (const status of ["LIVE", "HT", "FT", "AWD"]) {
  assert.equal(context.isPredictionOpen({ ...match, status }), false,
    "An official live/final status must not reopen betting when the client clock or date is wrong.");
}
assert.equal(context.isPredictionOpen(match), true);
assert.equal(context.isPredictionOpen({ ...match, kickoffConfirmed: false }), false);
assert.equal(context.formatDay({ ...match, kickoffAt: null }), "termin do ustalenia");
assert.equal(context.formatTime({ ...match, kickoffAt: "2026-10-24T18:15:00Z" }), "20:15");
assert.equal(context.formatTime({ ...match, kickoffAt: "2026-10-25T16:30:00Z" }), "17:30",
  "Europe/Warsaw must apply the autumn DST change exactly once.");
assert.equal(context.isLocked({ ...match, kickoffAt: "2026-10-25T17:30:00+01:00" }), true);

let syncCalls = 0;
let resolveSync;
context.notificationApiRequest = (path, body) => {
  syncCalls += 1;
  assert.equal(path, "/api/admin/schedule/sync");
  assert.equal(Object.keys(body).length, 0, "Browser dates/results must never be sent as trusted schedule data.");
  return new Promise((resolve) => { resolveSync = resolve; });
};
await context.syncTrustedMatchTimes();
assert.equal(syncCalls, 0, "Only the admin can trigger the optional server refresh.");
context.state.user = { ...user, email: "mateuszjoe@gmail.com" };
const firstSync = context.syncTrustedMatchTimes();
const duplicateSync = context.syncTrustedMatchTimes();
assert.equal(syncCalls, 1, "Concurrent browser refreshes share one request.");
resolveSync({ synchronized: true });
await Promise.all([firstSync, duplicateSync]);
assert.equal(context.trustedMatchesSyncPromise, null);

// Background and visibility-resume live polls are read-only. They must not
// enqueue forced server syncs and bypass the unattended five-minute cadence.
let pollSyncCalls = 0;
let dashboardLoads = 0;
const pollState = {
  user, userDataReady: true, participantReady: true, view: "matches",
  currentWeek: 13, matchday: 13, matches: [{ ...match }], liveSignature: ""
};
const pollFixture = {
  localMatchId: match.id, providerId: "provider-test", status: "FT", elapsed: null,
  score: { home: 2, away: 0 }, kickoffAt: "2026-10-29T11:00:00Z", kickoffConfirmed: true,
  source: "ekstraklasa-match-center"
};
const pollContext = {
  Date: context.Date, Boolean, Number, Set, Promise,
  state: pollState, LIVE: context.LIVE, typerMatchIds: context.typerMatchIds,
  livePollRunning: false, livePollRefreshQueued: false, livePollTimeout: null,
  autoSelectMatchday: false, firstLivePollSettled: false,
  rankingLoadRevision: 0, rankingLoadPromise: null, rankingReloadPending: false,
  playerFormLoadRevision: 0, playerFormLoadPromise: null,
  console: { warn() {} }, document: { querySelector: () => null },
  loadLivePayloadForClient: async () => ({ currentWeek: 13, pollIntervalSeconds: 45, fixtures: [{ ...pollFixture }] }),
  withCorrectedKickoff: (fixture) => fixture,
  settledResultsSignature: () => pollState.matches.map((entry) => `${entry.status}:${entry.homeScore}:${entry.awayScore}`).join("|"),
  syncTrustedMatchTimes: () => { pollSyncCalls += 1; return Promise.resolve(); },
  loadRankingData: () => Promise.resolve(),
  loadPlayerDashboardData: () => { dashboardLoads += 1; return Promise.resolve(); },
  render() {}, clearTimeout() {}, setTimeout: () => 1,
  tryApplyNotificationRoute: () => Promise.resolve()
};
vm.createContext(pollContext);
vm.runInContext(functionSource("pollLive", "refreshLiveAfterResume"), pollContext);
await pollContext.pollLive();
await pollContext.pollLive({ force: true });
assert.equal(pollState.matches[0].status, "FT", "The poll must still apply fresh live results.");
assert.equal(dashboardLoads, 1, "A changed final result must still refresh player statistics.");
assert.equal(pollSyncCalls, 0, "Neither regular nor resume/manual live refresh may force a schedule-sync loop.");

const rules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
for (const section of ["match /seasons/{seasonId}/matches/{matchId}", "match /scheduleMeta/{seasonId}"]) {
  const block = rules.slice(rules.indexOf(section), rules.indexOf("\n    }", rules.indexOf(section)));
  assert.match(block, /allow create, update: if isScheduleSyncService\(\) && valid/,
    "Cached admin clients must not overwrite server-owned schedules.");
  assert.doesNotMatch(block, /allow create, update: if isAdmin/);
}
assert.match(rules, /request\.auth\.uid == 'trusted-schedule-sync-2026-27'/);
assert.match(rules, /request\.auth\.token\.firebase\.sign_in_provider == 'custom'/);
assert.match(rules, /request\.auth\.token\.scheduleSync == true/);
console.log("OK: picks stay pending until confirmed, queued failures roll back safely, DST and invalid dates are handled, and only the server writes trusted deadlines.");
