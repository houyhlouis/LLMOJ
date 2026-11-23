// Run with: node --test packages/frontend/test/contest-drafts.test.cjs
// Audit 2026-11-07 RM-06 (draft recovery): code written for a contest problem is kept in the browser, per account,
// contest, problem and language, so a reload or a wrong click doesn't lose it; signing out, another account signing in
// and 14 days without changes delete it. Review 2026-11-20 RV-05: a save still waiting when someone signs out (or
// another account signs in), in this tab or another, must not bring a deleted draft back. The real
// utils/contestDrafts.ts, ContestProblemPage, the session refresh of initApp.ts and the sign-out of AppLayout.tsx, with
// a fake browser storage; contest-drafts-browser.test.cjs repeats the lifecycle cases in a real browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const { componentHarness } = require("./helpers/component-harness.cjs");

const src = path.join(__dirname, "../src");
const DAY = 24 * 60 * 60 * 1000;
const KEY = "llmoj.contestDraft.v1:";

function fakeStorage({ quota = Infinity, initial = {} } = {}) {
  const values = new Map(Object.entries(initial));
  const used = () => [...values].reduce((total, [key, value]) => total + key.length + value.length, 0);
  return {
    values,
    get length() {
      return values.size;
    },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem(key, value) {
      const previous = values.get(key);
      values.set(key, String(value));
      if (used() > quota) {
        if (previous === undefined) values.delete(key);
        else values.set(key, previous);
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      }
    },
    removeItem: key => void values.delete(key)
  };
}

function load(file, modules, globals) {
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(src, file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText,
    {
      module,
      exports: module.exports,
      require: name => {
        if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
        return modules[name];
      },
      ...globals
    },
    { filename: file }
  );
  return module.exports;
}

// One module per page: its own module state, like a browser tab, over whatever storage the window has
const loadDrafts = (window, globals = {}) => load("utils/contestDrafts.ts", {}, { window, ...globals });
const SESSION_KEY = "llmoj.contestDraftSession.v1";
// Values made in the modules' own realm, compared as plain data
const plain = value => JSON.parse(JSON.stringify(value));
const owner = { userId: 7, contestId: 3, problemId: 11 };
const draftKeys = storage => [...storage.values.keys()].filter(key => key.startsWith(KEY)).sort();

test("a draft belongs to one account, contest, problem and language", () => {
  const storage = fakeStorage();
  const drafts = loadDrafts({ localStorage: storage });
  assert.equal(drafts.saveDraft(owner, "cpp", "int main() {}", { std: "c++17" }, 1000), "saved");
  assert.deepEqual(plain(drafts.loadDraft(owner, "cpp", 2000)), {
    code: "int main() {}",
    options: { std: "c++17" },
    savedAt: 1000
  });
  for (const other of [
    [{ ...owner, userId: 8 }, "cpp"],
    [{ ...owner, contestId: 4 }, "cpp"],
    [{ ...owner, problemId: 12 }, "cpp"],
    [owner, "python"]
  ])
    assert.equal(drafts.loadDraft(...other, 2000), null);
  assert.deepEqual(draftKeys(storage), [`${KEY}7:3:11:cpp`]);
});

test("a draft is deleted 14 days after its last change, and reading an expired one removes it", () => {
  const storage = fakeStorage();
  const drafts = loadDrafts({ localStorage: storage });
  drafts.saveDraft(owner, "cpp", "a", {}, 0);
  assert.equal(drafts.loadDraft(owner, "cpp", 14 * DAY)?.code, "a");
  assert.equal(drafts.loadDraft(owner, "cpp", 14 * DAY + 1), null);
  assert.deepEqual(draftKeys(storage), []);
  // Unreadable entries go too
  storage.setItem(`${KEY}7:3:11:cpp`, "{not json");
  assert.equal(drafts.loadDraft(owner, "cpp", 0), null);
  assert.deepEqual(draftKeys(storage), []);
});

