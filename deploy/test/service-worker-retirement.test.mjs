/*
 * The site removes the service worker that LibreOJ's bootstrap used to install (review 4.5), checked in a browser.
 * A page installs the old worker (fixtures/legacy-service-worker.js), which is first shown serving an API response
 * as the home page; the site then serves what deployments publish now, and the browser must drop the worker and its
 * cache. Runs Chrome or Chromium through the DevTools protocol: LLMOJ_TEST_CHROME, or google-chrome or chromium on
 * PATH. Skipped without one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const legacyWorker = read('deploy/test/fixtures/legacy-service-worker.js');
const retiringWorker = read('packages/service-worker/retire-service-worker.js');
// The bootstrap page's script; it has no TypeScript syntax, so a page can run it as it is.
const bootstrapInstaller = read('packages/service-worker/src/installer.ts');
const PRIVATE = JSON.stringify({ username: 'alice', email: 'alice@example.test', note: 'private' });

function findChrome() {
  if (process.env.LLMOJ_TEST_CHROME) return process.env.LLMOJ_TEST_CHROME;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0) return found.stdout.trim();
  }
  return null;
}
const chrome = findChrome();
const skip = !chrome && 'needs Chrome or Chromium (LLMOJ_TEST_CHROME, or google-chrome or chromium on PATH)';

const START_TIMEOUT = 60000;
const REQUEST_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 60000;
const CONDITION_TIMEOUT = 60000;

async function bounded(work, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Per-test cleanup also runs on timeout/startup failure. Report the original error before any teardown waits.
function browserTest(name, work) {
  test(name, { skip, timeout: 180000 }, async t => {
    const cleanups = [];
    const cleanupErrors = [];
    let closing;
    const close = () => closing ||= (async () => {
      for (const cleanup of cleanups.reverse()) {
        try { await bounded(Promise.resolve().then(cleanup), 5000, 'Browser fixture cleanup'); }
        catch (error) { cleanupErrors.push(error); process.stderr.write(`[${name}] cleanup: ${error.stack || error}\n`); }
      }
    })();
    const abort = () => {
      process.stderr.write(`[${name}] test aborted: ${t.signal.reason}\n`);
      void close();
    };
    t.signal.addEventListener('abort', abort, { once: true });
    t.after(close);
    let failed = false;
    try {
      await work({ addCleanup: cleanup => cleanups.push(cleanup), signal: t.signal });
    } catch (error) {
      failed = true;
      process.stderr.write(`[${name}] ${error.stack || error}\n`);
      throw error;
    } finally {
      await close();
      t.signal.removeEventListener('abort', abort);
      if (!failed && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Browser cleanup failed');
    }
  });
}

// A site on its own origin (127.0.0.1 and a port), whose pages and /sw.js depend on `phase`.
async function startSite(fixture, pages) {
  if (fixture.signal.aborted) throw new Error('Browser fixture aborted');
  const site = { phase: 'legacy', apiRequests: 0, pageRequests: 0, signal: fixture.signal };
  const connections = new Set();
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://site');
    const send = (type, body, headers = {}) => {
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
      response.end(body);
    };
    if (pathname === '/sw.js') send('text/javascript', pages[site.phase].worker);
    else if (pathname === '/api/private') {
      site.apiRequests++;
      send('application/json', PRIVATE);
    } else if (pathname === '/') {
      site.pageRequests++;
      send('text/html', `<!doctype html><title>Site</title><h1>Home page</h1>${pages[site.phase].script}`,
        { 'X-Test-Page': String(site.pageRequests) });
    } else { response.writeHead(404); response.end(); }
  });
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  fixture.addCleanup(async () => {
    // close() alone waits for active/keep-alive connections, including requests left by a failed browser.
    server.closeAllConnections();
    for (const socket of connections) socket.destroy();
    try { await bounded(new Promise(resolve => server.close(resolve)), 2000, 'HTTP server close'); }
    finally { server.unref(); }
  });
  await bounded(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }), REQUEST_TIMEOUT, 'HTTP server listen');
  site.url = `http://127.0.0.1:${server.address().port}`;
  return site;
}

// The legacy bootstrap page's CDN host is unreachable (https on this HTTP port).
const legacyPage = { worker: legacyWorker, script: '<script>navigator.serviceWorker.register("/sw.js?o=" + location.host)</script>' };

async function launch(fixture) {
  if (fixture.signal.aborted) throw new Error('Browser fixture aborted');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-service-worker-test-'));
  const grouped = process.platform !== 'win32';
  const args = ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-breakpad', '--disable-crash-reporter', 'about:blank'];
  // A wrapper and Chrome's descendants inherit this dedicated process group.
  const browser = spawn(chrome, args, { detached: grouped, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_CACHE_HOME: path.join(profile, 'cache') } });
  const exited = new Promise(resolve => { browser.once('exit', resolve); browser.once('error', resolve); });
  let socket, closed = false, fatal;
  const pending = new Map();
  const listeners = new Set();
  const events = new Set();
  const rejectAll = error => {
    fatal = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const event of events) event.reject(error);
    events.clear(); listeners.clear();
  };
  fixture.addCleanup(async () => {
    closed = true;
    rejectAll(new Error('Browser fixture closed'));
    try { socket?.close(); } catch { /* A connection still opening may already be aborted. */ }
    try {
      if (Number.isInteger(browser.pid) && browser.pid > 0) {
        if (grouped) process.kill(-browser.pid, 'SIGKILL');
        else browser.kill('SIGKILL');
      }
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
    finally {
      // Descendants can otherwise keep the parent's stderr pipe open after the main process dies.
      browser.stderr.destroy();
      try { await bounded(exited, 2000, 'Chrome exit'); }
      finally {
        browser.unref();
        await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      }
    }
  });
  const endpoint = await bounded(new Promise((resolve, reject) => {
    let output = '';
    browser.stderr.on('data', chunk => {
      output = (output + chunk).slice(-16384);
      const listening = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (listening) resolve(listening[1]);
    });
    browser.once('error', reject);
    browser.once('exit', (code, signal) => {
      const error = new Error(`${chrome} exited (${code ?? signal}): ${output}`);
      reject(error);
      if (!closed) rejectAll(error);
    });
  }), START_TIMEOUT, 'Chrome startup');

  socket = new WebSocket(endpoint);
  socket.onclose = () => rejectAll(new Error('DevTools socket closed'));
  socket.onerror = () => rejectAll(new Error('DevTools socket failed'));
  await bounded(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('DevTools connection failed')), { once: true });
    socket.addEventListener('close', () => reject(new Error('DevTools connection closed')), { once: true });
  }), REQUEST_TIMEOUT, 'DevTools connection');
  let lastId = 0;
  socket.onmessage = ({ data }) => {
    try {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        if (message.error) request.reject(new Error(`${message.error.message} ${message.error.data || ''}`));
        else request.resolve(message.result);
      } else for (const listener of listeners) listener(message);
    } catch (error) { rejectAll(error); }
  };
  const checkActive = () => {
    if (fatal || closed || fixture.signal.aborted) throw fatal || new Error('Browser fixture aborted');
  };
  const send = async (method, params = {}, sessionId) => {
    checkActive();
    const id = ++lastId;
    try {
      return await bounded(new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }), REQUEST_TIMEOUT, `DevTools ${method}`);
    } finally { pending.delete(id); }
  };

  return async function newTab() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId);
    return {
      checkActive,
      async open(url) {
        let loaderId;
        const seen = new Set();
        let event;
        const loaded = new Promise((resolve, reject) => { event = { resolve, reject }; });
        // Prevent a close during Page.navigate from becoming an unhandled rejection before we await loaded.
        loaded.catch(() => {});
        const listener = message => {
          if (message.sessionId === sessionId && message.method === 'Page.lifecycleEvent' && message.params.name === 'load') {
            seen.add(message.params.loaderId);
            if (loaderId && seen.has(loaderId)) event.resolve();
          }
        };
        listeners.add(listener); events.add(event);
        try {
          const navigation = await send('Page.navigate', { url }, sessionId);
          if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
          loaderId = navigation.loaderId;
          if (!loaderId || seen.has(loaderId)) event.resolve();
          await bounded(loaded, NAVIGATION_TIMEOUT, `Navigation to ${url}`);
        } finally { listeners.delete(listener); events.delete(event); }
      },
      async evaluate(expression) {
        const { result, exceptionDetails } = await send('Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
        return result.value;
      }
    };
  };
}

