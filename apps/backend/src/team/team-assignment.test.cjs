const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );

const { DataSource } = require("typeorm");
const { TeamService } = require("./team.service.ts");
const { TeamAssignmentEntity, TeamMemberEntity } = require("./team.entity.ts");
const { SubmissionEntity } = require("../submission/submission.entity.ts");

const members = [10, 20, 30].map(userId => ({ userId, status: "member", groupId: 1, permissions: [] }));
const deadline = new Date("2025-01-31T00:00:00Z");
const visible = [1, 2, 3, 4, 5];
const hidden = 6;
const makeRow = (id, problemId, status, score, user = 10, date = deadline, contestId = null) => ({
  id,
  submitterId: user,
  problemId,
  status,
  score,
  submitTime: +date,
  contestId
});

// Independent reference for the previous per-user copy, filter and sort, including its effective-score tie rule.
function previous(rows) {
  const byUser = new Map();
  let copied = 0;
  for (const row of rows) {
    if (row.contestId != null || row.submitTime > +deadline || !visible.includes(row.problemId)) continue;
    const previous = byUser.get(row.submitterId) || [];
    copied += previous.length;
    byUser.set(row.submitterId, [...previous, row]);
  }
  const score = row =>
    row.status === "Accepted"
      ? 100
      : ["Fake", "Hacked"].includes(row.status)
        ? 0
        : Math.max(0, Math.min(100, Number(row.score) || 0));
  const results = members.map(({ userId }) => {
    const problems = {};
    let total = 0;
    for (const id of visible) {
      const best = (byUser.get(userId) || [])
        .filter(row => row.problemId === id && row.score != null)
        .sort((a, b) => score(b) - score(a) || b.id - a.id)[0];
      problems[id] = best
        ? { score: score(best), status: best.status, submissionId: best.id, accepted: best.status === "Accepted" }
        : { score: 0, status: null, submissionId: null, accepted: false };
      total += problems[id].score;
    }
    return { userId, problems, total };
  });
  return { results, copied };
}

test("assignment rows equal the previous scores, with one pass over eligible submissions", async t => {
  const source = new DataSource({
    type: "mariadb",
    database: "team_fixture",
    entities: [path.join(__dirname, "../**/*.entity.ts")]
  });
  await source.buildMetadatas();
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  // SQLite executes the real MariaDB query builder's SQL. Read rows in reverse order to exercise equal-score ties.
  const columns = source.getMetadata(SubmissionEntity).columns.map(column => '"' + column.databaseName + '"');
  sql.exec("CREATE TABLE submission (" + columns.join(",") + "); PRAGMA reverse_unordered_selects = ON");
  const insert = sql.prepare(
    "INSERT INTO submission (id, submitterId, problemId, status, score, submitTime, contestId) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const runner = source.createQueryRunner();
  const queries = [];
  runner.query = async (query, parameters) => {
    queries.push(query);
    return { records: sql.prepare(query).all(...parameters.map(value => (value instanceof Date ? +value : value))) };
  };
  const repo = runner.manager.getRepository(SubmissionEntity);
  let visited = 0,
    eligible = 0,
    canView = true;
  const submissionRepository = {
    createQueryBuilder(alias) {
      const qb = repo.createQueryBuilder(alias);
      const getMany = qb.getMany.bind(qb);
      qb.getMany = async () => {
        const rows = await getMany();
        eligible += rows.length;
        for (const row of rows) {
          const problemId = row.problemId;
          Object.defineProperty(row, "problemId", {
            get() {
              visited++;
              return problemId;
            }
          });
        }
        return rows;
      };
      return qb;
    }
  };
  const assignment = {
    id: 1,
    assignedUserIds: [],
    assignedGroupIds: [],
    deadline,
    items: [...visible, hidden].map(problemId => ({ problemId }))
  };
  const service = Object.assign(Object.create(TeamService.prototype), {
    requireMember: async () => ({ team: { id: 1, ownerId: 10 }, member: members[0] }),
    users: { findUsersByExistingIds: async ids => ids.map(id => ({ username: String(id) })) },
    problems: {
      findProblemById: async id => ({ id, locales: ["en_US"] }),
      getProblemLocalizedTitle: async p => String(p.id)
    },
    problemAccess: { userHasPermission: async (_user, p) => p.id !== hidden },
    privileges: { userHasPrivilege: async () => canView },
    db: {
      getRepository(entity) {
        if (entity === TeamAssignmentEntity) return { findOneBy: async () => assignment };
        if (entity === TeamMemberEntity) return { findBy: async () => members };
        assert.equal(entity, SubmissionEntity);
        return submissionRepository;
      }
    }
  });
  const read = () => service.assignment({ id: 10 }, { teamId: 1, id: 1 });
  for (const count of [500, 1000]) {
    const rows = Array.from({ length: count }, (_, i) => makeRow(i + 1, (i % 3) + 1, "PartiallyCorrect", i % 101));
    rows.push(
      makeRow(count + 1, 1, "Accepted", 0),
      makeRow(count + 2, 1, "PartiallyCorrect", 119),
      makeRow(count + 3, 2, "Fake", 100, 20),
      makeRow(count + 4, 2, "Hacked", 100, 20),
      makeRow(count + 5, 3, "WrongAnswer", -1, 20),
      makeRow(count + 6, 4, "Accepted", null),
      makeRow(count + 7, hidden, "Accepted", 100),
      makeRow(count + 8, 5, "Accepted", 100, 10, +deadline + 1),
      makeRow(count + 9, 5, "Accepted", 100, 10, deadline, 1)
    );
    sql.exec("DELETE FROM submission");
    for (const { id, submitterId, problemId, status, score, submitTime, contestId } of rows)
      insert.run(id, submitterId, problemId, status, score, submitTime, contestId);
    const old = previous(rows);
    visited = eligible = 0;
    queries.length = 0;
    const { rows: current, details } = await read();
    assert.deepEqual(
      current.map(({ userId, problems, total }) => ({ userId, problems, total })),
      old.results
    );
    assert.deepEqual(details.at(-1), { problemId: hidden, unavailable: true });
    assert.equal(current[0].problems[1].submissionId, count + 2);
    assert.deepEqual(current[1].problems[2], { score: 0, status: "Hacked", submissionId: count + 4, accepted: false });
    assert.equal(queries.length, 1);
    const selected = queries[0].split(" FROM ")[0];
    assert.deepEqual(Array.from(selected.matchAll(/`s`\.`(\w+)`/g), match => match[1]).sort(), [
      "id",
      "problemId",
      "score",
      "status",
      "submitterId"
    ]);
    assert.equal(eligible, count + 5);
    assert.equal(visited, eligible);
    assert.ok(old.copied >= (count * (count - 1)) / 2);
    t.diagnostic(
      `${count} repeated submissions: ${old.copied} earlier array entries copied, ${visited} new problem-ID reads`
    );
  }
  canView = false;
  queries.length = 0;
  const noResults = await read();
  assert.ok(noResults.rows.every(row => row.total === null && !Object.keys(row.problems).length));
  assert.deepEqual(queries, []);
});
