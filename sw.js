const CACHE_NAME = "ekstraklasa-typer-v5";
const OFFLINE_ASSETS = [
  "./",
  "./styles.css?v=5",
  "./manifest.webmanifest?v=5",
  "./assets/fonts/manrope-latin.woff2",
  "./assets/fonts/manrope-latin-ext.woff2",
  "./assets/fonts/space-grotesk-latin.woff2",
  "./assets/fonts/space-grotesk-latin-ext.woff2",
  "./assets/brand/app-icon-192.png?v=5",
  "./assets/brand/app-icon-512.png?v=5",
  "./assets/brand/apple-touch-icon.png?v=5",
  "./assets/brand/favicon-32.png?v=5",
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
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
