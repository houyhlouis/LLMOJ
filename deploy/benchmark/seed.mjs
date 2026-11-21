// Populate an initialized disposable database without running a backend, judge, or object store.
import { randomBytes } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const backendRequire = createRequire(new URL("../../apps/backend/package.json", import.meta.url));
const day = 24 * 60 * 60 * 1000;
const maxId = 2147483647;
const firstUser = 2; // Leave ID 1 available for the dev stack's administrator.
const locales = ["en_US", "zh_CN"];
const cppOptions = { compiler: "g++", std: "c++17", O: "2", m: "64" };
const usage = `node deploy/benchmark/seed.mjs --config backend.yaml [--manifest benchmark.json]
  [--seed UINT32] [--scale FACTOR] [--as-of YYYY-MM-DD]
  [--users N] [--problems N] [--practice-submissions N] [--contests N] [--discussions N] [--study-lists N]
  [--strict-submissions N] [--source-bytes N] [--yes-this-is-disposable]
Scale defaults to 1. Explicit counts override scaling. Study lists include one long list.
The optional strict IOI contest is additional to the regular contests. Source bytes apply only to that contest.
The reference date defaults to 2025-01-01 UTC. Contest 1 stays open through 2099 for repeatable live-page reads.
The target must have a fresh LLMOJ schema (the bootstrap administrator is allowed).
The manifest defaults to benchmark.json beside the config and stores the benchmark user's generated password.
The dev stack's server.hostname 127.0.0.1 and server.port 28400 give apiUrl http://127.0.0.1:28400.
Database-only configs have apiUrl null and can run the strict IOI measurement without a backend listener.`;

class SeedError extends Error {}

function integer(value, label, min, max = maxId) {
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new SeedError(`${label} must be an integer from ${min} to ${max}.`);
  return Number(value);
}

export function seedPlan(options = {}) {
  const seed = integer(options.seed ?? 1, "--seed", 0, 0xffffffff);
  const scale = Number(options.scale ?? 1);
  if (!Number.isFinite(scale) || scale <= 0) throw new SeedError("--scale must be a finite positive number.");
  const scaled = n => Math.max(1, Math.round(scale * n));
  const count = (flag, fallback, min = 0) => integer(options[flag] ?? fallback, `--${flag}`, min);
  const asOf = options["as-of"] ?? "2025-01-01";
  const anchor = Date.parse(`${asOf}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(anchor) ||
    new Date(anchor).toISOString().slice(0, 10) !== asOf ||
    asOf < "1002-01-01" ||
    asOf >= "2099-12-31"
  )
    throw new SeedError("--as-of must be an ISO calendar date between 1002-01-01 and 2099-12-30.");
  const counts = {
    users: count("users", scaled(2000), 1),
    problems: count("problems", scaled(1500), 1),
    practiceSubmissions: count("practice-submissions", scaled(300000)),
    contests: count("contests", scaled(30)),
    discussions: count("discussions", scaled(3000)),
    studyLists: count("study-lists", scaled(300) + 1),
    strictSubmissions: count("strict-submissions", 0)
  };
  counts.publicProblems = Math.max(1, Math.round((counts.problems * 14) / 15));
  counts.runningSubmissions = counts.contests ? scaled(2551) : 0;
  counts.perEndedContest = counts.contests > 1 ? scaled(1000) : 0;
  const ids = {
    firstUser,
    runningContest: counts.contests ? 1 : null,
    strictContest: counts.strictSubmissions ? counts.contests + 1 : null,
    longStudyList: counts.studyLists || null
  };
  const totalSubmissions =
    counts.practiceSubmissions +
    counts.strictSubmissions +
    counts.runningSubmissions +
    counts.perEndedContest * Math.max(0, counts.contests - 1);
  if (
    Math.max(
      totalSubmissions,
      counts.users + firstUser - 1,
      counts.problems * 2,
      counts.discussions * 5,
      (counts.contests + Number(!!ids.strictContest)) * Math.min(6, counts.problems)
    ) > maxId
  )
    throw new SeedError("The requested scale exceeds the database's integer IDs.");
  // The backend accepts traditional submission sources of at most one MiB.
  const sourceBytes = integer(options["source-bytes"] ?? 65536, "--source-bytes", 128, 1024 * 1024);
  return { version: 1, seed, scale, asOf, sourceBytes, counts, ids };
}

export function assertDisposableDatabase(name, yesThisIsDisposable = false) {
  if (typeof name !== "string" || !name || (!/^(llmoj_bench|llmoj_dev)/.test(name) && yesThisIsDisposable !== true))
    throw new SeedError(
      "Use a database named llmoj_bench* or llmoj_dev*, or explicitly pass --yes-this-is-disposable."
    );
}

async function readConfig(configPath) {
  return backendRequire("js-yaml").load(await readFile(configPath, "utf8"));
}

function benchmarkDatabase(config, yesThisIsDisposable) {
  const db = config?.services?.database;
  assertDisposableDatabase(db?.database, yesThisIsDisposable);
  if (
    !["mariadb", "mysql"].includes(db.type) ||
    !["localhost", "127.0.0.1"].includes(db.host) ||
    !db.username ||
    db.socketPath
  )
    throw new SeedError("Supply a disposable loopback TCP database in the backend config.");
  return {
    type: db.type,
    host: "127.0.0.1",
    port: integer(db.port ?? 3306, "database port", 1, 65535),
    username: db.username,
    password: db.password,
    database: db.database
  };
}

export async function readBenchmarkDatabase(configPath, yesThisIsDisposable = false) {
  return benchmarkDatabase(await readConfig(configPath), yesThisIsDisposable);
}

function seededIndex(seed) {
  let state = seed;
  return length => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * length);
  };
}

// Fixed-size parameterized batches keep scale 1 off the Node heap. Parent rows precede their children.
function* chunks(count, size = 400) {
  for (let start = 1; start <= count; start += size)
    yield Array.from({ length: Math.min(size, count - start + 1) }, (_, i) => start + i);
}

function insert(table, columnNames, rows) {
  const columns = columnNames.split(" ");
  const sql = `INSERT INTO \`${table}\` (${columns.map(name => `\`${name}\``).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  return { sql, rows };
}

