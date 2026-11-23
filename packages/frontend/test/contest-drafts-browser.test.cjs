// Run with: node --test packages/frontend/test/contest-drafts-browser.test.cjs (needs Chrome or Chromium)
// Review 2026-11-20 RV-05, in a real browser: a contest draft's save still waiting when someone signs out, in this tab
// or another, or when another account signs in, must not bring the deleted draft back, while an ordinary reload, a
// login session that just ended, and deleting a draft keep behaving as before. The pages run the real
// utils/contestDrafts.ts (its draft session and the writer ContestProblemPage uses), with real timers, real reloads
// and pagehide, and real storage events between tabs. contest-drafts.test.cjs checks the page and the sign-out
// handler themselves.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const { skip, launchChrome } = require("./helpers/chrome.cjs");

const KEY = "llmoj.contestDraft.v1:";
const DRAFT = `${KEY}7:3:11:cpp`;

const draftsScript = (() => {
  const source = fs.readFileSync(path.join(__dirname, "../src/utils/contestDrafts.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  });
  return `(function () { const module = { exports: {} }; const exports = module.exports;\n${outputText}\nwindow.contestDrafts = module.exports; })();`;
})();

// A contest problem page, reduced to what its drafts do: initApp's session refresh for the signed-in account (none
// for a visitor), ContestProblemPage's owner and writer, and AppLayout's sign-out once the server has ended the session.
const pageHtml = `<!doctype html><meta charset="utf-8"><title>Contest problem</title>
<script src="/drafts.js"></script>
<script>
  const drafts = window.contestDrafts;
  const parameters = new URLSearchParams(location.search);
  const userId = parameters.has("user") ? Number(parameters.get("user")) : null;
  window.pageLoad = Math.random().toString(36).slice(2);
  window.results = [];
  if (userId !== null) drafts.keepOnlyDraftsOf(userId);
  const owner = userId === null ? null : { userId, contestId: 3, problemId: 11, session: drafts.currentDraftSession() };
  const writer = drafts.createDraftWriter(owner, result => window.results.push(result));
  window.typeCode = code => writer.keep("cpp", code, { std: "c++17" });
  window.discardDraft = () => writer.discard("cpp");
  window.signOut = () => {
    drafts.signOutDrafts();
    location.reload();
  };
  window.draftKeys = () => Object.keys(localStorage).filter(key => key.startsWith(${JSON.stringify(KEY)})).sort();
  window.draftCode = () => JSON.parse(localStorage.getItem(${JSON.stringify(DRAFT)}) || "null")?.code ?? null;
</script>`;

async function startSite(t) {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://site");
    const send = (type, body) => {
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      response.end(body);
    };
    if (pathname === "/drafts.js") send("text/javascript", draftsScript);
    else if (pathname === "/problem") send("text/html", pageHtml);
    else {
      response.writeHead(404);
      response.end();
    }
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const [site, browser] = await Promise.all([startSite(t), launchChrome(t)]);
  const open = async (user = 7) => {
    const tab = await browser.newTab();
    await tab.open(`${site}/problem${user == null ? "" : `?user=${user}`}`);
    return tab;
  };
  return { open, site };
}

// Wait for the page `tab` had to be replaced by a reload, and its scripts to have run
async function reloaded(tab, previousLoad) {
  await tab.until(
    `window.pageLoad !== ${JSON.stringify(previousLoad)} && typeof window.draftKeys === "function"`,
    true
  );
}

const options = { skip, timeout: 120000 };

test(
  "RV-05: signing out with a save still waiting: the reload's pagehide doesn't bring the draft back",
  options,
  async t => {
    const { open } = await fixture(t);
    const tab = await open();
    // An ordinary reload first: the waiting save is written when the page goes, and the reloaded page has it
    const first = await tab.evaluate("window.pageLoad");
    await tab.evaluate('typeCode("int main() { return 0; }"); location.reload()');
    await reloaded(tab, first);
    assert.equal(await tab.evaluate("draftCode()"), "int main() { return 0; }");
    // Typing, then signing out within the save delay: the sign-out deletes the drafts and reloads
    const second = await tab.evaluate("window.pageLoad");
    await tab.evaluate('typeCode("int main() { return 1; }"); signOut()');
    await reloaded(tab, second);
    assert.deepEqual(await tab.evaluate("draftKeys()"), []);
    // Long after the save delay, nothing has come back
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.deepEqual(await tab.evaluate("draftKeys()"), []);
  }
);

test(
  "RV-05: a sign-out in another tab ends this tab's waiting save; its late timer and pagehide write nothing",
  options,
  async t => {
    const { open } = await fixture(t);
    const tab = await open();
    const other = await open();
    await tab.evaluate('typeCode("from the first tab")');
    await other.evaluate("contestDrafts.signOutDrafts()");
    // The storage event reaches the first tab, whose writer drops the save and says so
    await tab.until("window.results.at(-1)", "ended");
    await new Promise(resolve => setTimeout(resolve, 1000));
    await tab.evaluate('typeCode("typed afterwards")');
    // Leaving the page (pagehide) after the save delay
    await new Promise(resolve => setTimeout(resolve, 700));
    await tab.open("about:blank");
    assert.deepEqual(await other.evaluate("draftKeys()"), []);
  }
);

test("RV-05: another account signing in, in another tab, ends the earlier account's pages", options, async t => {
  const { open } = await fixture(t);
  const tab = await open(7);
  // Another tab, whose session refresh then finds account 8 signed in, well within the first tab's save delay
  const other = await open(null);
  await tab.evaluate('typeCode("account 7")');
  await other.evaluate("contestDrafts.keepOnlyDraftsOf(8)");
  await tab.until("window.results.at(-1)", "ended");
  await new Promise(resolve => setTimeout(resolve, 1000));
  await tab.open("about:blank");
  assert.deepEqual(await other.evaluate("draftKeys()"), []);
  assert.equal(await other.evaluate(`localStorage.getItem(${JSON.stringify(DRAFT)})`), null);
});

test(
  "RV-05: a login session that ends without signing out keeps the drafts; deleting a draft keeps it deleted",
  options,
  async t => {
    const { open } = await fixture(t);
    const tab = await open(7);
    await tab.evaluate('typeCode("kept")');
    // Another tab's page loads for a visitor: the server ended the login session, nobody signed out
    const visitor = await open(null);
    await tab.until("draftCode()", "kept");
    assert.deepEqual(await visitor.evaluate("draftKeys()"), [DRAFT]);
    // Deleting the draft with a save waiting, then leaving the page
    await tab.evaluate('typeCode("about to be deleted"); discardDraft()');
    await new Promise(resolve => setTimeout(resolve, 700));
    await tab.open("about:blank");
    assert.deepEqual(await visitor.evaluate("draftKeys()"), []);
  }
);
