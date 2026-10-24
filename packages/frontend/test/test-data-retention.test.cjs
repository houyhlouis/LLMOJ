// The removed test data section of Site management: its policy form and the dry run of the next cleanup. Real
// handlers and response validation; API transport and widgets are mocked.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

const page = "pages/site-management/TestDataRetentionSection.tsx";
const get = "site-management/getTestDataRetention";
const post = "site-management/updateTestDataRetention";
const totals = (files, bytes) => ({ files, bytes });
const report = (policy = { contestDays: 30, resultDays: 7 }, values = {}) => ({
  policy,
  removed: totals(2, 3072),
  kept: totals(1, 2048),
  deletedAtNextCleanup: totals(1, 1024),
  byReason: [{ kind: "Contest", ...totals(1, 2048) }],
  files: [
    {
      problemId: 12,
      problemDisplayId: 1001,
      filename: "1.in",
      size: 1024,
      removedAt: "2026-10-01",
      versions: [1],
      action: "Delete",
      reasons: []
    },
    {
      problemId: 13,
      problemDisplayId: null,
      filename: "2.in",
      size: 2048,
      removedAt: "2026-10-20",
      versions: [2, 3],
      action: "Keep",
      keptUntil: "2026-12-01",
      reasons: [
        { kind: "Contest", version: 2, contestId: 5, contestTitle: "Autumn cup", until: "2026-12-01" },
        { kind: "Kept", version: 3, keptBy: "alice" }
      ]
    }
  ],
  total: 2,
  cleanupMinutes: 10,
  ...values
});
const input = (h, field) => h.find("Form.Input", p => p.label === `.test_data.fields.${field}`);
const saveButton = h => h.find("Button", p => [p.children].flat(Infinity).includes(".save"));
const plain = value => JSON.parse(JSON.stringify(value));
const localize = (id, values) => (values ? `${id} ${JSON.stringify(values)}` : id);

test("the section shows the saved policy, and saving sends whole numbers and looks again", async () => {
  let saved = null;
  const h = componentHarness(page, {
    admin: true,
    localize,
    api: (name, body) => {
      if (name === post) saved = body;
      return { response: name === get ? report(saved ?? undefined) : body };
    }
  });
  await h.settle();
  assert.equal(input(h, "contestDays").props.value, "30");
  assert.equal(input(h, "resultDays").props.value, "7");
  assert.equal(saveButton(h).props.disabled, true);
  input(h, "resultDays").props.onChange(null, { value: "0" });
  await h.settle();
  await h.click("Button", p => [p.children].flat(Infinity).includes(".save"));
  assert.deepEqual(plain(saved), { contestDays: 30, resultDays: 0 });
  assert.deepEqual(
    h.calls.map(call => call.name),
    [get, post, get],
    "what the next cleanup does under the new policy"
  );
  assert.equal(h.find("Message", p => p.positive).props.content, ".test_data.saved");
  assert.equal(saveButton(h).props.disabled, true);
});

for (const value of ["-1", "1.5", "", "3651", "1e2"])
  test(`a number outside the allowed range isn't sent: ${JSON.stringify(value)}`, async () => {
    const h = componentHarness(page, { admin: true, api: () => ({ response: report() }) });
    await h.settle();
    input(h, "contestDays").props.onChange(null, { value });
    await h.settle();
    await h.click("Button", p => [p.children].flat(Infinity).includes(".save"));
    assert.equal(
      h.calls.filter(call => call.name === post).length,
      0
    );
    assert.equal(h.find("Message", p => p.negative).props.content, ".test_data.invalid");
  });

test("the dry run explains each removed file: what the next cleanup does, and why", async () => {
  const h = componentHarness(page, { admin: true, localize, api: () => ({ response: report() }) });
  await h.settle();
  const summary = h.all(node => node.type === "p").find(node => String(node.props.children).startsWith(".test_data.summary"));
  assert.deepEqual(JSON.parse(summary.props.children[0].slice(".test_data.summary ".length)), {
    files: "2",
    size: "3072 B",
    minutes: "10",
    deleteFiles: "1",
    deleteSize: "1024 B",
    keepFiles: "1",
    keepSize: "2048 B"
  });
  const [, files] = h.all(node => node.type?.name === "Table");
  const rows = h.all(node => node.type?.name === "Table.Row", files).slice(1);
  assert.deepEqual(
    rows.map(row => row.props.negative),
    [true, false],
    "the files the next cleanup deletes stand out"
  );
  const cells = row => row.props.children;
  const [link] = h.all(node => node.type?.name === "Link", cells(rows[0])[0]);
  assert.equal(link.props.href, "/p/1001/files");
  assert.equal(h.all(node => node.type?.name === "Link", cells(rows[1])[0])[0].props.href, "/p/id/13/files");
  assert.equal(cells(rows[0])[3].props.children[0], ".test_data.actions.Delete");
  assert.equal(cells(rows[0])[4].props.children[0], ".test_data.nothing_needs_it");
  assert.equal(cells(rows[1])[3].props.children[0], '.test_data.actions.KeepUntil {"date":"long 2026-12-01"}');
  const why = h.all(node => node.type === "div", cells(rows[1])[4]).map(node => node.props.children[0]);
  assert.deepEqual(why, [
    '.test_data.reasons.Contest {"contest":"Autumn cup","version":".test_data.version {\\"version\\":\\"2\\"}"}' +
      '.test_data.until {"date":"long 2026-12-01"}',
    '.test_data.reasons.Kept {"username":"alice","version":".test_data.version {\\"version\\":\\"3\\"}"}'
  ]);
  assert.equal(h.all(node => node.type === "p").some(node => String(node.props.children).startsWith(".test_data.showing")), false);
});

test("nothing removed, and an unrecognized answer", async () => {
  const empty = componentHarness(page, {
    admin: true,
    api: () => ({
      response: report(undefined, { removed: totals(0, 0), kept: totals(0, 0), deletedAtNextCleanup: totals(0, 0), byReason: [], files: [], total: 0 })
    })
  });
  await empty.settle();
  assert(empty.all(node => node.type === "p").some(node => node.props.children[0] === ".test_data.nothing_removed"));
  assert.equal(empty.all(node => node.type?.name === "Table").length, 0);

  const invalid = componentHarness(page, { admin: true, api: () => ({ response: { policy: { contestDays: -1 } } }) });
  await invalid.settle();
  assert.equal(invalid.find("Message", p => p.negative).props.content, ".invalid_response");
  assert.equal(invalid.all(node => node.type?.name === "Form").length, 0);
});