const dateTime = ms => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const username = id => `bench_user_${id}`;
const json = JSON.stringify;

export function seedManifest(plan, server, password) {
  const apiUrl = ["127.0.0.1", "localhost"].includes(server?.hostname)
    ? new URL(`http://127.0.0.1:${integer(server.port, "server.port", 1, 65535)}`).origin
    : null;
  return { ...plan, apiUrl, login: { username: username(plan.ids.firstUser), password } };
}

export const benchmarkProblemTitle = id => `LLMOJ benchmark ${id} — Double a number`;

function* users(plan, hashes, anchor) {
  for (const numbers of chunks(plan.counts.users)) {
    const ids = numbers.map(n => firstUser + n - 1);
    yield insert(
      "user",
      "id username email nickname bio avatarInfo isAdmin acceptedProblemCount submissionCount rating publicEmail registrationTime",
      ids.map(id => [
        id,
        username(id),
        `${username(id)}@example.invalid`,
        "",
        "",
        "gravatar:",
        false,
        0,
        0,
        0,
        false,
        dateTime(anchor - 366 * day)
      ])
    );
    yield insert(
      "user_auth",
      "userId password",
      ids.map(id => [id, id === firstUser ? hashes.viewer : hashes.other])
    );
    yield insert(
      "user_information",
      "userId organization location url telegram qq github",
      ids.map(id => [id, "", "", "", "", "", ""])
    );
    yield insert(
      "user_preference",
      "userId preference",
      ids.map(id => [id, "{}"])
    );
  }
}

function statementRows(id, locale) {
  const en = locale === "en_US";
  return [
    [id, "ProblemTitle", locale, en ? benchmarkProblemTitle(id) : `数字加倍 ${id}`],
    [
      id,
      "ProblemContent",
      locale,
      json([
        {
          type: "Text",
          sectionTitle: en ? "Task" : "题目描述",
          text: en ? "Read an integer and print twice its value." : "读入一个整数，输出它的两倍。"
        },
        { type: "Sample", sectionTitle: en ? "Sample" : "样例", sampleId: 0 }
      ])
    ]
  ];
}

