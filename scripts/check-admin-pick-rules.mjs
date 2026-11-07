import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, beforeEach, test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as sdk from 'firebase/firestore';
import { saveAdminPickCorrection } from '../admin-pick-transaction.js';

// A demo-only project and explicit localhost prevent this suite touching production.
sdk.setLogLevel('silent');
const env = await initializeTestEnvironment({ projectId: 'demo-admin-picks', firestore: {
  host: '127.0.0.1', port: 8185, rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8')
} });
const claims = (email) => ({ email, email_verified: true, firebase: { sign_in_provider: 'google.com' } });
const admin = env.authenticatedContext('admin', claims('mateuszjoe@gmail.com')).firestore();
const player = env.authenticatedContext('player', claims('player@example.test')).firestore();
const other = env.authenticatedContext('other', claims('other@example.test')).firestore();
const ref = (db, ...path) => sdk.doc(db, 'seasons', '2026-27', ...path);
const past = sdk.Timestamp.fromMillis(Date.now() - 86400000);
const future = sdk.Timestamp.fromMillis(Date.now() + 86400000);
const pickRef = (db, matchId = 'closed') => ref(db, 'players', 'player', 'picks', matchId);
const auditRef = (db, id = 'correction-test-001') => ref(db, 'adminPickCorrections', id);
const scoreRef = (db) => ref(db, 'players', 'player', 'scores', 'final');
const boardRef = (db) => ref(db, 'leaderboard', 'player');
async function seed(entries) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const seedDb = ctx.firestore();
    const batch = sdk.writeBatch(seedDb);
    for (const [path, data] of entries) batch.set(ref(seedDb, ...path), data);
    await batch.commit();
  });
}
const correction = (extra = {}) => saveAdminPickCorrection({ db: admin, sdk, actorUid: 'admin', uid: 'player',
  matchId: 'closed', pick: '1', expectedPick: '', reason: 'Awaria telefonu; zgłoszenie przed meczem.',
  correctionId: 'correction-test-001', ...extra });
beforeEach(async () => {
  await env.clearFirestore();
  await seed([
    ...['player', 'other', 'admin'].map(uid => [['participants', uid], { uid, seasonId: '2026-27', status: 'active', disabled: false, joinedAt: past }]),
    ...['open', 'closed', 'final'].map(id => [['matches', id], { matchday: 14, closesAt: id === 'open' ? future : past,
      revealsAt: id === 'open' ? future : past, kickoffConfirmed: true, result: id === 'final' ? '1' : '', updatedAt: past }]),
    [['leaderboard', 'player'], { uid: 'player', displayName: 'Test Player', avatarType: 'google', avatarValue: '',
      points: 0, typed: 0, joinedAt: past, lastScoreMatchId: '', settledMatchIds: [], updatedAt: past }]
  ]);
});
after(async () => env.cleanup());