test("signing out deletes every draft; another account signing in deletes the earlier account's and expired ones", () => {
  const storage = fakeStorage({ initial: { appState: "{}", "session-swr": "{}" } });
  const drafts = loadDrafts({ localStorage: storage });
  drafts.saveDraft(owner, "cpp", "mine", {}, 10 * DAY);
  drafts.saveDraft({ ...owner, problemId: 12 }, "cpp", "mine, old", {}, 0);
  drafts.saveDraft({ ...owner, userId: 8 }, "cpp", "someone else's", {}, 10 * DAY);
  drafts.keepOnlyDraftsOf(7, 15 * DAY);
  assert.deepEqual(draftKeys(storage), [`${KEY}7:3:11:cpp`]);
  drafts.signOutDrafts();
  assert.deepEqual(draftKeys(storage), []);
  assert.deepEqual(
    [...storage.values.keys()].sort(),
    ["appState", SESSION_KEY, "session-swr"],
    "other settings stay; the new draft session is recorded"
  );
});

test("empty code removes the draft; code too long to submit isn't kept, and the older draft doesn't come back", () => {
  const storage = fakeStorage();
  const drafts = loadDrafts({ localStorage: storage });
  drafts.saveDraft(owner, "cpp", "short", {}, 0);
  assert.equal(drafts.saveDraft(owner, "cpp", "", {}, 1), "removed");
  assert.deepEqual(draftKeys(storage), []);
  drafts.saveDraft(owner, "cpp", "short", {}, 2);
  assert.equal(drafts.saveDraft(owner, "cpp", "x".repeat(drafts.MAX_DRAFT_LENGTH + 1), {}, 3), "not-kept");
  assert.equal(drafts.loadDraft(owner, "cpp", 4), null);
});

test("a full storage makes room by dropping the drafts changed longest ago; at most 50 drafts are kept", () => {
  const storage = fakeStorage({ quota: 600 });
  const drafts = loadDrafts({ localStorage: storage });
  for (let problemId = 1; problemId <= 6; problemId++)
    assert.equal(drafts.saveDraft({ ...owner, problemId }, "cpp", "x".repeat(50), {}, problemId), "saved");
  const kept = draftKeys(storage).map(key => Number(key.split(":")[3]));
  assert.deepEqual(
    kept.sort((a, b) => a - b),
    [2, 3, 4, 5, 6],
    "the oldest draft made room for the new one"
  );
  assert.equal(drafts.saveDraft({ ...owner, problemId: 99 }, "cpp", "x".repeat(700), {}, 7), "not-kept");
  assert.equal(drafts.loadDraft({ ...owner, problemId: 99 }, "cpp", 8), null);

  const roomy = fakeStorage();
  const many = loadDrafts({ localStorage: roomy });
  for (let problemId = 1; problemId <= 55; problemId++)
    many.saveDraft({ ...owner, problemId }, "cpp", "x", {}, problemId);
  const left = draftKeys(roomy).map(key => Number(key.split(":")[3]));
  assert.equal(left.length, many.MAX_DRAFTS);
  assert.deepEqual(
    left.sort((a, b) => a - b),
    Array.from({ length: 50 }, (_, i) => i + 6)
  );
});

test("without browser storage (blocked or failing) there are no drafts and no errors", () => {
  const blocked = {};
  Object.defineProperty(blocked, "localStorage", {
    get() {
      throw new Error("SecurityError");
    }
  });
  const drafts = loadDrafts(blocked);
  assert.equal(drafts.saveDraft(owner, "cpp", "code", {}, 0), "not-kept");
  assert.equal(drafts.loadDraft(owner, "cpp", 0), null);
  assert.equal(drafts.latestDraftLanguage(owner, ["cpp"], 0), null);
  drafts.signOutDrafts();
  drafts.keepOnlyDraftsOf(7);
  const writer = drafts.createDraftWriter(null, () => assert.fail("nothing to report"));
  writer.keep("cpp", "code", {});
  writer.close();
});

