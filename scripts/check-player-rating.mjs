import assert from "node:assert/strict";
import {
  formatRecentPlayerRating,
  MAX_RECENT_PLAYER_RATINGS
} from "../player-rating.js";

assert.equal(MAX_RECENT_PLAYER_RATINGS, 5);
assert.equal(formatRecentPlayerRating({ average: 7.24, appearances: 3 }), "7,2 (3 w.)");
assert.equal(formatRecentPlayerRating({ average: 8, appearances: 5 }), "8,0");
assert.equal(formatRecentPlayerRating({ average: null, appearances: 0 }), "—");
assert.equal(formatRecentPlayerRating({ average: null, appearances: 1 }), "—");
assert.equal(formatRecentPlayerRating({ average: 7.2, appearances: 6 }), "—");
assert.equal(formatRecentPlayerRating({ average: "7.2", appearances: 3 }), "—");
assert.equal(formatRecentPlayerRating({ average: "niepoprawna", appearances: 3 }), "—");
assert.equal(formatRecentPlayerRating(), "—");

console.log("OK: formatowanie średniej z maksymalnie 5 ocenionych występów.");
