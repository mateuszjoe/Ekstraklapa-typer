import assert from "node:assert/strict";
import { roundDatesByNumber } from "../data.js";
import { currentMatchday, initialMatchdayFor } from "../matchday-selection.js";

const now = Date.parse("2026-09-18T16:00:00Z");
const roundDates = roundDatesByNumber;
assert.equal(currentMatchday(roundDates, { now }), 9, "September must not get stuck on the last bundled exact kickoff in August.");
assert.equal(currentMatchday(roundDates, { now: Date.parse("2026-09-20T19:00:00Z") }), 9, "Keep the active weekend's round.");
assert.equal(currentMatchday(roundDates, { now: Date.parse("2026-09-21T17:00:00Z") }), 9, "Include Monday fixtures.");
assert.equal(currentMatchday(roundDates, { now, currentWeek: 8 }), 8, "The official provider takes precedence over the calendar fallback.");
assert.equal(currentMatchday(roundDates, { now: Date.parse("2026-07-01T00:00:00Z") }), 1);
assert.equal(currentMatchday(roundDates, { now: Date.parse("2027-01-01T00:00:00Z") }), 17);
assert.equal(currentMatchday(roundDates, { now, currentWeek: 34 }), 17, "Never select a spring round outside this edition.");
assert.equal(initialMatchdayFor({ roundDates, now }), 9);
assert.equal(initialMatchdayFor({ roundDates, now, routeMatchday: 3 }), 3, "Keep explicit historical links.");
assert.equal(initialMatchdayFor({ roundDates, now, routeMatchday: 3, notificationMatchday: 8 }), 8, "Keep notification targets.");
assert.equal(initialMatchdayFor({ roundDates, now, routeMatchday: 99, notificationMatchday: 0 }), 9);
console.log("OK: bieżąca kolejka, stare linki, powiadomienia i granice rundy jesiennej.");
