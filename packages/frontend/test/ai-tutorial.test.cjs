// Run: node --test packages/frontend/test/ai-tutorial.test.cjs
// An AI job's tutorials and what their code passed, for the job's owner and for the tutorial's readers (review Part
// III, H08): real component code; the AI API and widgets are mocked.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

const text = node =>
  node == null || typeof node === "boolean"
    ? ""
    : typeof node !== "object"
      ? String(node)
      : Array.isArray(node)
        ? node.map(text).join("")
        : text(node.props?.children);

function deps(answers = {}, calls = []) {
  return {
    axios: {
      post: async (url, body) => {
        const method = url.replace(/^.*api\/ai\//, "");
        calls.push({ method, body });
        return { status: 200, data: answers[method] || {}, headers: {} };
      },
      isCancel: () => false
    },
    "@/utils/callApiWithFileUpload": { callApiWithFileUpload: async () => ({}) },
    "@/utils/session": { noteSessionEnded() {}, responseRequestId() {}, sessionHeaders: () => ({}) }
  };
}
const page = "pages/ai/AiTutorialBinding.tsx";
const job = (tutorials, tutorialCorrection) => ({
  id: "11111111-2222-4333-8444-555555555555",
  action: "all",
  status: "completed",
  progress: 100,
  step: "testdata",
  result: { warnings: [], tutorials, ...(tutorialCorrection ? { tutorialCorrection } : {}) }
});

test("the owner sees what each tutorial's code passed, and can have it replaced by the reference solution", () => {
  let corrected = 0;
  const h = componentHarness(page, {
    deps: deps(),
    props: {
      job: job(
        [
          {
            discussionId: 7,
            locale: "zh_CN",
            status: "rejected",
            samplesPassed: 1,
            kind: "wrong_answer",
            subject: "sample 1",
            reason: "Output mismatch",
            observationId: "o"
          },
          { discussionId: 8, locale: "en_US", status: "superseded" }
        ],
        "available"
      ),
      busy: false,
      onCorrect: () => corrected++
    }
  });
  const lines = h.all(node => node.type === "p").map(text);
  assert.deepEqual(lines, [
    "题解-AI · its code failed an official sample check (sample 1: Output mismatch), so the test data doesn't use it (see Failure details)",
    "Tutorial-AI · the published test data was made with another reference solution; its code wasn't checked as the reference"
  ]);
  const button = h.find("Button");
  assert.equal(text(button), "Use the reference solution's code in the tutorials");
  button.props.onClick();
  assert.equal(corrected, 1);
});

test("each status reads as what the code passed; a corrected tutorial says so; no button when there's nothing to do", () => {
  for (const [view, shown] of [
    [{ status: "qualified" }, /its code is the reference solution the published test data was made and checked with/],
    [{ status: "passed-samples", samplesPassed: 2 }, /passed the 2 official samples; no test data is published yet/],
    [{ status: "unchecked" }, /its code hasn't been checked/],
    [{ status: "no-code" }, /shows no C\+\+ program the job could run/],
    [{ status: "qualified", corrected: "2026-11-05T10:00:00.000Z" }, /code replaced by the reference solution on/]
  ]) {
    const h = componentHarness(page, {
      deps: deps(),
      props: { job: job([{ discussionId: 7, locale: "en_US", ...view }]), busy: false, onCorrect() {} }
    });
    assert.match(text(h.all(node => node.type === "p")), shown);
    assert.equal(h.all(node => node.type?.name === "Button").length, 0);
  }
  const files = componentHarness(page, {
    deps: deps(),
    props: {
      job: job([{ discussionId: 7, locale: "en_US", status: "rejected" }], "FILE_IO"),
      busy: false,
      onCorrect() {}
    }
  });
  assert.match(text(files.all(node => node.type === "p")), /reads and writes named files/);
  assert.equal(files.all(node => node.type?.name === "Button").length, 0);
  const none = componentHarness(page, { deps: deps(), props: { job: job(undefined), busy: false, onCorrect() {} } });
  assert.equal(text(none.all(() => true)[0]), "");
});

test("a tutorial's readers see what its code passed, never that its proof is verified", async () => {
  for (const [status, shown, kind] of [
    [
      "qualified",
      /is the problem's reference solution: it passed the official samples and every check of the test data\. The explanation and proof aren't verified\./,
      "info"
    ],
    ["passed-samples", /passed the official samples\. The explanation and proof aren't verified\./, "info"],
    ["rejected", /failed an official sample check, so it isn't the problem's reference solution\./, "warning"],
    ["superseded", /wasn't used to make the problem's test data/, "warning"],
    ["unchecked", /hasn't been checked/, "warning"]
  ]) {
    const calls = [];
    const h = componentHarness(page, {
      component: "AiTutorialStatus",
      deps: deps({ tutorialStatus: { tutorial: { status } } }, calls),
      props: { discussionId: 7 }
    });
    await h.settle();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ method: "tutorialStatus", body: { discussionId: 7 } }]);
    const message = h.find("Message");
    assert.match(message.props.content, shown);
    assert.equal(message.props[kind], true);
  }
  // Not an AI job's tutorial (or not readable): nothing
  for (const answer of [{ tutorial: null }, { tutorial: { status: "no-code" } }]) {
    const h = componentHarness(page, {
      component: "AiTutorialStatus",
      deps: deps({ tutorialStatus: answer }),
      props: { discussionId: 9 }
    });
    await h.settle();
    assert.equal(h.all(node => node.type?.name === "Message").length, 0);
  }
});
