// Run with: node --test packages/frontend/test/contest-polling.test.cjs
// The contest page's refreshes (audit 2026-11-07, F15): the real ContestPage and usePoll, with the contest API replaced
// by requests the test answers in any order. Only the answer to the current tab, page and filters may be shown, at most
// one request runs at a time, a hidden tab waits, and nothing is shown after the page is left.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

function contestPage(tab = "submissions") {
  const requests = [];
  const listeners = new Set();
  const document = {
    hidden: false,
    addEventListener: (name, listener) => name === "visibilitychange" && listeners.add(listener),
    removeEventListener: (name, listener) => listeners.delete(listener)
  };
  const detail = {
    contest: { id: 7, title: "Contest", rule: "acm" },
    problems: [
      { id: 71, title: "A" },
      { id: 72, title: "B" }
    ]
  };
  const callContest = (action, request) =>
    new Promise((resolve, reject) => requests.push({ action, request, resolve, reject }));
  const stub = name => ({ name });
  const h = componentHarness("pages/contest/ContestPage.tsx", {
    component: "ContestPage",
    props: { initial: detail, tab },
    realHooks: ["usePoll"],
    globals: { document, AbortController },
    deps: {
      "./api": {
        callContest,
        tr: (zh, en) => en,
        formatDate: value => String(value),
        problemLetter: index => "AB"[index],
        languageChoices: () => [],
        contestStatusText: () => "",
        contestLanguageName: value => value
      },
      "./ContestFrame": { __esModule: true, default: stub("ContestFrame") },
      "@/markdown/MarkdownContent": { __esModule: true, default: stub("MarkdownContent") },
      "./contest-rules": { ruleDescription: () => "" },
      "@/pages/submission/SubmissionPreview": {
        SubmissionPreviewLink: stub("SubmissionPreviewLink"),
        SubmissionPreviewProvider: stub("SubmissionPreviewProvider")
      },
      "./contestArchive": { downloadContestArchive: async () => ({}) }
    }
  });
  const pending = () => requests.filter(request => !request.settled);
  async function answer(request, value) {
    request.settled = true;
    request.resolve(value);
    await h.settle();
  }
  const rows = () =>
    h
      .all(node => node.type?.name === "Table.Row" && node.props.key != null)
      .map(node => node.props.key)
      .filter(key => typeof key === "number");
  const tables = () => h.all(node => node.props?.["aria-busy"] !== undefined);
  return { h, requests, pending, answer, rows, tables, document, listeners, detail };
}
const submissions = (...ids) => ({ total: ids.length, submissions: ids.map(id => ({ id, username: `u${id}` })) });

test("a filter's answer is shown even when the earlier, unfiltered answer arrives after it", async () => {
  const page = contestPage();
  await page.h.settle();
  const [unfiltered] = page.pending();
  assert.equal(unfiltered.action, "submissions");
  assert.equal(unfiltered.request.data.userId, undefined);
  assert.equal(unfiltered.request.data.problemId, undefined);

  page.h.find("Form.Input").props.onChange(null, { value: "2" });
  await page.h.settle();
  const filtered = page.pending().find(request => request.request.data.userId === 2);
  assert.ok(filtered, "the filter asks for user 2's submissions at once");

  await page.answer(filtered, submissions(20, 21));
  assert.deepEqual(page.rows(), [20, 21]);
  await page.answer(unfiltered, submissions(1, 2, 3));
  assert.deepEqual(page.rows(), [20, 21], "the earlier query's answer is dropped");
  assert.equal(page.tables()[0].props["aria-busy"], false);
});

test("while another page loads, the last rows stay dimmed and are replaced only by that page's answer", async () => {
  const page = contestPage();
  await page.h.settle();
  await page.answer(page.pending()[0], { total: 120, submissions: [{ id: 1, username: "u1" }] });
  assert.deepEqual(page.rows(), [1]);

  page.h.find("Pagination").props.onPageChange(null, { activePage: 2 });
  await page.h.settle();
  page.h.find("Pagination").props.onPageChange(null, { activePage: 3 });
  await page.h.settle();
  const second = page.pending().find(request => request.request.page === 2);
  const third = page.pending().find(request => request.request.page === 3);
  assert.ok(second && third);
  assert.deepEqual(page.rows(), [1]);
  assert.equal(page.tables()[0].props["aria-busy"], true, "page 1's rows are marked as not the current page");

  await page.answer(third, { total: 120, submissions: [{ id: 3, username: "u3" }] });
  await page.answer(second, { total: 120, submissions: [{ id: 2, username: "u2" }] });
  assert.deepEqual(page.rows(), [3], "page 3 stays: page 2's late answer isn't shown");
  assert.equal(page.tables()[0].props["aria-busy"], false);
});

test("a timer refresh never overlaps a request in flight, and a wake-up during one runs once after it", async () => {
  const page = contestPage();
  await page.h.settle();
  await page.answer(page.pending()[0], submissions(1));
  assert.equal(page.h.timers.length, 1, "the next refresh is scheduled after the answer");

  page.h.timers.shift()();
  await page.h.settle();
  assert.equal(page.pending().length, 1);
  assert.equal(page.pending()[0].action, "detail", "later refreshes reload the contest's detail first");
  // The tab is shown again while the refresh is still waiting: no second request now
  for (const listener of page.listeners) listener();
  await page.h.settle();
  assert.equal(page.pending().length, 1, "one request at a time");

  await page.answer(page.pending()[0], { ...page.detail, contest: { ...page.detail.contest, title: "Renamed" } });
  assert.equal(page.pending().length, 1);
  assert.equal(page.pending()[0].action, "submissions");
  await page.answer(page.pending()[0], submissions(1, 2));
  assert.deepEqual(page.rows(), [1, 2]);
  // The wake-up asked for during the refresh runs right after it, still one request at a time
  assert.equal(page.pending().length, 1);
  assert.equal(page.pending()[0].action, "detail");
});

test("a hidden tab doesn't refresh until it's shown again", async () => {
  const page = contestPage("ranklist");
  await page.h.settle();
  page.document.hidden = true;
  await page.answer(page.pending()[0], { problems: [], rows: [] });
  assert.equal(page.h.timers.length, 0, "no refresh is scheduled for a hidden tab");
  assert.equal(page.pending().length, 0);
  page.document.hidden = false;
  for (const listener of page.listeners) listener();
  await page.h.settle();
  assert.equal(page.pending().length, 1, "showing the tab refreshes at once");
});

test("an answer that arrives after the page is left changes nothing", async () => {
  const page = contestPage();
  await page.h.settle();
  const request = page.pending()[0];
  page.h.unmount();
  assert.equal(page.listeners.size, 0, "leaving the page stops listening for the tab being shown");
  request.settled = true;
  request.resolve(submissions(99));
  await new Promise(resolve => setImmediate(resolve));
  page.h.render();
  assert.deepEqual(page.rows(), [], "the late answer isn't shown");
  assert.equal(page.pending().length, 0, "and nothing new is asked for");
});
