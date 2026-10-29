import { correctedKickoffAt } from "./kickoff-corrections.js";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export function officialKickoff(item, matchId = item?.match_id) {
  const postponed = item?.postponed === true || Boolean(item?.postponed_datetime);
  const rawKickoff = postponed ? item?.postponed_datetime : item?.match_datetime;
  const kickoff = correctedKickoffAt(matchId, correctedKickoffAt(item?.match_id, rawKickoff || null));
  const clock = TIMESTAMP.exec(String(kickoff || ""))?.[1];
  const explicitTime = postponed ? item?.postponed_local_time : item?.local_time;
  const corrected = Boolean(kickoff && kickoff !== rawKickoff);
  // "None" and 00:00 are date-only placeholders in the provider's schedule,
  // including the postponed December fixtures. A previous date is not a fallback.
  const validClock = clock && clock !== "00:00:00"
    && (corrected || explicitTime == null || (CLOCK.test(explicitTime) && !/^00:00(?::00)?$/.test(explicitTime)));
  const kickoffConfirmed = Boolean(validClock && Number.isFinite(Date.parse(kickoff)));
  return {
    kickoffAt: kickoffConfirmed ? kickoff : null,
    kickoffConfirmed,
    scheduledDate: (postponed ? item?.postponed_date : item?.date) || String(kickoff || "").slice(0, 10) || null
  };
}
