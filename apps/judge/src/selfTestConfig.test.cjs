// The self-test's configuration never carries the judge's key or uses the judge's directories.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const loaded = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  ts.transpileModule(fs.readFileSync(path.join(__dirname, "selfTestConfig.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText
)(require, loaded, loaded.exports);
const { deriveSelfTestConfig } = loaded.exports;

test("the self-test runs with its own directories and without the judge's key", () => {
  const judge = {
    serverUrl: "http://127.0.0.1:2002",
    key: "c2VjcmV0LWp1ZGdlLWtleS1kby1ub3QtbGVhay0xMg==",
    dataStore: "/opt/LLMOJ/data/judge/testdata",
    binaryCacheStore: "/opt/LLMOJ/data/judge/cache",
    taskWorkingDirectories: ["/opt/LLMOJ/data/judge/work/1", "/opt/LLMOJ/data/judge/work/2", "/opt/LLMOJ/data/judge/work/3"],
    maxConcurrentTasks: 3,
    taskConsumingThreads: 3,
    aiRunnerSocket: "/opt/LLMOJ/data/judge/ai-runner.sock",
    aiGeneratedDirectory: "/opt/LLMOJ/data/ai-generated",
    sandbox: { rootfs: "/opt/LLMOJ/runtime/sandbox-rootfs", syscallFilter: true },
    cpuAffinity: { compiler: [1, 2] }
  };
  const derived = deriveSelfTestConfig(judge, "/tmp/llmoj-judge-self-test-x");
  assert.equal(JSON.stringify(derived).includes(judge.key), false, "the key is never copied");
  assert.match(derived.key, /^A{40}$/);
  for (const directory of [derived.dataStore, derived.binaryCacheStore, ...derived.taskWorkingDirectories])
    assert.ok(directory.startsWith("/tmp/llmoj-judge-self-test-x/"), directory);
  assert.deepEqual([derived.maxConcurrentTasks, derived.taskWorkingDirectories.length], [2, 2]);
  assert.deepEqual([derived.aiRunnerSocket, derived.aiGeneratedDirectory], [null, null]);
  // The sandbox and CPUs are the judge's, so that it checks what judging uses
  assert.deepEqual([derived.sandbox, derived.cpuAffinity, derived.serverUrl], [judge.sandbox, judge.cpuAffinity, judge.serverUrl]);
});
