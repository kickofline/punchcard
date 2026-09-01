/* punchcard service worker: makes the app shell available offline so manual
   punch entry and totals work with no signal. The reader (/api/read) always
   goes to the network. */

const CACHE = "punchcard-v3";

const SHELL = [
  "/",
  "/index.html",
  "/app.mjs",
  "/lib.mjs",
  "/styles.css",
  "/manifest.webmanifest",
  "/vendor/preact.mjs",
  "/vendor/hooks.mjs",
  "/vendor/htm.mjs",
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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // /api/read POST goes straight to the network

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api/read") return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return resp;
      });
    })
  );
});
