// Exercise the actual controller and permission service without database or HTTP I/O.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const { DiscussionController } = require("./discussion.controller.ts");
const { DiscussionService } = require("./discussion.service.ts");
const { DiscussionEntity } = require("./discussion.entity.ts");
const { DiscussionReplyEntity } = require("./discussion-reply.entity.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { TeamEntity, TeamMemberEntity, TeamResourceEntity } = require("../team/team.entity.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { UserPrivilegeType } = require("../user/user-privilege.service.ts");
const { AuditLogObjectType } = require("../audit/audit.service.ts");
const { SetDiscussionReplyPublicResponseError } = require("./dto/set-discussion-reply-public-response.dto.ts");
const currentUser = { id: 4 };

function fixture({ parentProblem = 30, collisionProblem = null, canViewParent = false, manage = true } = {}) {
  const controller = Object.create(DiscussionController.prototype);
  const service = Object.create(DiscussionService.prototype);
  service.connection = { getRepository: () => ({ findOne: async () => null }) };
  const reply = { id: 12, discussionId: 38, publisherId: 1, isPublic: true };
  const parent = { id: 38, problemId: parentProblem, publisherId: 1, isPublic: false };
  const collision = { id: 12, problemId: collisionProblem, publisherId: 1, isPublic: true };
  const discussionLookups = [],
    problemChecks = [],
    changes = [],
    audit = [];
  service.findDiscussionReplyById = async id => (id === reply.id ? reply : null);
  service.findDiscussionById = async id => {
    discussionLookups.push(id);
    return id === parent.id ? parent : id === collision.id ? collision : null;
  };
  service.userPrivilegeService = {
    userHasPrivilege: async (user, type) =>
      !!user && (type === UserPrivilegeType.ViewDiscussion || (type === UserPrivilegeType.ManageDiscussion && manage))
  };
  service.problemService = {
    findProblemById: async id => ({ id }),
    userHasPermission: async (_user, problem) => {
      problemChecks.push(problem.id);
      return problem.id === parentProblem && canViewParent;
    }
  };
  service.problemAccess = service.problemFiles = service.problemTags = service.problemLocks = service.problemService;
  service.permissionService = { userOrItsGroupsHavePermission: async () => false };
  service.connection.transaction = async (_isolation, write) =>
    write({
      getRepository: service.connection.getRepository,
      findOne: async (entity, { where, lock }) => {
        if (entity === UserEntity) {
          assert.deepEqual(lock, { mode: "pessimistic_read" });
          return where.id === currentUser.id ? currentUser : null;
        }
        if (entity === DiscussionEntity) return service.findDiscussionById(where.id);
        if (entity === DiscussionReplyEntity) return service.findDiscussionReplyById(where.id);
        assert.equal(entity, ProblemEntity);
        return service.problemService.findProblemById(where.id);
      },
      update: async (entity, where, { isPublic }) => {
        assert.equal(entity, DiscussionReplyEntity);
        assert.deepEqual(where, { id: reply.id, discussionId: parent.id });
        changes.push({ target: reply, value: isPublic });
      }
    });
  controller.discussionService = service;
  controller.auditService = { log: async (...args) => audit.push(args) };
  return { controller, service, reply, parent, discussionLookups, problemChecks, changes, audit };
}

const request = { discussionReplyId: 12, isPublic: false };
test("restricted moderator cannot hide a reply whose hidden parent is denied even when the reply ID names a public discussion", async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, request), {
    error: SetDiscussionReplyPublicResponseError.PERMISSION_DENIED
  });
  assert.deepEqual(f.discussionLookups, [38]);
  assert.deepEqual(f.problemChecks, [30]);
  assert.equal(f.reply.isPublic, true);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.audit, []);
});

test("authorized parent permits hide and publish despite an unrelated denied discussion matching the reply ID", async () => {
  const f = fixture({ parentProblem: 31, collisionProblem: 30, canViewParent: true });
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, request), {});
  assert.equal(f.reply.isPublic, false);
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, { ...request, isPublic: true }), {});
  assert.equal(f.reply.isPublic, true);
  assert.deepEqual(f.discussionLookups, [38, 38]);
  assert.deepEqual(f.problemChecks, [31, 31]);
  assert.deepEqual(
    f.changes.map(change => change.value),
    [false, true]
  );
  assert.deepEqual(f.audit, [
    ["discussion.set_reply_non_public", AuditLogObjectType.Discussion, 38, AuditLogObjectType.DiscussionReply, 12],
    ["discussion.set_reply_public", AuditLogObjectType.Discussion, 38, AuditLogObjectType.DiscussionReply, 12]
  ]);
});

