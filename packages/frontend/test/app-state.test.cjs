// Run: node --test packages/frontend/test/app-state.test.cjs
// The app-wide state keeps the session, locale and theme; a feature's own settings live with the feature. A setting
// that earlier versions saved in the app state moves to its feature's storage, keeping the person's choice.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const src = path.join(__dirname, "../src");

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value))
  };
}

const decorator = () => undefined;
function load(file, localStorage, extraModules = {}) {
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(src, file), "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        experimentalDecorators: true,
        useDefineForClassFields: false
      }
    }).outputText,
    {
      module,
      exports: module.exports,
      localStorage,
      navigator: { languages: ["en-US"] },
      window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
      require: name => {
        const modules = {
          mobx: { observable: decorator, computed: decorator, action: decorator, makeObservable() {} },
          "mobx-utils": { computedFn: fn => fn },
          "mobx-persist": {
            persist: decorator,
            // Hydration reads what initAppStateStore left in storage
            create: () => async key => {
              try {
                hydrated[key] = JSON.parse(localStorage.getItem(key));
              } catch {
                hydrated[key] = undefined;
              }
            }
          },
          "./interfaces/Locale": { Locale: { en_US: "en_US", zh_CN: "zh_CN" } },
          "./themes": { defaultLightTheme: "pure", defaultDarkTheme: "far", themeList: {} },
          ...extraModules
        };
        if (!(name in modules)) throw new Error("Unexpected import " + name);
        return modules[name];
      }
    }
  );
  return module.exports;
}
let hydrated = {};

test("a problem-set setting saved in the app state by an earlier version moves to the problem set's own storage", async () => {
  hydrated = {};
  const local = storage({ appState: JSON.stringify({ token: "t", showTagsInProblemSet: true, localLocale: "zh_CN" }) });
  const { initAppStateStore } = load("appState.ts", local);
  await initAppStateStore();
  assert.deepEqual(JSON.parse(local.getItem("problemSetPreferences")), { showTags: true });
  assert.deepEqual(hydrated.appState, { token: "t", localLocale: "zh_CN" }, "the rest of the app state is kept");

  const { problemSetPreferences } = load("pages/problem/problem-set/problemSetPreferences.ts", local);
  assert.equal(problemSetPreferences.showTags, true);
  problemSetPreferences.setShowTags(false);
  assert.deepEqual(JSON.parse(local.getItem("problemSetPreferences")), { showTags: false });
});

test("a newer saved choice isn't overwritten, and missing or unreadable storage is fine", async () => {
  hydrated = {};
  const local = storage({
    appState: JSON.stringify({ showTagsInProblemSet: true }),
    problemSetPreferences: JSON.stringify({ showTags: false })
  });
  await load("appState.ts", local).initAppStateStore();
  assert.deepEqual(JSON.parse(local.getItem("problemSetPreferences")), { showTags: false });
  assert.deepEqual(JSON.parse(local.getItem("appState")), {});

  for (const broken of [storage(), storage({ appState: "{not json" })]) {
    await load("appState.ts", broken).initAppStateStore();
    assert.equal(broken.getItem("problemSetPreferences"), null);
  }
  assert.equal(
    load("pages/problem/problem-set/problemSetPreferences.ts", storage({ problemSetPreferences: "[" }))
      .problemSetPreferences.showTags,
    false
  );
});

test("the app state no longer holds feature settings", () => {
  const source = fs.readFileSync(path.join(src, "appState.ts"), "utf8");
  assert.doesNotMatch(source, /showTagsInProblemSet\s*:\s*boolean/);
  assert.doesNotMatch(source, /TODO: move it out of global app state/);
});
