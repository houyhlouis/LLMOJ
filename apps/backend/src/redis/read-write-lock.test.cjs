const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { redisAvailable, startRedis } = require("../../test/temporary-redis.cjs");

test("Redis read/write lock", { skip: !redisAvailable && "redis-server is not installed" }, async t => {
  const redis = await startRedis(t);
  redis.defineCommand("readWriteLock", {
    numberOfKeys: 3,
    lua: fs.readFileSync(path.join(__dirname, "scripts/read-write-lock.lua"), "utf8")
  });
  const intent = "rwlock-v2:example:write-intent";
  const writer = "rwlock-v2:example:write-lock";
  const readers = "rwlock-v2:example:readers";
  const lock = (...args) => redis.readWriteLock(intent, writer, readers, ...args);
  const lease = 5000;
  t.beforeEach(() => redis.del(intent, writer, readers));

  async function waitForExpiry(key) {
    const deadline = Date.now() + 2000;
    while (await redis.exists(key)) {
      assert.ok(Date.now() < deadline, `${key} did not expire within two seconds`);
      await delay(10);
    }
  }

  await t.test("a writer acquires on its first attempt after the only reader releases", async () => {
    assert.equal(await lock("read_lock", "reader", lease), 1);
    assert.deepEqual(await redis.zrange(readers, 0, -1), ["reader"]);
    assert.equal(await lock("read_unlock", "reader"), 1);
    assert.equal(await redis.exists(readers), 0);
    assert.equal(await lock("write_lock", "waiting", lease), 1);
    assert.equal(await lock("read_lock", "another", lease), null);
  });

  await t.test("writer intent blocks new readers and competing writers until both holders release", async () => {
    assert.equal(await lock("read_lock", "a", lease), 1);
    assert.equal(await lock("read_lock", "b", lease), 1);
    assert.equal(await redis.zcard(readers), 2);
    assert.equal(await lock("write_lock", "first", lease), null);
    assert.equal(await redis.get(intent), "first");
    assert.equal(await lock("read_lock", "c", lease), null);
    assert.equal(await lock("read_refresh", "b", lease), 1);
    assert.equal(await lock("read_unlock", "a"), 1);
    assert.deepEqual(await redis.zrange(readers, 0, -1), ["b"]);
    assert.equal(await lock("write_lock", "first", lease), null);
    assert.equal(await lock("read_unlock", "b"), 1);
    assert.equal(await lock("write_lock", "second", lease), null);
    assert.equal(await lock("read_lock", "c", lease), null);
    assert.equal(await lock("write_lock", "first", lease), 1);
    assert.equal(await redis.get(intent), null);
    assert.equal(await lock("write_unlock", "first"), 1);
    assert.equal(await lock("read_lock", "c", lease), 1);
  });

  await t.test("refresh extends each lease and a former holder cannot refresh or release after expiry", async () => {
    assert.equal(await lock("read_lock", "old", lease), 1);
    assert.equal(await lock("read_refresh", "old", 30000), 1);
    assert.ok((await redis.pttl(readers)) > lease);
    assert.equal(await lock("read_refresh", "old", 20), 1);
    await waitForExpiry(readers);
    assert.equal(await lock("read_refresh", "old", lease), 0);
    assert.equal(await lock("read_unlock", "old"), null);

    assert.equal(await lock("write_lock", "old", lease), 1);
    assert.equal(await lock("write_refresh", "old", 30000), 1);
    assert.ok((await redis.pttl(writer)) > lease);
    assert.equal(await lock("write_refresh", "old", 20), 1);
    await waitForExpiry(writer);
    assert.equal(await lock("write_lock", "new", lease), 1);
    assert.equal(await lock("write_refresh", "old", 30000), null);
    assert.equal(await lock("write_unlock", "old"), null);
    assert.equal(await redis.get(writer), "new");
  });

  await t.test("a waiting writer that stops retrying releases its intent by expiry", async () => {
    assert.equal(await lock("read_lock", "a", lease), 1);
    assert.equal(await lock("write_lock", "cancelled", lease), null);
    assert.equal(await lock("read_lock", "b", lease), null);
    assert.equal(await lock("write_lock", "cancelled", 20), null);
    await waitForExpiry(intent);
    assert.equal(await lock("read_lock", "b", lease), 1);
    assert.equal(await redis.zcard(readers), 2);
  });

  await t.test("a former reader cannot release or refresh a recreated generation", async () => {
    assert.equal(await lock("read_lock", "a", 20), 1);
    await waitForExpiry(readers);
    assert.equal(await lock("read_lock", "b", lease), 1);
    const before = await redis.zrange(readers, 0, -1, "WITHSCORES");
    const expiry = await redis.pexpiretime(readers);
    assert.equal(await lock("read_unlock", "a"), null);
    assert.equal(await lock("read_refresh", "a", 30000), 0);
    assert.deepEqual(await redis.zrange(readers, 0, -1, "WITHSCORES"), before);
    assert.equal(await redis.pexpiretime(readers), expiry);
    assert.equal(await lock("write_lock", "waiting", lease), null);
    assert.equal(await redis.exists(writer), 0);
    assert.equal(await lock("read_unlock", "b"), 1);
    assert.equal(await lock("write_lock", "waiting", lease), 1);
  });

  await t.test("a reader dying among live readers never holds up the writer after the live reader leaves", async () => {
    assert.equal(await lock("read_lock", "live", lease), 1);
    const liveExpiry = await redis.zscore(readers, "live");
    assert.equal(await lock("read_lock", "dead", 20), 1);
    assert.equal(await redis.pexpiretime(readers), Number(liveExpiry));
    await delay(30);
    assert.equal(await lock("write_lock", "waiting", lease), null);
    assert.deepEqual(await redis.zrange(readers, 0, -1, "WITHSCORES"), ["live", liveExpiry]);
    assert.equal(await lock("read_refresh", "dead", 30000), 0);
    assert.equal(await lock("read_refresh", "live", lease), 1);
    assert.ok(Number(await redis.zscore(readers, "live")) > Number(liveExpiry));
    assert.equal(await lock("read_unlock", "live"), 1);
    assert.equal(await lock("write_lock", "waiting", lease), 1);
  });

  await t.test("expired members cannot be revived or released while a different reader keeps the set alive", async () => {
    assert.equal(await lock("read_lock", "live", lease), 1);
    const liveExpiry = await redis.zscore(readers, "live");
    assert.equal(await lock("read_lock", "a", 20), 1);
    await delay(30);
    assert.equal(await lock("read_refresh", "a", 30000), 0);
    assert.deepEqual(await redis.zrange(readers, 0, -1, "WITHSCORES"), ["live", liveExpiry]);
    assert.equal(await lock("read_lock", "b", 20), 1);
    await delay(30);
    assert.equal(await lock("read_unlock", "b"), null);
    assert.deepEqual(await redis.zrange(readers, 0, -1, "WITHSCORES"), ["live", liveExpiry]);
  });

  await t.test("LockService leaves legacy reader counts, writer locks and intents to expire on rollout", async t => {
    require("./register-typescript.cjs");
    const { LockService } = require("./lock.service.ts");
    const client = redis.duplicate();
    t.after(() => client.disconnect());
    await client.ping();
    const service = new LockService({ getClient: () => client });
    const oldReaders = "rwlock:example:readers";
    const oldIntent = "rwlock:example:write-intent";
    const oldWriter = "rwlock:example:write-lock";
    for (const count of [0, -1, 1]) {
      await redis.set(oldReaders, count, "PX", lease);
      await redis.set(oldIntent, "previous-writer", "PX", lease);
      const expiry = await redis.pexpiretime(oldReaders);
      assert.equal(await lock("read_refresh", "missing", 30000), 0);
      assert.equal(await lock("read_unlock", "missing"), null);
      await service.lockReadWrite("example", "Read", async () => {
        assert.equal(await redis.zcard(readers), 1);
        assert.equal(await lock("write_lock", "new-writer", lease), null);
        assert.equal(await redis.get(intent), "new-writer");
      });
      assert.equal(await redis.exists(readers), 0);
      assert.equal(await lock("write_lock", "new-writer", lease), 1);
      assert.equal(await lock("write_unlock", "new-writer"), 1);
      assert.deepEqual(await redis.mget(oldReaders, oldIntent), [String(count), "previous-writer"]);
      assert.equal(await redis.pexpiretime(oldReaders), expiry);
    }
    // Age the retired reader and intent keys. Old processes have all stopped before this rollout.
    await redis.pexpire(oldReaders, 20);
    await redis.pexpire(oldIntent, 20);
    await waitForExpiry(oldReaders);
    await waitForExpiry(oldIntent);
    await redis.set(oldWriter, "previous-owner", "PX", lease);
    const expiry = await redis.pexpiretime(oldWriter);
    await service.lockReadWrite("example", "Write", async () => {
      assert.ok(await redis.get(writer));
      assert.equal(await redis.get(oldWriter), "previous-owner");
    });
    assert.equal(await redis.exists(writer), 0);
    assert.equal(await redis.pexpiretime(oldWriter), expiry);
    await redis.pexpire(oldWriter, 20);
    await waitForExpiry(oldWriter);
  });
});
