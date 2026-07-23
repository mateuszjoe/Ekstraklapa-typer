export const MAX_RECENT_PLAYER_RATINGS = 5;

export function formatRecentPlayerRating(rating) {
  const average = rating?.average;
  const appearances = rating?.appearances;
  const validAverage = typeof average === "number"
    && Number.isFinite(average)
    && average >= 0
    && average <= 10;
  const validAppearances = typeof appearances === "number"
    && Number.isInteger(appearances)
    && appearances >= 1
    && appearances <= MAX_RECENT_PLAYER_RATINGS;
  if (!validAverage || !validAppearances) return "—";
  const formattedAverage = average.toFixed(1).replace(".", ",");
  return appearances < MAX_RECENT_PLAYER_RATINGS
    ? `${formattedAverage} (${appearances} w.)`
    : formattedAverage;
}
