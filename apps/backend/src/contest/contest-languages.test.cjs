// No database, server, judge RPC, or production mutation.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
require("reflect-metadata");
const compilerOptions = {
  target: ts.ScriptTarget.ES2019,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true
};
require.extensions[".ts"] = (module, filename) =>
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions }).outputText, filename);
const { normalizeContestLanguages, isContestLanguageAllowed } = require("./contest-languages.ts");
const { CodeLanguage } = require("../code-language/code-language.type.ts");
const { CodeLanguageService } = require("../code-language/code-language.service.ts");
const { CPP_STANDARDS } = require("../code-language/compile-and-run-options/cpp.ts");
const { PYTHON_VERSIONS } = require("../code-language/compile-and-run-options/python.ts");
const { ProblemTypeTraditionalService } = require("../problem-type/types/traditional/problem-type.service.ts");
const { ContestService } = require("./contest.service.ts");
const repoRoot = path.resolve(__dirname, "../../../..");
function loadFrontend(relative, imports) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(repoRoot, relative), "utf8"), {
    compilerOptions
  }).outputText;
  new Function("require", "module", "exports", source)(
    id => {
      if (!(id in imports)) throw Error("Unexpected import " + id);
      return imports[id];
    },
    module,
    module.exports
  );
  return module.exports;
}
const frontend = loadFrontend("packages/frontend/src/interfaces/CodeLanguage.ts", {
  "@/appState": { appState: { userPreference: {} } }
});
class RouteErrorFixture {
  constructor(message, options) {
    this.message = message;
    this.options = options;
  }
}
const frontendAppState = { locale: "en_US" };
const frontendApi = loadFrontend("packages/frontend/src/pages/contest/api.ts", {
  "@/api": { createPostApi: () => () => {} },
  "@/appState": { appState: frontendAppState },
  "@/AppRouter": { RouteError: RouteErrorFixture },
  "@/interfaces/CodeLanguage": frontend
});
const all = normalizeContestLanguages(Object.values(CodeLanguage));
const cpp = (std = "c++17") => ({ compiler: "g++", std, O: "0", m: "64" });
const content = (language, options) => ({ language, code: "example", compileAndRunOptions: options });
function fixture(allowed = ["cpp:c++17"]) {
  const service = Object.create(ContestService.prototype),
    writes = [],
    logins = [];
  const contest = {
    id: 1,
    languages: allowed,
    endTime: new Date(Date.now() + 3600000),
    startTime: new Date(Date.now() - 3600000),
    rule: "noi"
  };
  const traditional = new ProblemTypeTraditionalService({}, new CodeLanguageService());
  service.login = async (_user, privilege) => {
    logins.push(privilege);
  };
  service.get = async () => ({ contest, manager: true });
  service.db = {
    getRepository: () => ({
      create: x => ({ ...x, id: 1 }),
      save: async x => {
        writes.push(x);
        return x;
      },
      findOneBy: async () => ({ id: 2, problemId: 3, inputFilename: "", outputFilename: "" }),
      countBy: async () => 0
    })
  };
  service.problems = {
    lockProblemById: async (_id, _mode, callback) => callback({ id: 3 }),
    getProblemJudgeInfo: async () => [{}, true]
  };
  service.submissions = {
    validateSubmissionContent: (_problem, value) => traditional.validateSubmissionContent(value),
    createSubmission: async (_user, _problem, value) => {
      writes.push(value);
      return [null, { id: 4 }];
    }
  };
  return { service, writes, logins };
}
const contestData = languages => ({
  title: "Language fixture",
  rule: "noi",
  startTime: new Date(Date.now() + 3600000).toISOString(),
  endTime: new Date(Date.now() + 7200000).toISOString(),
  adminIds: [],
  languages
});
test("frontend, backend, deployed inventory and judge adapters agree on all 12 upstream languages", () => {
  const profile = JSON.parse(fs.readFileSync(path.join(repoRoot, "deploy/sandbox/languages.json"), "utf8"));
  const inventory = Object.keys(profile);
  const judgeSource = fs.readFileSync(path.join(repoRoot, "apps/judge/src/languages/index.ts"), "utf8");
  const judge = JSON.parse(judgeSource.match(/const languageList = (\[[\s\S]*?\]);/)[1]);
  for (const list of [Object.values(CodeLanguage), Object.values(frontend.CodeLanguage), judge])
    assert.deepEqual([...list].sort(), [...inventory].sort());
  assert.equal(inventory.length, 12);
  for (const language of ["c", "cpp"]) {
    const architectures = frontend.compileAndRunOptions[language].find(option => option.name === "m").values;
    assert.deepEqual(architectures, profile[language].architectures);
    assert(!architectures.includes("x32"));
  }
  assert.equal(all.length, 27);
  assert.deepEqual(frontend.contestLanguageValues, all);
  assert.deepEqual(frontend.normalizeContestLanguages(Object.values(frontend.CodeLanguage)), all);
});
test("old wildcard entries expand to actual standards/versions without broad duplicate choices", () => {
  assert.deepEqual(normalizeContestLanguages(["cpp", "cpp:c++17", "python", "java"]), [
    ...CPP_STANDARDS.map(version => `cpp:${version}`),
    ...PYTHON_VERSIONS.map(version => `python:${version}`),
    "java"
  ]);
  assert.deepEqual(normalizeContestLanguages(["cpp:c++17"]), ["cpp:c++17"]);
  assert(!all.includes("cpp"));
  assert(!all.includes("python"));
});
test("unknown, unavailable and malformed language choices are rejected", () => {
  for (const value of [
    null,
    {},
    [],
    [3],
    ["ruby"],
    ["awk"],
    ["assembly"],
    ["elisp"],
    ["cpp:"],
    ["cpp:c++27"],
    ["cpp:c++17:"],
    ["python:3.8"],
    ["ruby:2.7"],
    ["__proto__"]
  ])
    assert.throws(
      () => normalizeContestLanguages(value),
      e => e.getStatus() === 400,
      JSON.stringify(value)
    );
});
test("both UI locales use real labels and identical executable choices", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    const tree = new Function(
      fs.readFileSync(path.join(repoRoot, "packages/frontend/src/locales/messages", locale, "code_language.js"), "utf8")
    )();
    const messages = {};
    function flatten(value, prefix = "") {
      for (const [key, child] of Object.entries(value)) {
        const name = prefix ? prefix + "." + key : key;
        if (typeof child === "string") messages[name] = child;
        else flatten(child, name);
      }
    }
    flatten(tree);
    const choices = frontendApi.languageChoices(Object.values(frontend.CodeLanguage), key => messages[key.slice(1)]);
    assert.deepEqual(
      choices.map(x => x.value),
      all
    );
    assert(choices.every(x => x.text && !x.text.includes("undefined")));
    assert.equal(choices.find(x => x.value === "cpp:c++17").text, "ISO C++ 17 (G++)");
    assert.equal(choices.find(x => x.value === "python:3.10").text, "Python 3.10");
    assert.equal(choices.find(x => x.value === "java").text, "Java");
    assert(!choices.some(x => ["ruby", "awk", "assembly", "elisp"].includes(x.value)));
    assert(!choices.some(x => /all standards|all versions|所有标准|所有版本/.test(x.text)));
  }
});
test("contest save persists the canonical language selection and keeps admission checks", async () => {
  const f = fixture();
  await f.service.save({ id: 7 }, undefined, contestData(["cpp", "python:3.10", "java"]));
  assert.deepEqual(f.writes[0].languages, [...CPP_STANDARDS.map(version => `cpp:${version}`), "python:3.10", "java"]);
  assert.deepEqual(f.logins, ["CreateContest"]);
  const invalid = fixture();
  await assert.rejects(
    invalid.service.save({ id: 7 }, undefined, contestData(["cpp:c++17:"])),
    e => e.getStatus() === 400
  );
  assert.equal(invalid.writes.length, 0);
  const denied = fixture();
  denied.service.get = async () => ({ contest: {}, manager: false });
  await assert.rejects(denied.service.save({ id: 7 }, 1, contestData(["cpp:c++17"])), e => e.getStatus() === 403);
  assert.equal(denied.writes.length, 0);
});
test("C++ and Python restrictions apply to real contest submissions", async () => {
  const f = fixture(["cpp:c++17", "python:3.10"]);
  for (const value of [
    content("cpp", cpp("c++11")),
    content("cpp", cpp("c++14")),
    content("cpp", cpp("c++20")),
    content("python", { version: "2.7" }),
    content("python", { version: "3.9" }),
    content("ruby", {})
  ])
    await assert.rejects(f.service.submit({ id: 7 }, 1, 2, { content: value }), e => e.getStatus() === 403);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(await f.service.submit({ id: 7 }, 1, 2, { content: content("cpp", cpp()) }), { submissionId: 4 });
  assert.deepEqual(await f.service.submit({ id: 7 }, 1, 2, { content: content("python", { version: "3.10" }) }), {
    submissionId: 4
  });
});
test("every actually supported language remains submittable, with option validation intact", async () => {
  const f = fixture(all);
  for (const choice of all) {
    const [language, version] = choice.split(":");
    const options = frontend.getDefaultCompileAndRunOptions(language);
    if (version) options[language === "cpp" ? "std" : "version"] = version;
    assert.deepEqual(await f.service.submit({ id: 7 }, 1, 2, { content: content(language, options) }), {
      submissionId: 4
    });
  }
  const before = f.writes.length;
  await assert.rejects(
    f.service.submit({ id: 7 }, 1, 2, { content: content("cpp", { ...cpp(), O: "injected" }) }),
    e => e.getStatus() === 400
  );
  await assert.rejects(
    f.service.submit({ id: 7 }, 1, 2, { content: content("cpp", { ...cpp(), m: "x32" }) }),
    e => e.getStatus() === 400
  );
  assert.equal(f.writes.length, before);
  assert(!isContestLanguageAllowed(["cpp"], "cpp", cpp("c++27")));
  assert(isContestLanguageAllowed(["cpp"], "cpp", cpp("c++20")));
  assert(!isContestLanguageAllowed(["python"], "python", { version: "3.11" }));
  assert(isContestLanguageAllowed(["cpp"], "cpp", cpp("c++11")));
});

