/* Credential-free tests of AI tutorials' code tied to the reference solution (review Part III, H08/W06). */
// A job's tutorial keeps the code it shows; the job records whether that code passed or failed the official samples
// and whether its published test data was made with it; readers see that; and the owner can have the tutorials' code
// replaced by the reference solution, in the same discussions, without anything else of the job running again.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
const { aiServices } = require("./ai-test-services.cjs");
const { AiError } = require("./ai.types.ts");
const {
  AI_TUTORIAL_CODE_PLACEHOLDER,
  correctedTutorial,
  tutorialBindingsOf,
  tutorialCodeStatus,
  tutorialCorrectionRefusal,
  tutorialViews
} = require("./ai-tutorial-binding.ts");

const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
const wrong = '#include <cstdio>\nint main(){long long a,b;scanf("%lld%lld",&a,&b);printf("%lld\\n",a+b+1);}';
const right = '#include <cstdio>\nint main(){long long a,b;scanf("%lld%lld",&a,&b);printf("%lld\\n",a+b);}';
const tutorial = (text, code) => `## ${text}\n\nAdd the two numbers.\n\n\`\`\`cpp\n${code}\n\`\`\`\n`;
const binding = (discussionId, locale, code) => ({
  discussionId,
  locale,
  sha256: code ? sha256(code) : null,
  at: "2026-11-05T00:00:00.000Z"
});

test("a tutorial's status follows what its code passed and the code the test data was made with", () => {
  const checks = {
    [sha256(wrong)]: { result: "rejected", samples: 1, observationId: "o", at: "" },
    [sha256(right)]: { result: "passed", samples: 1, at: "" }
  };
  assert.equal(tutorialCodeStatus({ sha256: null }, checks, null), "no-code");
  assert.equal(tutorialCodeStatus({ sha256: sha256("other") }, checks, null), "unchecked");
  assert.equal(tutorialCodeStatus({ sha256: sha256(right) }, checks, null), "passed-samples");
  assert.equal(tutorialCodeStatus({ sha256: sha256(right) }, checks, sha256(right)), "qualified");
  // Rejected stays rejected, whatever was published after
  assert.equal(tutorialCodeStatus({ sha256: sha256(wrong) }, checks, null), "rejected");
  assert.equal(tutorialCodeStatus({ sha256: sha256(wrong) }, checks, sha256(right)), "rejected");
  // The test data was made with another program: this code wasn't checked as the reference
  assert.equal(tutorialCodeStatus({ sha256: sha256(right) }, checks, sha256("repaired")), "superseded");
  assert.equal(tutorialCodeStatus({ sha256: sha256("other") }, checks, sha256(right)), "superseded");
});

test("the owner's view, also of a job from before tutorials' code was kept", () => {
  const state = {
    tutorialBindings: [binding(7, "zh_CN", wrong), binding(8, "en_US", right)],
    tutorialChecks: {
      [sha256(wrong)]: {
        result: "rejected",
        samples: 2,
        subject: "sample 2",
        reason: "WA",
        observationId: "o1",
        at: ""
      }
    },
    generated: { count: 5 },
    stdCode: right
  };
  assert.deepEqual(tutorialViews(state), [
    {
      discussionId: 7,
      locale: "zh_CN",
      status: "rejected",
      samplesPassed: 2,
      subject: "sample 2",
      reason: "WA",
      observationId: "o1"
    },
    { discussionId: 8, locale: "en_US", status: "qualified" }
  ]);
  const legacy = {
    discussionIds: { zh_CN: 7, en_US: 8 },
    tutorialContents: { zh_CN: tutorial("题解", wrong), en_US: tutorial("Tutorial", right) },
    generated: { count: 5 },
    stdCode: right
  };
  assert.deepEqual(
    tutorialBindingsOf(legacy).map(item => [item.discussionId, item.sha256]),
    [
      [7, sha256(wrong)],
      [8, sha256(right)]
    ]
  );
  assert.deepEqual(
    tutorialViews(legacy).map(view => view.status),
    ["superseded", "qualified"]
  );
  assert.deepEqual(tutorialViews({}), []);
});

