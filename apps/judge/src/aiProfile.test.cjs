/* Run: node --test apps/judge/src/aiProfile.test.cjs (after building packages/judge-protocol) */
// An AI run's programs are compiled and run with their role's execution profile, each seeing only its own binary, and
// the judging settings the backend publishes give every published program the profile it was checked with (review
// Part III, W02: H03 and H05). The backend's contract is checked here against the judge's own reading of those settings.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText,
    filename
  );
const protocol = require("@libreoj/judge-protocol");
const { legacyProfiles, profileRole, programDirectory, programSandbox, roleProfile } = require("./aiProfile.ts");
const { getCheckerMeta } = require("./checkers/index.ts");
const { interactorLimits } = require("./task/submission/interaction/limits.ts");
const { languageConfig: cpp } = require("./languages/cpp.ts");
const contract = require("../../backend/src/ai/ai-judging-contract.ts");

test("each program's role, and the directory of its own binary", () => {
  assert.deepEqual(
    ["make", "quality-small-make", "std", "quality-alt-greedy", "quality-challenge-spfa", "quality-oracle", "validator", "checker", "interactor", "manager"].map(profileRole),
    ["generator", "generator", "std", "alternative", "challenge", "oracle", "validator", "checker", "interactor", "manager"]
  );
  assert.throws(() => profileRole("grader"), /No execution profile role/);
  assert.equal(programDirectory("/w/job/bin", "quality-alt-greedy"), "/w/job/bin/quality-alt-greedy");
  for (const name of ["..", "../std", "std/../checker", "", "Std", "a".repeat(65)])
    assert.throws(() => programDirectory("/w/job/bin", name), /Invalid program name/);
});

test("a program's sandbox mounts its own binary directory alone, read-only, with its role's limits and CPU class", () => {
  const profiles = contract.resolveAiProfiles({
    problemType: "Traditional",
    judgeInfo: { timeLimit: 1000, memoryLimit: 256 },
    timeLimitMs: 1000,
    memoryLimitMiB: 256,
    checker: true
  });
  const binaryRoot = "/w/job/bin";
  for (const name of ["std", "checker", "validator", "make", "quality-oracle", "quality-alt-x", "quality-challenge-y"]) {
    const profile = roleProfile(profiles, name);
    const sandbox = programSandbox(
      profile,
      { outside: programDirectory(binaryRoot, name), inside: "/sandbox/binary" },
      { outside: "/w/task/working", inside: "/sandbox/working" },
      { outside: "/w/job/references-1", inside: "/sandbox/source" }
    );
    assert.equal(sandbox.executable, "/sandbox/binary/a.out");
    const binaries = sandbox.extraMounts.filter(mount => mount.mappedPath.inside === "/sandbox/binary");
    assert.deepEqual(binaries, [{ mappedPath: { outside: `${binaryRoot}/${name}`, inside: "/sandbox/binary" }, readOnly: true }]);
    assert(sandbox.extraMounts.every(mount => mount.mappedPath.outside !== binaryRoot), `${name} sees no peer`);
    assert.equal(sandbox.time, profile.timeLimitMs);
    assert.equal(sandbox.memory, profile.memoryLimitMiB * 1024 * 1024);
    assert.equal(sandbox.cpuAffinity, name === "checker" ? "Checker" : "UserProgram");
  }
  assert.throws(() => roleProfile({ version: 1, roles: {} }, "checker"), /no execution profile for checker/);
});

test("a request without profiles (from an older backend) runs as before", () => {
  const { roles } = legacyProfiles({
    timeLimitMs: 5000,
    memoryLimitMiB: 512,
    stdTimeLimitMs: 1500,
    stdMemoryLimitMiB: 128,
    stdFileIo: { inputFilename: "a.in", outputFilename: "a.out" }
  });
  assert.deepEqual([roles.std.timeLimitMs, roles.std.memoryLimitMiB, roles.std.fileIo.inputFilename], [1500, 128, "a.in"]);
  assert.equal(roles.alternative.fileIo, undefined);
  assert.deepEqual([roles.checker.timeLimitMs, roles.checker.memoryLimitMiB, roles.checker.cpu], [5000, 512, "UserProgram"]);
  assert.deepEqual([roles.oracle.timeLimitMs, roles.oracle.memoryLimitMiB], [5000, 512]);
  assert.equal(roles.interactor.cpu, "Interactor");
  assert(Object.values(roles).every(profile => profile.testlib && profile.extraSources));
  assert.deepEqual(roles.validator.compileAndRunOptions, { compiler: "g++", std: "c++17", O: "2", m: "64" });
});

