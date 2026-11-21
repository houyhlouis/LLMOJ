import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDisposableDatabase,
  benchmarkProblemTitle,
  readBenchmarkDatabase,
  seedBatches,
  seedDatabase,
  seedManifest,
  seedPlan
} from "../benchmark/seed.mjs";
import { backendConfig, portsFor } from "../dev/stack.mjs";

const hashes = { viewer: "synthetic-viewer-hash", other: "synthetic-other-hash" };
const small = {
  seed: "42",
  scale: "0.001",
  users: "8",
  problems: "30",
  contests: "2",
  discussions: "3",
  "practice-submissions": "80",
  "study-lists": "3",
  "strict-submissions": "5",
  "source-bytes": "2048"
};

// Consume the same SQL and parameter arrays that go to the MariaDB driver.
function tablesFor(plan) {
  const tables = new Map();
  for (const { sql, rows } of seedBatches(plan, hashes)) {
    const [, table, names, placeholders] = /^INSERT INTO \`(\w+)\` \((.+)\) VALUES \((.+)\)$/.exec(sql);
    const fields = [...names.matchAll(/\`(\w+)\`/g)].map(match => match[1]);
    assert.deepEqual(
      placeholders.split(", "),
      fields.map(() => "?")
    );
    if (!tables.has(table)) tables.set(table, []);
    for (const values of rows) {
      assert.equal(fields.length, values.length, table);
      tables.get(table).push(Object.fromEntries(fields.map((field, i) => [field, values[i]])));
    }
  }
  return tables;
}

test("scale one and explicit counts reproduce the Capacity dataset", () => {
  const plan = seedPlan();
  assert.deepEqual(plan.counts, {
    users: 2000,
    problems: 1500,
    publicProblems: 1400,
    practiceSubmissions: 300000,
    contests: 30,
    runningSubmissions: 2551,
    perEndedContest: 1000,
    discussions: 3000,
    studyLists: 301,
    strictSubmissions: 0
  });
  assert.equal(plan.ids.strictContest, null);
  assert.equal(plan.ids.longStudyList, 301);
  const tiny = seedPlan({ scale: "0.01", contests: "0", "study-lists": "0", "strict-submissions": "7" });
  assert.equal(tiny.counts.users, 20);
  assert.equal(tiny.counts.practiceSubmissions, 3000);
  assert.equal(tiny.ids.runningContest, null);
  assert.equal(tiny.ids.longStudyList, null);
  assert.equal(tiny.ids.strictContest, 1);
  const lists = tablesFor(
    seedPlan({ scale: "0.001", problems: "1200", "study-lists": "2", contests: "0", "practice-submissions": "0" })
  ).get("study_list");
  assert.deepEqual(
    lists.map(list => new Set(JSON.parse(list.items).map(item => item.problemId)).size),
    [50, 1000]
  );
  const strictOnly = tablesFor(
    seedPlan({ scale: "0.001", contests: "0", "practice-submissions": "0", "strict-submissions": "1" })
  );
  assert.equal(strictOnly.get("contest")[0].rule, "strictioi");
  assert.equal(strictOnly.get("submission")[0].contestId, 1);
  for (const invalid of [
    { seed: "-1" },
    { scale: "Infinity" },
    { problems: "0" },
    { users: "1.5" },
    { "as-of": "2025-02-30" },
    { "source-bytes": "1048577" },
    { "practice-submissions": "2147483647" }
  ])
    assert.throws(() => seedPlan(invalid));
});

test("SQL and row values replay from a seed and reference date", () => {
  const batches = opts => [...seedBatches(seedPlan(opts), hashes)];
  assert.deepEqual(batches(small), batches({ ...small }));
  assert.notDeepEqual(batches(small), batches({ ...small, seed: "43" }));
  assert.notDeepEqual(batches(small), batches({ ...small, "as-of": "2025-02-01" }));
});

test("the private manifest names this stack's origin and seeded problem marker; SQL-only fixtures require no listener", () => {
  const plan = seedPlan(small);
  const config = backendConfig(portsFor(29400), {});
  const manifest = seedManifest(plan, config.server, "synthetic-test-value");
  assert.equal(manifest.apiUrl, "http://127.0.0.1:29400");
  const tables = tablesFor(plan);
  assert.equal(manifest.login.username, tables.get("user").find(user => user.id === manifest.ids.firstUser).username);
  const title = tables
    .get("localized_content")
    .find(c => c.objectId === 1 && c.type === "ProblemTitle" && c.locale === "en_US");
  assert.equal(title.data, benchmarkProblemTitle(1));
  assert.match(title.data, /LLMOJ benchmark/);
  assert.equal(seedManifest(plan, undefined, "unused").apiUrl, null);
  assert.equal(seedManifest(plan, { hostname: "example.invalid", port: 29400 }, "unused").apiUrl, null);
  assert.throws(() => seedManifest(plan, { hostname: "127.0.0.1", port: "29400/api" }, "unused"), /server.port/);
});

test("localized public fixtures and the signed-in viewer's private lists have real relationships", () => {
  const plan = seedPlan(small),
    tables = tablesFor(plan);
  const users = tables.get("user"),
    publicIds = new Set(),
    localized = tables.get("localized_content");
  assert.equal(users.length, plan.counts.users);
  assert.equal(users[0].id, plan.ids.firstUser);
  assert.ok(users.every(u => !u.isAdmin));
  for (const child of ["user_information", "user_preference", "user_auth"])
    assert.deepEqual(
      tables.get(child).map(x => x.userId),
      users.map(x => x.id)
    );
  assert.equal(tables.get("user_auth")[0].password, hashes.viewer);
  assert.ok(
    tables
      .get("user_auth")
      .slice(1)
      .every(row => row.password === hashes.other)
  );
  for (const p of tables.get("problem")) {
    if (p.isPublic) {
      assert.equal(p.id, p.displayId);
      publicIds.add(p.id);
    }
    for (const type of ["ProblemTitle", "ProblemContent"]) {
      const texts = localized.filter(c => c.objectId === p.id && c.type === type);
      assert.deepEqual(texts.map(c => c.locale).sort(), ["en_US", "zh_CN"]);
      if (type === "ProblemContent")
        for (const { data } of texts) {
          const sampleId = JSON.parse(data).find(s => s.type === "Sample").sampleId;
          const samples = JSON.parse(tables.get("problem_sample").find(s => s.problemId === p.id).data);
          assert.equal(samples[sampleId].outputData, "4\n");
        }
    }
    const tags = tables
      .get("problem_tag_map")
      .filter(m => m.problemId === p.id)
      .map(m => m.problemTagId);
    assert.equal(new Set(tags).size, 2);
    for (const tag of tags)
      assert.equal(localized.filter(c => c.type === "ProblemTagName" && c.objectId === tag).length, 2);
  }
  assert.equal(publicIds.size, plan.counts.publicProblems);
  for (const list of tables.get("study_list")) {
    assert.equal(list.ownerId, plan.ids.firstUser);
    const ids = JSON.parse(list.items).map(i => i.problemId);
    assert.equal(new Set(ids).size, Math.min(list.id === plan.ids.longStudyList ? 1000 : 50, publicIds.size));
    assert.ok(ids.every(id => publicIds.has(id)));
  }
  for (const d of tables.get("discussion")) {
    const replies = tables.get("discussion_reply").filter(r => r.discussionId === d.id);
    assert.equal(replies.length, d.replyCount);
    assert.equal(d.replyCount, 5);
    assert.equal(d.sortTime, replies.at(-1).publishTime);
    assert.ok(replies.every(r => r.isPublic));
    assert.ok(tables.get("discussion_content").some(c => c.discussionId === d.id));
  }
});

test("practice covers a year; contest scores have in-window verdicts, matching problem IDs and large strict sources", () => {
  const plan = seedPlan(small),
    t = tablesFor(plan);
  const at = value => Date.parse(value.replace(" ", "T") + "Z");
  const anchor = Date.parse(plan.asOf + "T00:00:00Z");
  const submissions = t.get("submission"),
    details = t.get("submission_detail");
  const practice = submissions.filter(s => s.contestId == null);
  assert.deepEqual(
    practice.map(s => s.id),
    Array.from({ length: plan.counts.practiceSubmissions }, (_, i) => i + 1)
  );
  assert.ok(practice.every(s => s.isPublic && s.problemId <= plan.counts.publicProblems && s.contestProblemId == null));
  assert.equal(at(practice[0].submitTime), anchor - 365 * 86400000);
  assert.equal(at(practice.at(-1).submitTime), anchor - 1000);
  for (const contest of t.get("contest")) {
    const strict = contest.id === plan.ids.strictContest,
      running = contest.id === plan.ids.runningContest;
    const members = t.get("contest_problem").filter(p => p.contestId === contest.id);
    assert.equal(new Set(members.map(p => p.problemId)).size, 6);
    assert.equal(contest.rule, strict ? "strictioi" : "ioi");
    assert.equal(at(contest.endTime) > anchor, running);
    const attempts = submissions.filter(s => s.contestId === contest.id);
    assert.equal(
      attempts.length,
      strict ? plan.counts.strictSubmissions : running ? plan.counts.runningSubmissions : plan.counts.perEndedContest
    );
    for (const attempt of attempts) {
      assert.equal(attempt.isPublic, false);
      assert.ok(members.some(p => p.id === attempt.contestProblemId && p.problemId === attempt.problemId));
      assert.ok(contest.startTime <= attempt.submitTime && attempt.submitTime < contest.endTime);
    }
  }
  for (const s of submissions) {
    const detail = details.find(d => d.submissionId === s.id);
    const result = JSON.parse(detail.result),
      content = JSON.parse(detail.content);
    assert.equal(Buffer.byteLength(content.code), s.answerSize);
    assert.equal(result.score, s.score);
    assert.equal(result.progressType, "Finished");
    assert.equal(result.status, s.status);
    assert.equal(
      result.subtasks.reduce((sum, task) => sum + task.score, 0),
      result.score
    );
    if (s.contestId === plan.ids.strictContest) {
      assert.equal(s.answerSize, plan.sourceBytes);
      assert.deepEqual(
        result.subtasks.map(task => task.fullScore),
        [40, 60]
      );
    }
  }
});

test("an ordinary database is refused before any SQL, and config resolution checks the loopback destination", async t => {
  for (const name of ["libreoj", "prod_llmoj_dev", "", null])
    assert.throws(() => assertDisposableDatabase(name), /llmoj_dev/);
  for (const name of ["llmoj_bench", "llmoj_bench_trial", "llmoj_dev_local"]) assertDisposableDatabase(name);
  assertDisposableDatabase("isolated_fixture", true);
  await assert.rejects(seedDatabase({}, "libreoj", seedPlan(small), hashes), /llmoj_dev/);
  await assert.rejects(
    seedDatabase({ query: async () => [{ db: "wrong" }] }, "llmoj_dev", seedPlan(small), hashes),
    /does not match/
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), "benchmark-seed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "fixture.yaml");
  const db = { type: "mariadb", host: "localhost", port: 33333, username: "fixture", database: "separate_fixture" };
  await writeFile(config, JSON.stringify({ services: { database: db } }));
  await assert.rejects(readBenchmarkDatabase(config), /llmoj_dev/);
  assert.equal((await readBenchmarkDatabase(config, true)).host, "127.0.0.1");
  for (const extra of [{ host: "192.0.2.1" }, { socketPath: "/irrelevant" }]) {
    await writeFile(config, JSON.stringify({ services: { database: { ...db, ...extra } } }));
    await assert.rejects(readBenchmarkDatabase(config, true), /loopback/);
  }
});

test("all inserts, count updates and login-manifest preparation must succeed for the single commit", async () => {
  const events = [];
  let occupied = 0,
    failBatch = false;
  const connection = {
    query: async sql => {
      if (sql.startsWith("SELECT DATABASE")) return [{ db: "llmoj_dev" }];
      if (sql.includes("AS used")) return [{ used: occupied }];
      events.push("count");
    },
    batch: async () => {
      events.push("batch");
      if (failBatch) throw new Error("injected insert failure");
    },
    beginTransaction: async () => {
      events.push("begin");
    },
    commit: async () => {
      events.push("commit");
    },
    rollback: async () => {
      events.push("rollback");
    }
  };
  const seed = (save = () => events.push("manifest")) =>
    seedDatabase(connection, "llmoj_dev", seedPlan(small), hashes, save);
  await seed();
  assert.deepEqual(events.slice(-4), ["count", "count", "manifest", "commit"]);
  events.length = 0;
  occupied = 1;
  await assert.rejects(seed(), /fresh database/);
  assert.deepEqual(events, ["begin", "rollback"]);
  events.length = 0;
  occupied = 0;
  failBatch = true;
  await assert.rejects(seed(), /injected insert failure/);
  assert.deepEqual(events, ["begin", "batch", "rollback"]);
  events.length = 0;
  failBatch = false;
  await assert.rejects(
    seed(() => {
      throw new Error("disk full");
    }),
    /disk full/
  );
  assert.deepEqual(events.slice(-3), ["count", "count", "rollback"]);
});