test('ordinary player keeps own open writes; closed and another player writes denied', async () => {
  await assertSucceeds(sdk.setDoc(pickRef(player, 'open'), { pick: 'X', updatedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.setDoc(pickRef(player), { pick: '1', updatedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.setDoc(pickRef(other, 'open'), { pick: '1', updatedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.setDoc(pickRef(player, 'open'), { pick: '1', updatedAt: sdk.serverTimestamp(), correctionId: 'correction-test-001' }));
  await assertFails(sdk.getDoc(pickRef(other, 'open')));
  await assertSucceeds(sdk.getDoc(pickRef(admin, 'open')));
  await assertFails(sdk.getDocs(sdk.collection(admin, 'seasons', '2026-27', 'players', 'player', 'picks')));
});

test('admin can fill a closed match, with immutable server-dated audit and idempotent retry', async () => {
  const before = Date.now();
  await assertSucceeds(correction());
  const audit = (await sdk.getDoc(auditRef(admin))).data();
  assert.equal(audit.oldPick, ''); assert.equal(audit.newPick, '1'); assert.equal(audit.actorUid, 'admin');
  assert.ok(audit.createdAt.toMillis() >= before - 1000);
  assert.equal((await correction()).replayed, true);
  assert.equal((await sdk.getDoc(pickRef(admin))).data().pick, '1');
  await assertFails(sdk.updateDoc(auditRef(admin), { reason: 'zmieniony powód' }));
  await assertFails(sdk.deleteDoc(auditRef(admin)));
  await assertFails(sdk.setDoc(pickRef(admin), { pick: '2', updatedAt: sdk.serverTimestamp() }));
  await assert.rejects(correction({ pick: '2' }), /przypisany/);
});

test('late missing final pick settles once, and repeated correction changes only point delta', async () => {
  await assertSucceeds(correction({ matchId: 'final' }));
  const first = (await sdk.getDoc(scoreRef(admin))).data();
  assert.equal(first.points, 1);
  assert.equal((await sdk.getDoc(boardRef(admin))).data().typed, 1);
  await assertSucceeds(correction({ matchId: 'final', expectedPick: '1', pick: '2', correctionId: 'correction-test-002' }));
  let board = (await sdk.getDoc(boardRef(admin))).data();
  assert.equal(board.points, 0); assert.equal(board.typed, 1); assert.deepEqual(board.settledMatchIds, ['final']);
  assert.equal((await sdk.getDoc(scoreRef(admin))).data().settledAt.toMillis(), first.settledAt.toMillis());
  await assertSucceeds(correction({ matchId: 'final', expectedPick: '2', pick: '1', correctionId: 'correction-test-003' }));
  board = (await sdk.getDoc(boardRef(admin))).data();
  assert.equal(board.points, 1); assert.equal(board.typed, 1);
});

test('ordinary identity, unverified admin and wrong provider cannot use correction privilege', async () => {
  await assertFails(correction({ db: other, actorUid: 'other' }));
  const unverified = env.authenticatedContext('unverified', { ...claims('mateuszjoe@gmail.com'), email_verified: false }).firestore();
  const password = env.authenticatedContext('password', { ...claims('mateuszjoe@gmail.com'), firebase: { sign_in_provider: 'password' } }).firestore();
  await assertFails(correction({ db: unverified, actorUid: 'unverified' }));
  await assertFails(correction({ db: password, actorUid: 'password' }));
});

test('concurrent drafts cannot overwrite each other', async () => {
  const attempts = await Promise.allSettled([correction(), correction({ pick: '2', correctionId: 'correction-test-002' })]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(x => x.status === 'rejected').length, 1);
});

async function rawCorrection({ matchId = 'closed', auditOverride = {}, withScore = false, tamperPoints = false } = {}) {
  const batch = sdk.writeBatch(admin);
  batch.set(pickRef(admin, matchId), { pick: '1', updatedAt: sdk.serverTimestamp(), correctionId: 'correction-test-001' });
  batch.set(auditRef(admin), { uid: 'player', matchId, actorUid: 'admin', oldPick: '', newPick: '1',
    reason: 'Awaria potwierdzona wiadomością', createdAt: sdk.serverTimestamp(), ...auditOverride });
  if (withScore) {
    batch.set(scoreRef(admin), { uid: 'player', matchId, pick: '1', points: 1, settledAt: sdk.serverTimestamp() });
    batch.update(boardRef(admin), { points: tamperPoints ? 10 : 1, typed: 1, lastScoreMatchId: matchId,
      settledMatchIds: [matchId], updatedAt: sdk.serverTimestamp() });
  }
  return batch.commit();
}
test('rules deny forged old pick, actor, reason, backdating and missing audit', async () => {
  for (const auditOverride of [{ oldPick: 'X' }, { actorUid: 'other' }, { reason: '' }, { createdAt: past }]) {
    await assertFails(rawCorrection({ auditOverride }));
  }
  await assertFails(sdk.setDoc(pickRef(admin), { pick: '1', updatedAt: sdk.serverTimestamp(), correctionId: 'correction-test-001' }));
});

test('rules require score and aggregate to accompany final correction; reject arbitrary points', async () => {
  await assertFails(rawCorrection({ matchId: 'final' }));
  await assertFails(rawCorrection({ matchId: 'final', withScore: true, tamperPoints: true }));
  assert.equal((await sdk.getDoc(pickRef(admin, 'final'))).exists(), false);
});

test('inactive target and unknown fixture cannot be written even by direct admin batch', async () => {
  await assertFails(rawCorrection({ matchId: 'unknown' }));
  await seed([[['participants', 'player'], { uid: 'player', seasonId: '2026-27', status: 'removed', disabled: true }]]);
  await assertFails(rawCorrection());
});

test('owner can update an open corrected pick while audit remains immutable', async () => {
  await assertSucceeds(correction({ matchId: 'open' }));
  await assertSucceeds(sdk.setDoc(pickRef(player, 'open'), { pick: 'X', updatedAt: sdk.serverTimestamp() }));
  assert.equal((await sdk.getDoc(auditRef(admin))).data().newPick, '1');
});
