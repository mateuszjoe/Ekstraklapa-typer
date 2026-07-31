import { readFile } from "node:fs/promises";

const [app, worker, serviceWorker] = await Promise.all([
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../notifications-worker/index.js", import.meta.url), "utf8"),
  readFile(new URL("../sw.js", import.meta.url), "utf8")
]);

const checks = [
  [app.includes('data-notification-test'), "Brakuje przycisku testu powiadomień."],
  [app.includes('notificationApiRequest("/api/push/test", {})'), "Frontend nie wywołuje testowego endpointu."],
  [worker.includes('"/api/push/test": testPush'), "Worker nie wystawia testowego endpointu."],
  [worker.includes('type: "test-notification"'), "Worker nie tworzy testowego powiadomienia."],
  [serviceWorker.includes('"test-notification": Object.freeze'), "Service worker nie obsługuje testowego typu."],
  [serviceWorker.includes("NOTIFICATION_TYPES[type] || FALLBACK_NOTIFICATION"), "Service worker nie ma bezpiecznego fallbacku dla nowego typu."],
  [serviceWorker.includes("if (pushState.muted === true) return;"), "Service worker nadal odrzuca push przy braku stanu lokalnego."]
];

for (const [passed, message] of checks) {
  if (!passed) throw new Error(message);
}

console.log("Powiadomienia: kontrakt klient–Worker i tryb samonaprawy są spójne.");
