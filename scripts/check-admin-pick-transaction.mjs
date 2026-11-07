import assert from "node:assert/strict";
import { saveAdminPickCorrection } from "../admin-pick-transaction.js";

const base = "seasons/2026-27";
const player = "player-1";
const matchId = "14-motor-wisla-plock";
const paths = {
  participant: `${base}/participants/${player}`,
  match: `${base}/matches/${matchId}`,
  pick: `${base}/players/${player}/picks/${matchId}`,
  score: `${base}/players/${player}/scores/${matchId}`,
  board: `${base}/leaderboard/${player}`
};
const timestamp = { seconds: 1794060000, nanoseconds: 0 };
function harness({ result = "", pick = "", settled = false } = {}) {
  const store = new Map([
    [paths.participant, { uid: player, seasonId: "2026-27" }],
    [paths.match, { matchday: 14, result }],
    [paths.board, { uid: player, points: settled ? 1 : 0, typed: settled ? 1 : 0,
      settledMatchIds: settled ? [matchId] : [], lastScoreMatchId: settled ? matchId : "", displayName: "Test" }]
  ]);
  if (pick) store.set(paths.pick, { pick, updatedAt: { seconds: 1 } });
  if (settled) store.set(paths.score, { uid: player, matchId, pick, points: 1, settledAt: { seconds: 2 } });
  let committedWrites = 0;
  const sdk = {
    doc: (_db, ...segments) => segments.join("/"),
    serverTimestamp: () => timestamp,
    runTransaction: async (_db, operation) => {
      const writes = [];
      const tx = {
        get: async (path) => ({ exists: () => store.has(path), data: () => structuredClone(store.get(path)) }),
        set: (path, value) => writes.push({ path, value }),
        update: (path, value) => writes.push({ path, value: { ...store.get(path), ...value } })
      };
      const result = await operation(tx);
      writes.forEach(({ path, value }) => store.set(path, value));
      committedWrites += writes.length;
      return result;
    }
  };
  const args = { db: {}, sdk, actorUid: "admin-1", uid: player, matchId, pick: "2",
    reason: "Awaria telefonu — zgłoszenie od gracza", expectedPick: pick, correctionId: "test-correction-0001" };
  return { store, args, writes: () => committedWrites };
}

{
  const h = harness();
  const saved = await saveAdminPickCorrection(h.args);
  assert.equal(saved.replayed, false);
  assert.deepEqual(h.store.get(paths.pick), { pick: "2", updatedAt: timestamp, correctionId: h.args.correctionId });
  const audit = h.store.get(`${base}/adminPickCorrections/${h.args.correctionId}`);
  assert.equal(audit.oldPick, ""); assert.equal(audit.actorUid, "admin-1");
  assert.equal(h.writes(), 2);
  assert.equal(h.store.has(paths.score), false);
  const replay = await saveAdminPickCorrection(h.args);
  assert.equal(replay.replayed, true);
  assert.equal(h.writes(), 2, "replay does not award points or append audit again");
  await assert.rejects(saveAdminPickCorrection({ ...h.args, pick: "1" }), { code: "admin-pick/id-conflict" });
}
{
  const h = harness({ pick: "1" });
  await assert.rejects(saveAdminPickCorrection({ ...h.args, expectedPick: "X" }), { code: "admin-pick/conflict" });
  assert.equal(h.writes(), 0);
  await assert.rejects(saveAdminPickCorrection({ ...h.args, pick: "1" }), { code: "admin-pick/no-change" });
  assert.equal(h.writes(), 0);
}
{
  const h = harness({ result: "2" });
  await saveAdminPickCorrection(h.args);
  assert.equal(h.store.get(paths.board).points, 1);
  assert.equal(h.store.get(paths.board).typed, 1);
  assert.deepEqual(h.store.get(paths.board).settledMatchIds, [matchId]);
  assert.equal(h.store.get(paths.score).points, 1);
  await saveAdminPickCorrection(h.args);
  assert.equal(h.writes(), 4);
}
{
  const h = harness({ pick: "1", result: "1", settled: true });
  await saveAdminPickCorrection(h.args);
  assert.equal(h.store.get(paths.board).points, 0);
  assert.equal(h.store.get(paths.board).typed, 1);
  assert.equal(h.store.get(paths.score).pick, "2");
  assert.deepEqual(h.store.get(paths.score).settledAt, { seconds: 2 }, "correction preserves historical settlement time");
  assert.equal(h.store.get(paths.board).displayName, "Test");
  const next = { ...h.args, pick: "1", expectedPick: "2", correctionId: "test-correction-0002" };
  await saveAdminPickCorrection(next);
  assert.equal(h.store.get(paths.board).points, 1);
  assert.equal(h.store.get(paths.board).typed, 1);
  assert.equal(h.store.get(`${base}/adminPickCorrections/test-correction-0001`).newPick, "2");
  assert.equal(h.store.get(`${base}/adminPickCorrections/test-correction-0002`).oldPick, "2");
}
for (const corrupt of [
  (h) => h.store.get(paths.participant).disabled = true,
  (h) => h.store.delete(paths.match),
  (h) => h.store.get(paths.board).settledMatchIds = [matchId],
  (h) => h.store.get(paths.board).points = -1
]) {
  const h = harness({ result: "1" }); corrupt(h);
  await assert.rejects(saveAdminPickCorrection(h.args));
  assert.equal(h.writes(), 0, "invalid state never partially writes a correction");
}
{
  const h = harness({ result: "", pick: "1", settled: true });
  await assert.rejects(saveAdminPickCorrection(h.args), { code: "admin-pick/inconsistent-score" });
  assert.equal(h.writes(), 0);
}
for (const invalid of [{ reason: " " }, { reason: "x".repeat(501) }, { uid: "x/y" }, { pick: "3" }, { correctionId: "short" }]) {
  const h = harness();
  await assert.rejects(saveAdminPickCorrection({ ...h.args, ...invalid }));
  assert.equal(h.writes(), 0);
}
console.log("OK: admin correction transaction handles missing/settled picks, score deltas, immutable audit, conflicts, retries and corrupt-state rejection.");
