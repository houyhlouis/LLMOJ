const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.join(__dirname, "..");
const privilegeSource = fs.readFileSync(path.join(root, "user/user-privilege.entity.ts"), "utf8");
const P = Object.fromEntries([...privilegeSource.matchAll(/(\w+)\s*=\s*"([^"]+)"/g)].map(m => [m[1], m[2]]));
const noop = function () {};
const decorator = () => noop;
const generic = new Proxy({}, { get: () => noop });
const decorators = new Proxy({}, { get: () => decorator });
function load(relative, overrides = {}) {
  const filename = path.join(root, relative);
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true }
  }).outputText;
  const module = { exports: {} };
  const requireStub = name =>
    overrides[name] ||
    (name === "@nestjs/common"
      ? {
          ...decorators,
          Injectable: decorator,
          Inject: decorator,
          forwardRef: x => x,
          ForbiddenException: class extends Error {},
          BadRequestException: class extends Error {}
        }
      : name === "@nestjs/typeorm"
      ? { InjectDataSource: decorator, InjectRepository: decorator }
      : name.endsWith("user-privilege.service") || name.endsWith("user-privilege.entity")
      ? { UserPrivilegeType: P, UserPrivilegeEntity: class {} }
      : generic);
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, {})(requireStub, module, module.exports);
  return module.exports;
}
const catalog = load("access/permission-catalog.ts");
const { UserPrivilegeService } = load("user/user-privilege.service.ts", { "../access/permission-catalog": catalog });
const { AccessGuard } = load("access/access.guard.ts");
const { withoutTestData } = load("submission/submission-redaction.ts");
const { SubmissionService, SubmissionPermissionType } = load("submission/submission.service.ts");
const { ProblemService, ProblemPermissionType } = load("problem/problem.service.ts");
const { DiscussionService, DiscussionPermissionType } = load("discussion/discussion.service.ts", {
  "../problem/problem.service": { ProblemPermissionType }
});
(async () => {
  const rules = new Map();
  const grants = new Set();
  const connection = {
    getRepository: () => ({
      findOneBy: async q => (rules.has(q.permission) ? { allowed: rules.get(q.permission) } : null)
    })
  };
  const service = new UserPrivilegeService(
    connection,
    { countBy: async q => (grants.has(q.privilegeType) ? 1 : 0) },
    {}
  );
  const user = { id: 2, isAdmin: false };
  assert.equal(await service.userHasPrivilege(user, P.ViewProblem), true);
  assert.equal(await service.userHasPrivilege(user, P.ManageProblem), false);
  grants.add(P.ManageProblem);
  rules.set(P.ManageProblem, false);
  assert.equal(
    await service.userHasPrivilege(user, P.ManageProblem),
    false,
    "explicit deny wins over legacy privilege grants"
  );
  rules.set(P.EditAnyProblem, false);
  assert.equal(
    await service.permissionDecision(user, P.EditAnyProblem, true),
    false,
    "deny wins over an object ACL fallback"
  );
  rules.set(P.ManagePermissions, true);
  assert.equal(
    await service.userHasPrivilege(user, P.ManagePermissions),
    false,
    "non-admins cannot gain permission administration by an override"
  );
  assert.equal(await service.userHasPrivilege({ id: 1, isAdmin: true }, P.ManagePermissions), true);
  assert.equal(await service.userHasPrivilege(null, P.ViewProblem), true);
  assert.equal(await service.userHasPrivilege(null, P.CreateProblem), false);
  assert.equal(await service.userHasPrivilege(null, P.ReadProblemData), false, "no unconditional guest test-data grant");
  assert.equal(await service.permissionDecision(null, P.ReadProblemData, true), true, "preserve permitted anonymous public data");
  assert.equal(await service.permissionDecision(null, P.ReadProblemData, false), false, "preserve denied object fallback");
  rules.set(P.ReadProblemData, false);
  assert.equal(await service.permissionDecision(user, P.ReadProblemData, true), false, "explicit deny still wins for data");
  rules.delete(P.ReadProblemData);
  const guard = new AccessGuard({
    userHasPrivilege: async (_u, p) => p !== P.SubmitProblem,
    permissionDecision: async () => true
  });
  for (const spelling of ["/api/submission/submit", "/api/submission/submit/", "/API/SuBmIsSiOn/sUbMiT/"]) {
    await assert.rejects(
      () =>
        guard.canActivate({
          getType: () => "http",
          switchToHttp: () => ({ getRequest: () => ({ path: spelling, session: { user } }) })
        }),
      Error,
      "equivalent Express URLs must not bypass a deny"
    );
  }
  await assert.rejects(
    () =>
      guard.canActivate({
        getType: () => "http",
        switchToHttp: () => ({
          getRequest: () => ({ path: "/unexpected", route: { path: "/api/submission/submit" }, session: { user } })
        })
      }),
    Error
  );
  const capability = {
    userHasPrivilege: async (_u, p) => p !== P.ViewHiddenProblem,
    permissionDecision: async (_u, p, fallback) => (p === P.EditAnyProblem ? true : fallback)
  };
  const problems = Object.create(ProblemService.prototype);
  problems.userPrivilegeService = capability;
  problems.userHasPermissionOriginal = async () => false;
  assert.equal(
    await problems.userHasPermission(user, { id: 1, ownerId: 99, isPublic: false }, ProblemPermissionType.Modify),
    false,
    "editing capability cannot bypass a private problem's view ACL"
  );
  const discussions = Object.create(DiscussionService.prototype);
  discussions.userPrivilegeService = capability;
  discussions.userHasPermissionOriginal = async () => false;
  discussions.problemService = { findProblemById: async () => ({}), userHasPermission: async () => false };
  assert.equal(
    await discussions.userHasPermission(
      user,
      { id: 1, publisherId: 99, isPublic: true, problemId: 1 },
      DiscussionPermissionType.View
    ),
    false,
    "a public discussion cannot disclose an inaccessible private problem"
  );
  assert.equal(
    await discussions.userHasPermission(
      user,
      { id: 1, publisherId: 99, isPublic: false },
      DiscussionPermissionType.Modify
    ),
    false
  );
  const submissions = Object.create(SubmissionService.prototype);
  submissions.userPrivilegeService = service;
  submissions.problemService = { userHasPermission: async () => false, findProblemById: async () => ({}) };
  submissions.getUserProblemAcceptedSubmissionCount = async () => 1;
  const publicSubmission = { isPublic: true, submitterId: 99, problemId: 1 };
  assert.equal(
    await submissions.userHasPermission(user, publicSubmission, SubmissionPermissionType.View),
    true,
    "public source remains readable by default"
  );
  assert.equal(
    await submissions.userHasPermission(null, publicSubmission, SubmissionPermissionType.View),
    true,
    "upstream anonymous public-source access is preserved"
  );
  rules.set(P.ReadAnySubmissionCode, false);
  assert.equal(await submissions.userHasPermission(user, publicSubmission, SubmissionPermissionType.View), false);
  grants.add(P.ReadCodeAfterAccepted);
  assert.equal(await submissions.userHasPermission(user, publicSubmission, SubmissionPermissionType.View), true);
  assert.equal(
    await submissions.userHasPermission(user, { ...publicSubmission, isPublic: false }, SubmissionPermissionType.View),
    false,
    "solving a problem cannot reveal another user's private submission"
  );
  rules.set(P.RejudgeSubmission, false);
  submissions.problemService.userHasPermission = async () => true;
  assert.equal(
    await submissions.userHasPermission(user, publicSubmission, SubmissionPermissionType.Rejudge),
    false,
    "explicit rejudge denial beats problem editor privileges"
  );
  const rawProgress = {
    progressType: "Finished",
    status: "Accepted",
    score: 100,
    compile: { success: true },
    systemMessage: "private trace",
    testcaseResult: {
      hash: {
        status: "Accepted",
        score: 100,
        time: 5,
        memory: 100,
        input: "secret input",
        output: "secret answer",
        userOutput: "secret answer",
        checkerMessage: "secret input",
        testcaseInfo: { inputFile: "private.in", outputFile: "private.out", timeLimit: 1000, memoryLimit: 128 }
      }
    },
    subtasks: [{ score: 100, fullScore: 100, testcases: [{ testcaseHash: "hash" }] }]
  };
  const redacted = withoutTestData(rawProgress);
  assert.equal(redacted.testcaseResult.hash.status, "Accepted");
  assert.equal(redacted.testcaseResult.hash.time, 5);
  assert.equal(JSON.stringify(redacted).includes("secret"), false);
  assert.equal(JSON.stringify(redacted).includes("private"), false);
  assert.equal(
    rawProgress.testcaseResult.hash.input,
    "secret input",
    "redaction cannot mutate cached judge progress used by authorized viewers"
  );
  console.log("Access permissions: 30 assertions passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
