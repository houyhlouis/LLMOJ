// Actual discussion authorization and controller methods; I/O is substituted.
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
const { DiscussionService, DiscussionReplyPermissionType, DiscussionReactionType } = require("./discussion.service.ts");
const { UserPrivilegeType } = require("../user/user-privilege.service.ts");
const { GetDiscussionAndRepliesRequestDto, GetDiscussionAndRepliesRequestQueryRepliesType } = require("./dto/get-discussion-and-replies-request.dto.ts");
const { GetDiscussionAndRepliesResponseError } = require("./dto/get-discussion-and-replies-response.dto.ts");
const { ToggleReactionResponseError } = require("./dto/toggle-reaction-response.dto.ts");
const { Locale } = require("../common/locale.type.ts");

function fixture({ isPublic = false, manage = false, canViewParent = true, overrides = {} } = {}) {
  const service = Object.create(DiscussionService.prototype), controller = Object.create(DiscussionController.prototype);
  const parent = { id: 11, publisherId: 10, isPublic: true, problemId: 22 };
  const reply = { id: 31, discussionId: 11, publisherId: 2, isPublic };
  const writes = [];
  service.findDiscussionById = async id => id === parent.id ? parent : null;
  service.findDiscussionReplyById = async id => id === reply.id ? reply : null;
  service.userPrivilegeService = {
    userHasPrivilege: async (user, privilege) => privilege === UserPrivilegeType.ViewDiscussion ||
      (!!user && manage && privilege === UserPrivilegeType.ManageDiscussion),
    permissionDecision: async (_user, privilege, fallback) => overrides[privilege] ?? fallback
  };
  service.problemService = { findProblemById: async id => ({ id }), userHasPermission: async () => canViewParent };
  service.permissionService = { userOrItsGroupsHavePermission: async () => false };
  service.addReaction = async (...args) => writes.push(["add", ...args]);
  service.removeReaction = async (...args) => writes.push(["remove", ...args]);
  controller.discussionService = service;
  controller.userPrivilegeService = service.userPrivilegeService;
  controller.problemService = service.problemService;
  controller.configService = { config: { preference: { misc: { discussionReactionAllowCustomEmojis: false,
    discussionReactionEmojis: ["👍"] } }, queryLimit: { discussionReplies: 4 } } };
  return { service, controller, parent, reply, writes };
}

for (const isPublic of [true, false]) {
  test(`F06: moderator receives publicness permission for ${isPublic ? "public" : "hidden"} replies`, async () => {
    const f = fixture({ isPublic, manage: true });
    assert.deepEqual(await f.service.getUserPermissionsOfReply({ id: 1 }, f.reply), [
      DiscussionReplyPermissionType.Modify, DiscussionReplyPermissionType.Delete, DiscussionReplyPermissionType.ManagePublicness]);
  });
}
test("F06: reply author cannot moderate publicness", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.getUserPermissionsOfReply({ id: 2 }, f.reply), [
    DiscussionReplyPermissionType.Modify, DiscussionReplyPermissionType.Delete]);
  assert.deepEqual(await f.service.getUserPermissionsOfReply({ id: 3 }, f.reply), []);
  assert.deepEqual(await f.service.getUserPermissionsOfReply(null, f.reply), []);
});
test("F06: publicness permission is independent of denied reply edits", async () => {
  const f = fixture({ manage: true, overrides: { [UserPrivilegeType.ManageDiscussionReplies]: false } });
  assert.deepEqual(await f.service.getUserPermissionsOfReply({ id: 1 }, f.reply), [DiscussionReplyPermissionType.ManagePublicness]);
});
test("F06: denied parent problem prevents reply permission metadata", async () => {
  const f = fixture({ manage: true, canViewParent: false });
  assert.deepEqual(await f.service.getUserPermissionsOfReply({ id: 1 }, f.reply), []);
});