test("the page opens with the draft changed last, in a language the contest still allows", () => {
  const storage = fakeStorage();
  const drafts = loadDrafts({ localStorage: storage });
  drafts.saveDraft(owner, "cpp", "C++", {}, 1);
  drafts.saveDraft(owner, "python", "Python", {}, 3);
  drafts.saveDraft(owner, "java", "Java", {}, 5);
  assert.equal(drafts.latestDraftLanguage(owner, ["cpp", "python"], 6), "python");
  assert.equal(drafts.latestDraftLanguage(owner, ["c"], 6), null);
});

// The contest problem page

const codeLanguage = load(
  "interfaces/CodeLanguage.ts",
  { "@/appState": { appState: { userPreference: {}, judgeArchitectures: null } } },
  {}
);

function page({
  storage,
  user = { id: 7 },
  type = "Traditional",
  submittable = true,
  languages,
  api = {},
  confirm,
  drafts: shared
}) {
  const listeners = { window: new Map(), document: new Map() };
  const target = name => ({
    addEventListener: (event, listener) => listeners[name].set(event, listener),
    removeEventListener: (event, listener) => listeners[name].get(event) === listener && listeners[name].delete(event)
  });
  const window = { localStorage: storage, ...target("window"), confirm: () => confirm?.() ?? true };
  const document = { visibilityState: "visible", ...target("document") };
  // The draft writer's timers, run by runTimers with the page's own
  const draftTimers = [];
  const drafts = shared ?? loadDrafts(window, { document, setTimeout: fn => draftTimers.push(fn), clearTimeout() {} });
  const calls = [];
  const initial = {
    type,
    title: "A + B",
    locale: "en_US",
    locales: ["en_US"],
    limits: { timeLimit: 1000, memoryLimit: 256 },
    problem: { id: 11, problemId: 101, attachments: [] },
    contest: { id: 3, rule: "icpc", languages: languages ?? ["cpp", "python", "c"] },
    content: [],
    samples: [],
    submittable
  };
  const h = componentHarness("pages/contest/ContestProblemPage.tsx", {
    component: "ContestProblemPage",
    props: { detail: {}, initial },
    window,
    globals: { document },
    deps: {
      "@/appState": { appState: { currentUser: user, locale: "en_US", userPreference: {} } },
      "@/interfaces/CodeLanguage": codeLanguage,
      "@/utils/contestDrafts": drafts,
      "@/components/LazyCodeEditor": { __esModule: true, default: { name: "CodeEditor" } },
      "@/markdown/MarkdownContent": { __esModule: true, default: { name: "MarkdownContent" } },
      "@/utils/callApiWithFileUpload": { callApiWithFileUpload: async () => ({}) },
      "@/pages/self-eval/SelfEvalButton": { __esModule: true, default: { name: "SelfEvalButton" } },
      "@/utils/downloadFile": { saveBlob() {} },
      "./ContestFrame": { __esModule: true, default: { name: "ContestFrame" } },
      "./api": {
        tr: (zh, en) => en,
        callContest: async () => initial,
        contestRequest: () => async () => ({}),
        prepareContestUpload: async () => ({}),
        submitContest: async body => {
          calls.push(body);
          return api.submit?.(body) ?? { response: { submissionId: 5 } };
        }
      }
    }
  });
  const editor = () => h.find("CodeEditor");
  const notice = () => h.all(node => node.type?.name === "DraftNotice")[0]?.props.status ?? null;
  const select = label => h.find("Form.Select", props => props.label === label);
  const runTimers = () => [...draftTimers.splice(0), ...h.timers.splice(0)].forEach(timer => timer());
  // A real browser fires `storage` on the other tabs' windows when one tab changes the storage
  const storageEvent = key => listeners.window.get("storage")?.({ key });
  return { h, editor, notice, select, runTimers, storageEvent, listeners, window, document, drafts, calls };
}

