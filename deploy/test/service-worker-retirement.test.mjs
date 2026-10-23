/*
 * The site removes the service worker that LibreOJ's bootstrap used to install (review 4.5), checked in a browser.
 * A page installs the old worker (fixtures/legacy-service-worker.js), which is first shown serving an API response
 * as the home page; the site then serves what deployments publish now, and the browser must drop the worker and its
 * cache. Runs Chrome or Chromium through the DevTools protocol: LLMOJ_TEST_CHROME, or google-chrome or chromium on
 * PATH. Skipped without one.
 */
import { test, after } from 'node:test';
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

// A site on its own origin (127.0.0.1 and a port), whose pages and /sw.js depend on `phase`.
async function startSite(pages) {
  const site = { phase: 'legacy', apiRequests: 0 };
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://site');
    const send = (type, body) => {
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(body);
    };
    if (pathname === '/sw.js') send('text/javascript', pages[site.phase].worker);
    else if (pathname === '/api/private') {
      site.apiRequests++;
      send('application/json', PRIVATE);
    } else if (pathname === '/') send('text/html', `<!doctype html><title>Site</title><h1>Home page</h1>${pages[site.phase].script}`);
    else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  site.url = `http://127.0.0.1:${server.address().port}`;
  return site;
}

// The legacy bootstrap page registered the worker with its CDN host; here it is unreachable (https on this port).
const legacyPage = { worker: legacyWorker, script: '<script>navigator.serviceWorker.register("/sw.js?o=" + location.host)</script>' };

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-service-worker-test-'));
  // Without Chrome's sandbox, which many build machines cannot start: the browser opens only this test's pages.
  const args = ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank'];
  const browser = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  after(() => {
    browser.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`${chrome} did not start: ${output}`)), 30000);
    browser.stderr.on('data', chunk => {
      output += chunk;
      const listening = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (listening) {
        clearTimeout(timer);
        resolve(listening[1]);
      }
    });
    browser.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`${chrome} exited with ${code}: ${output}`));
    });
  });

  // A minimal DevTools protocol client
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  after(() => socket.close());
  let lastId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} ${message.error.data || ''}`));
      else resolve(message.result);
    } else for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}, sessionId) => {
    const id = ++lastId;
    socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  return async function newTab() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    return {
      async open(url) {
        const loaded = new Promise(resolve => {
          const listener = message => {
            if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
              listeners.delete(listener);
              resolve();
            }
          };
          listeners.add(listener);
        });
        await send('Page.navigate', { url }, sessionId);
        await loaded;
      },
      async evaluate(expression) {
        const { result, exceptionDetails } = await send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId
        );
        if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
        return result.value;
      }
    };
  };
}

async function until(read, expected, what, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (value === expected) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail(`${what}: still ${JSON.stringify(value)} after ${timeout} ms`);
}

const registrations = 'navigator.serviceWorker.getRegistrations().then(list => list.length)';
const bootstrapCache = 'caches.has("bootstrap")';
const cachedHome = 'caches.open("bootstrap").then(cache => cache.match("/")).then(response => response && response.text())';
const fetchPrivate = 'fetch("/api/private").then(response => response.text())';

// The old worker installed and controlling the page, and shown doing harm: it answers an API request with the home
// page it cached, stores the API's answer as the home page, and shows that as the home page afterwards.
async function installLegacyWorker(tab, site) {
  await tab.open(`${site.url}/`);
  const state = 'Promise.race([navigator.serviceWorker.ready.then(r => r.active.state), new Promise(r => setTimeout(r, 2000))])';
  await until(() => tab.evaluate(state), 'activated', 'the old worker');
  await tab.open(`${site.url}/`);
  assert.equal(await tab.evaluate('!!navigator.serviceWorker.controller'), true, 'the old worker controls the page');
  assert.match(await tab.evaluate(fetchPrivate), /<h1>Home page<\/h1>/, 'the API request gets the home page');
  await until(() => tab.evaluate(cachedHome), PRIVATE, 'the API response cached as the home page');
  await tab.open(`${site.url}/`);
  assert.equal(await tab.evaluate('document.body.innerText.includes("alice@example.test")'), true, 'shown as the home page');
}

test('a browser drops the old worker and its cache when it next opens the site', { skip, timeout: 120000 }, async () => {
  const newTab = await launch();
  // What deploy/build-frontend-offline.mjs publishes: a page without a worker, and the retiring /sw.js
  const site = await startSite({ legacy: legacyPage, current: { worker: retiringWorker, script: '' } });
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

test('the bootstrap page removes the old worker even before the browser replaces it', { skip, timeout: 120000 }, async () => {
  const newTab = await launch();
  // The old /sw.js stays, as on a server where only the page has been updated
  const site = await startSite({ legacy: legacyPage, current: { worker: legacyWorker, script: `<script>${bootstrapInstaller}</script>` } });
  const tab = await newTab();
  await installLegacyWorker(tab, site);

  site.phase = 'current';
  // The first visit gets the old worker's cached page, while it fetches the new one; the second runs the new page.
  await tab.open(`${site.url}/`);
  await tab.open(`${site.url}/`);
  await until(() => tab.evaluate(registrations), 0, 'service worker registrations');
  await until(() => tab.evaluate(bootstrapCache), false, 'the old cache');
  await tab.open(`${site.url}/`);
  assert.equal(await tab.evaluate('document.querySelector("h1")?.textContent'), 'Home page');
  assert.equal(await tab.evaluate('!!navigator.serviceWorker.controller'), false);
});
