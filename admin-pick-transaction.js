// Administrative corrections use the signed-in administrator's Firebase session.
// Firestore rules enforce the same checks, including the immutable audit and score delta.
const SEASON_ID = "2026-27";
const PICKS = new Set(["1", "X", "2"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = `admin-pick/${code}`;
  throw error;
}

function validSegment(value, max = 180) {
  return typeof value === "string" && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function saveAdminPickCorrection({
  db, sdk, actorUid, uid, matchId, pick, reason, expectedPick, correctionId
}) {
  if (!db || !sdk || !validSegment(actorUid, 128) || !validSegment(uid, 128)
    || !validSegment(matchId) || !PICKS.has(pick)
    || !(expectedPick === "" || PICKS.has(expectedPick))) {
    fail("invalid-input", "Nieprawidłowy gracz, mecz lub typ.");
  }
  const note = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (note.length < 5 || note.length > 500 || !/[\p{L}\p{N}]/u.test(note)) {
    fail("invalid-reason", "Podaj powód korekty (5–500 znaków).");
  }
  if (typeof correctionId !== "string" || !/^[A-Za-z0-9_-]{10,100}$/.test(correctionId)) {
    fail("invalid-input", "Brak poprawnego identyfikatora korekty.");
  }
  const { doc, runTransaction, serverTimestamp } = sdk;
  const season = (...path) => doc(db, "seasons", SEASON_ID, ...path);
  const auditRef = season("adminPickCorrections", correctionId);
  const participantRef = season("participants", uid);
  const matchRef = season("matches", matchId);
  const pickRef = season("players", uid, "picks", matchId);
  const scoreRef = season("players", uid, "scores", matchId);
  const leaderboardRef = season("leaderboard", uid);

  return runTransaction(db, async (transaction) => {
    const existingAudit = await transaction.get(auditRef);
    if (existingAudit.exists()) {
      const audit = existingAudit.data();
      if (audit.uid !== uid || audit.matchId !== matchId || audit.actorUid !== actorUid
        || audit.newPick !== pick || audit.oldPick !== expectedPick || audit.reason !== note) {
        fail("id-conflict", "Identyfikator jest już przypisany do innej korekty. Odśwież formularz.");
      }
      return { correctionId, uid, matchId, pick, previousPick: audit.oldPick, replayed: true };
    }
    const [participantSnapshot, matchSnapshot, pickSnapshot, scoreSnapshot, leaderboardSnapshot] = await Promise.all([
      transaction.get(participantRef), transaction.get(matchRef), transaction.get(pickRef),
      transaction.get(scoreRef), transaction.get(leaderboardRef)
    ]);
    const participant = participantSnapshot.exists() ? participantSnapshot.data() : null;
    if (!participant || participant.uid !== uid || participant.seasonId !== SEASON_ID
      || participant.disabled === true || !["active", "approved"].includes(participant.status || "active")) {
      fail("inactive-player", "Korekta jest dostępna tylko dla aktywnego gracza.");
    }
    const match = matchSnapshot.exists() ? matchSnapshot.data() : null;
    if (!match || !Number.isInteger(match.matchday) || match.matchday < 1 || match.matchday > 17
      || !(match.result === undefined || match.result === "" || PICKS.has(match.result))) {
      fail("missing-match", "Brak potwierdzonego meczu w terminarzu serwera.");
    }
    const oldPick = pickSnapshot.exists() ? pickSnapshot.data().pick : "";
    if (!(oldPick === "" || PICKS.has(oldPick))) fail("invalid-input", "Zapisany typ jest nieprawidłowy.");
    if (oldPick !== expectedPick) fail("conflict", "Typ zmienił się od otwarcia formularza. Odśwież go przed korektą.");
    if (oldPick === pick) fail("no-change", "Ten typ jest już zapisany; nie utworzono zbędnej korekty.");

    const score = scoreSnapshot.exists() ? scoreSnapshot.data() : null;
    const leaderboard = leaderboardSnapshot.exists() ? leaderboardSnapshot.data() : null;
    if (score && !PICKS.has(match.result)) {
      fail("inconsistent-score", "Rozliczony mecz nie ma potwierdzonego wyniku. Najpierw sprawdź terminarz.");
    }
    let newScore = null;
    let leaderboardUpdate = null;
    if (PICKS.has(match.result)) {
      if (!leaderboard || leaderboard.uid !== uid
        || !Number.isInteger(leaderboard.points) || !Number.isInteger(leaderboard.typed)
        || leaderboard.points < 0 || leaderboard.points > leaderboard.typed
        || leaderboard.typed < 0 || leaderboard.typed > 153
        || !Array.isArray(leaderboard.settledMatchIds)
        || new Set(leaderboard.settledMatchIds).size !== leaderboard.settledMatchIds.length
        || leaderboard.typed !== leaderboard.settledMatchIds.length
        || Boolean(score) !== leaderboard.settledMatchIds.includes(matchId)
        || (score && (score.uid !== uid || score.matchId !== matchId || score.pick !== oldPick
          || ![0, 1].includes(score.points) || !score.settledAt))) {
        fail("inconsistent-score", "Historia punktacji jest niespójna. Nie zapisano korekty; wymagane jest sprawdzenie rankingu.");
      }
      const points = pick === match.result ? 1 : 0;
      const totalPoints = leaderboard.points + points - (score?.points || 0);
      const typed = leaderboard.typed + (score ? 0 : 1);
      if (totalPoints < 0 || totalPoints > typed || typed > 153) {
        fail("inconsistent-score", "Nieprawidłowa suma punktów po korekcie. Nie zmieniono danych.");
      }
      newScore = { uid, matchId, pick, points, settledAt: score?.settledAt || serverTimestamp() };
      leaderboardUpdate = {
        points: totalPoints, typed, lastScoreMatchId: matchId,
        settledMatchIds: score ? leaderboard.settledMatchIds : [...leaderboard.settledMatchIds, matchId],
        updatedAt: serverTimestamp()
      };
    }
    transaction.set(pickRef, { pick, updatedAt: serverTimestamp(), correctionId });
    transaction.set(auditRef, {
      uid, matchId, actorUid, oldPick, newPick: pick, reason: note, createdAt: serverTimestamp()
    });
    if (newScore) {
      transaction.set(scoreRef, newScore);
      transaction.update(leaderboardRef, leaderboardUpdate);
    }
    return { correctionId, uid, matchId, pick, previousPick: oldPick, replayed: false };
  });
}