test("profiles are taken field by field, and nothing else", () => {
  const valid = contract.resolveAiProfiles({
    problemType: "Interaction",
    judgeInfo: { interactor: { filename: "i.cpp", language: "cpp", interface: "stdio", compileAndRunOptions: { compiler: "clang++", std: "c++20", O: "3", m: "64" }, sharedMemorySize: 16 } },
    timeLimitMs: 2000,
    memoryLimitMiB: 512,
    checker: false
  });
  assert.deepEqual(protocol.parseAiExecutionProfiles(JSON.parse(JSON.stringify(valid))), valid);
  const mutated = mutate => {
    const copy = structuredClone(valid);
    mutate(copy);
    return protocol.parseAiExecutionProfiles(copy);
  };
  for (const mutation of [
    profiles => (profiles.version = 2),
    profiles => (profiles.roles.grader = profiles.roles.std),
    profiles => (profiles.roles.std.extra = true),
    profiles => (profiles.roles.std.compileAndRunOptions.std = "c++98"),
    profiles => (profiles.roles.std.compileAndRunOptions.O = "4"),
    profiles => (profiles.roles.std.compileAndRunOptions.m = "x32"),
    profiles => (profiles.roles.std.compileAndRunOptions.flags = "-fsanitize=address"),
    profiles => (profiles.roles.std.timeLimitMs = 60001),
    profiles => (profiles.roles.std.memoryLimitMiB = 0),
    profiles => (profiles.roles.std.cpu = "Compiler"),
    profiles => (profiles.roles.std.fileIo = { inputFilename: "../x", outputFilename: "y" }),
    profiles => (profiles.roles.std.fileIo = { inputFilename: "same", outputFilename: "same" }),
    profiles => (profiles.roles.interactor.sharedMemorySize = 2048),
    profiles => (profiles.roles.std.origin = "judge")
  ])
    assert.equal(mutated(mutation), null, mutation.toString());
  // Equal profiles have equal digests whatever order their fields are in
  const reordered = { roles: Object.fromEntries(Object.entries(valid.roles).reverse()), version: 1 };
  assert.equal(protocol.aiContractDigest(reordered), protocol.aiContractDigest(valid));
  const longer = { ...valid, roles: { ...valid.roles, std: { ...valid.roles.std, timeLimitMs: 2001 } } };
  assert.notEqual(protocol.aiContractDigest(longer), protocol.aiContractDigest(valid));
});

// The published settings of a fixture problem, as the AI job publishes them
function publish(problemType, judgeInfo, profiles) {
  const published = { timeLimit: judgeInfo.timeLimit, memoryLimit: judgeInfo.memoryLimit, subtasks: [{ scoringType: "Sum", testcases: [] }] };
  if (profiles.roles.checker) published.checker = contract.publishedChecker(profiles, judgeInfo.checker, "ai-managed-x-checker.cpp");
  if (problemType !== "Traditional") {
    const role = problemType === "Interaction" ? "interactor" : "manager";
    published[role] = contract.publishedProtocolHelper(profiles, role, judgeInfo[role], `ai-managed-x-${role}.cpp`);
  } else
    published.selfEval = {
      validatorFile: "ai-managed-x-validator.cpp",
      ...(profiles.roles.std.fileIo ? { standardFileIo: profiles.roles.std.fileIo } : {}),
      limits: contract.selfEvalLimits(profiles)
    };
  return published;
}

// What the judge does with a compile: its compiler's parameters, with the bundled testlib.h and extra sources or not
const compiled = (options, testlib, extraSources) => ({
  parameters: cpp.compile({ sourcePathInside: "/s/main.cpp", binaryDirectoryInside: "/b", compileAndRunOptions: options }).parameters,
  testlib,
  extraSources
});

const custom = (fields = {}) => ({
  type: "custom",
  interface: "testlib",
  language: "cpp",
  compileAndRunOptions: { compiler: "g++", std: "c++17", O: "2", m: "64" },
  filename: "checker.cpp",
  ...fields
});
const helper = (iface, fields = {}) => ({
  interface: iface,
  language: "cpp",
  compileAndRunOptions: { compiler: "g++", std: "c++17", O: "2", m: "64" },
  filename: "helper.cpp",
  ...fields
});

