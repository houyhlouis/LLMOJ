// Run: node --test packages/frontend/test/judge-machine.test.cjs
// The Judge Machine page's draining and capability display, with the real component handlers and mocked widgets.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

const page = "pages/judge-machine/JudgeMachinePage.tsx";
const capabilities = {
  protocolVersion: 2,
  taskTypes: ["Submission", "Hack", "SelfEvalPrepare", "SelfEval"],
  consumerThreads: 2,
  executionSlots: 4,
  memoryBudget: 2374,
  aiExecutionSlots: 3
};
const client = (id, fields) => ({
  id,
  name: `judge${id}`,
  key: "k".repeat(40),
  allowedHosts: [],
  online: true,
  draining: false,
  runningTasks: 0,
  capabilities,
  ...fields
});
const judgeClients = [
  client(1, { runningTasks: 3 }),
  client(2, { draining: true, runningTasks: 2 }),
  client(3, { draining: true }),
  client(4, { online: false, draining: true }),
  client(5, { capabilities: undefined })
];

function harness(api) {
  return componentHarness(page, {
    props: { hasManagePermission: true, judgeClients },
    deps: {
      "@/components/EmojiRenderer": { EmojiRenderer: { name: "EmojiRenderer" } },
      "@/utils/formatDateTime": { __esModule: true, default: () => ["", ""] }
    },
    api
  });
}
const text = node => [node.props.children].flat(Infinity).filter(child => typeof child === "string");
const plain = value => JSON.parse(JSON.stringify(value));
const rows = h => h.all(node => node.type?.name === "Table.Row" && node.props.children.length > 2).slice(1);

test("status shows draining until the judge machine has finished its tasks", () => {
  const h = harness();
  const statuses = rows(h).map(row => {
    const status = h.all(node => node.type?.name === "Label" && node.props.circular, row)[0];
    return [status.props.color, ...text(h.all(node => node.type === "div", row)[0])];
  });
  assert.deepEqual(plain(statuses), [
    ["green", ".online"],
    ["yellow", ".draining"],
    ["grey", ".drained"],
    ["red", ".offline_drained"],
    ["green", ".online"]
  ]);
  const running = rows(h).map(row => row.props.children[6].props.children[0]);
  assert.deepEqual(plain(running), [3, 2, 0, 0, 0]);
});

test("capacity is announced by the judge machine; an older one is marked as legacy", () => {
  const h = harness();
  const capacity = rows(h).map(row => row.props.children[5].props.children[0]);
  assert.equal(capacity[0].type.name, "Popup");
  const details = h.all(node => node.type === "tr", capacity[0].props.content);
  assert.equal(details.length, 6);
  assert.deepEqual(plain(details[0].props.children[1].props.children), [
    ".queue.types.Submission, .queue.types.Hack, .queue.types.SelfEvalPrepare, .queue.types.SelfEval"
  ]);
  assert.equal(capacity[4].props.trigger.props.content, ".capabilities.legacy");
  assert.equal(capacity[4].props.content, ".capabilities.legacy_notes");
});

test("drain and resume ask first, then update the judge machine and refresh", async () => {
  const h = harness();
  const popup = icon => h.find("Popup", props => props.trigger?.props?.name === icon);
  assert.equal(
    h.all(node => node.type?.name === "Popup" && node.props.trigger?.props?.name === "pause circle outline").length,
    2
  );
  assert.equal(
    h.all(node => node.type?.name === "Popup" && node.props.trigger?.props?.name === "play circle outline").length,
    3
  );

  popup("pause circle outline").props.onOpen();
  h.render();
  assert.equal(popup("pause circle outline").props.open, true);
  assert.equal(h.calls.length, 0, "opening only asks");
  const confirm = h.all(node => node.type?.name === "Button", popup("pause circle outline").props.content)[0];
  assert.equal(confirm.props.content, ".confirm_drain");
  await confirm.props.onClick();
  await h.settle();
  assert.deepEqual(plain(h.calls), [
    { name: "setJudgeClientDraining", body: { id: 1, draining: true } },
    { name: "refresh" }
  ]);
  assert.deepEqual(plain(h.toasts), [".drain_success"]);
  assert.equal(popup("pause circle outline").props.open, false);

  const resume = h.all(
    node => node.type?.name === "Popup" && node.props.trigger?.props?.name === "play circle outline"
  )[0];
  await h.all(node => node.type?.name === "Button", resume.props.content)[0].props.onClick();
  await h.settle();
  assert.deepEqual(plain(h.calls.slice(2)), [
    { name: "setJudgeClientDraining", body: { id: 2, draining: false } },
    { name: "refresh" }
  ]);
});