test("typing keeps a draft after a short pause, and a reload brings it back", async () => {
  const storage = fakeStorage();
  const first = page({ storage });
  await first.h.settle();
  assert.equal(first.editor().props.value, "");
  assert.equal(first.notice(), null);
  first.editor().props.onChange("int main() { return 0; }");
  await first.h.settle();
  assert.deepEqual(draftKeys(storage), [], "saved after a pause, not on every key");
  first.runTimers();
  await first.h.settle();
  assert.deepEqual(draftKeys(storage), [`${KEY}7:3:11:cpp`]);
  assert.equal(typeof first.notice().savedAt, "number");
  first.h.unmount();

  const reloaded = page({ storage });
  await reloaded.h.settle();
  assert.equal(reloaded.editor().props.value, "int main() { return 0; }");
  assert.equal(reloaded.select("Language").props.value, "cpp");
  assert.equal(reloaded.notice().restored, true, "the page says the draft was restored");
});

test("leaving the page or hiding the tab saves the draft at once", async () => {
  const storage = fakeStorage();
  const view = page({ storage });
  await view.h.settle();
  view.editor().props.onChange("print(1)");
  await view.h.settle();
  view.listeners.window.get("pagehide")();
  assert.equal(JSON.parse(storage.getItem(`${KEY}7:3:11:cpp`)).code, "print(1)");

  view.editor().props.onChange("print(2)");
  await view.h.settle();
  view.document.visibilityState = "hidden";
  view.listeners.document.get("visibilitychange")();
  assert.equal(JSON.parse(storage.getItem(`${KEY}7:3:11:cpp`)).code, "print(2)");

  view.document.visibilityState = "visible";
  view.editor().props.onChange("print(3)");
  await view.h.settle();
  view.h.unmount();
  assert.equal(JSON.parse(storage.getItem(`${KEY}7:3:11:cpp`)).code, "print(3)", "and so does leaving in the app");
  assert.equal(view.listeners.window.size + view.listeners.document.size, 0, "listeners removed");
});

test("each language has its own draft; a language without one takes the code along", async () => {
  const storage = fakeStorage();
  const drafts = loadDrafts({ localStorage: storage });
  drafts.saveDraft(owner, "cpp", "C++ code", { compiler: "clang++", std: "c++20", O: "2", m: "64" }, Date.now() - 2000);
  drafts.saveDraft(owner, "python", "print(1)", { version: "3.10" }, Date.now() - 1000);
  const view = page({ storage });
  await view.h.settle();
  assert.equal(view.select("Language").props.value, "python", "the draft changed last");
  assert.equal(view.editor().props.value, "print(1)");

  view.select("Language").props.onChange(null, { value: "cpp" });
  await view.h.settle();
  assert.equal(view.editor().props.value, "C++ code");
  assert.equal(view.select(".cpp.options.compiler.name").props.value, "clang++", "and its options");
  assert.equal(JSON.parse(storage.getItem(`${KEY}7:3:11:python`)).code, "print(1)", "the other draft stays");

  view.select("Language").props.onChange(null, { value: "c" });
  await view.h.settle();
  assert.equal(view.editor().props.value, "C++ code", "the code stays in the editor");
  assert.deepEqual(draftKeys(storage), [`${KEY}7:3:11:c`, `${KEY}7:3:11:python`], "its draft moved to C");
});

test("a draft's options the contest no longer allows fall back to the contest's own", async () => {
  const storage = fakeStorage();
  loadDrafts({ localStorage: storage }).saveDraft(
    owner,
    "cpp",
    "code",
    { compiler: "g++", std: "c++03", m: "x86" },
    Date.now()
  );
  const view = page({ storage, languages: ["cpp:c++17"] });
  await view.h.settle();
  assert.equal(view.editor().props.value, "code");
  assert.equal(view.select(".cpp.options.std.name").props.value, "c++17");
  assert.deepEqual(plain(view.select(".cpp.options.std.name").props.options.map(option => option.value)), ["c++17"]);
});

