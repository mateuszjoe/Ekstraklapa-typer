import { readFile } from "node:fs/promises";

const [app, rules, worker, serviceWorker] = await Promise.all([
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../firestore.rules", import.meta.url), "utf8"),
  readFile(new URL("../notifications-worker/index.js", import.meta.url), "utf8"),
  readFile(new URL("../sw.js", import.meta.url), "utf8")
]);

const checks = [
  [rules.includes("allow create: if validOwnJoinRequestCreate(seasonId, uid);"), "Nowy użytkownik może utworzyć wyłącznie kontrolowane zgłoszenie."],
  [rules.includes("allow create: if validAdminParticipantCreateFromJoin(seasonId, uid);"), "Uczestnika może utworzyć wyłącznie administrator po akceptacji."],
  [rules.includes("allow create: if validAdminLeaderboardCreateFromJoin(seasonId, uid)"), "Wpis rankingu jest chroniony transakcją akceptacji."],
  [rules.includes("request.resource.data.status == 'pending'"), "Nowe zgłoszenie zawsze zaczyna w poczekalni."],
  [rules.includes("validAdminJoinRequestRejection(seasonId, uid)"), "Administrator może odrzucić zgłoszenie bez aktywacji gracza."],
  [(rules.match(/&& isSeasonParticipant\(\)/g) || []).length >= 8, "Typy, wyniki i chat wymagają aktywnego uczestnictwa."],
  [/status:\s*"pending",\s*requestedAt:\s*serverTimestamp\(\),\s*updatedAt:\s*serverTimestamp\(\)/.test(app), "Frontend zapisuje pełne zgłoszenie oczekujące."],
  [app.includes('lastMembershipAction: "approved"'), "Akceptacja atomowo aktualizuje licznik uczestników."],
  [app.includes("async function resolveAdminJoinRequest(uid, decision)"), "Panel administratora rozpatruje zgłoszenia."],
  [worker.includes('"/api/events/join-request": playerJoinRequest'), "Worker przyjmuje zdarzenia nowych zgłoszeń."],
  [serviceWorker.includes('"admin-join-request"'), "Powiadomienie administratora otwiera poczekalnię."]
];

const failed = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failed.length) {
  console.error(`BŁĄD: poczekalnia nie spełnia ${failed.length} warunków:\n- ${failed.join("\n- ")}`);
  process.exit(1);
}

console.log("OK: nowe konta trafiają do poczekalni, a aktywacja wymaga atomowej akceptacji administratora.");
