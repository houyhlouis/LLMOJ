const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const main = require.resolve("../main.ts");
require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
const { SubmissionService } = require("./submission.service.ts");
const { SubmissionController } = require("./submission.controller.ts");
const { SubmissionAccessService, SubmissionPermissionType } = require("./submission-access.service.ts");
const { ContestEntity } = require("../contest/contest.entity.ts");
const { ContestVirtualParticipationEntity } = require("../contest/contest-virtual-participation.entity.ts");
const { TeamResourceEntity } = require("../team/team.entity.ts");

function fixture(initial, duringPermissionCheck) {
  const row = { id: 17, isPublic: initial, status: "Pending", score: null, taskId: "old-task" };
  const writes = [];
  const logs = [];
  const service = Object.assign(Object.create(SubmissionService.prototype), {
    findSubmissionById: async () => ({ ...row }),
    submissionRepository: {
      update: async (where, patch) => {
        writes.push([where, patch]);
        const matches = row.id === where.id && row.isPublic === where.isPublic;
        if (matches) Object.assign(row, patch);
        return { affected: matches ? 1 : 0 };
      }
    }
  });
  const controller = Object.assign(Object.create(SubmissionController.prototype), {
    submissionService: service,
    submissionAccessService: {
      userHasPermission: async (_user, _submission, permission) => {
        assert.equal(permission, SubmissionPermissionType.ManagePublicness);
        if (duringPermissionCheck) duringPermissionCheck(row);
        return true;
      }
    },
    auditService: { log: async (...args) => logs.push(args) }
  });
  return { controller, row, writes, logs };
}

for (const desired of [false, true]) {
  test(`visibility ${desired} writes only isPublic and records a real transition`, async () => {
    const { controller, row, writes, logs } = fixture(!desired, current => {
      Object.assign(current, { status: "Accepted", score: 100, taskId: null });
    });
    assert.deepEqual(await controller.setSubmissionPublic({ id: 1 }, { submissionId: 17, isPublic: desired }), {});
    assert.deepEqual(writes, [[{ id: 17, isPublic: !desired }, { isPublic: desired }]]);
    assert.deepEqual(row, { id: 17, isPublic: desired, status: "Accepted", score: 100, taskId: null });
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], desired ? "submission.set_public" : "submission.set_non_public");
  });

  test(`visibility ${desired} does not return early using a stale matching value`, async () => {
    const { controller, row, logs } = fixture(desired, current => {
      current.isPublic = !desired;
    });
    await controller.setSubmissionPublic({ id: 1 }, { submissionId: 17, isPublic: desired });
    assert.equal(row.isPublic, desired);
    assert.equal(logs.length, 1);
  });

  test(`visibility ${desired} logs nothing if another write already made the requested transition`, async () => {
    const { controller, logs } = fixture(!desired, current => {
      current.isPublic = desired;
    });
    await controller.setSubmissionPublic({ id: 1 }, { submissionId: 17, isPublic: desired });
    assert.deepEqual(logs, []);
  });
}

test("visibility authorization failures still prevent writes", async () => {
  const { controller, writes, logs } = fixture(false);
  controller.submissionAccessService.userHasPermission = async () => false;
  assert.deepEqual(await controller.setSubmissionPublic({ id: 1 }, { submissionId: 17, isPublic: true }), {
    error: "PERMISSION_DENIED"
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(logs, []);
});

test("raw submission and progress access honors the virtual window, including cancellation", async () => {
  const now = Date.now();
  const contest = { id: 8, ownerId: 42, adminIds: [], startTime: new Date(now - 200000), endTime: new Date(now - 100000) };
  const run = { startTime: new Date(now - 1000), endTime: new Date(now + 99000) };
  const user = { id: 7 };
  const sub = { contestId: contest.id, submitterId: user.id, submitTime: run.startTime };
  const service = Object.assign(Object.create(SubmissionAccessService.prototype), {
    userPrivilegeService: { userHasPrivilege: async (_user, permission) => permission === "ViewContest" },
    connection: { getRepository: entity => {
      if (entity === ContestEntity) return { findOneBy: async () => contest };
      if (entity === TeamResourceEntity) return { findOne: async () => null };
      assert.equal(entity, ContestVirtualParticipationEntity);
      return { findOneBy: async where => {
        assert.deepEqual(where, { contestId: contest.id, userId: user.id });
        return run;
      } };
    } }
  });
  const can = (type, submission = sub) => service.userHasPermission(user, submission, type);
  assert.equal(await can(SubmissionPermissionType.View), false);
  assert.equal(await can(SubmissionPermissionType.Cancel), true);
  assert.equal(await can(SubmissionPermissionType.Cancel, { ...sub, submitTime: contest.startTime }), false);
  assert.equal(await can(SubmissionPermissionType.Cancel, { ...sub, submitterId: 9 }), false);
  run.endTime = new Date(now);
  assert.equal(await can(SubmissionPermissionType.View), true);
  assert.equal(await can(SubmissionPermissionType.Cancel), false);
});
