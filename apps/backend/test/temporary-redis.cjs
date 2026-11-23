const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const Redis = require("ioredis");

const redisAvailable = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;

async function startRedisFixture(t) {
  const host = "127.0.0.1";
  const probe = net.createServer().listen(0, host);
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => (error ? reject(error) : resolve())));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-redis-test-"));
  const args = ["--bind", host, "--port", String(port), "--save", "", "--appendonly", "no", "--dir", directory];
  let server, stopped, redis;
  function launch() {
    server = spawn("redis-server", args, { stdio: "ignore" });
    stopped = new Promise(resolve => server.once("close", resolve));
    return once(server, "spawn");
  }
  async function stop() {
    server?.kill();
    await stopped;
  }
  async function verifyServer() {
    const info = await redis.info("server");
    if (!info.split("\r\n").includes(`process_id:${server.pid}`))
      throw new Error("Unexpected Redis server on the test port");
  }
  t.after(async () => {
    redis?.disconnect();
    await stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await launch();
  redis = new Redis({ host, port, retryStrategy: attempt => (attempt < 50 ? 100 : null), maxRetriesPerRequest: 50 });
  // Connection refusals are expected while the child is starting. Commands still reject if retries run out.
  redis.on("error", () => {});
  await verifyServer();
  return {
    redis,
    async restart() {
      const closed = redis.status === "ready" && new Promise(resolve => redis.once("close", resolve));
      await Promise.all([closed, stop()]);
      await launch();
      await verifyServer();
    }
  };
}

async function startRedis(t) {
  return (await startRedisFixture(t)).redis;
}

module.exports = { redisAvailable, startRedis, startRedisFixture };
