// Actual classification API, including delegated editor boundaries.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true,
    emitDecoratorMetadata: true } }).outputText, filename);
const { validate } = require("class-validator");
const { DiscussionController } = require("./discussion.controller.ts");
const { DiscussionType } = require("./discussion-type.enum.ts");
const { CreateDiscussionRequestDto } = require("./dto/create-discussion-request.dto.ts");
const { UpdateDiscussionRequestDto } = require("./dto/update-discussion-request.dto.ts");
function fixture({ ownerId = 1, moderator = false, viewProblem = true } = {}) {
  const controller = Object.create(DiscussionController.prototype);
  const discussion = { id: 12, publisherId: ownerId, problemId: null, title: "Proof", type: DiscussionType.Discussion };
  const writes = [], audit = [];
  controller.discussionService = {
    userHasCreateDiscussionPermission: async () => true,
    findDiscussionById: async () => discussion,
    userHasPermission: async () => true,
    getDiscussionContent: async () => "Original discussion",
    createDiscussion: async (...args) => { writes.push(args); return { id: 13 }; },
    updateDiscussionTitleAndContent: async (...args) => writes.push(args)
  };
  controller.problemService = {
    findProblemById: async id => id === 20 ? { id } : null,
    userHasPermission: async () => viewProblem
  };
  controller.problemAccess = controller.problemFiles = controller.problemTags = controller.problemLocks = controller.problemService;
  controller.userPrivilegeService = { userHasPrivilege: async () => moderator };
  controller.auditService = { log: async (...args) => audit.push(args) };
  const update = extra => controller.updateDiscussion({ id: 1 }, { discussionId: 12, title: "Proof", content: "Updated", ...extra });
  return { controller, discussion, writes, audit, update };
}
test("solution creation requires a real, visible problem", async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.createDiscussion({ id: 1 }, { title: "Proof", content: "x", type: "Solution" }), { error: "SOLUTION_REQUIRES_PROBLEM" });
  assert.deepEqual(await f.controller.createDiscussion({ id: 1 }, { title: "Proof", content: "x", type: "Solution", problemId: 99 }), { error: "NO_SUCH_PROBLEM" });
  assert.equal(f.writes.length, 0);
  const denied = fixture({ viewProblem: false });
  assert.deepEqual(await denied.controller.createDiscussion({ id: 1 }, { title: "Proof", content: "x", type: "Solution", problemId: 20 }), { error: "PERMISSION_DENIED" });
  assert.equal(denied.writes.length, 0);
  assert.deepEqual(await f.controller.createDiscussion({ id: 1 }, { title: "Proof", content: "x", type: "Solution", problemId: 20 }), { discussionId: 13 });
  assert.equal(f.writes[0][6], "Solution");
});
test("author and moderator can classify existing discussions; delegated editors cannot", async () => {
  for (const options of [{}, { ownerId: 2, moderator: true }]) {
    const f = fixture(options);
    assert.deepEqual(await f.update({ type: "Solution", problemId: 20 }), {});
    assert.deepEqual(f.writes[0][3], { type: "Solution", problemId: 20 });
    assert.deepEqual(f.audit[0][3].old.type, "Discussion");
    assert.deepEqual(f.audit[0][3].new.type, "Solution");
  }
  const delegated = fixture({ ownerId: 2 });
  assert.deepEqual(await delegated.update({ type: "Solution", problemId: 20 }), { error: "PERMISSION_DENIED" });
  assert.equal(delegated.writes.length, 0);
  assert.deepEqual(await delegated.update({}), {});
  assert.equal(delegated.writes.length, 1);
});
test("conversion cannot expose a hidden target problem or leave a solution unlinked", async () => {
  const f = fixture({ viewProblem: false });
  assert.deepEqual(await f.update({ type: "Solution", problemId: 20 }), { error: "PERMISSION_DENIED" });
  assert.deepEqual(await f.update({ type: "Solution" }), { error: "SOLUTION_REQUIRES_PROBLEM" });
  assert.deepEqual(await f.update({ type: "Solution", problemId: 99 }), { error: "NO_SUCH_PROBLEM" });
  assert.equal(f.writes.length, 0);
  f.discussion.type = "Solution"; f.discussion.problemId = 20;
  assert.deepEqual(await f.update({ problemId: null }), { error: "SOLUTION_REQUIRES_PROBLEM" });
});
test("classification DTOs reject arbitrary type strings", async () => {
  const create = Object.assign(new CreateDiscussionRequestDto(), { title: "Proof", content: "x", type: "arbitrary" });
  const update = Object.assign(new UpdateDiscussionRequestDto(), { discussionId: 12, title: "Proof", content: "x", type: "arbitrary" });
  for (const request of [create, update]) assert((await validate(request)).some(error => error.property === "type"));
});