async function until(read, expected, what, timeout = CONDITION_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (value === expected) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail(`${what}: still ${JSON.stringify(value)} after ${timeout} ms`);
}

// A navigation's stale-while-revalidate fetch must finish before the next operation can overwrite its cache entry.
async function pageRefreshed(tab, site, previousRequests) {
  await until(async () => {
    tab.checkActive();
    return site.pageRequests > previousRequests;
  }, true, 'background home request');
  await until(() => tab.evaluate('caches.match("/", {cacheName:"bootstrap"}).then(r => r && r.headers.get("X-Test-Page"))'),
    String(site.pageRequests), 'background home response cached');
}

const registrations = 'navigator.serviceWorker.getRegistrations().then(list => list.length)';
const bootstrapCache = 'caches.has("bootstrap")';
const cachedHome = 'caches.match("/", {cacheName:"bootstrap"}).then(response => response && response.text())';
const fetchPrivate = 'fetch("/api/private").then(response => response.text())';

// The old worker installed and controlling the page, and shown doing harm: it answers an API request with the home
// page it cached, stores the API's answer as the home page, and shows that as the home page afterwards.
async function installLegacyWorker(tab, site) {
  await tab.open(`${site.url}/`);
  const state = 'Promise.race([navigator.serviceWorker.ready.then(r => r.active.state), new Promise(r => setTimeout(r, 2000))])';
  await until(() => tab.evaluate(state), 'activated', 'the old worker');
  let previousRequests = site.pageRequests;
  await tab.open(`${site.url}/`);
  await pageRefreshed(tab, site, previousRequests);
  assert.equal(await tab.evaluate('!!navigator.serviceWorker.controller'), true, 'the old worker controls the page');
  assert.match(await tab.evaluate(fetchPrivate), /<h1>Home page<\/h1>/, 'the API request gets the home page');
  await until(() => tab.evaluate(cachedHome), PRIVATE, 'the API response cached as the home page');
  previousRequests = site.pageRequests;
  await tab.open(`${site.url}/`);
  assert.equal(await tab.evaluate('document.body.innerText.includes("alice@example.test")'), true, 'shown as the home page');
  await pageRefreshed(tab, site, previousRequests);
}