test("contest statement exposes only a safe Communication grader capability", async () => {
  const { service } = fixture(["python", "cpp:c++17"]);
  const internal = {
    timeLimit: 3000,
    memoryLimit: 128,
    grader: { filename: "hidden-grader.cpp" },
    manager: { filename: "hidden-manager.cpp" },
    extraSourceFiles: { cpp: { "private.h": "secret.h" } },
    subtasks: [{ testcases: [{ inputFile: "hidden.in" }] }]
  };
  service.problemMeta = () => ({ id: 2 });
  service.privileges = { userHasPrivilege: async () => false };
  for (const [type, judgeInfo, expected] of [
    ["Communication", internal, true],
    ["Communication", { ...internal, grader: undefined }, false],
    ["Interaction", internal, false],
    ["Traditional", internal, false],
    ["SubmitAnswer", internal, false]
  ]) {
    const problem = { type, locales: ["en_US"] };
    service.db.getRepository = () => ({ findOneBy: async () => ({ problem: Promise.resolve(problem) }) });
    service.problems.getProblemJudgeInfo = async () => [judgeInfo, true];
    service.problems.getProblemLocalizedTitle = async () => "Public title";
    service.problems.getProblemLocalizedContent = async () => [];
    service.problems.getProblemSamples = async () => [];
    const response = await service.problem({ id: 8 }, 1, 2, "en_US");
    assert.equal(response.hasGrader, expected);
    assert.deepEqual(response.limits, { timeLimit: 3000, memoryLimit: 128 });
    assert.equal(response.submittable, true);
    assert(!JSON.stringify(response).includes("hidden-"));
    assert(!JSON.stringify(response).includes("secret.h"));
    assert(!JSON.stringify(response).includes("hidden.in"));
    assert(!Object.hasOwn(response, "judgeInfo"));
  }
});

