// Run: node --test packages/frontend/test/judging-record.test.cjs
// The submission page's data version and earlier results, shown to users who can rejudge the submission.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

const file = "pages/submission/submission/SubmissionJudgingRecord.tsx";
const deps = {
  "@/utils/formatFileSize": { __esModule: true, default: size => `${size / 1024} KiB` },
  "@/utils/formatDateTime": { __esModule: true, default: date => [`short ${date}`, `long ${date}`] },
  "@/components/StatusText": { __esModule: true, default: { name: "StatusText" } },
  "@/components/ScoreText": { __esModule: true, default: { name: "ScoreText" } }
};
const plain = value => JSON.parse(JSON.stringify(value));
const texts = node => [node?.props?.children].flat(Infinity).filter(child => typeof child === "string");
const render = props => componentHarness(file, { props, deps });

test("nothing is shown without a data version or earlier results", () => {
  const h = render({});
  assert.equal(h.all(() => true).length, 0);
});

test("the data version says whether the problem still has it", () => {
  const current = render({ dataVersion: { version: 3, current: true } });
  const line = current.all(node => node.type === "p")[0];
  assert.deepEqual(plain(texts(line)), [".data_version"]);
  assert.deepEqual(plain(texts(current.all(node => node.type === "span")[0])), [".current"]);
  assert.equal(current.all(node => node.type?.name === "Accordion").length, 0);

  const changed = render({ dataVersion: { version: 2, current: false } });
  const badge = changed.all(node => node.type === "span")[0];
  assert.deepEqual(plain(texts(badge)), [".changed"]);
  assert.equal(badge.props.title, ".changed_notes");
});

test("earlier results open on demand, the most recent first", () => {
  const h = render({
    earlierResults: [
      { status: "Accepted", score: 100, timeUsed: 120, memoryUsed: 2048, dataVersion: 3, replacedAt: "2026-10-17" },
      {
        status: "SystemError",
        score: null,
        timeUsed: null,
        memoryUsed: null,
        dataVersion: null,
        replacedAt: "2026-10-16"
      }
    ]
  });
  const title = () => h.find("Accordion.Title");
  const content = () => h.find("Accordion.Content");
  assert.deepEqual(plain(texts(title())), [".earlier_results"]);
  assert.equal(content().props.active, false);
  title().props.onClick();
  h.render();
  assert.equal(content().props.active, true);

  const rows = h.all(node => node.type?.name === "Table.Row", content()).slice(1);
  const cells = rows.map(row => row.props.children.map(cell => cell.props.children[0]));
  assert.equal(cells.length, 2);
  assert.equal(cells[0][0], "short 2026-10-17");
  assert.equal(cells[0][1].props.status, "Accepted");
  assert.equal(cells[0][2].props.score, 100);
  assert.deepEqual(plain(cells[0].slice(3)), ["120 ms", "2048 KiB", "#3"]);
  assert.deepEqual(plain(cells[1].slice(2)), ["-", "-", "-", ".not_recorded"]);
});