const FIXTURES = [
  ["a checker the job writes", "Traditional", { timeLimit: 1000, memoryLimit: 256 }, true],
  ["a checker the job writes, for a problem with large limits", "Traditional", { timeLimit: 8000, memoryLimit: 1024 }, true],
  [
    "the problem's checker with other options and limits of its own",
    "Traditional",
    { timeLimit: 1000, memoryLimit: 256, checker: custom({ compileAndRunOptions: { compiler: "clang++", std: "c++20", O: "3", m: "64" }, timeLimit: 2000, memoryLimit: 300 }) },
    true
  ],
  ["the problem's checker with the problem's limits", "Traditional", { timeLimit: 1500, memoryLimit: 128, checker: custom() }, true],
  ["a reference solution with file I/O", "Traditional", { timeLimit: 1000, memoryLimit: 256, fileIo: { inputFilename: "a.in", outputFilename: "a.out" } }, false],
  ["an interactor the job writes", "Interaction", { timeLimit: 1000, memoryLimit: 256 }, false],
  [
    "the problem's interactor, with shared memory and a shorter time limit than the problem's",
    "Interaction",
    { timeLimit: 3000, memoryLimit: 512, interactor: helper("stdio", { compileAndRunOptions: { compiler: "g++", std: "gnu++20", O: "2", m: "64" }, timeLimit: 1000, memoryLimit: 64, sharedMemorySize: 16 }) },
    false
  ],
  ["the problem's communication manager", "Communication", { timeLimit: 2000, memoryLimit: 256, manager: helper("run-twice", { timeLimit: 9000 }) }, false]
];

for (const [name, problemType, judgeInfo, checker] of FIXTURES)
  test(`qualification and judging agree: ${name}`, () => {
    const profiles = contract.resolveAiProfiles({
      problemType,
      judgeInfo,
      timeLimitMs: judgeInfo.timeLimit,
      memoryLimitMiB: judgeInfo.memoryLimit,
      fileIo: judgeInfo.fileIo || null,
      checker
    });
    // What the AI runner gets is exactly what it accepts
    assert.deepEqual(protocol.parseAiExecutionProfiles(JSON.parse(JSON.stringify(profiles))), profiles);
    const published = publish(problemType, judgeInfo, profiles);
    assert.deepEqual(contract.profileDifferences(profiles, published, problemType), []);
    const { roles } = profiles;
    if (checker) {
      // The judge's checker: its compile (testlib, no extra sources) and limits (getCheckerMeta), as a Checker
      const meta = getCheckerMeta(published);
      assert.deepEqual(
        compiled(published.checker.compileAndRunOptions, published.checker.interface === "testlib", false),
        compiled(roles.checker.compileAndRunOptions, roles.checker.testlib, roles.checker.extraSources)
      );
      assert.deepEqual([meta.timeLimit, meta.memoryLimit], [roles.checker.timeLimitMs, roles.checker.memoryLimitMiB]);
      assert.equal(roles.checker.cpu, "Checker");
      if (!judgeInfo.checker) {
        // A generated checker's limits are written down, never inherited from the problem
        assert.equal(published.checker.timeLimit, Math.max(5000, judgeInfo.timeLimit));
        assert.equal(published.checker.memoryLimit, Math.max(256, judgeInfo.memoryLimit));
        assert.equal(roles.checker.origin, "ai");
      } else {
        assert.deepEqual({ ...published.checker, filename: "checker.cpp" }, judgeInfo.checker, "kept as it was");
        assert.equal(roles.checker.origin, "problem");
      }
    }
    if (problemType !== "Traditional") {
      const role = problemType === "Interaction" ? "interactor" : "manager";
      // The AI runner's protocol check gives the helper its profile's limits; the judge reads them the same way
      const judged = interactorLimits(published[role], published.timeLimit, published.memoryLimit);
      const checked = interactorLimits(
        { timeLimit: roles[role].timeLimitMs, memoryLimit: roles[role].memoryLimitMiB },
        roles.std.timeLimitMs,
        roles.std.memoryLimitMiB
      );
      assert.deepEqual(judged, checked);
      assert.deepEqual(
        compiled(published[role].compileAndRunOptions, true, true),
        compiled(roles[role].compileAndRunOptions, roles[role].testlib, roles[role].extraSources)
      );
      assert.equal(published[role].sharedMemorySize, roles[role].sharedMemorySize);
      assert.equal(roles[role].cpu, "Interactor");
    } else {
      // Self Eval runs the generator and validator with the limits they were checked with, and the reference solution
      // with its file I/O
      assert.deepEqual(published.selfEval.limits.generator, { timeLimit: roles.generator.timeLimitMs, memoryLimit: roles.generator.memoryLimitMiB });
      assert.deepEqual(published.selfEval.limits.validator, { timeLimit: roles.validator.timeLimitMs, memoryLimit: roles.validator.memoryLimitMiB });
      assert.deepEqual(published.selfEval.standardFileIo, roles.std.fileIo);
    }
    // Solutions run with the problem's limits as user programs; the job's own programs with its auxiliary budget
    for (const role of ["std", "alternative", "challenge"]) {
      assert.deepEqual([roles[role].timeLimitMs, roles[role].memoryLimitMiB, roles[role].cpu], [judgeInfo.timeLimit, judgeInfo.memoryLimit, "UserProgram"]);
      assert.equal(roles[role].extraSources, true);
    }
    for (const role of ["oracle", "generator", "validator"])
      assert.deepEqual([roles[role].timeLimitMs, roles[role].memoryLimitMiB, roles[role].extraSources], [5000, 512, false]);
  });

