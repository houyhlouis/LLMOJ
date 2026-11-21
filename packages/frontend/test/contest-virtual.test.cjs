// Run with: node --test packages/frontend/test/contest-virtual.test.cjs
// Audit 2026-11-07 RM-07 (virtual participation): after a contest has ended, someone who didn't take part can take it
// once as if it were live. The real VirtualRun.tsx (the start panel, the banner and its clock), ContestPage's standings
// (the "show virtual participants" switch and the marked rows), ContestFrame (no Hack tab during a run) and the
// contest API's messages for the server's refusals.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const { componentHarness } = require("./helpers/component-harness.cjs");

const src = path.join(__dirname, "../src");
const HOUR = 3600 * 1000;
const iso = ms => new Date(ms).toISOString();
const texts = node =>
  node == null || typeof node === "boolean"
    ? ""
    : typeof node !== "object"
      ? String(node)
      : Array.isArray(node)
        ? node.map(texts).join("")
        : texts(node.props?.children);

function apiStub(calls, answer = () => ({})) {
  return {
    tr: (zh, en) => en,
    formatDate: value => `<${value}>`,
    callContest: async (action, request) => {
      calls.push({ action, request });
      const value = await answer(action, request);
      if (value instanceof Error) throw value;
      return value;
    }
  };
}

function panel({ participation, confirm = true, answer }) {
  const calls = [],
    started = [];
  const now = Date.now();
  const h = componentHarness("pages/contest/VirtualRun.tsx", {
    component: "VirtualParticipationPanel",
    props: {
      contestId: 3,
      startTime: iso(now - 3 * HOUR),
      endTime: iso(now - 30 * 60 * 1000),
      participation,
      onStarted: detail => started.push(detail)
    },
    window: { confirm: () => confirm },
    deps: { "./api": apiStub(calls, answer) }
  });
  return { h, calls, started };
}

test("an ended contest offers a virtual run of its length, asks first, then shows the contest as running", async () => {
  const declined = panel({ participation: { canStart: true, reason: null, run: null }, confirm: false });
  await declined.h.settle();
  const button = declined.h.find("Button");
  assert.match(texts(button), /Start virtual participation/);
  assert.match(texts(declined.h.find("Segment")), /2 hours 30 minutes/, "the contest's own length");
  await button.props.onClick();
  await declined.h.settle();
  assert.deepEqual(declined.calls, [], "nothing starts without a yes");

  const detail = { contest: { id: 3 }, virtualParticipation: { canStart: false, reason: "ALREADY_USED", run: {} } };
  const accepted = panel({
    participation: { canStart: true, reason: null, run: null },
    answer: action => (action === "detail" ? detail : { run: {} })
  });
  await accepted.h.settle();
  await accepted.h.find("Button").props.onClick();
  await accepted.h.settle();
  assert.deepEqual(
    accepted.calls.map(call => [call.action, call.request.id]),
    [
      ["startVirtual", 3],
      ["detail", 3]
    ]
  );
  assert.deepEqual(accepted.started, [detail], "the page continues with the running contest's detail");
});

test("a refused start says why, and the button can be pressed again", async () => {
  const refused = panel({
    participation: { canStart: true, reason: null, run: null },
    answer: () => new Error("You've already taken this contest as a virtual run.")
  });
  await refused.h.settle();
  await refused.h.find("Button").props.onClick();
  await refused.h.settle();
  assert.match(texts(refused.h.find("Message")), /already taken this contest/);
  assert.equal(refused.h.find("Button").props.disabled, false);
});

test("without a start, the panel says nothing, or recalls a finished run", async () => {
  for (const reason of ["NOT_ENDED", "PARTICIPATED", "MANAGER", "NO_PERMISSION"]) {
    const none = panel({ participation: { canStart: false, reason, run: null } });
    await none.h.settle();
    assert.equal(none.h.all(node => node.type?.name === "Button").length, 0, reason);
  }
  const now = Date.now();
  const finished = panel({
    participation: {
      canStart: false,
      reason: "ALREADY_USED",
      run: { startTime: iso(now - 4 * HOUR), endTime: iso(now - HOUR) }
    }
  });
  await finished.h.settle();
  assert.equal(finished.h.all(node => node.type?.name === "Button").length, 0);
  assert.match(
    texts(finished.h.all(node => node.type === "p")),
    /You took this contest as a virtual run from <.*> to <.*>\./
  );
});