test("contest code and answer upload challenges match the backend guards", () => {
  const requests = [];
  loadFrontend("packages/frontend/src/pages/contest/api.ts", {
    "@/api": {
      createPostApi: (path, options) => {
        requests.push({ path, options });
        return () => {};
      }
    },
    "@/appState": { appState: frontendAppState },
    "@/AppRouter": { RouteError: RouteErrorFixture },
    "@/interfaces/CodeLanguage": frontend
  });
  const { ContestController } = require("./contest.controller.ts");
  const { PROOF_OF_WORK_ACTION_METADATA, ProofOfWorkAction } = require("../proof-of-work/proof-of-work-action.enum.ts");
  for (const [path, method] of [
    ["contest/submit", "submit"],
    ["contest/prepareUpload", "prepareUpload"]
  ]) {
    const action = requests.find(request => request.path === path).options.proofOfWorkAction;
    assert(Object.values(ProofOfWorkAction).includes(action));
    assert.equal(action, Reflect.getMetadata(PROOF_OF_WORK_ACTION_METADATA, ContestController.prototype[method]));
  }
});

test("Chinese contest results localize all verdicts and source languages", () => {
  const { SubmissionStatusAll } = loadFrontend("packages/frontend/src/interfaces/SubmissionStatus.ts", {});
  frontendAppState.locale = "zh_CN";
  try {
    for (const status of [...Object.values(SubmissionStatusAll), "Compiled"])
      assert(/[\u4e00-\u9fff]/.test(frontendApi.contestStatusText(status)), status);
    assert.equal(frontendApi.contestStatusText("Accepted"), "通过");
    assert.equal(frontendApi.contestStatusText("WrongAnswer"), "答案错误");
    assert.equal(frontendApi.contestStatusText(undefined), "—");
    assert.equal(
      frontendApi.contestLanguageName("cpp", key => (key === ".cpp.name" ? "C++" : "unknown")),
      "C++"
    );
  } finally {
    frontendAppState.locale = "en_US";
  }
  assert.equal(frontendApi.contestStatusText("WrongAnswer"), "Wrong Answer");
});

