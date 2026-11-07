// Firestore is canonical. Verification time alone cannot order two concurrent
// reads, so D1 also retains the document's fixed-width, lexically sortable version.
export function firestorePickVersion(updateTime) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(String(updateTime || ""));
  if (!match || !Number.isFinite(Date.parse(`${match[1]}Z`))) {
    throw new Error("Brak potwierdzonej wersji typu w Firestore.");
  }
  return `${match[1]}.${(match[2] || "").padEnd(9, "0")}Z`;
}

export const PICK_PROJECTION_SQL = `
  INSERT INTO picks (uid, match_id, matchday, pick, verified_at, firestore_updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT(uid, match_id) DO UPDATE SET
    matchday = excluded.matchday,
    pick = excluded.pick,
    verified_at = excluded.verified_at,
    firestore_updated_at = excluded.firestore_updated_at
  WHERE excluded.firestore_updated_at > picks.firestore_updated_at
`;

export function pickProjectionBindings(uid, item, now = Date.now()) {
  if (typeof uid !== "string" || !uid || uid.length > 128
    || !/^[A-Za-z0-9_-]{1,180}$/.test(item?.matchId || "")
    || !Number.isInteger(item?.matchday) || item.matchday < 1 || item.matchday > 17
    || !["1", "X", "2"].includes(item?.pick)) {
    throw new Error("Nieprawidłowe potwierdzone dane typu.");
  }
  return [uid, item.matchId, item.matchday, item.pick, now, firestorePickVersion(item.updateTime)];
}

export function preparePickProjection(db, uid, item) {
  return db.prepare(PICK_PROJECTION_SQL).bind(...pickProjectionBindings(uid, item));
}

export class PickCorrectionSyncError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Called only after authenticatedAdmin. The supplied audit identifies the
// correction; it never supplies the value that is written to the ranking.
export async function readAdminPickProjection({ actorUid, uid, matchId, correctionId,
  match, readDocument, participantIsActive }) {
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)
    || typeof correctionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(correctionId)
    || !/^[A-Za-z0-9_-]{1,180}$/.test(matchId || "") || !match) {
    throw new PickCorrectionSyncError(400, "invalid-correction", "Nieprawidłowy gracz, mecz albo identyfikator korekty.");
  }
  const base = ["seasons", "2026-27"];
  const [participant, audit, trusted] = await Promise.all([
    readDocument([...base, "participants", uid]),
    readDocument([...base, "adminPickCorrections", correctionId]),
    readDocument([...base, "matches", matchId])
  ]);
  if (participant?.data?.uid !== uid || participant.data.seasonId !== "2026-27"
    || !participantIsActive(participant.data)) {
    throw new PickCorrectionSyncError(403, "participant-disabled", "Gracz nie jest aktywnym uczestnikiem typera.");
  }
  const correction = audit?.data;
  if (audit?.id !== correctionId || correction?.uid !== uid || correction?.matchId !== matchId
    || correction?.actorUid !== actorUid || !["1", "X", "2"].includes(correction?.newPick)
    || !["", "1", "X", "2"].includes(correction?.oldPick)
    || correction.oldPick === correction.newPick
    || typeof correction.reason !== "string" || !correction.reason.trim()
    || !Number.isFinite(Date.parse(correction.createdAt || ""))) {
    throw new PickCorrectionSyncError(409, "correction-mismatch", "Nie udało się potwierdzić zapisanego audytu korekty.");
  }
  if (trusted?.id !== matchId || trusted?.data?.matchday !== match.matchday) {
    throw new PickCorrectionSyncError(409, "match-mismatch", "Mecz nie zgadza się z terminarzem typera.");
  }
  // Read after the audit. A newer correction or a later ordinary open-match
  // edit takes precedence even when an old outbox item is being retried.
  const canonical = await readDocument([...base, "players", uid, "picks", matchId]);
  if (canonical?.id !== matchId || !["1", "X", "2"].includes(canonical?.data?.pick)) {
    throw new PickCorrectionSyncError(409, "pick-mismatch", "Nie udało się potwierdzić aktualnego typu gracza.");
  }
  const currentCorrectionId = canonical.data.correctionId || "";
  if (currentCorrectionId === correctionId && canonical.data.pick !== correction.newPick) {
    throw new PickCorrectionSyncError(409, "correction-mismatch", "Typ nie zgadza się z audytem korekty.");
  }
  // Validate here so absent versions fail before any projection is written.
  firestorePickVersion(canonical.updateTime);
  return {
    matchId, matchday: match.matchday, pick: canonical.data.pick,
    updateTime: canonical.updateTime, currentCorrectionId,
    status: currentCorrectionId === correctionId ? "synced" : "superseded"
  };
}
