// Round dates cover the whole autumn, unlike the bundled exact kickoff times.
// Keep the weekend's round through Monday; the live provider then refines it.
export function currentMatchday(roundDates, { currentWeek, now = Date.now() } = {}) {
  const rounds = Object.entries(roundDates)
    .map(([number, date]) => ({ number: Number(number), date }))
    .sort((a, b) => a.number - b.number);
  if (!rounds.length) return 1;
  const week = Number(currentWeek);
  if (Number.isInteger(week) && week >= 1) {
    return Math.min(rounds.at(-1).number, Math.max(rounds[0].number, week));
  }
  return rounds.find(({ date }) => Date.parse(`${date}T00:00:00Z`) + 3 * 86_400_000 > now)?.number
    || rounds.at(-1).number;
}

export function initialMatchdayFor({ roundDates, notificationMatchday, routeMatchday, now }) {
  for (const value of [notificationMatchday, routeMatchday]) {
    if (Number.isInteger(value) && Object.hasOwn(roundDates, value)) return value;
  }
  return currentMatchday(roundDates, { now });
}
