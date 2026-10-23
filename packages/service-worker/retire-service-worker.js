// The site's /sw.js: it removes the service worker that LibreOJ's bootstrap used to install (review 4.5).
//
// That worker was made for a bootstrap origin serving nothing but the page. It answered every same-origin GET that
// was not a .js file with the home page's cache entry and stored whatever came back there, so on a site that also
// serves the API and downloads it could show an API response, or someone's file, as the home page. No deployment of
// this site installs it any more. Browsers that still have it fetch this script when they next open the site (a
// service worker's script is checked on every navigation); it then takes over, unregisters itself and deletes the
// old cache. It has no fetch handler, so requests go to the network meanwhile.
//
// deploy/build-frontend-offline.mjs publishes this file as /sw.js; the bootstrap packages bundle it as theirs.
// deploy/test/service-worker-retirement.test.mjs checks it in a browser.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event =>
  event.waitUntil(Promise.all([self.registration.unregister(), caches.delete("bootstrap")]))
);