for (const reaction of [true, false]) {
  test(`F07: unseen hidden reply refuses reaction ${reaction ? "addition" : "removal"}`, async () => {
    const f = fixture();
    assert.deepEqual(await f.controller.toggleReaction({ id: 3 }, { type: DiscussionReactionType.DiscussionReply,
      id: 31, emoji: "👍", reaction }), { error: ToggleReactionResponseError.PERMISSION_DENIED });
    assert.deepEqual(f.writes, []);
  });
}
for (const scenario of [{ name: "public reply", isPublic: true, user: { id: 3 } },
  { name: "hidden reply author", user: { id: 2 } }, { name: "hidden reply moderator", manage: true, user: { id: 1 } }]) {
  test(`F07 control: ${scenario.name} can add and remove reactions`, async () => {
    const f = fixture(scenario);
    for (const reaction of [true, false]) assert.deepEqual(await f.controller.toggleReaction(scenario.user, {
      type: DiscussionReactionType.DiscussionReply, id: 31, emoji: "👍", reaction }), {});
    assert.deepEqual(f.writes.map(write => write[0]), ["add", "remove"]);
  });
}
test("F07: visible parent cannot authorize hidden reply to anonymous callers", async () => {
  const f = fixture({ isPublic: true });
  assert.deepEqual(await f.controller.toggleReaction(null, { type: DiscussionReactionType.DiscussionReply,
    id: 31, emoji: "👍", reaction: true }), { error: ToggleReactionResponseError.PERMISSION_DENIED });
  assert.deepEqual(f.writes, []);
});
test("F07: own reply and moderation privilege cannot bypass denied parent problem", async () => {
  const f = fixture({ manage: true, canViewParent: false });
  for (const id of [1, 2]) assert.deepEqual(await f.controller.toggleReaction({ id }, {
    type: DiscussionReactionType.DiscussionReply, id: 31, emoji: "👍", reaction: true }), {
    error: ToggleReactionResponseError.PERMISSION_DENIED });
  assert.deepEqual(f.writes, []);
});
test("F07: unavailable reply or parent causes no writes", async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.toggleReaction({ id: 3 }, { type: DiscussionReactionType.DiscussionReply,
    id: 99, emoji: "👍", reaction: true }), { error: ToggleReactionResponseError.NO_SUCH_DISCUSSION_REPLY });
  f.reply.discussionId = 99;
  assert.deepEqual(await f.controller.toggleReaction({ id: 3 }, { type: DiscussionReactionType.DiscussionReply,
    id: 31, emoji: "👍", reaction: true }), { error: ToggleReactionResponseError.NO_SUCH_DISCUSSION });
  assert.deepEqual(f.writes, []);
});

test("F08: optional page counts default to zero and still honor total query limits", async () => {
  const f = fixture();
  const calls = [];
  f.service.queryDiscussionRepliesByHeadTail = async (...args) => { calls.push(args.slice(-2)); return [[], [], 6]; };
  f.service.queryDiscussionRepliesInIdRange = async (...args) => { calls.push(args.slice(-3)); return [[], 5]; };
  f.service.getReactions = async () => [];
  f.controller.userService = { findUsersByExistingIds: async () => [] };
  const base = { discussionId: 11, locale: Locale.en_US, queryRepliesType: GetDiscussionAndRepliesRequestQueryRepliesType.HeadTail };
  for (const input of [{ headTakeCount: 1 }, { tailTakeCount: 1 }, {}, { headTakeCount: 2, tailTakeCount: 2 }]) {
    const result = await f.controller.getDiscussionAndReplies({ id: 3 }, { ...base, ...input });
    assert.equal(result.repliesTotalCount, 6);
  }
  const range = { ...base, queryRepliesType: GetDiscussionAndRepliesRequestQueryRepliesType.IdRange, beforeId: 99, afterId: 1 };
  assert.equal((await f.controller.getDiscussionAndReplies({ id: 3 }, range)).repliesCountInRange, 5);
  assert.deepEqual(calls, [[1, 0], [0, 1], [0, 0], [2, 2], [99, 1, 0]]);
  for (const request of [{ ...base, headTakeCount: 3, tailTakeCount: 2 }, { ...range, idRangeTakeCount: 5 }]) {
    assert.deepEqual(await f.controller.getDiscussionAndReplies({ id: 3 }, request), {
      error: GetDiscussionAndRepliesResponseError.TAKE_TOO_MANY });
  }
  assert.equal(calls.length, 5);
});
test("F08: optional DTO counts accept omission but reject explicit zero, negative, fractional and string values", async () => {
  const base = { discussionId: 11, locale: Locale.en_US };
  for (const field of ["headTakeCount", "tailTakeCount", "idRangeTakeCount"]) {
    for (const value of [undefined, 1]) assert.deepEqual(await validate(Object.assign(new GetDiscussionAndRepliesRequestDto(), base, { [field]: value })), []);
    for (const value of [0, -1, 1.5, "1"]) {
      const errors = await validate(Object.assign(new GetDiscussionAndRepliesRequestDto(), base, { [field]: value }));
      assert.ok(errors.some(error => error.property === field));
    }
  }
});