browserTest('a browser drops the old worker and its cache when it next opens the site', async fixture => {
  const newTab = await launch(fixture);
  // What deploy/build-frontend-offline.mjs publishes: a page without a worker, and the retiring /sw.js
  const site = await startSite(fixture, { legacy: legacyPage, current: { worker: retiringWorker, script: '' } });
  const tab = await newTab();
  await installLegacyWorker(tab, site);

  site.phase = 'current';
  // The old worker still answers this navigation, but the browser checks its script and gets the retiring one.
  await tab.open(`${site.url}/`);
  await until(() => tab.evaluate(registrations), 0, 'service worker registrations');
  await until(() => tab.evaluate(bootstrapCache), false, 'the old cache');
  await tab.open(`${site.url}/`);
  assert.equal(await tab.evaluate('document.querySelector("h1")?.textContent'), 'Home page', 'the real home page');
  assert.equal(await tab.evaluate('!!navigator.serviceWorker.controller'), false);
  const before = site.apiRequests;
  assert.equal(await tab.evaluate(fetchPrivate), PRIVATE);
  assert.equal(site.apiRequests, before + 1, 'from the network');
  assert.equal(await tab.evaluate(bootstrapCache), false, 'nothing is cached again');
});

browserTest('the bootstrap page removes the old worker even before the browser replaces it', async fixture => {
  const newTab = await launch(fixture);
  // The old /sw.js stays, as on a server where only the page has been updated
  const site = await startSite(fixture, { legacy: legacyPage, current: { worker: legacyWorker, script: `<script>${bootstrapInstaller}</script>` } });
  const tab = await newTab();
  await installLegacyWorker(tab, site);

  site.phase = 'current';
  // Wait for the first visit's background fetch before the second visit consumes the updated page.
  const previousRequests = site.pageRequests;
  await tab.open(`${site.url}/`);
  await pageRefreshed(tab, site, previousRequests);
  await tab.open(`${site.url}/`);
  await until(() => tab.evaluate(registrations), 0, 'service worker registrations');
  await until(() => tab.evaluate(bootstrapCache), false, 'the old cache');
  await tab.open(`${site.url}/`);
  assert.equal(await tab.evaluate('document.querySelector("h1")?.textContent'), 'Home page');
  assert.equal(await tab.evaluate('!!navigator.serviceWorker.controller'), false);
});
