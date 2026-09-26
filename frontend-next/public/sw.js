// Minimal service worker - exists to satisfy PWA installability, not to run
// an offline app. Alert/incident data is live and changes every pipeline
// run, so caching it would show stale incidents after a page reload -
// worse than no offline support at all. Network-first, no cache writes.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Intentionally not calling event.respondWith() - every request passes
  // straight through to the network unchanged.
});
