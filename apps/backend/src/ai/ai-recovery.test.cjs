/* In-memory recovery and semantic-scope regressions. No API, DB or runner connections. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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
const { AiService } = require("./ai.service.ts");
const { outputCaseRule } = require("./ai-output-rules.ts");
const statement = (text, sectionTitle = "Description") => [
  { locale: "en_US", title: "Fixture", contentSections: [{ type: "Text", sectionTitle, text }] }
];
const original = () => ({
  id: 8,
  type: "Traditional",
  difficulty: 1200,
  tagIds: [1],
  statements: statement("Print the sum of the two integers."),
  samples: [{ inputData: "1 2\n", outputData: "3\n" }],
  judgeInfo: { timeLimit: 1000, memoryLimit: 128, fileIo: null }
});
function fixture() {
  const svc = new AiService(
    {},
    {},
    {},
    { userHasPrivilege: async () => true, permissionDecision: async () => true },
    {},
    {},
    {}
  );
  svc.checkpoint = async () => {};
  const snapshot = original();
  const job = {
    id: "memory-only",
    input: { count: 5 },
    state: {
      completed: [],
      discussionId: 31,
      plan: { subtasks: [{ id: 1, points: 100 }], needsSpj: false },
      makeCode: "int main(){/* make */}",
      stdCode: "int main(){/* std */}",
      validatorCode: "int main(){/* validator */}"
    }
  };
  job.state.testdataSnapshotHash = svc.testdataFingerprint(snapshot);
  const run = value => svc.testdata(job, { id: 1 }, { id: 8, type: "Traditional" }, {}, value, 0, 100);
  return { svc, snapshot, job, run };
}

test("resuming a bound cache reuses programs only for the same statement and judging settings", async () => {
  const { svc, snapshot, job, run } = fixture();
  let attempts = 0;
  svc.model = async () => {
    throw new Error("must not request another model output");
  };
  svc.runSandbox = async (_job, request) => {
    attempts++;
    assert.equal(request.stdCode, job.state.stdCode);
    throw new Error("STOP_RUNNER");
  };
  await assert.rejects(run(structuredClone(snapshot)), /STOP_RUNNER/);
  for (const modify of [
    s => {
      s.statements[0].contentSections[0].text = "Print the product instead.";
    },
    s => {
      s.samples[0].outputData = "2\n";
    },
    s => {
      s.judgeInfo.timeLimit = 2000;
    },
    s => {
      s.judgeInfo.memoryLimit = 256;
    },
    s => {
      s.judgeInfo.fileIo = { inputFilename: "data.in", outputFilename: "data.out" };
    },
    s => {
      s.judgeInfo.subtasks = [
        { points: 100, scoringType: "GroupMin", testcases: [{ inputFile: "manual.in", outputFile: "manual.out" }] }
      ];
    }
  ]) {
    const changed = structuredClone(snapshot);
    modify(changed);
    await assert.rejects(run(changed), /PROBLEM_CHANGED_DURING_AI/);
  }
  assert.equal(attempts, 1, "stale programs must never reach the runner");
  assert.equal(
    svc.testdataFingerprint({ judgeInfo: snapshot.judgeInfo, ...snapshot }),
    svc.testdataFingerprint(snapshot),
    "key ordering must not affect the fingerprint"
  );
});

test('old bound and published hashes resume after source-title snapshot expansion', async () => {
  for (const published of [false, true]) {
    const {svc, snapshot, job, run} = fixture();
    const legacy = structuredClone(snapshot);
    if (published) {
      legacy.judgeInfo.timeLimit = 2000;
      legacy.submittable = true;
      job.state.testdataPublishedSnapshotHash = svc.testdataFingerprint(legacy);
    }
    const current = {...legacy, originalProblemTitle: 'Source display title added to commit snapshots'};
    const oldHash = published ? job.state.testdataPublishedSnapshotHash : job.state.testdataSnapshotHash;
    assert.equal(svc.testdataFingerprint(current), oldHash, 'the new display label cannot invalidate a durable checkpoint');
    assert.equal(svc.sampleIndependentFingerprint(current), svc.sampleIndependentFingerprint(legacy));
    svc.model = async () => assert.fail('unchanged checkpoint must reuse its cached programs');
    let attempts = 0;
    svc.runSandbox = async () => {attempts++; throw new Error('LEGACY_PROGRAMS_REUSED');};
    await assert.rejects(run(current), /LEGACY_PROGRAMS_REUSED/);
    for (const modify of [
      s => {s.statements[0].contentSections[0].text = 'A genuinely changed problem rule';},
      s => {s.judgeInfo.memoryLimit = 512;},
      s => {s.originalProblem = 'https://example.org/a-different-source';}
    ]) {
      const changed = structuredClone(current); modify(changed);
      await assert.rejects(run(changed), /PROBLEM_CHANGED_DURING_AI/);
    }
    assert.equal(attempts, 1, 'semantic or judging changes still cannot reach the runner');
  }
});

test("a legacy cache without a fingerprint is discarded before a fresh plan is requested", async () => {
  const { svc, snapshot, job, run } = fixture();
  delete job.state.testdataSnapshotHash;
  job.state.testdataPublishedSnapshotHash = "obsolete";
  job.state.generated = { count: 5 };
  svc.model = async () => {
    for (const field of [
      "plan",
      "makeCode",
      "stdCode",
      "checkerCode",
      "validatorCode",
      "generated",
      "testdataPublishedSnapshotHash"
    ])
      assert.equal(job.state[field], undefined);
    assert.equal(job.state.testdataSnapshotHash, svc.testdataFingerprint(snapshot));
    throw new Error("FRESH_PLAN_REQUESTED");
  };
  await assert.rejects(run(snapshot), /FRESH_PLAN_REQUESTED/);
  assert.equal(job.state.discussionId, 31, "committed tutorial identity must be retained");
});

