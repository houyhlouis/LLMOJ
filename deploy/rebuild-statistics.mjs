#!/usr/bin/env node
// Checks the counts derived from submissions (problems' submissions and accepted submissions, users' submissions and
// accepted problems) against the submissions themselves, and with --apply corrects the ones that differ.
// Contest submissions aren't counted. Safe while the site runs: the backend records each change of the counts in the
// transaction that changes a submission (statistics_outbox) and applies it afterwards, so a count is compared with
// the submissions minus the changes not applied yet, both read by one statement; a row is corrected while locked.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

class StatisticsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const PENDING_PROBLEM = `SELECT targetId, SUM(submissions) AS submissions, SUM(accepted) AS accepted
  FROM statistics_outbox WHERE kind = 'Problem' GROUP BY targetId`;
const PENDING_USER = `SELECT targetId, SUM(submissions) AS submissions, SUM(accepted <> 0) AS recount
  FROM statistics_outbox WHERE kind = 'User' GROUP BY targetId`;
const PROBLEM_COUNTS = `SELECT
  (SELECT COUNT(*) FROM submission WHERE problemId = ? AND contestId IS NULL) -
  (SELECT COALESCE(SUM(submissions), 0) FROM statistics_outbox WHERE kind = 'Problem' AND targetId = ?) AS submissions,
  (SELECT COALESCE(SUM(status = 'Accepted'), 0) FROM submission WHERE problemId = ? AND contestId IS NULL) -
  (SELECT COALESCE(SUM(accepted), 0) FROM statistics_outbox WHERE kind = 'Problem' AND targetId = ?) AS accepted`;
// A user's accepted problems are counted again whenever they change, so they're compared without pending changes
const USER_COUNTS = `SELECT
  (SELECT COUNT(*) FROM submission WHERE submitterId = ? AND contestId IS NULL) -
  (SELECT COALESCE(SUM(submissions), 0) FROM statistics_outbox WHERE kind = 'User' AND targetId = ?) AS submissions,
  (SELECT COUNT(DISTINCT problemId) FROM submission
    WHERE submitterId = ? AND status = 'Accepted' AND contestId IS NULL) AS accepted`;
const PROBLEM_DRIFT = `SELECT p.id, p.submissionCount, p.acceptedSubmissionCount,
  COALESCE(s.submissions, 0) - COALESCE(o.submissions, 0) AS submissions,
  COALESCE(s.accepted, 0) - COALESCE(o.accepted, 0) AS accepted FROM problem p
  LEFT JOIN (SELECT problemId, COUNT(*) AS submissions, SUM(status = 'Accepted') AS accepted FROM submission
    WHERE contestId IS NULL GROUP BY problemId) s ON s.problemId = p.id
  LEFT JOIN (${PENDING_PROBLEM}) o ON o.targetId = p.id
  WHERE p.submissionCount <> COALESCE(s.submissions, 0) - COALESCE(o.submissions, 0)
    OR p.acceptedSubmissionCount <> COALESCE(s.accepted, 0) - COALESCE(o.accepted, 0)
  ORDER BY p.id`;
const USER_DRIFT = `SELECT u.id, u.submissionCount, u.acceptedProblemCount,
  COALESCE(s.submissions, 0) - COALESCE(o.submissions, 0) AS submissions, COALESCE(s.accepted, 0) AS accepted
  FROM user u
  LEFT JOIN (SELECT submitterId, COUNT(*) AS submissions,
    COUNT(DISTINCT CASE WHEN status = 'Accepted' THEN problemId END) AS accepted FROM submission
    WHERE contestId IS NULL GROUP BY submitterId) s ON s.submitterId = u.id
  LEFT JOIN (${PENDING_USER}) o ON o.targetId = u.id
  WHERE u.submissionCount <> COALESCE(s.submissions, 0) - COALESCE(o.submissions, 0)
    OR (u.acceptedProblemCount <> COALESCE(s.accepted, 0) AND COALESCE(o.recount, 0) = 0)
  ORDER BY u.id`;
const SAMPLE = 20;

const counts = row => [Number(row.submissions), Number(row.accepted)];

/**
 * @param ds An initialized TypeORM DataSource of the site's database.
 * @return `{ problems, users }`, each `{ differing, corrected, sample }`.
 */
export async function rebuildStatistics(ds, { apply = false } = {}) {
  const result = {};
  for (const [kind, table, columns, drift, recount] of [
    ['problems', 'problem', ['submissionCount', 'acceptedSubmissionCount'], PROBLEM_DRIFT, PROBLEM_COUNTS],
    ['users', 'user', ['submissionCount', 'acceptedProblemCount'], USER_DRIFT, USER_COUNTS]
  ]) {
    const rows = await ds.query(drift);
    let corrected = 0;
    if (apply)
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop -- One short transaction per row.
        corrected += await ds.transaction('READ COMMITTED', async manager => {
          const locked = await manager.query(`SELECT ${columns.join(', ')} FROM \`${table}\` WHERE id = ? FOR UPDATE`, [row.id]);
          if (locked.length === 0) return 0;
          // Every placeholder of the recount is this row's ID
          const ids = Array(recount.split('?').length - 1).fill(row.id);
          const [submissions, accepted] = counts((await manager.query(recount, ids))[0]);
          if (Number(locked[0][columns[0]]) === submissions && Number(locked[0][columns[1]]) === accepted) return 0;
          await manager.query(`UPDATE \`${table}\` SET ${columns[0]} = ?, ${columns[1]} = ? WHERE id = ?`,
            [submissions, accepted, row.id]);
          return 1;
        });
      }
    result[kind] = {
      differing: rows.length,
      corrected,
      sample: rows.slice(0, SAMPLE).map(row => ({
        id: Number(row.id),
        stored: [Number(row[columns[0]]), Number(row[columns[1]])],
        counted: counts(row)
      }))
    };
  }
  return result;
}

function argumentsFor(values) {
  const result = { apply: false };
  for (let index = 0; index < values.length; index++) {
    const option = values[index];
    if (option === '--apply' && !result.apply) {
      result.apply = true;
      continue;
    }
    if (option !== '--root' && option !== '--config') throw new StatisticsError('INVALID_ARGUMENTS');
    const key = option.slice(2);
    if (result[key] || !values[index + 1] || values[index + 1].startsWith('--'))
      throw new StatisticsError('INVALID_ARGUMENTS');
    result[key] = values[++index];
  }
  if (!result.root || !result.config) throw new StatisticsError('INVALID_ARGUMENTS');
  return result;
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const root = fs.realpathSync(path.resolve(args.root));
  const require = createRequire(path.join(root, 'apps/backend/package.json'));
  const config = require('js-yaml').load(fs.readFileSync(path.resolve(args.config), 'utf8'));
  const database = config?.services?.database;
  if (!database || !['mariadb', 'mysql'].includes(database.type) || !database.database)
    throw new StatisticsError('DATABASE_CONFIGURATION_REQUIRED');
  const { DataSource } = require('typeorm');
  const ds = new DataSource({ ...database, entities: [], synchronize: false, migrationsRun: false, logging: false });
  await ds.initialize();
  try {
    const result = await rebuildStatistics(ds, { apply: args.apply });
    console.log(JSON.stringify({ applied: args.apply, ...result }));
  } finally {
    await ds.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    console.error(JSON.stringify({ error: error instanceof StatisticsError ? error.code : 'STATISTICS_FAILED' }));
    if (!(error instanceof StatisticsError)) console.error(error);
    process.exit(1);
  });