test("a checker can't have been checked with a larger budget than it's judged with", () => {
  const judgeInfo = { timeLimit: 1000, memoryLimit: 256 };
  const profiles = contract.resolveAiProfiles({ problemType: "Traditional", judgeInfo, timeLimitMs: 1000, memoryLimitMiB: 256, checker: true });
  const published = publish("Traditional", judgeInfo, profiles);
  // As before W02: the generated checker published without limits of its own gets the problem's 1000 ms and 256 MiB
  const unwritten = { ...published, checker: { ...published.checker } };
  delete unwritten.checker.timeLimit;
  delete unwritten.checker.memoryLimit;
  assert.equal(getCheckerMeta(unwritten).timeLimit, 1000);
  assert.deepEqual(contract.profileDifferences(profiles, unwritten, "Traditional"), ["checker limits"]);
  assert.deepEqual(contract.profileDifferences(profiles, { ...published, checker: { ...published.checker, timeLimit: 4999 } }, "Traditional"), ["checker limits"]);
  assert.deepEqual(
    contract.profileDifferences(profiles, { ...published, checker: { ...published.checker, compileAndRunOptions: { compiler: "g++", std: "c++17", O: "0", m: "64" } } }, "Traditional"),
    ["checker options"]
  );
  assert.deepEqual(contract.profileDifferences(profiles, { ...published, checker: { type: "tokens", caseSensitive: true } }, "Traditional"), ["checker unpublished"]);
  assert.deepEqual(
    contract.profileDifferences(profiles, { ...published, selfEval: { ...published.selfEval, limits: { generator: { timeLimit: 1000, memoryLimit: 256 } } } }, "Traditional"),
    ["generator limits", "validator limits"]
  );
  assert.deepEqual(contract.profileDifferences(profiles, { ...published, subtasks: [{ timeLimit: 2000, testcases: [] }] }, "Traditional"), ["subtask limits"]);
  // An interactor checked under the problem's memory but judged with less
  const interaction = contract.resolveAiProfiles({ problemType: "Interaction", judgeInfo, timeLimitMs: 1000, memoryLimitMiB: 256, checker: false });
  const helperSettings = publish("Interaction", judgeInfo, interaction).interactor;
  assert.deepEqual(
    contract.profileDifferences(interaction, { ...judgeInfo, interactor: { ...helperSettings, memoryLimit: 128 } }, "Interaction"),
    ["interactor limits"]
  );
});

test("the problem's helpers with settings the job can't check them with are refused before anything runs", () => {
  for (const settings of [
    { compileAndRunOptions: { compiler: "g++", std: "c++98", O: "2", m: "64" } },
    { compileAndRunOptions: { compiler: "tcc", std: "c++17", O: "2", m: "64" } },
    { timeLimit: 120000 },
    { memoryLimit: 8192 }
  ])
    assert.throws(
      () =>
        contract.resolveAiProfiles({
          problemType: "Traditional",
          judgeInfo: { timeLimit: 1000, memoryLimit: 256, checker: custom(settings) },
          timeLimitMs: 1000,
          memoryLimitMiB: 256,
          checker: true
        }),
      { code: "AI_HELPER_SETTINGS_UNSUPPORTED" }
    );
  // A custom checker the job can't read (no language) isn't the problem's: the job writes its own
  const profiles = contract.resolveAiProfiles({
    problemType: "Traditional",
    judgeInfo: { timeLimit: 1000, memoryLimit: 256, checker: { type: "custom", filename: "old.cpp" } },
    timeLimitMs: 1000,
    memoryLimitMiB: 256,
    checker: true
  });
  assert.equal(profiles.roles.checker.origin, "ai");
});