test("submitting keeps the draft; discarding asks first, then deletes it and empties the editor", async () => {
  const storage = fakeStorage();
  let answer = false;
  const view = page({ storage, confirm: () => answer });
  await view.h.settle();
  view.editor().props.onChange("int main() {}");
  await view.h.settle();
  await view.h.find("Form", props => typeof props.onSubmit === "function").props.onSubmit();
  await view.h.settle();
  assert.equal(view.calls[0].data.content.code, "int main() {}");
  assert.ok(view.h.calls.some(call => call.name === "navigate" && call.body === "/contest/3/submission/5"));
  assert.equal(
    JSON.parse(storage.getItem(`${KEY}7:3:11:cpp`)).code,
    "int main() {}",
    "kept, to fix after a wrong answer"
  );

  const discard = () => view.h.all(node => node.type?.name === "DraftNotice")[0].props.onDiscard();
  discard();
  await view.h.settle();
  assert.equal(view.editor().props.value, "int main() {}", "nothing happens without a yes");
  answer = true;
  discard();
  await view.h.settle();
  assert.equal(view.editor().props.value, "");
  assert.deepEqual(draftKeys(storage), []);
  assert.equal(view.notice(), null);
  view.runTimers();
  view.h.unmount();
  assert.deepEqual(draftKeys(storage), [], "a save already scheduled doesn't bring it back");
});

test("after submissions close, the draft can still be read and copied", async () => {
  const storage = fakeStorage();
  loadDrafts({ localStorage: storage }).saveDraft(owner, "cpp", "almost done", {}, Date.now());
  const view = page({ storage, submittable: false });
  await view.h.settle();
  assert.equal(view.editor().props.value, "almost done");
  assert.equal(view.editor().props.options.readOnly, true);
  assert.equal(view.editor().props.onChange, undefined);
});

test("visitors and answer-file problems keep no drafts", async () => {
  const storage = fakeStorage();
  const visitor = page({ storage, user: null });
  await visitor.h.settle();
  assert.equal(visitor.h.all(node => node.type?.name === "CodeEditor").length, 0);
  visitor.h.unmount();

  const answers = page({ storage, type: "SubmitAnswer" });
  await answers.h.settle();
  answers.h.unmount();
  assert.deepEqual(draftKeys(storage), []);
});

// Signing in and out

test("a session refresh for another account deletes the earlier account's drafts; one without a user keeps them", async () => {
  const storage = fakeStorage();
  const drafts = loadDrafts({ localStorage: storage });
  drafts.saveDraft(owner, "cpp", "user 7", {}, Date.now());
  const window = {};
  const appState = { token: "" };
  const { refreshSession } = load(
    "initApp.ts",
    {
      "@/appState": { appState, initAppStateStore: async () => {} },
      "@/misc/analytics": { loadGoogleAnalytics() {}, loadPlausible() {} },
      "@/utils/session": { apiSameOrigin: () => true, isSessionMarker: () => false },
      "@/api": { __esModule: true, default: { auth: {} } },
      "@/utils/contestDrafts": drafts
    },
    { window, localStorage: storage, console: { log() {}, error() {} } }
  );
  const refresh = async sessionInfo => {
    window.refreshSession = () => (window.sessionInfo = sessionInfo);
    await refreshSession();
  };
  await refresh({ userMeta: null });
  assert.deepEqual(draftKeys(storage), [`${KEY}7:3:11:cpp`], "an ended session may sign in again as the same account");
  await refresh({ userMeta: { id: 7 } });
  assert.deepEqual(draftKeys(storage), [`${KEY}7:3:11:cpp`]);
  await refresh({ userMeta: { id: 8 } });
  assert.deepEqual(draftKeys(storage), []);
});

