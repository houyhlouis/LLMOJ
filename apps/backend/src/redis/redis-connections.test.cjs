// Every getClient() opens a Redis connection that stays open until it's closed. Periodic jobs used to open one per
// run (about 1,600 a day, never closed) until Redis refused new clients. Connections are opened once, in a
// constructor, or closed by the code that opened them; periodic turns use the shared connection.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );

const src = path.resolve(__dirname, "..");
const sources = dir =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [file] : [];
  });

/** The class member (starting at two spaces' indentation) a line belongs to, and the lines of that member. */
function member(lines, index) {
  const starts = line => /^ {2}[A-Za-z@]/.test(line);
  let start = index;
  while (start > 0 && !starts(lines[start])) start--;
  let end = index + 1;
  while (end < lines.length && !starts(lines[end]) && !/^\}/.test(lines[end])) end++;
  return { header: lines[start], body: lines.slice(start, end).join("\n") };
}

test("Redis connections are opened in constructors or closed where they're opened", () => {
  const offenders = [];
  let opened = 0;
  for (const file of sources(src)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!line.includes(".getClient()") || /^\s*(\*|\/\/)/.test(line) || /getClient\(\): Redis/.test(line)) return;
      opened++;
      const { header, body } = member(lines, index);
      const kept = /^ {2}constructor\(/.test(header) && /this\.\w+ = (this\.)?redisService\.getClient\(\)/.test(line);
      const local = line.match(/const (\w+) = this\.redisService\.getClient\(\);/);
      const closed = local && new RegExp(`${local[1]}\\.(quit|disconnect)\\(\\)`).test(body);
      if (!kept && !closed) offenders.push(`${path.relative(src, file)}:${index + 1}`);
    });
  }
  assert(opened >= 10, "the scan finds the backend's Redis clients");
  assert.deepEqual(offenders, []);
});

test("periodic turns take no new connection", async () => {
  const { RedisService } = require("./redis.service.ts");
  const { StatisticsOutboxService } = require("../submission/statistics-outbox.service.ts");
  const { ProblemDataVersionService } = require("../problem/problem-data-version.service.ts");

  // The shared connection: SET ... PX ... NX succeeds once per period.
  const holders = new Map();
  const calls = [];
  const redis = Object.assign(Object.create(RedisService.prototype), {
    client: {
      set: async (key, value, unit, milliseconds, mode) => {
        calls.push([key, unit, milliseconds, mode]);
        if (holders.has(key)) return null;
        holders.set(key, value);
        return "OK";
      }
    },
    getClient() {
      throw new Error("a periodic turn opened a connection");
    }
  });
  assert.equal(await redis.takeTurn("job", 59000), true);
  assert.equal(await redis.takeTurn("job", 59000), false);
  assert.deepEqual(calls[0], ["job", "PX", 59000, "NX"]);

  let replays = 0;
  const outbox = Object.assign(Object.create(StatisticsOutboxService.prototype), {
    redisService: redis,
    replay: async () => replays++
  });
  let sweeps = 0;
  const versions = Object.assign(Object.create(ProblemDataVersionService.prototype), {
    redisService: redis,
    sweepDeferredFiles: async () => sweeps++
  });
  for (let i = 0; i < 100; i++) {
    // eslint-disable-next-line no-await-in-loop
    await outbox.replayTurn();
    // eslint-disable-next-line no-await-in-loop
    await versions.sweepTurn();
  }
  // One turn each until the period passes; never a new connection.
  assert.equal(replays, 1);
  assert.equal(sweeps, 1);

  // Without Redis, every process takes the turn (both jobs are safe to run twice).
  const down = Object.assign(Object.create(RedisService.prototype), {
    client: { set: async () => Promise.reject(new Error("connection refused")) }
  });
  Object.assign(outbox, { redisService: down });
  Object.assign(versions, { redisService: down });
  await outbox.replayTurn();
  await versions.sweepTurn();
  assert.equal(replays, 2);
  assert.equal(sweeps, 2);
});
