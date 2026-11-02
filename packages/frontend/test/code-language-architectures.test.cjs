// Run: node --test packages/frontend/test/code-language-architectures.test.cjs
// C and C++ architectures follow what the site's judge machines build: no 32-bit choice where all are arm64.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const { componentHarness } = require("./helpers/component-harness.cjs");

const src = path.join(__dirname, "../src");
const appState = { userPreference: {}, judgeArchitectures: null };
function loadCodeLanguage() {
  const module = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    ts.transpileModule(fs.readFileSync(path.join(src, "interfaces/CodeLanguage.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText
  )(
    name => {
      if (name !== "@/appState") throw new Error(`Unexpected import ${name}`);
      return { appState };
    },
    module,
    module.exports
  );
  return module.exports;
}
const codeLanguage = loadCodeLanguage();
const option = (language, name) => codeLanguage.compileAndRunOptions[language].find(value => value.name === name);

test("the architectures offered are the ones the judge machines build", () => {
  for (const language of ["cpp", "c"]) {
    appState.judgeArchitectures = null;
    assert.deepEqual(codeLanguage.availableOptionValues(language, option(language, "m")), ["64", "32"]);
    appState.judgeArchitectures = ["64", "32"];
    assert.deepEqual(codeLanguage.availableOptionValues(language, option(language, "m")), ["64", "32"]);
    appState.judgeArchitectures = ["64"];
    assert.deepEqual(codeLanguage.availableOptionValues(language, option(language, "m")), ["64"]);
    // Other options are left alone
    assert.deepEqual(
      codeLanguage.availableOptionValues(language, option(language, "O")),
      option(language, "O").values
    );
  }
  appState.judgeArchitectures = [];
  assert.deepEqual(codeLanguage.availableOptionValues("cpp", option("cpp", "m")), ["64", "32"], "never no choice");
});

test("a saved 32-bit preference becomes 64-bit where it can't be judged", () => {
  appState.userPreference = {
    code: { defaultLanguage: "cpp", defaultCompileAndRunOptions: { compiler: "clang++", std: "c++20", O: "3", m: "32" } }
  };
  appState.judgeArchitectures = ["64", "32"];
  assert.equal(codeLanguage.getPreferredCompileAndRunOptions("cpp").m, "32");
  appState.judgeArchitectures = ["64"];
  assert.deepEqual(codeLanguage.getPreferredCompileAndRunOptions("cpp"), {
    compiler: "clang++",
    std: "c++20",
    O: "3",
    m: "64"
  });
  appState.userPreference = {};
});

function editor(compileAndRunOptions) {
  const updates = [];
  const h = componentHarness("components/CodeLanguageAndOptions.tsx", {
    props: {
      language: "cpp",
      compileAndRunOptions,
      onUpdateLanguage() {},
      onUpdateCompileAndRunOptions: value => updates.push(value)
    },
    deps: { "@/appState": { appState }, "@/interfaces/CodeLanguage": codeLanguage }
  });
  const choices = h
    .all(node => node.type?.name === "Form.Select" && node.props.label === ".cpp.options.m.name")[0]
    .props.options.map(choice => choice.value);
  // Objects made by the component belong to the harness's realm
  return { choices: [...choices], updates: JSON.parse(JSON.stringify(updates)) };
}

test("the language options show only what can be judged, and change a choice that can't", () => {
  const options = { compiler: "g++", std: "c++17", O: "2", m: "32" };
  appState.judgeArchitectures = ["64", "32"];
  let { choices, updates } = editor(options);
  assert.deepEqual(choices, ["64", "32"]);
  assert.deepEqual(updates, []);
  appState.judgeArchitectures = ["64"];
  ({ choices, updates } = editor(options));
  assert.deepEqual(choices, ["64"]);
  assert.deepEqual(updates, [{ ...options, m: "64" }]);
  appState.judgeArchitectures = null;
});
