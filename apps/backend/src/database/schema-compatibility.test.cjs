// The schema builder's statements, as TypeORM writes them for MariaDB, sorted into what the backend's startup check
// refuses (missing), reports (changed) and ignores (extra). deploy/test/initialize-schema.test.mjs checks the same on a
// real database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "schema-compatibility.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const exported = {};
new Function("module", "exports", "require", source)({ exports: exported }, exported, require);
const { classifySchemaQueries, describeMissing, isSchemaCheckEnabled } = exported;

test("missing tables and columns are told apart from changes and a newer release's additions", () => {
  const differences = classifySchemaQueries([
    "CREATE TABLE `judge_job_attempt` (`id` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB",
    "ALTER TABLE `judge_job` ADD `availableAt` datetime(3) NOT NULL",
    "ALTER TABLE `judge_job` DROP COLUMN `qaNewerColumn`",
    "ALTER TABLE `judge_job` DROP COLUMN `type`",
    "ALTER TABLE `judge_job` ADD `type` varchar(24) NOT NULL",
    "ALTER TABLE `user` CHANGE `nickname` `nickname` varchar(80) NOT NULL",
    "CREATE INDEX `IDX_d78633726d8ce6f8afb263b595` ON `judge_job` (`state`, `leaseUntil`)",
    "CREATE UNIQUE INDEX `REL_abc` ON `user_auth` (`userId`)",
    "DROP INDEX `IDX_qa_newer` ON `judge_job`",
    "ALTER TABLE `problem` DROP FOREIGN KEY `FK_qa`",
    "ALTER TABLE `problem` ADD CONSTRAINT `FK_owner` FOREIGN KEY (`ownerId`) REFERENCES `user`(`id`)"
  ]);
  assert.deepEqual(differences.missing, ["table judge_job_attempt", "column judge_job.availableAt"]);
  assert.deepEqual(differences.extra, [
    "column judge_job.qaNewerColumn",
    "index judge_job.IDX_qa_newer",
    "foreign key problem.FK_qa"
  ]);
  assert.equal(differences.changed.length, 5);
  assert(differences.changed.includes("column judge_job.type"));
  assert(differences.changed.some(change => change.startsWith("ALTER TABLE `problem` ADD CONSTRAINT")));
});

test("a proposed rename means the new name is missing and the old one is extra", () => {
  const differences = classifySchemaQueries([
    "ALTER TABLE `judge_job` CHANGE `qaNewerColumn` `availableAt` int NULL",
    "ALTER TABLE `judge_job` DROP COLUMN `availableAt`",
    "ALTER TABLE `judge_job` ADD `availableAt` datetime(3) NOT NULL"
  ]);
  assert.deepEqual(differences, {
    missing: ["column judge_job.availableAt"],
    changed: [],
    extra: ["column judge_job.qaNewerColumn"]
  });
  assert.deepEqual(classifySchemaQueries([]), { missing: [], changed: [], extra: [] });
});

test("the refusal names what is missing and how to start anyway", () => {
  const message = describeMissing({ missing: ["a", "b", "c", "d", "e", "f", "g"], changed: [], extra: [] });
  assert.match(message, /a, b, c, d, e and 2 more/);
  assert.match(message, /deploy\/upgrade\.sh/);
  assert.match(message, /LIBREOJ_SCHEMA_CHECK=0/);
  assert.equal(isSchemaCheckEnabled({}), true);
  assert.equal(isSchemaCheckEnabled({ LIBREOJ_SCHEMA_CHECK: "0" }), false);
});
