// Run: node --test packages/frontend/test/ai-replay.test.cjs
// A kept failure is replayed by its job's owner, and a finished job says where its test data was made (review Part III,
// W03): real component code; the AI API and widgets are mocked.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

const plain = value => JSON.parse(JSON.stringify(value));
const text = node =>
  node == null || typeof node === "boolean"
    ? ""
    : typeof node !== "object"
      ? String(node)
      : Array.isArray(node)
        ? node.map(text).join("")
        : text(node.props?.children);

function aiApi(answers, calls) {
  return {
    axios: {
      post: async (url, body) => {
        const method = url.replace(/^.*api\/ai\//, "");
        calls.push({ method, body });
        const answer = answers[method];
        if (!answer) return { status: 200, data: { error: "NO_SUCH_JOB" }, headers: {} };
        return { status: 200, data: typeof answer === "function" ? answer(body) : answer, headers: {} };
      },
      isCancel: () => false
    },
    "@/utils/callApiWithFileUpload": { callApiWithFileUpload: async () => ({}) },
    "@/utils/session": { noteSessionEnded() {}, responseRequestId() {}, sessionHeaders: () => ({}) }
  };
}

const job = {
  id: "11111111-2222-4333-8444-555555555555",
  action: "testdata",
  status: "failed",
  progress: 50,
  step: "testdata.quality-differential",
  result: { observationCount: 1, warnings: [] }
};
const observation = (overrides = {}) => ({
  id: "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee",
  createdAt: "2026-11-03T10:00:00.000Z",
  expiresAt: "2026-11-17T10:00:00.000Z",
  evidence: "stored",
  current: true,
  kind: "time_limit",
  fatal: true,
  origin: "local",
  operation: "generate",
  phase: "generate",
  role: "std",
  summary: "std: TimeLimitExceeded",
  artifacts: [],
  replay: { available: true },
  replays: [],
  ...overrides
});
const run = (outcome, kind, timeMs) => ({
  outcome,
  ...(kind ? { kind } : {}),
  summary: "",
  ...(timeMs ? { execution: { status: "TimeLimitExceeded", timeMs } } : {})
});
const page = "pages/ai/AiFailureDetails.tsx";

test("a failure that can be replayed offers it; the replay starts and the failures are read again", async () => {
  const calls = [];
  let started = 0;
  const h = componentHarness(page, {
    component: "ReplayPanel",
    props: { job, observation: observation(), onStarted: () => started++ },
    deps: aiApi({ replayFailure: { replay: { id: "r", status: "running" } } }, calls)
  });
  assert.equal(text(h.find("Button")), "Replay (run the check again on the kept input)");
  await h.click("Button");
  assert.deepEqual(plain(calls), [{ method: "replayFailure", body: { jobId: job.id, id: observation().id } }]);
  assert.equal(started, 1);
});

test("a refused replay says why; one that can't run now says so, and a failure that's no input's says nothing", async () => {
  const calls = [];
  const h = componentHarness(page, {
    component: "ReplayPanel",
    props: { job, observation: observation(), onStarted: () => assert.fail("not started") },
    deps: aiApi({ replayFailure: { error: "AI_REPLAY_BUSY" } }, calls)
  });
  await h.click("Button");
  assert.match(h.find("Message").props.content, /A replay is already running/);
  for (const [reason, shown] of [
    ["EVIDENCE_MISSING", /the evidence it needs wasn't kept in full, or has expired/],
    ["PROGRAM_MISSING", /no longer has a program it needs/],
    ["PROTOCOL", /only compilations and input validation are replayed/],
    ["JOB_ACTIVE", /once the job stops/]
  ]) {
    const panel = componentHarness(page, {
      component: "ReplayPanel",
      props: { job, observation: observation({ replay: { available: false, reason } }), onStarted() {} },
      deps: aiApi({}, [])
    });
    assert.equal(panel.all(node => node.type?.name === "Button").length, 0);
    assert.match(text(panel.all(node => node.type === "p")), shown);
  }
  for (const reason of ["NOT_REPLAYABLE", "TUTORIAL_CODE", "NO_PROBLEM"]) {
    const panel = componentHarness(page, {
      component: "ReplayPanel",
      props: { job, observation: observation({ replay: { available: false, reason } }), onStarted() {} },
      deps: aiApi({}, [])
    });
    assert.equal(text(panel.all(() => true)[0]), "");
  }
});

test("each replay says whether it reproduced, with which programs, and how each run ended; latest first", () => {
  const replays = [
    {
      id: "1",
      status: "reproduced",
      startedAt: "2026-11-04T10:00:00.000Z",
      check: "run",
      revision: "same",
      profiles: "same",
      origin: "judge",
      runs: [run("failed", "time_limit", 1012), run("failed", "time_limit", 1009), run("failed", "time_limit", 1020)]
    },
    {
      id: "2",
      status: "unstable",
      startedAt: "2026-11-04T11:00:00.000Z",
      check: "run",
      revision: "changed",
      profiles: "same",
      origin: "local",
      runs: [run("failed", "time_limit", 1004), run("passed"), run("passed")]
    },
    {
      id: "3",
      status: "failed",
      startedAt: "2026-11-04T12:00:00.000Z",
      check: "run",
      revision: "same",
      profiles: "changed",
      error: "REPLAY_INTERRUPTED"
    },
    {
      id: "4",
      status: "running",
      startedAt: "2026-11-04T13:00:00.000Z",
      check: "run",
      revision: "same",
      profiles: "same"
    }
  ];
  const h = componentHarness(page, {
    component: "ReplayPanel",
    props: { job, observation: observation({ replays }), onStarted() {} },
    deps: aiApi({}, [])
  });
  assert.equal(h.find("Button").props.disabled, true, "one at a time");
  const shown = h
    .all(node => node.type === "div" && replays.some(replay => replay.id === node.props.key))
    .map(node => text(node));
  assert.equal(shown.length, 4);
  assert.match(shown[0], /^Replaying…/);
  assert.match(shown[1], /^The replay itself failed · the program run again on the kept input/);
  assert.match(shown[1], /problem's judging settings \(limits or options\) changed since/);
  assert.match(shown[1], /The replay was interrupted \(the server restarted\)\./);
  assert.match(shown[2], /^Unstable: the runs didn't all end the same way/);
  assert.match(shown[2], /It ran the job's programs as they are now, which differ from the ones that failed/);
  assert.match(shown[2], /Runs: Time limit exceeded, 1004 ms · passed · passed/);
  assert.match(
    shown[3],
    /^Reproduced: every run failed the same way · the program run again on the kept input · .* · on a judge machine/
  );
  assert.match(
    shown[3],
    /Runs: Time limit exceeded, 1012 ms · Time limit exceeded, 1009 ms · Time limit exceeded, 1020 ms/
  );
});

test("the failure details read the failures again once a replay starts", async () => {
  const calls = [];
  const failures = [observation()];
  const h = componentHarness(page, {
    props: { job },
    deps: aiApi({ failures: { failures }, replayFailure: { replay: { id: "r", status: "running" } } }, calls)
  });
  await h.click("Button");
  // The replay panel of the failure starts a replay, then says so
  await h.find("ObservationView").props.onReplayed();
  await h.settle();
  assert.deepEqual(plain(calls.map(call => call.method)), ["failures", "failures"]);
});

test("a finished job says where its test data was made, and whether it was made again", () => {
  const execution = (overrides = {}) => ({
    operation: "k".repeat(64),
    origin: "judge",
    result: "new",
    attempt: "a",
    runtime: { judgeProgram: "c".repeat(64), sandboxImage: "bbe9c69b2027", arch: "x64" },
    startedAt: "2026-11-04T10:00:00.000Z",
    finishedAt: "2026-11-04T10:05:00.000Z",
    reuse: { builds: 0, inputs: 0 },
    ...overrides
  });
  const line = result =>
    text(
      componentHarness("pages/ai/AiScoringReview.tsx", {
        component: "AiRunSummary",
        props: { result },
        deps: aiApi({}, [])
      }).all(() => true)[0]
    );
  assert.equal(line({}), "");
  assert.equal(
    line({ execution: execution(), corpus: { digest: "d", cases: 20, adversarial: 2 } }),
    "Made on a judge machine · 20 cases (2 adversarial)"
  );
  assert.equal(
    line({
      execution: execution({ origin: "local", result: "collected-again" }),
      corpus: { digest: "d", cases: 5, adversarial: 0 }
    }),
    "Made on this server, and collected again after the job stopped (not made again) · 5 cases"
  );
  assert.equal(
    line({ execution: execution({ result: "resumed", reuse: { builds: 9, inputs: 40 } }) }),
    "Made on a judge machine, the job waiting again for the same run after it stopped · 9 programs taken from earlier builds · 40 inputs the same generator made in an earlier run"
  );
});