test("a correction needs a tutorial to correct, published test data, and a solution submissions could use", () => {
  const state = {
    tutorialBindings: [binding(7, "zh_CN", wrong)],
    tutorialChecks: { [sha256(wrong)]: { result: "rejected", samples: 1, at: "" } },
    generated: { count: 5 },
    stdCode: right,
    stdFileIo: null
  };
  assert.equal(tutorialCorrectionRefusal(state, null), null);
  assert.equal(
    tutorialCorrectionRefusal({ ...state, tutorialBindings: [binding(7, "zh_CN", right)] }, null),
    "NOTHING_TO_CORRECT"
  );
  // A rejected tutorial stays to correct, but there's no reference solution to correct it with yet
  assert.equal(tutorialCorrectionRefusal({ ...state, generated: undefined }, null), "NO_REFERENCE");
  assert.equal(
    tutorialCorrectionRefusal({ ...state, tutorialChecks: {}, generated: undefined }, null),
    "NOTHING_TO_CORRECT"
  );
  const files = { inputFilename: "a.in", outputFilename: "a.out" };
  // A model-written reference solution reads stdin: it isn't a submission of a problem judged with files
  assert.equal(tutorialCorrectionRefusal(state, files), "FILE_IO");
  assert.equal(tutorialCorrectionRefusal({ ...state, stdFileIo: files }, files), null);
});

test("a corrected tutorial shows exactly the reference solution, and no other program", () => {
  const text = `Explanation.\n\n${AI_TUTORIAL_CODE_PLACEHOLDER}\n\nComplexity: O(1).`;
  const content = correctedTutorial(text, right, false);
  assert(content.includes(`\`\`\`cpp\n${right}\n\`\`\``));
  assert(content.startsWith("Explanation."));
  assert.equal(correctedTutorial("No placeholder", right, false), null);
  assert.equal(correctedTutorial(`${text}\n${AI_TUTORIAL_CODE_PLACEHOLDER}`, right, false), null);
  assert.equal(correctedTutorial(`${text}\n\n\`\`\`cpp\n${wrong}\n\`\`\``, right, false), null, "another program");
  assert.equal(correctedTutorial(42, right, false), null);
});

// The workflow, with stubbed services
function fixture({ state = {}, discussions = {}, rows = [], jobs = {}, permission = true } = {}) {
  const user = { id: 1 };
  const records = { created: [], updated: [], audits: [], visibility: [], checkpoints: [] };
  const stored = new Map([
    [7, { id: 7, title: "题解-AI", isPublic: false, type: "Solution", problemId: 8, content: tutorial("题解", wrong) }],
    [
      8,
      {
        id: 8,
        title: "Tutorial-AI",
        isPublic: false,
        type: "Solution",
        problemId: 8,
        content: tutorial("Tutorial", wrong)
      }
    ]
  ]);
  const db = {
    getRepository: () => ({ findOneBy: async ({ id }) => stored.get(id) || null }),
    // The problem's jobs' bindings, then one job's state (a string, as MariaDB returns its column)
    query: async (sql, [id]) =>
      /^SELECT state FROM ai_job WHERE id = \?$/.test(sql)
        ? jobs[id]
          ? [{ state: JSON.stringify(jobs[id].state) }]
          : []
        : rows
  };
  const svc = aiServices(
    db,
    {},
    {},
    { userHasPrivilege: async () => true, permissionDecision: async () => true },
    {},
    {
      userHasCreateDiscussionPermission: async () => true,
      userHasPermission: async () => permission,
      getDiscussionContent: async discussion => discussion.content,
      createDiscussion: async (_user, title, content) => {
        records.created.push({ title, content });
        return { id: records.created.length + 100 };
      },
      updateDiscussionTitleAndContent: async (discussion, title, content) => {
        records.updated.push({ id: discussion.id, title, content });
        discussion.content = content;
      },
      setDiscussionPublic: async (discussion, isPublic) => records.visibility.push({ id: discussion.id, isPublic }),
      ...discussions
    }
  );
  svc.assertSnapshot = async () => user;
  svc.checkpoint = async (_job, step) => records.checkpoints.push(step);
  svc.recordAiAudit = async (_user, action, _job, details) => records.audits.push({ action, details });
  svc.references = async () => "";
  const job = { id: "tutorial-job", ownerId: 1, action: "all", progress: 50, state: { completed: [], ...state } };
  const problem = { id: 8, type: "Traditional", isPublic: false };
  const snapshot = { samples: [{ inputData: "1 2\n", outputData: "3\n" }], statements: [], judgeInfo: {} };
  return { svc, job, user, problem, snapshot, records, stored };
}

test("publishing a tutorial keeps the code each language version shows", async () => {
  const f = fixture();
  f.svc.model = async () => ({ zh_CN: tutorial("题解", wrong), en_US: tutorial("Tutorial", right) });
  await f.svc.edit(f.job, f.user, f.problem, {}, f.snapshot, "tutorial");
  assert.equal(f.records.created.length, 2);
  assert.deepEqual(
    f.job.state.tutorialBindings.map(item => [item.discussionId, item.locale, item.sha256]),
    [
      [101, "zh_CN", sha256(wrong)],
      [102, "en_US", sha256(right)]
    ]
  );
  assert.deepEqual(
    tutorialViews(f.job.state).map(view => view.status),
    ["unchecked", "unchecked"]
  );
});