test("a failed drain shows the error and keeps the confirmation open", async () => {
  const h = harness(name =>
    name === "setJudgeClientDraining" ? { response: { error: "NO_SUCH_JUDGE_CLIENT" } } : null
  );
  const popup = () => h.find("Popup", props => props.trigger?.props?.name === "pause circle outline");
  popup().props.onOpen();
  h.render();
  await h.all(node => node.type?.name === "Button", popup().props.content)[0].props.onClick();
  await h.settle();
  assert.deepEqual(plain(h.toasts), [".error.NO_SUCH_JUDGE_CLIENT"]);
  assert.equal(h.calls.filter(call => call.name === "refresh").length, 0);
  assert.equal(popup().props.open, true);
});

test("reset key explains that the judge machine is disconnected at once", () => {
  const h = harness();
  const reset = h.find("Popup", props => props.trigger?.props?.name === "refresh");
  assert.deepEqual(plain(text(h.all(node => node.type === "p", reset.props.content)[0])), [".reset_key_notes"]);
});

const runtime = (overrides = {}) => ({
  judgeProgram: "a".repeat(64),
  sandboxImage: "b".repeat(64),
  node: "v24.21.0",
  os: "Ubuntu 26.04",
  kernel: "Linux 7.0.0",
  arch: "x64",
  cpu: "Intel Core i7",
  ...overrides
});
const withRuntimes = runtimes =>
  componentHarness(page, {
    props: {
      hasManagePermission: true,
      judgeClients: runtimes.map(([value, online], i) =>
        client(i + 1, { online, capabilities: { ...capabilities, protocolVersion: 3, runtime: value } })
      )
    },
    deps: {
      "@/components/EmojiRenderer": { EmojiRenderer: { name: "EmojiRenderer" } },
      "@/utils/formatDateTime": { __esModule: true, default: () => ["", ""] }
    }
  });
const warnings = h => h.all(node => node.type?.name === "Message" && node.props.warning);

test("a judge machine's runtime is shown with its capacity", () => {
  const h = withRuntimes([[runtime(), true]]);
  const capacity = rows(h)[0].props.children[5].props.children[0];
  const details = h.all(node => node.type === "tr", capacity.props.content);
  assert.equal(details.length, 9);
  const value = row => [row.props.children[1].props.children].flat()[0];
  const program = value(details[6]);
  assert.equal(program.props.title, "a".repeat(64));
  assert.deepEqual([program.props.children].flat(), ["a".repeat(12)]);
  assert.equal(value(details[8]), "v24.21.0");
});

test("online judge machines with different judge programs or sandbox images are pointed out", () => {
  assert.equal(warnings(withRuntimes([[runtime(), true], [runtime({ kernel: "Linux 6.8" }), true]])).length, 0);
  assert.equal(warnings(withRuntimes([[runtime(), true], [runtime({ judgeProgram: "c".repeat(64) }), false]])).length, 0,
    "an offline judge machine doesn't judge");
  for (const changed of [{ judgeProgram: "c".repeat(64) }, { sandboxImage: "d".repeat(64) }]) {
    const [warning] = warnings(withRuntimes([[runtime(), true], [runtime(changed), true]]));
    assert.equal(warning.props.header, ".runtime_mismatch");
  }
});