// AppLayout's real onLogoutClick, with the sign-out API's outcome and the browser's reload given by the test
function logoutHandler({ outcome, signOutDrafts, reload = () => {} }) {
  const filename = path.join(src, "layouts/AppLayout.tsx");
  const ast = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let handler;
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "onLogoutClick") handler = node.getText(ast);
    ts.forEachChild(node, visit);
  })(ast);
  assert.ok(handler, "AppLayout signs out in onLogoutClick");
  return new Function(
    "api",
    "toast",
    "_",
    "appState",
    "location",
    "signOutDrafts",
    `return (${ts.transpile(handler, { target: ts.ScriptTarget.ES2020 }).replace(/^"use strict";\s*/, "")})`
  )({ auth: { logout: async () => outcome } }, { error() {} }, text => text, {}, { reload }, signOutDrafts);
}

test("signing out deletes the drafts kept in this browser", async () => {
  const removed = [];
  await logoutHandler({ outcome: { requestError: () => "offline" }, signOutDrafts: () => removed.push(true) })();
  assert.equal(removed.length, 0, "not while the server still has the session");
  await logoutHandler({ outcome: { response: {} }, signOutDrafts: () => removed.push(true) })();
  assert.equal(removed.length, 1);
});

// Review 2026-11-20 RV-05: a save still waiting when the draft session ends

// What initApp does when the server says `userId` is signed in (one tab's session refresh)
const signedIn = (storage, userId = 7) => loadDrafts({ localStorage: storage }).keepOnlyDraftsOf(userId);

test("RV-05: signing out with a save still waiting leaves no draft, whatever runs after it", async () => {
  const storage = fakeStorage();
  signedIn(storage);
  const view = page({ storage });
  await view.h.settle();
  view.editor().props.onChange("int main() { return 1; }");
  await view.h.settle();
  assert.deepEqual(draftKeys(storage), [], "the save is still waiting");
  let reloaded = false;
  await logoutHandler({
    outcome: { response: {} },
    signOutDrafts: view.drafts.signOutDrafts,
    reload: () => (reloaded = true)
  })();
  assert.equal(reloaded, true);
  assert.deepEqual(draftKeys(storage), []);
  await view.h.settle();
  assert.equal(view.notice(), "ended");
  // A reload hides the tab and fires pagehide; the save timer may still run; then the page goes
  view.document.visibilityState = "hidden";
  view.listeners.document.get("visibilitychange")();
  view.listeners.window.get("pagehide")();
  view.runTimers();
  view.h.unmount();
  assert.deepEqual(draftKeys(storage), [], "nothing wrote the draft back");
  // The next page load, signed out, starts from nothing
  const next = page({ storage, user: null });
  await next.h.settle();
  assert.deepEqual(draftKeys(storage), []);
});

test("RV-05: after a sign-out in another tab, this tab's waiting save is dropped as soon as it hears of it", async () => {
  const storage = fakeStorage();
  signedIn(storage);
  const tab = page({ storage });
  await tab.h.settle();
  tab.editor().props.onChange("this tab's code");
  await tab.h.settle();
  // The other tab: its own page module over the same storage
  loadDrafts({ localStorage: storage }).signOutDrafts();
  tab.storageEvent(SESSION_KEY);
  await tab.h.settle();
  assert.equal(tab.notice(), "ended", "the page says it stopped keeping drafts");
  tab.editor().props.onChange("typed afterwards");
  await tab.h.settle();
  tab.runTimers();
  tab.listeners.window.get("pagehide")();
  tab.h.unmount();
  assert.deepEqual(draftKeys(storage), []);
});

test("RV-05: without the storage event, the old tab's late timer, pagehide and closing still write nothing", async () => {
  const storage = fakeStorage();
  signedIn(storage);
  const tab = page({ storage });
  await tab.h.settle();
  tab.editor().props.onChange("first");
  await tab.h.settle();
  loadDrafts({ localStorage: storage }).signOutDrafts();
  tab.runTimers();
  await tab.h.settle();
  assert.deepEqual(draftKeys(storage), [], "the late timer wrote nothing");
  assert.equal(tab.notice(), "ended");
  tab.editor().props.onChange("second");
  await tab.h.settle();
  tab.listeners.window.get("pagehide")();
  tab.h.unmount();
  assert.deepEqual(draftKeys(storage), [], "nor did pagehide or closing the page");
});