function* problems(plan, random, anchor) {
  const tags = [
    ["Arithmetic", "算术"],
    ["Implementation", "实现"],
    ["Integers", "整数"],
    ["Input and output", "输入输出"],
    ["Simulation", "模拟"],
    ["Basics", "基础"]
  ];
  const tagNumbers = tags.map((_, i) => i + 1);
  yield insert(
    "problem_tag",
    "id color locales",
    tagNumbers.map(id => [id, "blue", json(locales)])
  );
  yield insert(
    "localized_content",
    "objectId type locale data",
    tagNumbers.flatMap(id => locales.map((locale, i) => [id, "ProblemTagName", locale, tags[id - 1][i]]))
  );
  for (const ids of chunks(plan.counts.problems)) {
    yield insert(
      "problem",
      "id displayId type isPublic publicTime ownerId locales difficulty submissionCount acceptedSubmissionCount",
      ids.map(id => {
        const isPublic = id <= plan.counts.publicProblems;
        return [
          id,
          isPublic ? id : null,
          "Traditional",
          isPublic,
          isPublic ? dateTime(anchor - 365 * day) : null,
          firstUser + random(plan.counts.users),
          json(locales),
          1 + random(10),
          0,
          0
        ];
      })
    );
    yield insert(
      "localized_content",
      "objectId type locale data",
      ids.flatMap(id => locales.flatMap(locale => statementRows(id, locale)))
    );
    yield insert(
      "problem_sample",
      "problemId data",
      ids.map(id => [id, json([{ inputData: "2\n", outputData: "4\n" }])])
    );
    // This SQL read workload has no object-store test files or pending judge jobs.
    yield insert(
      "problem_judge_info",
      "problemId judgeInfo submittable",
      ids.map(id => [
        id,
        json({
          timeLimit: 1000,
          memoryLimit: 256,
          runSamples: true,
          subtasks: null,
          checker: { type: "lines", caseSensitive: false }
        }),
        false
      ])
    );
    yield insert(
      "problem_tag_map",
      "id problemId problemTagId",
      ids.flatMap(id => {
        const tag = random(tags.length);
        return [
          [id * 2 - 1, id, tag + 1],
          [id * 2, id, ((tag + 1 + random(tags.length - 1)) % tags.length) + 1]
        ];
      })
    );
  }
}

// A public IOI contest stays live across benchmark replays. Ended contest submissions span four hours.
function contestFixture(plan, id, anchor) {
  const running = id === plan.ids.runningContest;
  const strict = id === plan.ids.strictContest;
  const start = running ? anchor - day / 8 : anchor - (1 + ((id - 1) % 360)) * day;
  const end = running ? Date.UTC(2099, 11, 31) : start + day / 6;
  const width = Math.min(6, plan.counts.problems);
  const problems = Array.from({ length: width }, (_, i) => {
    const contestProblemId = (id - 1) * width + i + 1;
    return { id: contestProblemId, problemId: ((contestProblemId - 1) % plan.counts.problems) + 1, position: i + 1 };
  });
  const submissions = strict
    ? plan.counts.strictSubmissions
    : running
      ? plan.counts.runningSubmissions
      : plan.counts.perEndedContest;
  return { id, start, end, strict, running, problems, submissions };
}

function* contests(plan, anchor) {
  const count = plan.counts.contests + Number(!!plan.ids.strictContest);
  for (const ids of chunks(count)) {
    const fixtures = ids.map(id => contestFixture(plan, id, anchor));
    yield insert(
      "contest",
      "id title subtitle description rule ruleOptions startTime endTime ownerId adminIds isPublic hideStatistics languages createdAt",
      fixtures.map(c => [
        c.id,
        `Benchmark contest ${c.id}`,
        "",
        "Double a number.",
        c.strict ? "strictioi" : "ioi",
        "{}",
        dateTime(c.start),
        dateTime(c.end),
        firstUser + plan.counts.users - 1,
        "[]",
        true,
        false,
        json(["cpp:c++17"]),
        dateTime(c.start - day)
      ])
    );
    yield insert(
      "contest_problem",
      "id contestId problemId position title attachments",
      fixtures.flatMap(c => c.problems.map(p => [p.id, c.id, p.problemId, p.position, `Double ${p.position}`, "[]"]))
    );
  }
}

const subtaskWeights = [40, 60];
function finishedResult(mask, time, memory) {
  let score = 0;
  const testcaseResult = {};
  const subtasks = subtaskWeights.map((fullScore, index) => {
    const accepted = !!(mask & (1 << index));
    const earned = accepted ? fullScore : 0;
    score += earned;
    const key = `case${index + 1}`;
    testcaseResult[key] = {
      testcaseInfo: { inputFile: `${index + 1}.in`, outputFile: `${index + 1}.out`, timeLimit: 1000, memoryLimit: 256 },
      status: accepted ? "Accepted" : "WrongAnswer",
      score: accepted ? 100 : 0,
      time,
      memory
    };
    return { score: earned, fullScore, testcases: [{ testcaseHash: key }] };
  });
  const status = score === 100 ? "Accepted" : score === 0 ? "WrongAnswer" : "PartiallyCorrect";
  return { progressType: "Finished", status, score, totalOccupiedTime: 2 * time, subtasks, testcaseResult };
}

