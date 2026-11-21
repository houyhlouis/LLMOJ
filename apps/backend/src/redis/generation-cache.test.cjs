const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const { redisAvailable, startRedis } = require("../../test/temporary-redis.cjs");

require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
    }).outputText,
    filename
  );
const { GenerationCache } = require("./generation-cache.ts");
const key = "sample-object";
const field = "summary";
const ttl = 60;

test("a read begun without Redis computes once and cannot fill after recovery", async () => {
  const client = Object.assign(new EventEmitter(), {
    status: "reconnecting",
    eval: () => assert.fail("no generation was observed")
  });
  const cache = new GenerationCache(client);
  const value = await cache.read(key, field, ttl, async () => {
    client.status = "ready";
    return 42;
  });
  assert.equal(value, 42);
});

test("a failed cache lookup or fill returns the SQL result and preserves SQL errors", async () => {
  const client = Object.assign(new EventEmitter(), { status: "ready" });
  const cache = new GenerationCache(client);
  const lookupError = new Error("cache unavailable");
  client.eval = async () => {
    throw lookupError;
  };
  assert.equal(await cache.read(key, field, ttl, async () => 4), 4);

  let calls = 0;
  client.eval = async () => {
    if (++calls === 1) return ["epoch", "2", null];
    throw lookupError;
  };
  assert.equal(await cache.read(key, field, ttl, async () => 5), 5);
  assert.equal(calls, 2);

  let sqlReads = 0;
  const sqlError = new Error("SQL failed");
  await assert.rejects(
    cache.read(key, field, ttl, async () => {
      sqlReads++;
      throw sqlError;
    }),
    sqlError
  );
  assert.equal(sqlReads, 1);
});

test("a missed post-commit invalidation is discarded before reading a recovered cache", async () => {
  const client = Object.assign(new EventEmitter(), { status: "ready" });
  const cache = new GenerationCache(client);
  client.eval = async () => {
    throw new Error("invalidation failed");
  };
  await cache.invalidate(key, [field], ttl);

  const commands = [];
  client.del = async object => commands.push(["discard", object]);
  client.eval = async (_script, _numberOfKeys, object, ...args) => {
    if (args.length === 3) {
      commands.push(["read", object]);
      return ["new-epoch", "0", null];
    }
    commands.push(["fill", object, ...args]);
  };
  assert.equal(await cache.read(key, field, ttl, async () => 9), 9);
  assert.deepEqual(commands, [
    ["discard", key],
    ["read", key],
    ["fill", key, "new-epoch", "0", field, "9"]
  ]);
});

test(
  "expiry or eviction during SQL cannot refill a recreated Redis hash",
  {
    skip: !redisAvailable && "needs redis-server"
  },
  async t => {
    const redis = await startRedis(t);
    const cache = new GenerationCache(redis);
    const began = Promise.withResolvers();
    const release = Promise.withResolvers();
    const old = cache.read(key, field, ttl, async () => {
      began.resolve();
      await release.promise;
      return "previous";
    });
    try {
      await Promise.race([began.promise, old.then(() => assert.fail("expected a cold read"))]);
      await redis.pexpire(key, 0);
      assert.equal(await cache.read(key, field, ttl, async () => "current"), "current");
    } finally {
      release.resolve();
      await old;
    }
    assert.equal(await cache.read(key, field, ttl, () => assert.fail("expected cached current value")), "current");
    await redis.expire(key, 30);
    assert.equal(await cache.read(key, "another-variant", ttl, async () => "other"), "other");
    const remaining = await redis.ttl(key);
    assert.ok(remaining > 0 && remaining <= 30, "filling a second variant must preserve the original deadline");
  }
);
