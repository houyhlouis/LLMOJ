/* Pure regressions for content normalization, proportional data allocation and import metadata. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const { allocateAiTestcases } = require("./ai-case-allocation.ts");
const { normalizeAiMarkdown, normalizeAiSections } = require("./ai-content.ts");
const { parseAiImportHints } = require("./ai-import-hints.ts");
const { signAiAttachment, readAiAttachment } = require("./ai-attachment.ts");
const { normalizeProblemSource, problemSourceLabel } = require("../problem/problem-source.ts");
const { AiService } = require("./ai.service.ts");
const { AiError } = require("./ai.types.ts");
const { AiJobEntity } = require("./ai.entity.ts");
const { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts");
const { UserPrivilegeType } = require("../user/user-privilege.service.ts");

test("equal-point allocation raises 5 to 6 for 50/50 and preserves each exact declared weight", () => {
  const allocation = allocateAiTestcases(
    [
      { id: 1, points: 50 },
      { id: 2, points: 50 }
    ],
    5
  );
  assert.equal(allocation.count, 6);
  assert.deepEqual(
    allocation.allocations.map(x => x.count),
    [3, 3]
  );
  assert.deepEqual(allocation.cases, [
    { subtask: 1, seed: 1 },
    { subtask: 1, seed: 2 },
    { subtask: 1, seed: 3 },
    { subtask: 2, seed: 1 },
    { subtask: 2, seed: 2 },
    { subtask: 2, seed: 3 }
  ]);
  for (const weights of [
    [10, 30, 60],
    [12.5, 37.5, 50],
    [33, 33, 34],
    [1, 99]
  ]) {
    const result = allocateAiTestcases(
      weights.map((points, index) => ({ id: index + 1, points })),
      21
    );
    assert(result.count >= 21 && result.count <= 1000);
    assert.equal(
      result.allocations.reduce((sum, x) => sum + x.count, 0),
      result.count
    );
    for (const group of result.allocations) assert(Math.abs(group.points / group.count - result.pointsPerCase) < 1e-10);
  }
});
test("fractional weights retain exact counts when their ratio fits the hard cap", () => {
  const result = allocateAiTestcases(
    [
      { id: 1, points: 0.1 },
      { id: 2, points: 99.9 }
    ],
    1000
  );
  assert.equal(result.count, 1000);
  assert.deepEqual(
    result.allocations.map(x => x.count),
    [1, 999]
  );
});
test("allocation rejects zero/negative/inexact totals and cap overflow", () => {
  for (const weights of [
    [0, 100],
    [-1, 101],
    [30, 30],
    [NaN, 100],
    [0.000001, 99.999999]
  ])
    assert.throws(
      () =>
        allocateAiTestcases(
          weights.map((points, index) => ({ id: index + 1, points })),
          5
        ),
      AiError
    );
  assert.throws(
    () =>
      allocateAiTestcases(
        [
          { id: 1, points: 1.25 },
          { id: 2, points: 98.75 }
        ],
        999
      ),
    /TEST_COUNT_RATIO_UNREPRESENTABLE/
  );
});
test("limits sections merge at their original first position, preserving subtasks, scores and samples", () => {
  const original = {
    locale: "zh_CN",
    title: "例题",
    contentSections: [
      { type: "Text", sectionTitle: "题目描述", text: "Read a value." },
      { type: "Text", sectionTitle: "数据范围", text: "1 ≤ n ≤ 100" },
      { type: "Sample", sectionTitle: "样例", sampleId: 0 },
      { type: "Text", sectionTitle: "子任务", text: "子任务 1：30 分。" },
      { type: "Text", sectionTitle: "提示", text: "Overflow is possible." }
    ]
  };
  const normalized = normalizeAiSections(original);
  assert.equal(normalized.contentSections.length, 3);
  assert.equal(normalized.contentSections[1].sectionTitle, "数据范围与提示");
  for (const phrase of ["1 ≤ n ≤ 100", "子任务 1：30 分。", "Overflow is possible."])
    assert(normalized.contentSections[1].text.includes(phrase));
  assert.deepEqual(normalized.contentSections[2], original.contentSections[2]);
  assert.equal(original.contentSections.length, 5, "do not mutate the input checkpoint");
});
test("explicit LaTeX delimiters normalize while ordinary parentheses and code remain literal", () => {
  const original =
    'Value \\(x+1\\), display \\[a^2+b^2\\], normal (x), code `\\(code\\)`\n```cpp\ncout << "\\\\(literal\\\\)";\n```';
  const result = normalizeAiMarkdown(original);
  assert(result.includes("$x+1$"));
  assert(result.includes("$$\na^2+b^2\n$$"));
  assert(result.includes("normal (x)"));
  assert(result.includes("`\\(code\\)`"));
  assert(result.includes('cout << "\\\\(literal\\\\)";'));
});
test("Markdown code fences and multi-backtick inline spans protect embedded delimiter-looking source text", () => {
  for (const value of [
    '```cpp\nstd::string ticks="```";\nstd::string latex="\\(literal\\)";\n```',
    "``A literal ` and \\(formula\\) remain code``",
    '~~~~cpp\nconst char* a="~~~~";\nconst char* b="\\[code\\]";\n~~~~'
  ])
    assert.equal(normalizeAiMarkdown(value), value);
});
test("import hints parse explicit millisecond/second and memory units without altering unrelated text", () => {
  assert.deepEqual(parseAiImportHints("Time Limit: 2s\nMemory Limit: 1GB\nfileio: answer"), {
    timeLimit: 2000,
    memoryLimit: 1024,
    fileIo: { inputFilename: "answer.in", outputFilename: "answer.out" }
  });
  assert.deepEqual(parseAiImportHints("time limit: 1500 ms; memory limit: 65536 KiB; fileio: stdio"), {
    timeLimit: 1500,
    memoryLimit: 64,
    fileIo: null
  });
  assert.deepEqual(parseAiImportHints("A statement discussing a time limit without a metadata declaration."), {});
  assert.throws(() => parseAiImportHints("time limit: 61s"), /INVALID_AI_RESOURCE_LIMITS/);
  assert.throws(() => parseAiImportHints("fileio: ../secret"), /INVALID_AI_FILE_IO/);
});
test("Chinese resource hints recognize milliseconds and cannot reinterpret excessive seconds as milliseconds", () => {
  assert.deepEqual(parseAiImportHints("时间限制：50 毫秒\n空间限制：128 MB"), { timeLimit: 50, memoryLimit: 128 });
  assert.throws(() => parseAiImportHints("时间限制：100 秒"), /INVALID_AI_RESOURCE_LIMITS/);
});
test("QOJ contest aliases become direct global problem links while unrelated paths and ports remain untouched", () => {
  for (const url of [
    "https://qoj.ac/contest/123/problem/456",
    "http://www.qoj.ac/problem/456/",
    "https://qoj.ac:443/contest/123/problem/456?locale=en"
  ])
    assert.equal(normalizeProblemSource(url), "https://qoj.ac/problem/456");
  for (const url of [
    "https://qoj.ac:444/contest/123/problem/456",
    "https://qoj.ac/problem/456/editorial",
    "https://qoj.ac.evil.test/problem/456"
  ])
    assert.equal(normalizeProblemSource(url), url);
  assert.equal(problemSourceLabel("https://qoj.ac/contest/123/problem/456", "Sample Title"), "QOJ 456 Sample Title");
});
test("attachment tokens bind owner, filename/size and upload UUID, including admitted-job expiry semantics", () => {
  const key = crypto.randomBytes(32),
    now = Date.now(),
    value = { ownerId: 7, uuid: crypto.randomUUID(), filename: "samples.zip", size: 123, expires: now + 1000 };
  const token = signAiAttachment(key, value);
  assert.deepEqual(readAiAttachment(key, token, 7, now), value);
  assert.throws(() => readAiAttachment(key, token, 8, now), /INVALID_ATTACHMENT_TOKEN/);
  assert.throws(() => readAiAttachment(key, token, 7, now + 2000), /INVALID_ATTACHMENT_TOKEN/);
  assert.deepEqual(
    readAiAttachment(key, token, 7, now),
    value,
    "job admitted before expiry can resume later using its trusted admission time"
  );
  for (const changed of [
    { ...value, filename: "../../samples.zip" },
    { ...value, size: 67108865 },
    { ...value, filename: "data.cpp" }
  ])
    assert.throws(() => readAiAttachment(key, signAiAttachment(key, changed), 7, now), /INVALID_ATTACHMENT_TOKEN/);
  const [payload, signature] = token.split(".");
  const other = Buffer.from(JSON.stringify({ ...value, size: 1 })).toString("base64url");
  assert.throws(() => readAiAttachment(key, other + "." + signature, 7, now), /INVALID_ATTACHMENT_TOKEN/);
});
function tutorialFixture() {
  const rows = [],
    saved = [],
    models = [];
  const user = { id: 1 },
    problem = { id: 1, isPublic: false, originalProblem: "" };
  const service = Object.create(AiService.prototype);
  service.model = async (_config, prompt) => {
    models.push(prompt);
    return { zh_CN: "中文 \\(x\\) 题解", en_US: "English \\(x\\) tutorial" };
  };
  service.assertSnapshot = async () => user;
  service.checkpoint = async () => {};
  service.discussions = {
    userHasCreateDiscussionPermission: async () => true,
    createDiscussion: async (_user, title, content, _problem, onCreated, authorizeCommit) => {
      const row = { id: rows.length + 100, title, content };
      const manager = {
        update: async (entity, where, value) => {
          saved.push({ entity, where, value });
          return { affected: 1 };
        }
      };
      await authorizeCommit(fixtureManager);
      await onCreated(row, manager);
      rows.push(row);
      return row;
    }
  };
  const snapshot = { statements: [], samples: [], judgeInfo: { fileIo: null } },
    job = { id: "tutorial-job", runToken: "lease", state: {}, progress: 20 };
  const fixtureManager = require("./ai-commit.fixture.cjs").commitFixture(service, job, problem, snapshot);
  return {
    service,
    rows,
    saved,
    models,
    job,
    fixtureManager,
    run: () => service.edit(job, user, problem, { search: {} }, snapshot, "tutorial")
  };
}
test("tutorial generation creates two separate localized discussions and resumes without duplicates", async () => {
  const fixture = tutorialFixture();
  await fixture.run();
  assert.deepEqual(
    fixture.rows.map(x => x.title),
    ["题解-AI", "Tutorial-AI"]
  );
  assert.equal(fixture.rows[0].content, "中文 $x$ 题解");
  assert.equal(fixture.rows[1].content, "English $x$ tutorial");
  assert.deepEqual(fixture.job.state.discussionIds, { zh_CN: 100, en_US: 101 });
  assert.equal(fixture.job.state.discussionId, 100);
  assert(fixture.saved.some(item => item.value.isPublic === false));
  await fixture.run();
  assert.equal(fixture.rows.length, 2);
  assert.equal(fixture.models.length, 1);
});
test("localized tutorial transaction checkpoint fences stale workers and rolls back partial creation", async () => {
  const fixture = tutorialFixture();
  fixture.service.discussions.createDiscussion = async (_user, _title, _content, _problem, onCreated, authorizeCommit) => {
    await authorizeCommit(fixture.fixtureManager);
    await onCreated(
      { id: 1 },
      {
        update: async (entity, where) => {
          if (entity === AiJobEntity) {
            assert.deepEqual(where, { id: fixture.job.id, status: "running", runToken: "lease" });
            return { affected: 0 };
          }
          return { affected: 1 };
        }
      }
    );
    throw Error("must reject before committing this discussion");
  };
  await assert.rejects(fixture.run(), /JOB_LEASE_LOST/);
});
test("malformed tutorial model responses reject as an AiError before creating discussions", async () => {
  for (const value of [null, {}, false, { zh_CN: "中文", en_US: null }]) {
    const fixture = tutorialFixture();
    fixture.service.model = async () => value;
    await assert.rejects(fixture.run(), error => error instanceof AiError && error.code === "INVALID_AI_TUTORIAL");
    assert.equal(fixture.rows.length, 0);
  }
});
test("stale worker authorization and checkpoint compare-and-swap reject before overwriting state", async () => {
  const service = Object.create(AiService.prototype),
    job = { id: "old-job", runToken: "old", state: {}, progress: 0 };
  service.jobs = { findOneBy: async () => ({ id: job.id, runToken: "new", status: "running" }) };
  await assert.rejects(service.assertJob(job), /JOB_LEASE_LOST/);
  service.assertJob = async () => ({ id: 1 });
  service.jobs.update = async where => {
    assert.deepEqual(where, { id: job.id, runToken: "old" });
    return { affected: 0 };
  };
  await assert.rejects(service.checkpoint(job, "step", 30), /JOB_LEASE_LOST/);
});
function importFixture(markdown, judgeInfo = { timeLimit: 1000, memoryLimit: 64, fileIo: null }) {
  const service = Object.create(AiService.prototype),
    writes = [];
  const job = {
    id: "import-job",
    runToken: "claim",
    input: { count: 5, markdown },
    state: { completed: [] },
    progress: 0
  };
  service.requirePrivilege = async () => {};
  service.assertJob = async () => ({ id: 1 });
  service.checkpoint = async () => {};
  service.installAttachment = async () => {};
  service.model = async () => ({
    localizedContents: [
      {
        locale: "en_US",
        title: "Fixture",
        contentSections: [{ type: "Text", sectionTitle: "Description", text: "Read a value." }]
      }
    ],
    samples: [],
    judgeInfo
  });
  service.problems = {
    userHasCreateProblemPermission: async () => true,
    createProblem: async (_user, _type, statement, _tags, onCreated, authorizeCommit) => {
      const manager = {
        findOneBy: async () => ({ judgeInfo: { timeLimit: 1000, memoryLimit: 128, fileIo: null, subtasks: [] } }),
        update: async (entity, where, value) => {
          writes.push({ entity, where, value });
          return { affected: 1 };
        }
      };
      await authorizeCommit(manager);
      await onCreated({ id: 99 }, manager);
      return { id: 99 };
    }
  };
  return { service, job, writes, run: () => service.importProblem(job, { id: 1 }, {}) };
}
test("explicit import metadata overrides model suggestions atomically with the new problem", async () => {
  const fixture = importFixture("Time Limit: 2s\nMemory Limit: 256 MiB\nfileio: task");
  await fixture.run();
  const settings = fixture.writes.find(item => item.entity === ProblemJudgeInfoEntity).value.judgeInfo;
  assert.equal(settings.timeLimit, 2000);
  assert.equal(settings.memoryLimit, 256);
  assert.deepEqual(settings.fileIo, { inputFilename: "task.in", outputFilename: "task.out" });
  const binding = fixture.writes.find(item => item.entity === AiJobEntity);
  assert.deepEqual(binding.where, { id: "import-job", status: "running", runToken: "claim" });
  assert.equal(binding.value.problemId, 99);
  const stdio = importFixture("fileio: stdio", {
    timeLimit: 1000,
    memoryLimit: 64,
    fileIo: { inputFilename: "guessed.in", outputFilename: "guessed.out" }
  });
  await stdio.run();
  assert.equal(stdio.writes.find(item => item.entity === ProblemJudgeInfoEntity).value.judgeInfo.fileIo, null);
});
test("invalid model-import limits fail before binding a created problem to the task", async () => {
  const fixture = importFixture("Read a value.", { timeLimit: 60001, memoryLimit: 64, fileIo: null });
  await assert.rejects(fixture.run(), /INVALID_AI_RESOURCE_LIMITS/);
  assert(!fixture.writes.some(item => item.entity === AiJobEntity));
  assert.equal(fixture.job.problemId, undefined);
});
test("attachment preparation enforces all import privileges before creating a signed upload", async () => {
  const service = Object.create(AiService.prototype),
    checked = [];
  service.key = crypto.randomBytes(32);
  service.requirePrivilege = async (_user, privilege) => checked.push(privilege);
  service.problems = { userHasCreateProblemPermission: async () => true };
  const uuid = crypto.randomUUID();
  service.files = {
    prepareUploadRequest: async (size, validate) => {
      assert.equal(validate(size), null);
      return { uuid, uploadUrl: "http://127.0.0.1/synthetic-only" };
    }
  };
  const result = await service.prepareAttachment({ id: 7 }, { filename: "samples.zip", size: 123 });
  assert.deepEqual(checked, [
    UserPrivilegeType.UseAi,
    UserPrivilegeType.ImportProblem,
    UserPrivilegeType.GenerateTestdata
  ]);
  assert.equal(readAiAttachment(service.key, result.attachmentToken, 7).uuid, uuid);
  service.requirePrivilege = async () => {
    throw new AiError("PERMISSION_DENIED");
  };
  service.files.prepareUploadRequest = () => {
    throw Error("must not create upload");
  };
  await assert.rejects(
    service.prepareAttachment({ id: 7 }, { filename: "samples.zip", size: 123 }),
    /PERMISSION_DENIED/
  );
});