test("the banner shows the run's end and time left, and nothing for a run that ended before the page opened", async () => {
  const now = Date.now();
  const running = componentHarness("pages/contest/VirtualRun.tsx", {
    component: "VirtualRunBanner",
    props: { run: { startTime: iso(now - HOUR), endTime: iso(now + HOUR + 5000) } },
    deps: { "./api": apiStub([]) }
  });
  await running.settle();
  const message = running.find("Message");
  assert.match(texts(message), /Virtual run: the contest runs for you as if it were live/);
  assert.match(texts(message), /in 1:00:0\d\./);

  const old = componentHarness("pages/contest/VirtualRun.tsx", {
    component: "VirtualRunBanner",
    props: { run: { startTime: iso(now - 3 * HOUR), endTime: iso(now - HOUR) } },
    deps: { "./api": apiStub([]) }
  });
  await old.settle();
  assert.equal(old.all(node => node.type?.name === "Message").length, 0);
});

test("the clock's helpers: time left, a contest's length, and whether a run is active", () => {
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(src, "pages/contest/VirtualRun.tsx"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true }
    }).outputText,
    {
      module,
      exports: module.exports,
      require: name =>
        ({
          react: { useState: () => [], useEffect() {} },
          "semantic-ui-react": {},
          "./api": apiStub([]),
          "./ContestPages.module.less": {}
        })[name]
    }
  );
  const { formatRemaining, formatDuration, virtualRunActive } = module.exports;
  assert.equal(formatRemaining(42 * 1000), "0:42");
  assert.equal(formatRemaining(3723 * 1000), "1:02:03");
  assert.equal(formatRemaining(-5), "0:00");
  assert.equal(formatDuration(90 * 60 * 1000), "1 hour 30 minutes");
  assert.equal(formatDuration(5 * HOUR), "5 hours");
  const now = Date.now();
  const detail = run => ({ virtualParticipation: { run } });
  assert.equal(virtualRunActive(detail({ startTime: iso(now - 1000), endTime: iso(now + 1000) }), now), true);
  assert.equal(virtualRunActive(detail({ startTime: iso(now - 2000), endTime: iso(now - 1000) }), now), false);
  assert.equal(virtualRunActive(detail(null), now), false);
  assert.equal(virtualRunActive({}, now), false);
});

function standings(detail) {
  const requests = [];
  const h = componentHarness("pages/contest/ContestPage.tsx", {
    component: "ContestPage",
    props: { initial: detail, tab: "ranklist" },
    realHooks: ["usePoll"],
    globals: {
      document: { hidden: false, addEventListener() {}, removeEventListener() {} },
      AbortController
    },
    deps: {
      "./api": {
        callContest: (action, request) => new Promise(resolve => requests.push({ action, request, resolve })),
        tr: (zh, en) => en,
        formatDate: value => `<${value}>`,
        problemLetter: index => "AB"[index],
        languageChoices: () => [],
        contestStatusText: () => "",
        contestLanguageName: value => value
      },
      "./ContestFrame": { __esModule: true, default: { name: "ContestFrame" } },
      "@/markdown/MarkdownContent": { __esModule: true, default: { name: "MarkdownContent" } },
      "./contest-rules": { ruleDescription: () => "" },
      "@/pages/submission/SubmissionPreview": {
        SubmissionPreviewLink: { name: "SubmissionPreviewLink" },
        SubmissionPreviewProvider: { name: "SubmissionPreviewProvider" }
      },
      "./contestArchive": { downloadContestArchive: async () => ({}) }
    }
  });
  return { h, requests };
}
const ended = Date.now() - HOUR;
const contestDetail = extra => ({
  contest: { id: 7, title: "Contest", rule: "acm", startTime: iso(ended - 2 * HOUR), endTime: iso(ended) },
  problems: [{ id: 71, title: "A" }],
  virtualParticipation: { canStart: false, reason: "PARTICIPATED", run: null },
  ...extra
});
const rows = virtual => ({
  problems: [{ id: 71 }],
  rows: [
    { userId: 1, username: "official", rank: 1, score: 1, penalty: 600, problems: {} },
    ...(virtual
      ? [
          {
            userId: 2,
            username: "later",
            rank: 2,
            score: 1,
            penalty: 1200,
            problems: {},
            virtual: true,
            virtualStartTime: "2026-11-20T10:00:00.000Z"
          }
        ]
      : [])
  ]
});

