const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "database.providers.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", "__dirname", source)(
  name =>
    ({
      "@nestjs/typeorm": { TypeOrmModule: { forRootAsync: options => options } },
      "../config/config.service": { ConfigService: class ConfigService {} },
      "./query-metrics": {
        QueryMetricsLogger: class QueryMetricsLogger {
          constructor(printAll) {
            this.printAll = printAll;
          }
        },
        QUERY_TIMING_THRESHOLD_MS: 1
      }
    }[name]),
  loaded,
  loaded.exports,
  __dirname
);
const { isSchemaSyncEnabled, databaseProviders } = loaded.exports;

test("production never synchronizes the schema unless explicitly enabled", () => {
  assert.equal(isSchemaSyncEnabled({ NODE_ENV: "production" }), false);
  assert.equal(isSchemaSyncEnabled({ NODE_ENV: "production", LIBREOJ_SCHEMA_SYNC: "" }), false);
  assert.equal(isSchemaSyncEnabled({ NODE_ENV: "production", LIBREOJ_SCHEMA_SYNC: "true" }), false);
  assert.equal(isSchemaSyncEnabled({ NODE_ENV: "production", LIBREOJ_SCHEMA_SYNC: "0" }), false);
  assert.equal(isSchemaSyncEnabled({ NODE_ENV: "production", LIBREOJ_SCHEMA_SYNC: "1" }), true);
});

test("development keeps synchronizing unless disabled by the upgrade guard", () => {
  assert.equal(isSchemaSyncEnabled({}), true);
  assert.equal(isSchemaSyncEnabled({ NODE_ENV: "development" }), true);
  assert.equal(isSchemaSyncEnabled({ LIBREOJ_SCHEMA_SYNC: "0" }), false);
});

test("the TypeORM options follow the process environment", () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, LIBREOJ_SCHEMA_SYNC: process.env.LIBREOJ_SCHEMA_SYNC };
  const database = { type: "mariadb", host: "h", port: 1, username: "u", password: "p", database: "d" };
  const options = () => databaseProviders[0].useFactory({ config: { services: { database } } });
  try {
    process.env.NODE_ENV = "production";
    delete process.env.LIBREOJ_SCHEMA_SYNC;
    assert.equal(options().synchronize, false);
    process.env.LIBREOJ_SCHEMA_SYNC = "1";
    assert.equal(options().synchronize, true);
    // Every query goes through the query counter (database/query-metrics.ts), which times those over 1 ms
    assert.equal(options().logger.constructor.name, "QueryMetricsLogger");
    assert.equal(options().maxQueryExecutionTime, 1);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
