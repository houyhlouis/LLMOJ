/* Runs scripts/session-manager.lua on a temporary redis-server; skipped when redis-server is unavailable. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const Redis = require("ioredis");

const available = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;
const DAY = 24 * 60 * 60 * 1000;

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("sessions expire after the idle timeout and the maximum age", { skip: !available && "redis-server is not installed" }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-session-test-"));
  const port = await freePort();
  const server = spawn(
    "redis-server",
    ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", directory],
    { stdio: "ignore" }
  );
  let redis;
  t.after(async () => {
    redis?.disconnect();
    server.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; ; attempt++) {
    const listening = await new Promise(resolve => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (listening) break;
    if (attempt > 50) throw new Error("redis-server did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  redis = new Redis({ port, host: "127.0.0.1" });
  redis.defineCommand("session", {
    numberOfKeys: 0,
    lua: fs.readFileSync(path.join(__dirname, "scripts/session-manager.lua"), "utf8")
  });
  const login = async (user, time) =>
    Number(await redis.session("new", time, user, JSON.stringify({ loginIp: "", userAgent: "", loginTime: time })));
  const access = async (user, id, time, idle = 30 * DAY, maxAge = 90 * DAY) =>
    (await redis.session("access", time, user, id, idle, maxAge)) === 1;
  const listed = async (user, time, idle = 30 * DAY, maxAge = 90 * DAY) =>
    (await redis.session("list", user, time, idle, maxAge)).map(([id]) => Number(id));
  const t0 = Date.UTC(2026, 0, 1);

  // Regular use keeps a session alive, but never beyond its maximum age.
  const daily = await login(1, t0);
  for (let day = 1; day <= 90; day++) assert.equal(await access(1, daily, t0 + day * DAY), true, `day ${day}`);
  assert.equal(await access(1, daily, t0 + 90 * DAY + 1), false);
  assert.equal(await access(1, daily, t0 + 90 * DAY + 2, 0, 0), false, "an expired session is revoked");

  // An unused session expires after the idle timeout, measured from its last access.
  const idle = await login(2, t0);
  assert.equal(await access(2, idle, t0 + 20 * DAY), true);
  assert.equal(await access(2, idle, t0 + 50 * DAY), true);
  assert.equal(await access(2, idle, t0 + 80 * DAY + 1), false);
  assert.equal(await redis.hexists("user-session-info-map", String(idle)), 0);

  // Listing revokes expired sessions instead of showing them.
  const stale = await login(3, t0);
  const fresh = await login(3, t0 + 40 * DAY);
  assert.deepEqual(await listed(3, t0 + 41 * DAY), [fresh]);
  assert.equal(await access(3, stale, t0 + 41 * DAY, 0, 0), false);

  // 0 disables both limits, and callers that pass no limits keep sessions alive.
  const forever = await login(4, t0);
  assert.equal(await access(4, forever, t0 + 1000 * DAY, 0, 0), true);
  assert.equal((await redis.session("access", t0 + 3000 * DAY, 4, forever)) === 1, true);
  assert.deepEqual(
    (await redis.session("list", 4)).map(([id]) => Number(id)),
    [forever]
  );

  // Revocation and the per-user limit are unchanged.
  assert.equal(await redis.session("revoke", 4, forever), 1);
  assert.equal(await access(4, forever, t0 + 3000 * DAY, 0, 0), false);
  const many = [];
  for (let i = 0; i < 21; i++) many.push(await login(5, t0 + i));
  assert.equal(await access(5, many[0], t0 + 100), false);
  assert.equal(await access(5, many[20], t0 + 100), true);
});