test("the standings are the official ones unless virtual participants are asked for, and those rows are marked", async () => {
  const page = standings(contestDetail({ hasVirtualParticipants: true }));
  await page.h.settle();
  assert.equal(page.requests.length, 1);
  assert.equal("virtual" in (page.requests[0].request.data ?? {}), false, "the default request is unchanged");
  page.requests[0].resolve(rows(false));
  await page.h.settle();
  const toggle = page.h.find("Checkbox");
  assert.equal(toggle.props.label, "Show virtual participants");
  assert.equal(toggle.props.checked, false);
  assert.equal(page.h.all(node => node.type?.name === "Label" && /Virtual/.test(texts(node))).length, 0);

  toggle.props.onChange(null, { checked: true });
  await page.h.settle();
  const next = page.requests.at(-1);
  assert.equal(next.action, "ranklist");
  assert.equal(next.request.data.virtual, true);
  next.resolve(rows(true));
  await page.h.settle();
  const marks = page.h.all(node => node.type?.name === "Label" && /Virtual/.test(texts(node)));
  assert.equal(marks.length, 1, "only the virtual row is marked");
  assert.match(marks[0].props.title, /Virtual run, started <2026-11-20T10:00:00.000Z>/);
});

test("no switch when there are no virtual runs; during your own run, the standings say whose time they follow", async () => {
  const none = standings(contestDetail({ hasVirtualParticipants: false }));
  await none.h.settle();
  none.requests[0].resolve(rows(false));
  await none.h.settle();
  assert.equal(none.h.all(node => node.type?.name === "Checkbox").length, 0);

  const now = Date.now();
  const mine = standings(
    contestDetail({
      hasVirtualParticipants: false,
      virtualParticipation: {
        canStart: false,
        reason: "ALREADY_USED",
        run: { startTime: iso(now - HOUR), endTime: iso(now + HOUR) }
      }
    })
  );
  await mine.h.settle();
  mine.requests[0].resolve(rows(true));
  await mine.h.settle();
  assert.match(texts(mine.h.find("Message")), /During your virtual run, the standings show the contest as it stood/);
});

test("the contest's tabs have no Hack during a virtual run", async () => {
  const now = Date.now();
  const frame = run =>
    componentHarness("pages/contest/ContestFrame.tsx", {
      props: {
        detail: {
          contest: {
            id: 7,
            title: "Contest",
            rule: "acm",
            startTime: iso(now - 4 * HOUR),
            endTime: iso(now - 2 * HOUR)
          },
          virtualParticipation: { canStart: false, reason: "ALREADY_USED", run },
          canRank: true
        },
        tab: "overview",
        children: null
      },
      deps: {
        "./api": apiStub([]),
        "./contest-rules": { ruleLabel: () => "ICPC" }
      }
    });
  const tabs = h => h.all(node => node.type?.name === "Menu.Item").map(node => texts(node));
  const during = frame({ startTime: iso(now - HOUR), endTime: iso(now + HOUR) });
  await during.settle();
  assert.ok(!tabs(during).includes("Hack"));
  assert.equal(during.find("VirtualRunBanner").props.run.endTime, iso(now + HOUR));
  const after = frame({ startTime: iso(now - 3 * HOUR), endTime: iso(now - HOUR) });
  await after.settle();
  assert.ok(tabs(after).includes("Hack"));
});

test("the server's reasons for refusing a virtual run, or a change of times, are explained", async () => {
  const load = code => {
    const module = { exports: {} };
    class RouteError extends Error {}
    vm.runInNewContext(
      ts.transpileModule(fs.readFileSync(path.join(src, "pages/contest/api.ts"), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
      }).outputText,
      {
        module,
        exports: module.exports,
        require: name =>
          ({
            "@/api": {
              createPostApi: () => async () => ({
                requestError: "refused",
                requestErrorCode: code,
                requestErrorStatus: code === "VIRTUAL_RUNS_EXIST" ? 400 : 403
              })
            },
            "@/appState": { appState: { locale: "en_US" } },
            "@/AppRouter": { RouteError },
            "@/interfaces/CodeLanguage": { CodeLanguage: {}, normalizeContestLanguages: value => value }
          })[name]
      }
    );
    return module.exports;
  };
  for (const [code, message] of [
    ["VIRTUAL_ALREADY_USED", /already taken this contest as a virtual run/],
    ["VIRTUAL_PARTICIPATED", /took part in this contest/],
    ["VIRTUAL_NOT_ENDED", /after the contest has ended/],
    ["VIRTUAL_MANAGER", /managers can't take a virtual run/],
    ["VIRTUAL_NO_PERMISSION", /permission to enter contests/],
    ["VIRTUAL_RUNS_EXIST", /start and end can't change/],
    ["PERMISSION_DENIED", /You do not have permission/]
  ])
    await assert.rejects(load(code).callContest("startVirtual", { id: 3 }), { message });
});
