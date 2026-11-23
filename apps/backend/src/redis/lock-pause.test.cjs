const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { redisAvailable, startRedis } = require("../../test/temporary-redis.cjs");
require("./register-typescript.cjs");
const { FileService } = require("../file/file.service.ts");
const { LockLeaseLostError } = require("./lock-lease.ts");
const { LockService } = require("./lock.service.ts");

test(
  "a Redis pause through renewal and expiry fences an upload until a fresh owner retries",
  {
    skip: !redisAvailable && "needs redis-server",
    timeout: 30000
  },
  async t => {
    const redis = await startRedis(t);
    const locks = new LockService({ getClient: options => redis.duplicate(options) });
    t.after(() => locks.onModuleDestroy());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lock-upload-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const objectName = "sample";
    const file = path.join(dir, objectName);
    // Use the production upload/retry path; the object store writes its bytes into this run's directory.
    const files = Object.assign(Object.create(FileService.prototype), {
      minioClient: { putObject: (_bucket, name, bytes) => fs.writeFile(path.join(dir, name), bytes) }
    });
    const upload = value => files.uploadFile(objectName, Buffer.from(value));
    const key = "upload-lock";
    await locks.lock(key, () => upload("original"));

    const attempted = Promise.withResolvers();
    let resumed = false;
    const outcome = locks.lock(key, async () => {
      try {
        await redis.client("PAUSE", 6500, "ALL");
        // The callback resumes only once this independent connection can use Redis again.
        await redis.ping();
        resumed = true;
        await upload("expired owner");
      } finally {
        attempted.resolve();
      }
    });
    await Promise.all([assert.rejects(outcome, LockLeaseLostError), attempted.promise]);
    assert.ok(resumed);
    assert.equal(await fs.readFile(file, "utf8"), "original");
    assert.equal(await redis.exists(key), 0);

    await locks.lock(key, () => upload("fresh owner"));
    assert.equal(await fs.readFile(file, "utf8"), "fresh owner");
    assert.equal(await redis.exists(key), 0);
  }
);
