// Stored files get a content hash: what the backend stores itself is hashed as it's stored, and files without one
// (from before content hashes, or added another way) are hashed in the background, a bounded amount at a time.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
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
String.prototype.format ||= function format(...args) {
  return require("node:util").format(String(this), ...args);
};
require("@nestjs/common").Logger.overrideLogger(false);
const { FileService } = require("./file.service.ts");
const { FileContentHashService } = require("./file-content-hash.service.ts");

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");

// A file service over in-memory storage and file rows
function storage(rows = [], objects = {}) {
  const stored = new Map(Object.entries(objects).map(([uuid, data]) => [uuid, Buffer.from(data)]));
  const reads = [];
  const minio = {
    getObject: async (_bucket, uuid) => {
      reads.push(uuid);
      if (!stored.has(uuid)) throw Object.assign(new Error("Not Found"), { code: "NoSuchKey" });
      return Readable.from([stored.get(uuid)]);
    },
    putObject: async (_bucket, uuid, value) => {
      if (Buffer.isBuffer(value)) stored.set(uuid, value);
      else {
        const chunks = [];
        for await (const chunk of value) chunks.push(chunk);
        stored.set(uuid, Buffer.concat(chunks));
      }
    },
    fPutObject: async (_bucket, uuid, local) => stored.set(uuid, fs.readFileSync(local))
  };
  const fileRepository = {
    find: async ({ where, order, take, select }) => {
      let result = rows;
      if (where.uuid) result = result.filter(row => where.uuid.value.includes(row.uuid));
      if (where.sha256) result = result.filter(row => row.sha256 == null);
      if (where.id) result = result.filter(row => row.id > where.id.value);
      if (order) result = [...result].sort((a, b) => a.id - b.id);
      if (take) result = result.slice(0, take);
      return result.map(row => (select ? Object.fromEntries(select.map(key => [key, row[key]])) : { ...row }));
    },
    update: async (criteria, changes) => {
      const row = rows.find(value => value.id === criteria.id && value.sha256 == null);
      if (row) Object.assign(row, changes);
    }
  };
  const service = Object.assign(Object.create(FileService.prototype), { bucket: "test", minioClient: minio, fileRepository });
  return { service, stored, reads, rows };
}

test("what the backend stores itself is hashed as it's stored", async t => {
  const { service, stored } = storage();
  assert.equal(await service.uploadFile("buffer", Buffer.from("1 2\n")), sha256("1 2\n"));
  assert.equal(await service.uploadFile("stream", Readable.from([Buffer.from("3 "), Buffer.from("4\n")]), 1), sha256("3 4\n"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-file-hash-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "local"), "5 6\n");
  assert.equal(await service.uploadFile("local", path.join(directory, "local")), sha256("5 6\n"));
  assert.equal(stored.get("stream").toString(), "3 4\n");
  assert.deepEqual(await service.hashStoredObject("local"), { sha256: sha256("5 6\n"), size: 4 });
});

test("recorded hashes are looked up by UUID; files without a valid one are left out", async () => {
  const { service } = storage([
    { id: 1, uuid: "a", size: 1, sha256: "a".repeat(64) },
    { id: 2, uuid: "b", size: 1, sha256: null },
    { id: 3, uuid: "c", size: 1, sha256: "not a hash" }
  ]);
  assert.deepEqual(await service.getContentHashes(["a", "b", "c", "a", "missing"]), { a: "a".repeat(64) });
  assert.deepEqual(await service.getContentHashes([]), {});
});

test("missing hashes are recorded in order, a bounded amount at a time; unreadable files are skipped", async () => {
  const rows = [
    { id: 1, uuid: "done", size: 3, sha256: sha256("old") },
    { id: 2, uuid: "one", size: 3, sha256: null },
    { id: 4, uuid: "missing", size: 3, sha256: null },
    { id: 5, uuid: "resized", size: 3, sha256: null },
    { id: 7, uuid: "large", size: 2000, sha256: null },
    { id: 9, uuid: "last", size: 4, sha256: null }
  ];
  const { service, reads } = storage(rows, {
    done: "old",
    one: "one",
    resized: "four",
    large: "x".repeat(2000),
    last: "last"
  });
  // At most 3 files or 100 bytes
  assert.deepEqual(await service.recordMissingContentHashes(0, 3, 100), { lastId: 5, recorded: 1, skipped: 2 });
  assert.equal(rows[1].sha256, sha256("one"));
  assert.equal(rows[2].sha256, null, "missing in storage");
  assert.equal(rows[3].sha256, null, "not the recorded size");
  // A file over the byte limit is still hashed when it's the first of a run
  assert.deepEqual(await service.recordMissingContentHashes(5, 3, 100), { lastId: 7, recorded: 1, skipped: 0 });
  assert.deepEqual(await service.recordMissingContentHashes(7, 3, 100), { lastId: 9, recorded: 1, skipped: 0 });
  assert.deepEqual(await service.recordMissingContentHashes(9, 3, 100), { lastId: null, recorded: 0, skipped: 0 });
  assert.equal(rows[4].sha256, sha256("x".repeat(2000)));
  assert.equal(rows[5].sha256, sha256("last"));
  assert(!reads.includes("done"), "a recorded hash isn't computed again");
});

test("the background job goes through all files, then waits before trying the unreadable ones again", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const calls = [];
  const batches = [
    { lastId: 200, recorded: 199, skipped: 1 },
    { lastId: 260, recorded: 60, skipped: 0 },
    { lastId: null, recorded: 0, skipped: 0 },
    { lastId: null, recorded: 0, skipped: 0 }
  ];
  const fileService = {
    recordMissingContentHashes: async (afterId, files, bytes) => {
      calls.push([afterId, files, bytes]);
      return batches.shift();
    }
  };
  let turns = 0;
  const redisService = {
    takeTurn: async () => {
      turns++;
      return true;
    }
  };
  const job = new FileContentHashService(fileService, redisService);
  for (let i = 0; i < 3; i++) await job.turn();
  assert.deepEqual(
    calls.map(([afterId]) => afterId),
    [0, 200, 260]
  );
  assert.deepEqual(calls[0].slice(1), [200, 1024 * 1024 * 1024]);
  // Waits 6 hours after a full pass
  await job.turn();
  assert.equal(calls.length, 3);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await job.turn();
  assert.deepEqual(calls.at(-1)[0], 0);
  assert.equal(turns, 4);

  // Only one backend process reads at a time; without Redis, each does
  const other = new FileContentHashService({ recordMissingContentHashes: async () => ({ lastId: null }) }, { takeTurn: async () => false });
  await other.turn();
  const withoutRedis = [];
  const alone = new FileContentHashService(
    { recordMissingContentHashes: async afterId => (withoutRedis.push(afterId), { lastId: null, recorded: 0, skipped: 0 }) },
    { takeTurn: async () => Promise.reject(new Error("Redis is unavailable")) }
  );
  await alone.turn();
  assert.deepEqual(withoutRedis, [0]);
});
