// Opt-in SQL migration regression. Refuses any selected database that already has a submission table.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("../apps/backend/node_modules/js-yaml");
test("Fake SQL migration preserves enum positions, is repeatable and rejects unknown definitions", {
  skip: !process.env.LLMOJ_FAKE_TEST_DB_CONFIG, timeout: 60000
}, () => {
  const cfg = yaml.load(fs.readFileSync(process.env.LLMOJ_FAKE_TEST_DB_CONFIG, "utf8")).services.database;
  assert.match(cfg.database, /(?:^|_)fake(?:_|$)/i, "Use an explicitly named Fake isolation database");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-fake-sql-test-")), options = path.join(directory, "client.cnf");
  const quote = value => '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  fs.writeFileSync(options, "[client]\nhost=" + quote(cfg.host) + "\nport=" + cfg.port + "\nuser=" + quote(cfg.username) +
    "\npassword=" + quote(cfg.password) + "\ndatabase=" + quote(cfg.database) + "\nprotocol=tcp\n", { mode: 0o600 });
  const sql = (query, success = true) => {
    const result = spawnSync(process.env.LLMOJ_MARIADB_BINARY || "mariadb", ["--defaults-extra-file=" + options, "--batch", "--skip-column-names", "--connect-timeout=5"], { input: query, encoding: "utf8", timeout: 10000 });
    if (result.error) throw result.error;
    if (success) assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const values = ["Pending", "ConfigurationError", "SystemError", "Canceled", "CompilationError", "FileError", "RuntimeError", "TimeLimitExceeded", "MemoryLimitExceeded", "OutputLimitExceeded", "PartiallyCorrect", "WrongAnswer", "Accepted", "JudgementFailed"];
  const migration = fs.readFileSync(path.join(__dirname, "fake-migration.sql"), "utf8");
  let created = false;
  try {
    assert.equal(sql("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='submission'").stdout.trim(), "0", "Refusing to alter an existing submission table");
    sql("CREATE TABLE submission(id INT PRIMARY KEY,status ENUM(" + values.map(v => "'" + v + "'").join(",") + ") NOT NULL)"); created = true;
    sql("INSERT INTO submission VALUES " + values.map((v, i) => "(" + (i + 1) + ",'" + v + "')").join(","));
    const before = sql("SELECT id,status,status+0 FROM submission ORDER BY id").stdout;
    sql(migration); assert.equal(sql("SELECT id,status,status+0 FROM submission ORDER BY id").stdout, before);
    sql(migration); sql("INSERT INTO submission VALUES (15,'Fake')");
    assert.equal(sql("SELECT status,status+0 FROM submission WHERE id=15").stdout.trim(), "Fake\t15");
    sql("ALTER TABLE submission MODIFY status ENUM(" + [...values, 'Fake', 'Hacked'].map(v=>"'"+v+"'").join(',') + ") NOT NULL");
    sql("INSERT INTO submission VALUES (16,'Hacked')");
    const withHacked = sql("SELECT id,status,status+0 FROM submission ORDER BY id").stdout;
    sql(migration);
    assert.equal(sql("SELECT id,status,status+0 FROM submission ORDER BY id").stdout, withHacked, 'The legacy Fake helper must never remove Hacked');
    sql("DROP TABLE submission; CREATE TABLE submission(id INT PRIMARY KEY,status ENUM('Accepted','WrongAnswer') NOT NULL)");
    const unsupported = sql(migration, false); assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /Unexpected submission.status enum or order/);
    assert.equal(sql("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='submission' AND COLUMN_NAME='status'").stdout.trim(), "enum('Accepted','WrongAnswer')");
  } finally {
    try {
      if (created) sql("DROP TABLE IF EXISTS submission; DROP PROCEDURE IF EXISTS llmoj_migrate_fake_verdict_20261013;");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});
