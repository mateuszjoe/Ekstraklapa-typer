const CACHE_NAME = "ekstraklasa-typer-v29";
const PUSH_STATE_CACHE = "ekstraklasa-typer-push-state-v1";
const PUSH_STATE_URL = new URL("./__chat-push-state__", self.registration.scope).href;
const VAPID_PUBLIC_KEY = "BHxWAMhHw3KJBpTqgJZK38Kr-fPA_dvKIYurfBjxTfuw9ie4D9I0cpYR8S9-5FEmzDYoLoBwdutcR_kLW7cADd0";
const ROTATE_PUSH_URL = "https://ekstraklapa-typer-notifications.mateuszjoe.workers.dev/api/push/rotate";
const ROTATE_PUSH_SYNC_TAG = "ekstraklapa-typer-rotate-chat-push";
const MAX_ROTATION_RETRIES = 4;
const OFFLINE_ASSETS = [
  "./",
  "./?app=typer-v2",
  "./styles.css?v=24",
  "./app.js?v=28",
  "./data.js",
  "./firebase-config.js",
  "./live-provider.js",
  "./league-provider.js",
  "./manifest.webmanifest?v=18",
  "./assets/fonts/manrope-latin.woff2",
  "./assets/fonts/manrope-latin-ext.woff2",
  "./assets/fonts/space-grotesk-latin.woff2",
  "./assets/fonts/space-grotesk-latin-ext.woff2",
  "./assets/brand/app-icon-192.png?v=14",
  "./assets/brand/app-icon-512.png?v=14",
  "./assets/brand/app-icon-maskable-192.png?v=1",
  "./assets/brand/app-icon-maskable-512.png?v=1",
  "./assets/brand/apple-touch-icon.png?v=14",
  "./assets/brand/favicon-32.png?v=14",
  "./assets/brand/logo-horizontal.png",
  "./assets/brand/logo-compact.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys
      .filter((key) => key.startsWith("ekstraklasa-typer-v") && key !== CACHE_NAME)
      .map((key) => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.pathname.startsWith("/api/") || requestUrl.pathname.endsWith(".apk")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(async () => (
      await caches.match(event.request)
      || await caches.match(new URL("./", self.registration.scope).href)
      || Response.error()
    )));
    return;
  }
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

const NOTIFICATION_TYPES = Object.freeze({
  "chat-message": Object.freeze({
    title: "Nowa wiadomość w szatni",
    body: "Otwórz Typera, aby przeczytać wiadomość.",
    url: "./?chat=open#matches",
    idFields: ["messageId"]
  }),
  "matchday-reminder": Object.freeze({
    title: "Nadchodzi kolejka Ekstraklasy",
    body: "Sprawdź mecze i oddaj typy przed pierwszym gwizdkiem.",
    url: "./#matches",
    idFields: ["matchday", "roundId", "matchdayId"]
  }),
  "player-joined": Object.freeze({
    title: "Nowy gracz dołączył do Typera",
    body: "Zajrzyj do rankingu i przywitaj nowego rywala.",
    url: "./#ranking",
    idFields: ["playerUid", "playerId", "uid"]
  }),
  "match-result": Object.freeze({
    title: "Mecz zakończony",
    body: "Sprawdź wynik meczu i punkt za swój typ.",
    url: "./#matches",
    idFields: ["matchId"]
  }),
  "matchday-summary": Object.freeze({
    title: "Podsumowanie kolejki",
    body: "Zobacz zdobyte punkty i swoją pozycję w rankingu.",
    url: "./#ranking",
    idFields: ["matchday", "roundId", "matchdayId"]
  }),
  "lineup-published": Object.freeze({
    title: "Składy zostały podane",
    body: "Sprawdź wyjściowe jedenastki przed pierwszym gwizdkiem.",
    url: "./#ekstraklasa",
    idFields: ["localMatchId", "matchId", "providerMatchId"]
  })
});

function safeNotificationText(value, fallback, maxLength) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, maxLength);
}

function safeNotificationId(value, fallback = "new") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function notificationTarget(value, defaultValue = "./#matches") {
  const scope = new URL(self.registration.scope);
  const fallback = new URL(defaultValue, scope).href;
  try {
    const candidate = new URL(value || fallback, scope);
    const isInScope = candidate.origin === scope.origin && candidate.pathname.startsWith(scope.pathname);
    return isInScope && ["http:", "https:"].includes(candidate.protocol) ? candidate.href : fallback;
  } catch {
    return fallback;
  }
}

function notificationIdentity(payload, type, config) {
  const field = config.idFields.find((name) => payload[name] !== undefined && payload[name] !== null);
  const value = field ? payload[field] : payload.notificationId ?? payload.id;
  return safeNotificationId(value, `${type}-new`);
}