test("the reference solution check records what each tutorial's code did, with the failure it kept", async () => {
  const f = fixture({ state: { validatorCode: "v" } });
  f.svc.referenceCandidates = async () => [
    { code: wrong, sha256: sha256(wrong) },
    { code: right, sha256: sha256(right) }
  ];
  f.svc.prepareSampleFiles = async () => ({ files: [], directory: null });
  let runs = 0;
  f.svc.runSandbox = async () => {
    if (runs++ === 0) {
      const error = new AiError("SANDBOX_GENERATION_FAILED", "Output mismatch: 1");
      error.candidateFailure = true;
      error.observationId = "kept-failure";
      error.failure = {
        kind: "wrong_answer",
        fatal: true,
        phase: "validate-samples",
        role: "std",
        subject: "sample 1"
      };
      throw error;
    }
    return { validation: { samplesPassed: 1, sampleInputsPassed: 1, inputsPassed: 0 } };
  };
  f.svc.runProfiles = () => ({});
  await f.svc.tryTutorialReference(f.job, f.user, f.problem, f.snapshot, { fileIo: null }, 0, 100);
  assert.equal(f.job.state.stdCode, right);
  const checks = f.job.state.tutorialChecks;
  assert.deepEqual(
    { ...checks[sha256(wrong)], at: undefined },
    {
      result: "rejected",
      samples: 1,
      kind: "wrong_answer",
      subject: "sample 1",
      reason: "Output mismatch: 1",
      observationId: "kept-failure",
      at: undefined
    }
  );
  assert.deepEqual({ ...checks[sha256(right)], at: undefined }, { result: "passed", samples: 1, at: undefined });
});

const corrected = (state = {}) => ({
  tutorialBindings: [binding(7, "zh_CN", wrong), binding(8, "en_US", wrong)],
  tutorialChecks: { [sha256(wrong)]: { result: "rejected", samples: 1, observationId: "o", at: "" } },
  generated: { count: 5 },
  stdCode: right,
  stdFileIo: null,
  tutorialCorrection: { requestedAt: "", reference: sha256(right) },
  completed: ["source", "translate", "tags", "difficulty", "testdata"],
  ...state
});
const placeholder = `Corrected explanation.\n\n${AI_TUTORIAL_CODE_PLACEHOLDER}\n`;

test("a correction puts the reference solution in the same discussions, and changes nothing else", async () => {
  const f = fixture({ state: corrected() });
  const prompts = [];
  f.svc.model = async (_config, prompt) => {
    prompts.push(prompt);
    return { zh_CN: `题解。\n\n${AI_TUTORIAL_CODE_PLACEHOLDER}\n`, en_US: placeholder };
  };
  await f.svc.edit(f.job, f.user, f.problem, {}, f.snapshot, "tutorial");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /it failed an official sample/);
  assert.deepEqual(
    f.records.updated.map(item => [item.id, item.title]),
    [
      [7, "题解-AI"],
      [8, "Tutorial-AI"]
    ]
  );
  for (const item of f.records.updated) assert(item.content.includes(`\`\`\`cpp\n${right}\n\`\`\``));
  assert.deepEqual(f.records.visibility, [], "visibility stays as it is");
  assert.equal(f.records.created.length, 0, "no new discussion");
  assert.equal(f.job.state.tutorialCorrection, undefined);
  assert.deepEqual(
    tutorialViews(f.job.state).map(view => [view.status, !!view.corrected]),
    [
      ["qualified", true],
      ["qualified", true]
    ]
  );
  assert.deepEqual(
    f.records.audits.map(item => [item.action, item.details.discussionId]),
    [
      ["tutorial.correct", 7],
      ["tutorial.correct", 8]
    ]
  );
});

test("a correction that isn't exactly the reference solution, or that the owner may no longer make, changes nothing", async () => {
  for (const answer of [
    { zh_CN: "No placeholder", en_US: placeholder },
    { zh_CN: `${placeholder}\n\`\`\`cpp\n${wrong}\n\`\`\``, en_US: placeholder },
    { zh_CN: placeholder }
  ]) {
    const f = fixture({ state: corrected() });
    f.svc.model = async () => answer;
    await assert.rejects(
      f.svc.edit(f.job, f.user, f.problem, {}, f.snapshot, "tutorial"),
      /INVALID_AI_TUTORIAL: CODE_NOT_REFERENCE/
    );
    assert.equal(f.records.updated.length, 0);
  }
  const denied = fixture({ state: corrected(), permission: false });
  denied.svc.model = async () => assert.fail("no model request");
  await assert.rejects(
    denied.svc.edit(denied.job, denied.user, denied.problem, {}, denied.snapshot, "tutorial"),
    /PERMISSION_DENIED/
  );
  assert.equal(denied.records.updated.length, 0);
  // Named files: a model-written reference solution isn't a submission
  const files = fixture({ state: corrected() });
  files.snapshot.judgeInfo = { fileIo: { inputFilename: "a.in", outputFilename: "a.out" } };
  files.svc.model = async () => assert.fail("no model request");
  await assert.rejects(
    files.svc.edit(files.job, files.user, files.problem, {}, files.snapshot, "tutorial"),
    /TUTORIAL_CORRECTION_UNAVAILABLE: FILE_IO/
  );
});

