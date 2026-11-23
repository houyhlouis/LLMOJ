// A headless Chrome or Chromium for browser tests, driven through the DevTools protocol (the same approach as
// deploy/test/service-worker-retirement.test.mjs). LLMOJ_TEST_CHROME names the browser, or google-chrome or chromium
// on PATH; without one, `chrome` is null and the tests skip.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function findChrome() {
  if (process.env.LLMOJ_TEST_CHROME) return process.env.LLMOJ_TEST_CHROME;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0) return found.stdout.trim();
  }
  return null;
}
const chrome = findChrome();
const skip = !chrome && "needs Chrome or Chromium (LLMOJ_TEST_CHROME, or google-chrome or chromium on PATH)";

const REQUEST_TIMEOUT = 30000;

async function bounded(work, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Starts the browser for test `t`; it's closed (with its profile deleted) when the test ends. */
async function launchChrome(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-browser-test-"));
  const grouped = process.platform !== "win32";
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "about:blank"
  ];
  // A wrapper and Chrome's descendants share this process group
  const browser = spawn(chrome, args, {
    detached: grouped,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, XDG_CONFIG_HOME: path.join(profile, "config"), XDG_CACHE_HOME: path.join(profile, "cache") }
  });
  const exited = new Promise(resolve => {
    browser.once("exit", resolve);
    browser.once("error", resolve);
  });
  let socket,
    fatal = null;
  const pending = new Map();
  const listeners = new Set();
  const fail = error => {
    fatal ||= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  t.after(async () => {
    fail(new Error("Browser closed"));
    try {
      socket?.close();
    } catch {
      // A connection still opening may already be gone
    }
    try {
      if (Number.isInteger(browser.pid) && browser.pid > 0) {
        if (grouped) process.kill(-browser.pid, "SIGKILL");
        else browser.kill("SIGKILL");
      }
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    } finally {
      browser.stderr.destroy();
      try {
        await bounded(exited, 5000, "Chrome exit");
      } finally {
        browser.unref();
        await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      }
    }
  });
  const endpoint = await bounded(
    new Promise((resolve, reject) => {
      let output = "";
      browser.stderr.on("data", chunk => {
        output = (output + chunk).slice(-16384);
        const listening = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (listening) resolve(listening[1]);
      });
      browser.once("error", reject);
      browser.once("exit", (code, signal) => reject(new Error(`${chrome} exited (${code ?? signal}): ${output}`)));
    }),
    60000,
    "Chrome startup"
  );
  socket = new WebSocket(endpoint);
  await bounded(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
    }),
    REQUEST_TIMEOUT,
    "DevTools connection"
  );
  socket.addEventListener("close", () => fail(new Error("DevTools socket closed")));
  let lastId = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`${message.error.message} ${message.error.data || ""}`));
      else request.resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) => {
    if (fatal) return Promise.reject(fatal);
    const id = ++lastId;
    return bounded(
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
      REQUEST_TIMEOUT,
      `DevTools ${method}`
    );
  };

  /** A new tab: `open` navigates and waits for the load, `evaluate` runs an expression and returns its value. */
  async function newTab() {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
    const tab = {
      async open(url) {
        let loaderId;
        const seen = new Set();
        let resolveLoaded;
        const loaded = new Promise(resolve => (resolveLoaded = resolve));
        const listener = message => {
          if (message.sessionId !== sessionId || message.method !== "Page.lifecycleEvent") return;
          if (message.params.name !== "load") return;
          seen.add(message.params.loaderId);
          if (loaderId && seen.has(loaderId)) resolveLoaded();
        };
        listeners.add(listener);
        try {
          const navigation = await send("Page.navigate", { url }, sessionId);
          if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
          loaderId = navigation.loaderId;
          if (!loaderId || seen.has(loaderId)) resolveLoaded();
          await bounded(loaded, 60000, `Navigation to ${url}`);
        } finally {
          listeners.delete(listener);
        }
      },
      async evaluate(expression) {
        const { result, exceptionDetails } = await send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          sessionId
        );
        if (exceptionDetails)
          throw new Error(`${expression}: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
        return result.value;
      },
      /** Waits until `expression` (evaluated again across reloads, which destroy the page's context) is `expected` */
      async until(expression, expected, timeout = 30000) {
        const deadline = Date.now() + timeout;
        let value, error;
        while (Date.now() < deadline) {
          try {
            value = await tab.evaluate(expression);
            error = null;
            if (JSON.stringify(value) === JSON.stringify(expected)) return value;
          } catch (caught) {
            error = caught;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(
          `${expression}: still ${JSON.stringify(value)} after ${timeout} ms${error ? ` (${error.message})` : ""}`
        );
      }
    };
    return tab;
  }
  return { newTab };
}

module.exports = { chrome, skip, launchChrome };
