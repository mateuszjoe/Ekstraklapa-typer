const CACHE_NAME = "ekstraklasa-typer-v20";
const OFFLINE_ASSETS = [
  "./",
  "./styles.css?v=19",
  "./app.js?v=19",
  "./data.js",
  "./firebase-config.js",
  "./live-provider.js",
  "./manifest.webmanifest?v=15",
  "./assets/fonts/manrope-latin.woff2",
  "./assets/fonts/manrope-latin-ext.woff2",
  "./assets/fonts/space-grotesk-latin.woff2",
  "./assets/fonts/space-grotesk-latin-ext.woff2",
  "./assets/brand/app-icon-192.png?v=14",
  "./assets/brand/app-icon-512.png?v=14",
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
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.pathname.startsWith("/api/") || requestUrl.pathname.endsWith(".apk")) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
