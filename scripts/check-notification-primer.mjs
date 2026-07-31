import assert from "node:assert/strict";
import { notificationPrimerDecision } from "../notification-primer-policy.js";

const activePlayer = {
  userReady: true,
  participantReady: true,
  supported: true,
  channelState: "disabled"
};

assert.equal(notificationPrimerDecision({ ...activePlayer, installedAndroidApp: true }).show, true,
  "APK/PWA Android bez push powinien pokazać popup.");
assert.equal(notificationPrimerDecision({ ...activePlayer, installedAndroidApp: true, permission: "denied" }).show, true,
  "Zablokowana zgoda w aplikacji Android powinna pokazać instrukcję ustawień.");
assert.equal(notificationPrimerDecision({ ...activePlayer, installedAndroidApp: true, recentlyDismissed: true }).show, true,
  "Stary cooldown nie może blokować popupu przy kolejnym uruchomieniu aplikacji.");
assert.equal(notificationPrimerDecision({ ...activePlayer, installedAndroidApp: true, dismissedThisLaunch: true }).show, false,
  "Może później powinno wyciszyć popup do końca bieżącego uruchomienia.");
assert.equal(notificationPrimerDecision({ ...activePlayer, installedAndroidApp: true, channelState: "enabled" }).show, false,
  "Aktywny kanał push powinien trwale wyłączyć popup.");
assert.equal(notificationPrimerDecision({ ...activePlayer, installedAndroidApp: true, channelState: "pending" }).show, true,
  "Niesprawna lub oczekująca subskrypcja nie jest aktywnym kanałem.");
assert.deepEqual(notificationPrimerDecision({ ...activePlayer, installedAndroidApp: true, busy: true }), {
  show: false, retry: true, reason: "temporarily-blocked"
}, "Zajęty klient powinien jedynie odroczyć popup.");
assert.equal(notificationPrimerDecision({ ...activePlayer, permission: "denied" }).show, false,
  "Zwykła strona nie powinna zapętlać instrukcji po trwałej odmowie.");
assert.equal(notificationPrimerDecision({ ...activePlayer, recentlyDismissed: true }).show, false,
  "Dotychczasowy cooldown zwykłej strony powinien pozostać aktywny.");
assert.equal(notificationPrimerDecision({ ...activePlayer, installedAndroidApp: true, userReady: false }).show, false,
  "Gość nie może rejestrować subskrypcji backendowej.");
assert.equal(notificationPrimerDecision({ ...activePlayer, installedAndroidApp: true, participantReady: false }).show, false,
  "Gracz w poczekalni nie może jeszcze włączać push.");

console.log("Popup powiadomień: polityka APK/PWA Android działa poprawnie.");
