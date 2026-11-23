const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const child = path.join(__dirname, "lock-lifecycle-child.cjs");
for (const scenario of [
  "rejected renewal", "refused renewal", "concurrent successful renewal", "concurrent refused renewal",
  "shutdown", "shutdown during contention", "callback and unlock failure", "delayed acquisition", "late renewal reply", "nested loss",
  "detached ordinary callback", "bounded contention"
]) {
  test(`strict child exits after ${scenario}`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-lifecycle-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const output = path.join(dir, "log");
    const fd = fs.openSync(output, "wx", 0o600);
    let result;
    try {
      result = spawnSync(process.execPath, ["--unhandled-rejections=strict", child, scenario], {
        stdio: ["ignore", fd, fd], timeout: 20000, killSignal: "SIGKILL"
      });
    } finally {
      fs.closeSync(fd);
    }
    const log = fs.readFileSync(output, "utf8");
    assert.ifError(result.error);
    assert.equal(result.status, 0, log);
    assert.equal(log, "completed\n");
  });
}

test("a lost operation can roll back its transaction and savepoints", async () => {
  require("./register-typescript.cjs");
  const { EventEmitter } = require("node:events");
  const { LockService } = require("./lock.service.ts");
  const { LockLeaseLostError } = require("./lock-lease.ts");
  const { LockLeaseSubscriber } = require("./lock-lease.subscriber.ts");
  const redis = Object.assign(new EventEmitter(), {
    defineCommand() {},
    callLock: async (_key, action) => action !== "check"
  });
  const service = new LockService({ getClient: () => redis });
  const subscriber = new LockLeaseSubscriber();
  const query = sql => subscriber.beforeQuery({ query: sql, queryRunner: { isTransactionActive: true } });
  const finished = Promise.withResolvers();
  const operation = service.lock("obsolete", async () => {
    try {
      await assert.rejects(subscriber.beforeTransactionCommit(), LockLeaseLostError);
      assert.throws(() => query("UPDATE example SET value = 1"), LockLeaseLostError);
      assert.throws(() => query("COMMIT"), LockLeaseLostError);
      await query("ROLLBACK TO SAVEPOINT typeorm_1");
      await query("ROLLBACK");
      finished.resolve();
    } catch (error) {
      finished.reject(error);
      throw error;
    }
  });
  await Promise.all([assert.rejects(operation, LockLeaseLostError), finished.promise]);
});
