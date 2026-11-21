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
  const intent = "rwlock:example:write-intent";
  const writer = "rwlock:example:write-lock";
  const readers = "rwlock:example:readers";
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
    assert.equal(await lock("read_lock", lease), 1);
    assert.equal(await redis.get(readers), "1");
    assert.equal(await lock("read_unlock"), 1);
    assert.equal(await redis.get(readers), null);
    assert.equal(await lock("write_lock", "waiting", lease), 1);
    assert.equal(await lock("read_lock", lease), null);
  });

  await t.test("writer intent blocks new readers and competing writers until both holders release", async () => {
    assert.equal(await lock("read_lock", lease), 1);
    assert.equal(await lock("read_lock", lease), 1);
    assert.equal(await redis.get(readers), "2");
    assert.equal(await lock("write_lock", "first", lease), null);
    assert.equal(await redis.get(intent), "first");
    assert.equal(await lock("read_lock", lease), null);
    assert.equal(await lock("read_unlock"), 1);
    assert.equal(await redis.get(readers), "1");
    assert.equal(await lock("write_lock", "first", lease), null);
    assert.equal(await lock("read_unlock"), 1);
    assert.equal(await lock("write_lock", "second", lease), null);
    assert.equal(await lock("read_lock", lease), null);
    assert.equal(await lock("write_lock", "first", lease), 1);
    assert.equal(await redis.get(intent), null);
    assert.equal(await lock("write_unlock", "first"), 1);
    assert.equal(await lock("read_lock", lease), 1);
  });

  await t.test("a non-positive reader count represents no holder", async () => {
    assert.equal(await lock("read_unlock"), null);
    for (const count of [0, -1]) {
      await redis.set(readers, count, "PX", lease);
      assert.equal(await lock("read_refresh", 30000), 0);
      const remaining = await redis.pttl(readers);
      assert.ok(remaining > 0 && remaining <= lease, "refresh must preserve the stale key's original deadline");
      assert.equal(await lock("read_unlock"), null);
      assert.equal(await redis.get(readers), null);
      await redis.set(readers, count, "PX", lease);
      assert.equal(await lock("read_lock", lease), 1);
      assert.equal(await redis.get(readers), "1");
      assert.equal(await lock("read_unlock"), 1);
    }
    assert.equal(await lock("write_lock", "next", lease), 1);
  });

  await t.test("refresh extends each lease and a former holder cannot refresh or release after expiry", async () => {
    assert.equal(await lock("read_lock", lease), 1);
    assert.equal(await lock("read_refresh", 30000), 1);
    assert.ok((await redis.pttl(readers)) > lease);
    assert.equal(await lock("read_refresh", 20), 1);
    await waitForExpiry(readers);
    assert.equal(await lock("read_refresh", lease), 0);
    assert.equal(await lock("read_unlock"), null);

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
    assert.equal(await lock("read_lock", lease), 1);
    assert.equal(await lock("write_lock", "cancelled", lease), null);
    assert.equal(await lock("read_lock", lease), null);
    assert.equal(await lock("write_lock", "cancelled", 20), null);
    await waitForExpiry(intent);
    assert.equal(await lock("read_lock", lease), 1);
    assert.equal(await redis.get(readers), "2");
  });
});
