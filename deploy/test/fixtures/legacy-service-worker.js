// Test fixture: the service worker that LibreOJ's bootstrap installed before LLMOJ Part 24
// (packages/service-worker/src/service-worker.ts at commit 9dd1bf1), compiled to JavaScript unchanged.
// Browsers may still have it; deploy/test/service-worker-retirement.test.mjs checks that the site removes it.
"use strict";
const sw = self;
const bootstrapCdnRoot = "https://" + new URL(sw.location.href).searchParams.get("o");
if (!Promise.any) {
    Promise.any = (promises) => {
        return Promise.all([...promises].map(promise => {
            return new Promise((resolve, reject) => Promise.resolve(promise)
                // When a promise fulfilled, we call reject to bail out Promise.all
                // When a promise rejected, we call resolve to continue Promise.all
                .then(reject, resolve));
        })).then(
        // The resolved are actually aggregated errors
        errors => Promise.reject(errors),
        // The reject is the first fulfilled promise (which causes the bail out)
        fastest => Promise.resolve(fastest));
    };
}
sw.addEventListener("install", event => {
    event.waitUntil(sw.skipWaiting());
});
sw.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || url.origin !== sw.origin) {
        return;
    }
    if (!url.pathname.endsWith(".js"))
        url.pathname = "/";
    url.search = "";
    url.hash = "";
    const abortEvent = new Event("abortFetch");
    const eventTarget = new EventTarget();
    const withAbort = (fetchWithSignal) => {
        // Abort other doFetch()-es when the first doFetch() resolved with true
        const abortController = typeof AbortController === "function" && new AbortController();
        // When the abort event triggered, don't abort the current fetch() if `fetchSucceed` is true
        let fetchSucceed = false;
        if (abortController) {
            eventTarget.addEventListener(abortEvent.type, () => {
                if (!fetchSucceed)
                    abortController.abort();
            });
        }
        const doFetch = fetchWithSignal(abortController ? abortController.signal : undefined);
        return async (...args) => {
            const response = await doFetch(...args);
            if (response) {
                // Abort other fetch()-es
                fetchSucceed = true;
                eventTarget.dispatchEvent(abortEvent);
                return response;
            }
        };
    };
    const fetchOrigin = withAbort(signal => async () => {
        const resp = await fetch(event.request, { signal });
        return resp;
    });
    const fetchRedirected = withAbort(signal => async () => {
        // Intercept the request of main HTML page and service worker script
        const newUrl = new URL(bootstrapCdnRoot);
        if (newUrl.origin === url.origin)
            throw null;
        const fetchOptions = {
            redirect: "follow",
            signal
        };
        let response = await fetch(newUrl, fetchOptions);
        if (!response.ok) {
            // Oops! the service worker CDN may not available now
            // Fallback to the original URL
            // This error won't be used, just to indicate the fetch failed
            throw null;
        }
        return response;
    });
    event.respondWith((async () => {
        // stale-while-revalidate
        const SWR_MAXTIME = 7 * 24 * 60 * 60 * 1000;
        const cache = await caches.open("bootstrap");
        const newResponse = Promise.any([fetchOrigin(), fetchRedirected()]).then(async (newResponse) => {
            await cache.put(url, newResponse.clone());
            return newResponse;
        });
        const cachedResponse = await cache.match(url);
        // If cache found and valid
        if (cachedResponse && Date.now() - Date.parse(cachedResponse.headers.get("Date")) <= SWR_MAXTIME) {
            event.waitUntil(newResponse);
            return cachedResponse;
        }
        else {
            return newResponse;
        }
    })());
});
