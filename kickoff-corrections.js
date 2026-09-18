// Confirmed kickoff changes that have not reached the official match-center feed.
// Keep corrections after the match so historical dates do not revert on refresh.
export const kickoffCorrections = Object.freeze([
  Object.freeze({
    matchId: "9-widzew-wieczysta",
    providerId: "1434a4dc-50b9-4587-ac17-20fe74a6fd83",
    kickoffAt: "2026-09-18T18:30:00+02:00",
    reason: "Start delayed by 30 minutes after a stadium water-supply failure.",
    source: "https://kanalsportowy.pl/pilka-nozna/ekstraklasa/oficjalnie-zapadla-decyzja-odnosnie-meczu-widzew-lodz-wieczysta-krakow/"
  })
]);

const correctedTimes = new Map(kickoffCorrections.flatMap((correction) => [
  [correction.matchId, correction.kickoffAt],
  [correction.providerId, correction.kickoffAt]
]));

export function correctedKickoffAt(matchId, providerKickoffAt) {
  return correctedTimes.get(matchId) || providerKickoffAt;
}

// Apply at transport boundaries as well: a server cache may still contain the old time.
export function withCorrectedKickoff(match) {
  return {
    ...match,
    kickoffAt: correctedKickoffAt(
      match.localMatchId || match.id || match.providerId,
      correctedKickoffAt(match.providerId, match.kickoffAt)
    )
  };
}