function* submissions(plan, random, anchor) {
  const contests = plan.counts.contests + Number(!!plan.ids.strictContest);
  let id = 0;
  // Zero is the practice stream; subsequent streams have real contest/problem links.
  for (let contestId = 0; contestId <= contests; contestId++) {
    const contest = contestId ? contestFixture(plan, contestId, anchor) : null;
    const count = contest ? contest.submissions : plan.counts.practiceSubmissions;
    const window = contest ? (contest.running ? anchor : contest.end) - contest.start : 365 * day;
    const start = contest ? contest.start : anchor - window;
    const batchSize = contest?.strict ? Math.min(400, Math.floor((1024 * 1024) / plan.sourceBytes)) : 400;
    for (const numbers of chunks(count, batchSize)) {
      const rows = [];
      const details = [];
      for (const n of numbers) {
        id++;
        const member = contest?.problems[random(contest.problems.length)];
        const problemId = member?.problemId ?? 1 + random(plan.counts.publicProblems);
        const submitter = firstUser + random(plan.counts.users);
        const time = 1 + random(100),
          memory = 1 + random(32);
        const result = finishedResult(random(4), time, memory);
        let code = `#include <iostream>\nint main(){int n;std::cin>>n;std::cout<<${result.score === 100 ? "2*n" : "n"};}\n// submission ${id}`;
        if (contest?.strict) code = code.padEnd(plan.sourceBytes, id.toString(36));
        const content = { language: "cpp", compileAndRunOptions: cppOptions, code };
        const submitTime = dateTime(start + Math.floor(((n - 1) / Math.max(1, count - 1)) * (window - 1000)));
        rows.push([
          id,
          contest?.id ?? null,
          member?.id ?? null,
          !contest,
          problemId,
          submitter,
          submitTime,
          "cpp",
          code.length,
          result.totalOccupiedTime,
          memory,
          result.score,
          result.status,
          result.totalOccupiedTime
        ]);
        details.push([id, json(content), json(result)]);
      }
      yield insert(
        "submission",
        "id contestId contestProblemId isPublic problemId submitterId submitTime codeLanguage answerSize timeUsed memoryUsed score status totalOccupiedTime",
        rows
      );
      yield insert("submission_detail", "submissionId content result", details);
    }
  }
}

function* discussions(plan, random, anchor) {
  for (const ids of chunks(plan.counts.discussions)) {
    const threads = ids.map(id => ({ id, at: anchor - day * (1 + random(365)) }));
    yield insert(
      "discussion",
      "id title publishTime sortTime replyCount isPublic publisherId problemId",
      threads.map(({ id, at }) => [
        id,
        `Benchmark discussion ${id}`,
        dateTime(at),
        dateTime(at + 5000),
        5,
        true,
        firstUser + random(plan.counts.users),
        id % 2 ? null : 1 + random(plan.counts.publicProblems)
      ])
    );
    yield insert(
      "discussion_content",
      "discussionId content",
      ids.map(id => [id, `Notes on example ${id}.`])
    );
    yield insert(
      "discussion_reply",
      "id discussionId publisherId content publishTime isPublic",
      threads.flatMap(({ id, at }) =>
        Array.from({ length: 5 }, (_, i) => [
          (id - 1) * 5 + i + 1,
          id,
          firstUser + random(plan.counts.users),
          `Reply ${i + 1} to discussion ${id}.`,
          dateTime(at + (i + 1) * 1000),
          true
        ])
      )
    );
  }
}

function* studyLists(plan, random, anchor) {
  for (const ids of chunks(plan.counts.studyLists)) {
    yield insert(
      "study_list",
      "id ownerId title description items version updatedAt",
      ids.map(id => {
        const count = Math.min(id === plan.ids.longStudyList ? 1000 : 50, plan.counts.publicProblems);
        const offset = random(plan.counts.publicProblems);
        const items = Array.from({ length: count }, (_, i) => ({
          problemId: ((offset + i) % plan.counts.publicProblems) + 1,
          section: "Practice",
          note: ""
        }));
        return [id, firstUser, `Practice list ${id}`, "Double a number.", json(items), 1, dateTime(anchor)];
      })
    );
  }
}

export function* seedBatches(plan, hashes) {
  const anchor = Date.parse(`${plan.asOf}T00:00:00Z`);
  const random = seededIndex(plan.seed);
  yield* users(plan, hashes, anchor);
  yield* problems(plan, random, anchor);
  yield* contests(plan, anchor);
  yield* submissions(plan, random, anchor);
  yield* discussions(plan, random, anchor);
  yield* studyLists(plan, random, anchor);
}

