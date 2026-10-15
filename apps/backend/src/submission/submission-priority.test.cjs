const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "submission-priority.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", source)(require, loaded, loaded.exports);
const { makeSubmissionPriority } = loaded.exports;

const High = 1;
// Smaller values are judged first. `k` is how many standard deviations above average the user's recent usage is.
const priorityAt = (k, { id = 100, pending = 0, priorityType = High } = {}) =>
  makeSubmissionPriority(id, pending, 1000 + k * 100, 1000, 100, priorityType);

test("more recent judging time never improves a submission's priority", () => {
  let previous = -Infinity;
  for (let k = -5; k <= 6; k += 0.01) {
    const priority = priorityAt(k);
    assert(priority >= previous - 1e-15, `priority improved at k=${k}`);
    previous = priority;
  }
});

test("the usage penalty is continuous at both ends of its range", () => {
  const epsilon = 1e-9;
  assert(Math.abs(priorityAt(1 - epsilon) - priorityAt(1 + epsilon)) < 1e-12);
  assert(Math.abs(priorityAt(3 - epsilon) - priorityAt(3 + epsilon)) < 1e-12);
  assert.equal(priorityAt(3), priorityAt(10));
  assert.equal(priorityAt(1), priorityAt(-10));
});

test("no recorded usage, or no spread between users, gives no penalty instead of NaN", () => {
  for (const priority of [
    makeSubmissionPriority(100, 0, null, null, null, High),
    makeSubmissionPriority(100, 0, 0, 0, 0, High),
    makeSubmissionPriority(100, 0, 500, 500, 0, High)
  ]) {
    assert(Number.isFinite(priority));
    assert.equal(priority, priorityAt(0));
  }
  // A user above an all-equal population is penalized like any user far above average.
  assert.equal(makeSubmissionPriority(100, 0, 600, 500, 0, High), priorityAt(10));
});

test("priority classes dominate; more pending submissions and later IDs are judged later", () => {
  assert(priorityAt(10, { priorityType: High }) < priorityAt(-10, { priorityType: 2 }));
  assert(priorityAt(2, { pending: 0 }) < priorityAt(2, { pending: 1 }));
  assert(priorityAt(0, { id: 100 }) < priorityAt(0, { id: 101 }));
});