test("retry after changed statements clears only generation cache and binds the new snapshot", async () => {
  const { svc, snapshot, job, run } = fixture();
  job.state.completed = ["import", "translate", "tutorial"];
  job.state.testdataPublishedSnapshotHash = "old-publication";
  job.state.generated = { count: 5 };
  job.state = svc.retryState({ state: job.state, error: "PROBLEM_CHANGED_DURING_AI" });
  for (const field of [
    "testdataSnapshotHash",
    "testdataPublishedSnapshotHash",
    "plan",
    "makeCode",
    "stdCode",
    "validatorCode",
    "generated"
  ])
    assert.equal(job.state[field], undefined);
  assert.equal(job.state.discussionId, 31);
  assert.deepEqual(job.state.completed, ["import", "translate", "tutorial"]);
  snapshot.statements[0].contentSections[0].text = "New problem specification";
  svc.model = async (_config, prompt) => {
    assert(prompt.includes("New problem specification"));
    throw new Error("NEW_PLAN_REQUESTED");
  };
  await assert.rejects(run(snapshot), /NEW_PLAN_REQUESTED/);
  assert.equal(job.state.testdataSnapshotHash, svc.testdataFingerprint(snapshot));
});

test("an exact checkpointed self-publication is an allowed recovery baseline, other edits are not", async () => {
  const { svc, snapshot, job, run } = fixture();
  const published = structuredClone(snapshot);
  published.judgeInfo = {
    ...published.judgeInfo,
    timeLimit: 2000,
    subtasks: [
      {
        points: 100,
        scoringType: "GroupMin",
        testcases: [{ inputFile: "ai-managed-old-1.in", outputFile: "ai-managed-old-1.out" }]
      }
    ]
  };
  job.state.testdataPublishedSnapshotHash = svc.testdataFingerprint(published);
  svc.runSandbox = async () => {
    throw new Error("CACHED_PROGRAMS_REUSED");
  };
  await assert.rejects(run(published), /CACHED_PROGRAMS_REUSED/);
  assert.equal(
    job.state.testdataSnapshotHash,
    svc.testdataFingerprint(published),
    "rebase before any subsequent publication checkpoint"
  );
  const edited = structuredClone(published);
  edited.judgeInfo.memoryLimit = 512;
  await assert.rejects(run(edited), /PROBLEM_CHANGED_DURING_AI/);
});

test("all-pipeline metadata and translation changes happen before generation fingerprint binding", async () => {
  const { svc, snapshot, job } = fixture();
  job.state = { completed: [] };
  job.action = "all";
  job.ownerId = 1;
  job.problemId = 8;
  svc.config = async () => ({});
  svc.assertJob = async () => ({ id: 1 });
  svc.editable = async () => ({ id: 8, type: "Traditional" });
  svc.snapshot = async () => structuredClone(snapshot);
  svc.edit = async (_job, _user, _problem, _config, _snapshot, action) => {
    assert.equal(job.state.testdataSnapshotHash, undefined);
    if (action === "translate")
      snapshot.statements.push({
        locale: "zh_CN",
        title: "已翻译题目",
        contentSections: [{ type: "Text", sectionTitle: "描述", text: "输出两数之和。" }]
      });
    if (action === "tags") snapshot.tagIds = [2, 3];
    if (action === "difficulty") snapshot.difficulty = 800;
  };
  svc.model = async () => {
    assert.equal(job.state.testdataSnapshotHash, svc.testdataFingerprint(snapshot));
    throw new Error("LATEST_SNAPSHOT_BOUND");
  };
  await assert.rejects(svc.execute(job), /LATEST_SNAPSHOT_BOUND/);
});

test("case-insensitive input processing never overrides an explicitly case-sensitive output", () => {
  for (const input of [
    statement(
      "Perform case-insensitive dictionary lookup. Output the original stored spelling exactly; output is case-sensitive."
    ),
    statement("输入匹配不区分大小写；输出必须严格区分大小写。"),
    statement("The output is not case-insensitive.", "Output"),
    statement("Do not ignore case when comparing the output.", "Output")
  ])
    assert.equal(outputCaseRule(input).caseSensitive, true);
});

test("output-context rules permit case folding but ambiguous input-only mentions defer to the model", () => {
  for (const input of [
    statement("Letter case is ignored.", "Output"),
    statement("Print YES or NO. Letter case is ignored."),
    statement("答案不区分大小写。"),
    statement("Output is not case-sensitive.", "Output")
  ])
    assert.equal(outputCaseRule(input).caseSensitive, false);
  assert.deepEqual(outputCaseRule(statement("Perform case-insensitive dictionary lookup.")), { uncertain: true });
  assert.deepEqual(outputCaseRule(statement("Read integers and print their sum.")), { uncertain: false });
});

test("ambiguous case instructions preserve the model decision and attach a review warning", async () => {
  const { svc, snapshot, job, run } = fixture();
  snapshot.statements = statement("Perform case-insensitive dictionary lookup.");
  job.state.plan.caseSensitive = true;
  job.state.testdataSnapshotHash = svc.testdataFingerprint(snapshot);
  svc.runSandbox = async () => {
    throw new Error("MOCK_STOP");
  };
  await assert.rejects(run(snapshot), /MOCK_STOP/);
  assert.equal(job.state.plan.caseSensitive, true);
  assert.equal(job.state.plan.needsSpj, false);
  assert(job.state.warnings.includes("OUTPUT_CASE_REVIEW_RECOMMENDED"));
});