async function readPushState() {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const response = await cache.match(PUSH_STATE_URL);
    const value = response ? await response.json() : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function withPushStateLock(operation) {
  if (self.navigator?.locks?.request) {
    return self.navigator.locks.request("ekstraklapa-typer-chat-push-state", { mode: "exclusive" }, operation);
  }
  return operation();
}

async function writePushStateUnlocked(patch) {
  const cache = await caches.open(PUSH_STATE_CACHE);
  const previous = await readPushState();
  await cache.put(PUSH_STATE_URL, new Response(JSON.stringify({
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString()
  }), { headers: { "content-type": "application/json; charset=utf-8" } }));
}

function webPushKeyBytes(value = VAPID_PUBLIC_KEY) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob(`${value}${padding}`.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function subscriptionPayload(subscription) {
  const value = subscription?.toJSON?.();
  if (!value?.endpoint || !value?.keys?.p256dh || !value?.keys?.auth) throw new Error("Niepełna subskrypcja push.");
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

async function rotateStoredPushSubscription(oldEndpointOverride = "", nextSubscriptionOverride = null) {
  return withPushStateLock(async () => {
    const pushState = await readPushState();
    if (pushState.muted !== false) return { status: "muted" };
    const oldEndpoint = oldEndpointOverride || pushState.endpoint || "";
    const rotationToken = typeof pushState.rotationToken === "string" ? pushState.rotationToken : "";
    if (!oldEndpoint || !/^[A-Za-z0-9_-]{43}$/.test(rotationToken)) {
      await writePushStateUnlocked({ needsSync: true });
      throw new Error("Brakuje lokalnych danych rotacji push.");
    }
    const nextSubscription = nextSubscriptionOverride
      || await self.registration.pushManager.getSubscription()
      || await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: webPushKeyBytes()
      });
    const response = await fetch(ROTATE_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        oldEndpoint,
        subscription: subscriptionPayload(nextSubscription),
        rotationToken
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.error || result?.status !== "rotated") {
      throw new Error("Backend odrzucił rotację subskrypcji push.");
    }
    const nextRotationToken = /^[A-Za-z0-9_-]{43}$/.test(result.rotationToken || "")
      ? result.rotationToken
      : rotationToken;
    const latestState = await readPushState();
    if (latestState.muted !== false || latestState.rotationToken !== rotationToken) {
      await nextSubscription.unsubscribe().catch(() => {});
      return { status: "cancelled" };
    }
    await writePushStateUnlocked({
      endpoint: nextSubscription.endpoint,
      rotationToken: nextRotationToken,
      needsSync: false,
      rotationAttempts: 0
    });
    return { status: "rotated" };
  });
}

async function schedulePushRotationRetry() {
  if (self.registration.sync?.register) {
    await self.registration.sync.register(ROTATE_PUSH_SYNC_TAG);
  }
}

async function recordPushRotationFailure() {
  return withPushStateLock(async () => {
    const state = await readPushState();
    const attempts = Math.min(MAX_ROTATION_RETRIES, (Number(state.rotationAttempts) || 0) + 1);
    await writePushStateUnlocked({ needsSync: true, rotationAttempts: attempts });
    return attempts;
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const pushState = await readPushState();
    if (pushState.muted !== false) return;
    let payload = {};
    try {
      payload = event.data?.json?.() || {};
    } catch {
      try {
        payload = JSON.parse(event.data?.text?.() || "{}");
      } catch {
        payload = {};
      }
    }
    const type = safeNotificationId(payload.type, "");
    const config = NOTIFICATION_TYPES[type];
    if (!config) return;
    const notificationId = notificationIdentity(payload, type, config);
    const targetUrl = notificationTarget(payload.url, config.url);
    await self.registration.showNotification(safeNotificationText(payload.title, config.title, 80), {
      body: safeNotificationText(payload.body, config.body, 180),
      icon: new URL("./assets/brand/app-icon-192.png?v=14", self.registration.scope).href,
      badge: new URL("./assets/brand/favicon-32.png?v=14", self.registration.scope).href,
      tag: `${type}-${notificationId}`,
      renotify: Boolean(payload.renotify),
      vibrate: [140, 60, 140],
      timestamp: Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now(),
      data: { url: targetUrl, type, notificationId }
    });
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(rotateStoredPushSubscription(
    event.oldSubscription?.endpoint || "",
    event.newSubscription || null
  ).catch(async (error) => {
    console.warn("Nie udało się automatycznie odnowić subskrypcji push:", error);
    const attempts = await recordPushRotationFailure().catch(() => MAX_ROTATION_RETRIES);
    if (attempts < MAX_ROTATION_RETRIES) await schedulePushRotationRetry().catch(() => {});
  }));
});

self.addEventListener("sync", (event) => {
  if (event.tag !== ROTATE_PUSH_SYNC_TAG) return;
  event.waitUntil(rotateStoredPushSubscription().catch(async (error) => {
    const attempts = await recordPushRotationFailure().catch(() => MAX_ROTATION_RETRIES);
    if (attempts < MAX_ROTATION_RETRIES) throw error;
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = notificationTarget(event.notification.data?.url);
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.navigate(targetUrl);
      return existing.focus();
    }
    return clients.openWindow(targetUrl);
  }));
});
