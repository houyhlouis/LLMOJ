const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(file, overrides) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      experimentalDecorators: true
    }
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)(
    name => {
      if (!(name in overrides)) throw new Error(`Unexpected runtime import ${name}`);
      return overrides[name];
    },
    loaded,
    loaded.exports
  );
  return loaded.exports;
}

const noop = () => {};
const { JudgeQueueService } = load("judge-queue.service.ts", {
  "@nestjs/common": { Injectable: () => noop },
  "../logger": { logger: { verbose: noop, log: noop, error: noop, warn: noop } }
});

function fixture(taskService) {
  const queue = [];
  const observed = [];
  const redis = {
    async zadd(key, score, member) {
      queue.push({ score, member: JSON.parse(member) });
    },
    async bzpopmin() {
      if (!queue.length) return null;
      queue.sort((a, b) => a.score - b.score);
      const { score, member } = queue.shift();
      return ["judge-queue", typeof member === "string" ? member : JSON.stringify(member), String(score)];
    }
  };
  const histogram = () => ({ observe: (labels, value) => observed.push(value) });
  histogram.BUCKETS_TIME_10M_30 = [];
  const service = new JudgeQueueService({ getClient: () => redis }, { histogram });
  service.registerTaskType("Submission", taskService);
  return { service, queue, observed };
}

const task = taskId => ({ taskId, type: "Submission", priorityType: 1, priority: 0.5, extraInfo: {} });

test("queue time is measured from when the task was queued", async () => {
  const { service, queue, observed } = fixture({ getTaskToBeSentToJudgeByTaskId: async id => task(id) });
  queue.push({ score: 0.5, member: { taskId: "a", type: "Submission", enqueueTime: Date.now() - 5000 } });
  assert.equal((await service.consumeTask()).taskId, "a");
  assert.equal(observed.length, 1);
  assert(observed[0] >= 5 && observed[0] < 6, `observed ${observed[0]} seconds`);
});

test("a task that fails to be prepared is put back with its enqueue time and failure count", async () => {
  let calls = 0;
  const { service, queue } = fixture({
    getTaskToBeSentToJudgeByTaskId: async id => {
      if (++calls === 1) throw new Error("database briefly unavailable");
      return task(id);
    }
  });
  const enqueueTime = Date.now() - 1000;
  queue.push({ score: 1.25, member: { taskId: "b", type: "Submission", enqueueTime } });
  assert.equal(await service.consumeTask(), null);
  assert.deepEqual(queue, [{ score: 1.25, member: { taskId: "b", type: "Submission", enqueueTime, failures: 1 } }]);
  assert.equal((await service.consumeTask()).taskId, "b");
  assert.equal(queue.length, 0);
});

test("a task that keeps failing is eventually dropped instead of looping forever", async () => {
  const { service, queue } = fixture({
    getTaskToBeSentToJudgeByTaskId: async () => {
      throw new Error("permanent");
    }
  });
  queue.push({ score: 1, member: { taskId: "c", type: "Submission", enqueueTime: Date.now(), failures: 4 } });
  assert.equal(await service.consumeTask(), null);
  assert.equal(queue.length, 0);
});

test("missing tasks, unknown types and malformed entries never throw out of the consumer", async () => {
  const { service, queue } = fixture({ getTaskToBeSentToJudgeByTaskId: async () => null });
  queue.push({ score: 1, member: { taskId: "gone", type: "Submission", enqueueTime: Date.now() } });
  assert.equal(await service.consumeTask(), null);
  assert.equal(queue.length, 0);

  queue.push({ score: 1, member: "{not json" });
  assert.equal(await service.consumeTask(), null);
  assert.equal(queue.length, 0);

  queue.push({ score: 1, member: { taskId: "d", type: "Unknown", enqueueTime: 1, failures: 4 } });
  assert.equal(await service.consumeTask(), null);
  assert.equal(queue.length, 0);
});

test("new and repushed tasks get a fresh enqueue time", async () => {
  const { service, queue } = fixture({ getTaskToBeSentToJudgeByTaskId: async id => task(id) });
  const before = Date.now();
  await service.pushTask("e", "Submission", 2.5);
  await service.pushTask("f", "Submission", 2.5, true);
  assert.equal(queue.length, 2);
  for (const { score, member } of queue) {
    assert.equal(score, 2.5);
    assert(member.enqueueTime >= before);
    assert.equal("failures" in member, false);
  }
});