test("RV-05: another account signing in, in another tab, ends the earlier account's pages", async () => {
  const storage = fakeStorage();
  signedIn(storage, 7);
  const tab = page({ storage });
  await tab.h.settle();
  tab.editor().props.onChange("account 7's code");
  await tab.h.settle();
  signedIn(storage, 8);
  tab.runTimers();
  tab.listeners.window.get("pagehide")();
  tab.h.unmount();
  assert.deepEqual(draftKeys(storage), []);
});

test("RV-05: an old tab can't write even after the same account signs in again; a new page keeps drafts", async () => {
  const storage = fakeStorage();
  signedIn(storage, 7);
  const old = page({ storage });
  await old.h.settle();
  old.editor().props.onChange("from before signing out");
  await old.h.settle();
  // Another tab signs out (and reloads), then account 7 signs in again there
  loadDrafts({ localStorage: storage }).signOutDrafts();
  signedIn(storage, 7);
  old.runTimers();
  old.listeners.window.get("pagehide")();
  old.h.unmount();
  assert.deepEqual(draftKeys(storage), []);

  const fresh = page({ storage });
  await fresh.h.settle();
  fresh.editor().props.onChange("after signing in again");
  await fresh.h.settle();
  fresh.runTimers();
  fresh.h.unmount();
  assert.equal(JSON.parse(storage.getItem(`${KEY}7:3:11:cpp`)).code, "after signing in again");
});

test("RV-05: a draft written just as another tab signs out is taken back", () => {
  const storage = fakeStorage();
  signedIn(storage);
  const drafts = loadDrafts({ localStorage: storage });
  const other = loadDrafts({ localStorage: storage });
  const pageOwner = { ...owner, session: drafts.currentDraftSession() };
  const setItem = storage.setItem;
  // The other tab signs out between this tab's check of its session and its write
  storage.setItem = (key, value) => {
    if (key.startsWith(KEY)) {
      storage.setItem = setItem;
      other.signOutDrafts();
    }
    setItem(key, value);
  };
  assert.equal(drafts.saveDraft(pageOwner, "cpp", "raced", {}), "ended");
  assert.deepEqual(draftKeys(storage), []);
  assert.equal(drafts.draftSessionIsCurrent(pageOwner), false);
});

test("RV-05: a login session that ends without signing out keeps the page saving, for the same account", async () => {
  const storage = fakeStorage();
  signedIn(storage, 7);
  const tab = page({ storage });
  await tab.h.settle();
  // The server answers as to a visitor (expired, or ended on another device): initApp leaves the drafts alone, and the
  // same account signs in again
  tab.editor().props.onChange("still mine");
  await tab.h.settle();
  signedIn(storage, 7);
  tab.storageEvent(SESSION_KEY);
  tab.runTimers();
  await tab.h.settle();
  assert.equal(typeof tab.notice().savedAt, "number");
  tab.h.unmount();
  assert.equal(JSON.parse(storage.getItem(`${KEY}7:3:11:cpp`)).code, "still mine");
});

test("RV-05: deleting a draft stays deleted, whatever save was still waiting", async () => {
  const storage = fakeStorage();
  signedIn(storage);
  const view = page({ storage });
  await view.h.settle();
  view.editor().props.onChange("to be deleted");
  await view.h.settle();
  view.runTimers();
  view.editor().props.onChange("to be deleted, edited");
  await view.h.settle();
  view.h.all(node => node.type?.name === "DraftNotice")[0].props.onDiscard();
  await view.h.settle();
  view.document.visibilityState = "hidden";
  view.listeners.document.get("visibilitychange")();
  view.listeners.window.get("pagehide")();
  view.runTimers();
  view.h.unmount();
  assert.deepEqual(draftKeys(storage), []);
});
