/* punchcard service worker: makes the app shell available offline so manual
   punch entry and totals work with no signal. The reader (/api/read) always
   goes to the network. */

const CACHE = "punchcard-v7";

const SHELL = [
  "/",
  "/index.html",
  "/app.mjs",
  "/lib.mjs",
  "/scan.mjs",
  "/styles.css",
  "/manifest.webmanifest",
  "/vendor/preact.mjs",
  "/vendor/hooks.mjs",
  "/vendor/htm.mjs",
  "/fonts/archivo.woff2",
  "/sample-card.jpg",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Network-first for everything same-origin: online visitors always get the
   deployed version, offline visitors fall back to the last good copy (and the
   app shell for navigations). Only /api/read is left entirely alone. */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api/read") return;

  event.respondWith(
    fetch(request)
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit || caches.match("/index.html"))
      )
  );
});