test("viewing the parent alone does not grant reply moderation", async () => {
  const f = fixture({ parentProblem: null, canViewParent: true, manage: false });
  f.parent.isPublic = true;
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, request), {
    error: SetDiscussionReplyPublicResponseError.PERMISSION_DENIED
  });
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.audit, []);
});

test("reply moderation checks the locked account when the request carries an old administrator flag", async () => {
  const f = fixture({ parentProblem: null });
  f.parent.isPublic = true;
  f.service.userPrivilegeService.userHasPrivilege = async (user, type) =>
    type === UserPrivilegeType.ViewDiscussion || (type === UserPrivilegeType.ManageDiscussion && !!user?.isAdmin);
  assert.deepEqual(await f.controller.setDiscussionReplyPublic({ ...currentUser, isAdmin: true }, request), {
    error: SetDiscussionReplyPublicResponseError.PERMISSION_DENIED
  });
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.audit, []);
});

test("an absent reply returns NO_SUCH_DISCUSSION_REPLY without looking up or changing a discussion", async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, { ...request, discussionReplyId: 99 }), {
    error: SetDiscussionReplyPublicResponseError.NO_SUCH_DISCUSSION_REPLY
  });
  assert.deepEqual(f.discussionLookups, []);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.audit, []);
});

test("an absent parent fails closed", async () => {
  const f = fixture();
  f.reply.discussionId = 99;
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, request), {
    error: SetDiscussionReplyPublicResponseError.PERMISSION_DENIED
  });
  assert.deepEqual(f.discussionLookups, [99]);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.audit, []);
});

test("a reply deleted after the first lookup produces no moderation audit entry", async () => {
  const f = fixture({ parentProblem: null });
  let reads = 0;
  f.service.findDiscussionReplyById = async () => (++reads === 1 ? f.reply : null);
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, request), {
    error: SetDiscussionReplyPublicResponseError.NO_SUCH_DISCUSSION_REPLY
  });
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.audit, []);
});

test("an anonymous caller cannot moderate replies", async () => {
  const f = fixture({ parentProblem: null });
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(null, request), {
    error: SetDiscussionReplyPublicResponseError.PERMISSION_DENIED
  });
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.audit, []);
});

test("team reply approval checks the moderator's current membership and preserves the parent visibility", async () => {
  const f = fixture({ parentProblem: null, manage: false });
  const team = { id: 5, ownerId: 8, archived: false };
  const resource = { teamId: team.id, kind: "discussion", resourceId: f.parent.id, archived: false };
  const member = { status: "member", permissions: ["discussions"] };
  const rows = new Map([
    [TeamEntity, team],
    [TeamResourceEntity, resource],
    [TeamMemberEntity, member]
  ]);
  f.service.connection.getRepository = entity => ({ findOne: async () => rows.get(entity) ?? null });
  f.service.userPrivilegeService = {
    userHasPrivilege: async (_user, type) =>
      [UserPrivilegeType.ViewSite, UserPrivilegeType.ViewDiscussion].includes(type),
    permissionDecision: async (_user, _type, fallback) => fallback
  };
  f.reply.isPublic = false;
  const canApprove = async () =>
    (await f.service.getUserPermissionsOfReply(currentUser, f.reply)).includes("ManagePublicness");
  assert.equal(await f.service.userHasViewDiscussionReplyPermission(currentUser, f.reply), true);
  assert.equal(await canApprove(), true);
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, { ...request, isPublic: true }), {});
  resource.archived = true;
  assert.equal(await canApprove(), false);
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, request), { error: "PERMISSION_DENIED" });
  resource.archived = false;
  rows.delete(TeamMemberEntity);
  assert.equal(await f.service.userHasViewDiscussionReplyPermission(currentUser, f.reply), false);
  assert.deepEqual(await f.controller.setDiscussionReplyPublic(currentUser, request), { error: "PERMISSION_DENIED" });
  assert.equal(f.reply.isPublic, true);
  assert.equal(f.parent.isPublic, false);
  assert.equal(f.changes.length, 1);
  assert.equal(f.audit.length, 1);
});