test("the owner reopens only the tutorial step of a finished job", async () => {
  const f = fixture();
  const job = {
    id: "j",
    ownerId: 1,
    status: "completed",
    problemId: 8,
    action: "all",
    state: {
      ...corrected(),
      tutorialCorrection: undefined,
      completed: ["source", "translate", "tags", "difficulty", "tutorial", "testdata"]
    }
  };
  f.svc.services.facade.jobs = { findOneBy: async () => job };
  f.svc.editable = async () => f.problem;
  f.svc.problemSnapshot = async () => f.snapshot;
  let requeued;
  f.svc.services.coordinator.requeue = async (_user, _job, state, statuses) => {
    requeued = { state: state(), statuses };
  };
  f.svc.services.coordinator.wake = () => {};
  assert.deepEqual(await f.svc.correctTutorial(f.user, "j"), {});
  assert.deepEqual(requeued.statuses, ["completed"]);
  assert.deepEqual(requeued.state.completed, ["source", "translate", "tags", "difficulty", "testdata"]);
  assert.equal(requeued.state.tutorialCorrection.reference, sha256(right));
  // Only a completed job: a failed one hasn't finished its test data step
  job.status = "failed";
  await assert.rejects(f.svc.correctTutorial(f.user, "j"), /JOB_NOT_COMPLETED/);
  job.status = "completed";
  // Nothing to correct: refused before anything is queued
  job.state = { ...job.state, tutorialBindings: [binding(7, "zh_CN", right)] };
  requeued = null;
  await assert.rejects(f.svc.correctTutorial(f.user, "j"), /TUTORIAL_CORRECTION_UNAVAILABLE: NOTHING_TO_CORRECT/);
  assert.equal(requeued, null);
});

test("readers see what the tutorial's code passed, only if they may read it", async () => {
  const state = {
    tutorialBindings: [binding(7, "zh_CN", wrong), binding(8, "en_US", right)],
    tutorialChecks: {
      [sha256(wrong)]: { result: "rejected", samples: 1, reason: "Output mismatch", at: "" },
      [sha256(right)]: { result: "passed", samples: 1, at: "" }
    },
    generated: { count: 5 },
    stdCode: right
  };
  // The query reads the jobs' bindings (a string from MariaDB) and tutorial IDs only
  const rows = [
    { id: "other", bindings: null, zh: null, en: null },
    { id: "j", bindings: JSON.stringify(state.tutorialBindings), zh: "7", en: "8" }
  ];
  const f = fixture({ rows, jobs: { j: { id: "j", state } } });
  assert.deepEqual(await f.svc.services.facade.tutorialStatus(f.user, 7), { tutorial: { status: "rejected" } });
  assert.deepEqual(await f.svc.services.facade.tutorialStatus(f.user, 8), {
    tutorial: { status: "qualified", samplesPassed: 1 }
  });
  // A job from before tutorials' code was kept: from its tutorials' text
  const legacy = {
    discussionIds: { zh_CN: 7, en_US: 8 },
    tutorialContents: { zh_CN: tutorial("题解", wrong), en_US: tutorial("Tutorial", right) },
    generated: { count: 5 },
    stdCode: right
  };
  const old = fixture({ rows: [{ id: "l", bindings: null, zh: 7, en: 8 }], jobs: { l: { id: "l", state: legacy } } });
  assert.deepEqual(await old.svc.services.facade.tutorialStatus(f.user, 7), { tutorial: { status: "superseded" } });
  assert.deepEqual(await old.svc.services.facade.tutorialStatus(f.user, 8), { tutorial: { status: "qualified" } });
  // Not an AI job's tutorial, not a tutorial, or not readable
  assert.deepEqual(await fixture({ rows: [] }).svc.services.facade.tutorialStatus(f.user, 7), { tutorial: null });
  const discussion = fixture({ rows, jobs: { j: { id: "j", state } } });
  discussion.stored.get(7).type = "Discussion";
  assert.deepEqual(await discussion.svc.services.facade.tutorialStatus(f.user, 7), { tutorial: null });
  const hidden = fixture({ rows, jobs: { j: { id: "j", state } }, permission: false });
  assert.deepEqual(await hidden.svc.services.facade.tutorialStatus(null, 8), { tutorial: null });
});