export async function seedDatabase(connection, database, plan, hashes, persistManifest, yesThisIsDisposable = false) {
  assertDisposableDatabase(database, yesThisIsDisposable);
  const [selected] = await connection.query("SELECT DATABASE() AS db");
  if (selected?.db !== database) throw new SeedError("The selected database does not match the backend config.");
  await connection.beginTransaction();
  try {
    // No truncation, foreign-key disabling or upserts. A collision from a concurrent seed rolls back.
    const [occupied] = await connection.query(`SELECT
      EXISTS(SELECT 1 FROM \`user\` WHERE NOT (id = 1 AND username = 'admin' AND isAdmin = 1))
      OR EXISTS(SELECT 1 FROM problem) OR EXISTS(SELECT 1 FROM problem_tag) OR EXISTS(SELECT 1 FROM contest)
      OR EXISTS(SELECT 1 FROM submission) OR EXISTS(SELECT 1 FROM discussion) OR EXISTS(SELECT 1 FROM study_list) AS used`);
    if (Number(occupied.used))
      throw new SeedError("Seeding needs a fresh database. Reset the disposable stack before replay.");
    for (const { sql, rows } of seedBatches(plan, hashes)) await connection.batch(sql, rows);
    // Mirror the practice-only definitions in deploy/rebuild-statistics.mjs. There is no pending outbox on a fresh DB.
    await connection.query(`UPDATE problem p JOIN (
      SELECT problemId, COUNT(*) AS attempts, SUM(status = 'Accepted') AS accepted
      FROM submission WHERE contestId IS NULL GROUP BY problemId
    ) s ON s.problemId = p.id SET p.submissionCount = s.attempts, p.acceptedSubmissionCount = s.accepted`);
    await connection.query(`UPDATE \`user\` u JOIN (
      SELECT submitterId, COUNT(*) AS attempts, COUNT(DISTINCT CASE WHEN status = 'Accepted' THEN problemId END) AS accepted
      FROM submission WHERE contestId IS NULL GROUP BY submitterId
    ) s ON s.submitterId = u.id SET u.submissionCount = s.attempts, u.acceptedProblemCount = s.accepted`);
    // Keep the generated login available even if COMMIT's reply is lost.
    await persistManifest();
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  }
}

async function saveManifest(filename, value) {
  let file;
  try {
    file = await open(filename, "wx", 0o600);
    await file.writeFile(json(value, null, 2) + "\n");
    await file.sync();
  } catch (error) {
    if (file) await unlink(filename);
    if (error.code === "EEXIST")
      throw new SeedError("The benchmark manifest already exists. Choose an unused manifest path.");
    throw error;
  } finally {
    await file?.close();
  }
}

async function main(argv) {
  const strings = [
    "config",
    "manifest",
    "seed",
    "scale",
    "as-of",
    "users",
    "problems",
    "practice-submissions",
    "contests",
    "discussions",
    "study-lists",
    "strict-submissions",
    "source-bytes"
  ];
  const { values } = parseArgs({
    args: argv,
    options: {
      ...Object.fromEntries(strings.map(flag => [flag, { type: "string" }])),
      "yes-this-is-disposable": { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.config) throw new SeedError(usage);
  const plan = seedPlan(values);
  const yes = values["yes-this-is-disposable"];
  const config = await readConfig(values.config);
  const db = benchmarkDatabase(config, yes);
  const manifest = path.resolve(values.manifest ?? path.join(path.dirname(values.config), "benchmark.json"));
  const password = randomBytes(18).toString("base64url");
  const fixture = seedManifest(plan, config?.server, password);
  const bcrypt = backendRequire("bcrypt");
  const hashes = {
    viewer: await bcrypt.hash(password, 10),
    other: await bcrypt.hash(randomBytes(24).toString("base64url"), 10)
  };
  const connection = await backendRequire("mariadb").createConnection({
    host: db.host,
    port: db.port,
    user: db.username,
    password: db.password,
    database: db.database
  });
  try {
    await seedDatabase(connection, db.database, plan, hashes, () => saveManifest(manifest, fixture), yes);
    console.log(JSON.stringify({ ...plan, apiUrl: fixture.apiUrl, manifest }, null, 2));
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    // Driver errors can include SQL parameters. Report their code without echoing credentials.
    if (error instanceof SeedError || String(error.code).startsWith("ERR_PARSE_ARGS_")) console.error(error.message);
    else
      console.error(
        `Benchmark seed failed (${/^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "database or file operation"}).`
      );
    process.exitCode = 1;
  });