test("expected contest failures carry localized route messages instead of uncaught errors", async () => {
  for (const locale of ["zh_CN", "en_US"]) {
    frontendAppState.locale = locale;
    try {
      for (const [result, pattern] of [
        [
          { requestError: () => "403", requestErrorStatus: 403, requestErrorCode: "CONTEST_NOT_STARTED" },
          locale === "zh_CN" ? /比赛尚未开始/ : /contest starts/
        ],
        [
          { requestError: () => "403", requestErrorStatus: 403, requestErrorCode: "LOGIN_REQUIRED" },
          locale === "zh_CN" ? /请先登录/ : /sign in/
        ],
        [{ requestError: () => "403", requestErrorStatus: 403 }, locale === "zh_CN" ? /没有.*权限/ : /permission/],
        [{ response: { error: "PERMISSION_DENIED" } }, locale === "zh_CN" ? /没有.*权限/ : /permission/],
        [{ requestError: () => "network error" }, locale === "zh_CN" ? /稍后重试/ : /try again/]
      ]) {
        const api = loadFrontend("packages/frontend/src/pages/contest/api.ts", {
          "@/api": { createPostApi: () => async () => result },
          "@/appState": { appState: frontendAppState },
          "@/AppRouter": { RouteError: RouteErrorFixture },
          "@/interfaces/CodeLanguage": frontend
        });
        await assert.rejects(api.callContest("detail", { id: 1 }), error => {
          assert(error instanceof RouteErrorFixture);
          assert.match(error.message, pattern);
          assert.deepEqual(error.options, { showRefresh: true, showBack: true });
          return true;
        });
      }
    } finally {
      frontendAppState.locale = "en_US";
    }
  }
});
