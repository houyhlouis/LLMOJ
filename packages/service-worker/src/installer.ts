/// <reference no-default-lib="true" />
/// <reference lib="es2020" />
/// <reference lib="DOM" />

// The bootstrap page no longer installs a service worker (review 4.5). It removes the one earlier versions installed,
// with its cache, in case the browser has not yet replaced it with ../retire-service-worker.js.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (const registration of registrations) {
      const worker = registration.active || registration.waiting || registration.installing;
      if (worker && new URL(worker.scriptURL).pathname === "/sw.js") registration.unregister();
    }
  });
  if ("caches" in window) caches.delete("bootstrap");
}
