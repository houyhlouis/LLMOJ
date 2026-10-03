const backendRequire = require;
/* Real database regression with uniquely named, isolated tables. Opt in with
   HYHOJ_AI_TEST_DB_CONFIG=/path/to/backend.yaml; no production row is read or
   written, and every created table is dropped in finally. No model/sandbox I/O. */
const { test } = backendRequire("node:test");
const assert = backendRequire("node:assert/strict");
const fs = backendRequire("node:fs");
const crypto = backendRequire("node:crypto");
const os = backendRequire("node:os");
const path = backendRequire("node:path");
const ts = backendRequire("typescript");
backendRequire("reflect-metadata");
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
String.prototype.format ||= function (...args) {
  return backendRequire("node:util").format(this, ...args);
};
const { DataSource, EntitySchema } = backendRequire("typeorm");
const { UserPermissionRuleEntity } = backendRequire("../access/user-permission-rule.entity.ts");
const { UserPrivilegeEntity } = backendRequire("../user/user-privilege.entity.ts");
const { UserPrivilegeService } = backendRequire("../user/user-privilege.service.ts");
const { PermissionForUserEntity } = backendRequire("../permission/permission-for-user.entity.ts");
const { PermissionForGroupEntity } = backendRequire("../permission/permission-for-group.entity.ts");
const { GroupMembershipEntity } = backendRequire("../group/group-membership.entity.ts");
const { PermissionService, PermissionObjectType } = backendRequire("../permission/permission.service.ts");
const evidence = [];
const { AiService } = backendRequire("./ai.service.ts");
const { AiJobEntity } = backendRequire("./ai.entity.ts");
const { UserEntity } = backendRequire("../user/user.entity.ts");
const { ProblemService } = backendRequire("../problem/problem.service.ts");
const { ProblemEntity } = backendRequire("../problem/problem.entity.ts");
const { ProblemJudgeInfoEntity } = backendRequire("../problem/problem-judge-info.entity.ts");
const { ProblemSampleEntity } = backendRequire("../problem/problem-sample.entity.ts");
const { ProblemTagMapEntity } = backendRequire("../problem/problem-tag-map.entity.ts");
const { LocalizedContentEntity, LocalizedContentType } = backendRequire(
  "../localized-content/localized-content.entity.ts"
);
const { LocalizedContentService } = backendRequire("../localized-content/localized-content.service.ts");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}
const original = () => ({
  timeLimit: 1000,
  memoryLimit: 128,
  fileIo: null,
  extraSourceFiles: {},
  checker: { type: "tokens", caseSensitive: true },
  subtasks: []
});
const generated = () => ({
  ...original(),
  subtasks: [
    {
      points: 100,
      scoringType: "Sum",
      testcases: Array.from({ length: 5 }, (_, i) => ({ inputFile: `${i + 1}.in`, outputFile: `${i + 1}.out` }))
    }
  ]
});

test(
  "AI current permission publication and import authorization (real MariaDB)",
  { skip: !process.env.HYHOJ_AI_TEST_DB_CONFIG, timeout: 30000 },
  async t => {
    const config = backendRequire("js-yaml").load(fs.readFileSync(process.env.HYHOJ_AI_TEST_DB_CONFIG, "utf8")).services
      .database;
    const prefix = `qa_ai_acl_${crypto.randomBytes(8).toString("hex")}_`;
    const integer = { type: Number },
      text = { type: String, length: 255 },
      json = { type: "json" };
    const definitions = [
      [UserEntity, "user", { id: { ...integer, primary: true }, isAdmin: { type: Boolean, default: false } }],
      [
        UserPermissionRuleEntity,
        "rule",
        { userId: { ...integer, primary: true }, permission: { ...text, primary: true }, allowed: { type: Boolean } }
      ],
      [
        UserPrivilegeEntity,
        "privilege",
        { userId: { ...integer, primary: true }, privilegeType: { ...text, primary: true } }
      ],
      [
        PermissionForUserEntity,
        "acl_user",
        {
          objectId: { ...integer, primary: true },
          objectType: { ...text, primary: true },
          userId: { ...integer, primary: true },
          permissionLevel: integer
        }
      ],
      [
        PermissionForGroupEntity,
        "acl_group",
        {
          objectId: { ...integer, primary: true },
          objectType: { ...text, primary: true },
          groupId: { ...integer, primary: true },
          permissionLevel: integer
        }
      ],
      [
        GroupMembershipEntity,
        "membership",
        {
          id: { ...integer, primary: true, generated: true },
          userId: integer,
          groupId: integer,
          isGroupAdmin: { type: Boolean, default: false }
        }
      ],
      [
        ProblemEntity,
        "problem",
        {
          id: { ...integer, primary: true, generated: true },
          type: text,
          ownerId: integer,
          isPublic: { type: Boolean },
          difficulty: { ...integer, nullable: true },
          originalProblem: text,
          locales: json
        }
      ],
      [
        ProblemJudgeInfoEntity,
        "judge",
        { problemId: { ...integer, primary: true }, judgeInfo: json, submittable: { type: Boolean, default: false } }
      ],
      [ProblemSampleEntity, "sample", { problemId: { ...integer, primary: true }, data: json }],
      [
        ProblemTagMapEntity,
        "tags",
        { id: { ...integer, primary: true, generated: true }, problemId: integer, problemTagId: integer }
      ],
      [
        LocalizedContentEntity,
        "content",
        {
          objectId: { ...integer, primary: true },
          type: { ...text, primary: true },
          locale: { ...text, primary: true },
          data: { type: "text" }
        }
      ],
      [
        AiJobEntity,
        "job",
        {
          id: { ...text, primary: true },
          ownerId: integer,
          problemId: { ...integer, nullable: true },
          action: text,
          status: text,
          runToken: text,
          step: text,
          state: json,
          input: json,
          progress: integer,
          error: { type: "text", nullable: true }
        }
      ]
    ];
    const entities = definitions.map(
      ([target, name, columns]) => new EntitySchema({ name: target.name, target, tableName: prefix + name, columns })
    );
    const db = new DataSource({ ...config, entities, synchronize: true, logging: false });
    let initialized = false;
    try {
      await db.initialize();
      initialized = true;
      let problemId = 0;
      async function fixture() {
        const user = await db.getRepository(UserEntity).save({ id: 99, isAdmin: false });
        await db.getRepository(UserPermissionRuleEntity).delete({ userId: 99 });
        await db
          .getRepository(UserPermissionRuleEntity)
          .save(
            ["UseAi", "GenerateTestdata", "EditProblemData", "ImportProblem", "CreateProblem", "ViewProblem"].map(
              permission => ({ userId: 99, permission, allowed: true })
            )
          );
        const problemRepository = db.getRepository(ProblemEntity);
        const problem = await problemRepository.save(
          problemRepository.create({
            id: ++problemId,
            type: "Traditional",
            ownerId: user.id,
            isPublic: false,
            difficulty: null,
            originalProblem: "",
            locales: ["zh_CN"]
          })
        );
        await db
          .getRepository(ProblemJudgeInfoEntity)
          .save({ problemId: problem.id, judgeInfo: original(), submittable: false });
        await db.getRepository(ProblemSampleEntity).save({ problemId: problem.id, data: [] });
        await db.getRepository(LocalizedContentEntity).save([
          { objectId: problem.id, type: LocalizedContentType.ProblemTitle, locale: "zh_CN", data: "Original title" },
          { objectId: problem.id, type: LocalizedContentType.ProblemContent, locale: "zh_CN", data: "[]" }
        ]);
        const job = await db.getRepository(AiJobEntity).save({
          id: crypto.randomUUID(),
          ownerId: user.id,
          problemId: problem.id,
          action: "testdata",
          status: "running",
          step: "testdata",
          runToken: crypto.randomUUID(),
          state: {},
          input: { count: 5 },
          progress: 0,
          error: null
        });
        const redis = { cacheDelete: async () => {} };
        const problems = Object.create(ProblemService.prototype);
        Object.assign(problems, {
          connection: db,
          problemRepository: db.getRepository(ProblemEntity),
          problemJudgeInfoRepository: db.getRepository(ProblemJudgeInfoEntity),
          problemSampleRepository: db.getRepository(ProblemSampleEntity),
          problemTagMapRepository: db.getRepository(ProblemTagMapEntity),
          redisService: redis,
          localizedContentService: new LocalizedContentService(db.getRepository(LocalizedContentEntity), redis),
          problemTypeFactoryService: {
            type: () => ({ validateAndFilterJudgeInfo: () => {}, getDefaultJudgeInfo: () => original() })
          },
          getProblemFiles: async () => []
        });
        const privileges = new UserPrivilegeService(db, db.getRepository(UserPrivilegeEntity), {});
        problems.userPrivilegeService = privileges;
        problems.configService = {
          config: {
            preference: {
              security: { allowEveryoneCreateProblem: true, allowNonPrivilegedUserEditPublicProblem: false }
            }
          }
        };
        problems.permissionService = new PermissionService(
          db,
          db.getRepository(PermissionForUserEntity),
          db.getRepository(PermissionForGroupEntity),
          { getGroupIdsByUserId: async () => [] }
        );
        const service = new AiService(db, {}, db.getRepository(AiJobEntity), privileges, problems, {}, {});
        service.recordAiAudit = async () => {};
        const snapshot = await service.snapshot(problem);
        const read = async () =>
          (await db.getRepository(ProblemJudgeInfoEntity).findOneBy({ problemId: problem.id })).judgeInfo;
        const publish = () =>
          problems.updateProblemJudgeInfo(problem, generated(), true, true, (manager, currentProblem) =>
            service.authorizeTestdataCommit(job, snapshot, manager, currentProblem)
          );
        return { user, problem, job, service, problems, snapshot, read, publish };
      }
      function pauseBeforeSave(f) {
        const entered = deferred(),
          released = deferred();
        f.problems.connection = {
          transaction: (isolation, callback) =>
            db.transaction(isolation, async manager => {
              const save = manager.save.bind(manager);
              manager.save = async (...args) => {
                entered.resolve();
                await released.promise;
                return save(...args);
              };
              return callback(manager);
            })
        };
        return { entered, released };
      }
      for (const mode of ["UseAi", "GenerateTestdata", "EditProblemData", "object-ACL"])
        await t.test(`regression: revoking ${mode} during final file validation`, async () => {
          const f = await fixture(),
            timeline = [];
          const originalAssert = f.service.assertSnapshot.bind(f.service);
          f.service.assertSnapshot = async (...args) => {
            const r = await originalAssert(...args);
            timeline.push("external snapshot and current permissions passed");
            return r;
          };
          const originalAuthorize = f.service.authorizeTestdataCommit.bind(f.service);
          f.service.authorizeTestdataCommit = async (...args) => {
            await originalAuthorize(...args);
            timeline.push("transaction authorizeTestdataCommit passed");
            const manager = args[2],
              save = manager.save.bind(manager);
            manager.save = async (...a) => {
              const r = await save(...a);
              timeline.push("transaction judgeInfo save executed");
              return r;
            };
          };
          if (mode === "object-ACL") {
            f.problem.ownerId = 200;
            await db.getRepository(ProblemEntity).update({ id: f.problem.id }, { ownerId: 200 });
            await db.getRepository(PermissionForUserEntity).save({
              userId: 99,
              objectId: f.problem.id,
              objectType: PermissionObjectType.Problem,
              permissionLevel: 2
            });
            Object.assign(f.snapshot, await f.service.snapshot(f.problem));
          }
          await f.service.assertSnapshot(f.job, f.snapshot);
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyhoj-ai-commit-wiring-"));
          const previousDirectory = process.env.HYHOJ_AI_GENERATED_DIR;
          process.env.HYHOJ_AI_GENERATED_DIR = root;
          const directory = path.join(root, f.job.id);
          fs.mkdirSync(directory);
          f.job.state = {
            completed: [],
            plan: {
              subtasks: [{ id: 1, points: 100 }],
              needsSpj: false,
              timeLimitMs: 1000,
              memoryLimitMiB: 128,
              fileIo: null
            },
            makeCode: "int main(){}",
            stdCode: "int main(){}",
            validatorCode: "int main(){}",
            testdataSnapshotHash: f.service.testdataFingerprint(f.snapshot)
          };
          await db.getRepository(AiJobEntity).update({ id: f.job.id }, { state: f.job.state });
          f.service.readExistingAiHelpers = async () => ({});
          f.service.runSandbox = async () => {
            const files = [];
            for (let i = 1; i <= 5; i++)
              for (const extension of ["in", "out"]) {
                const name = `${i}.${extension}`;
                fs.writeFileSync(path.join(directory, name), "1\n");
                files.push(name);
              }
            return { directory, files, validation: { samplesPassed: 0, inputsPassed: 5, sampleInputsPassed: 0 } };
          };
          f.service.putFile = async () => {};
          f.service.cleanupSandbox = async () => {};
          f.service.execute = () => f.service.testdata(f.job, f.user, f.problem, {}, f.snapshot, 0, 100);
          f.problems.getProblemFiles = async () => {
            if (mode === "object-ACL")
              await db
                .getRepository(PermissionForUserEntity)
                .delete({ userId: 99, objectId: f.problem.id, objectType: PermissionObjectType.Problem });
            else
              await db.getRepository(UserPermissionRuleEntity).save({ userId: 99, permission: mode, allowed: false });
            timeline.push("permission or ACL revocation committed");
            await assert.rejects(f.service.assertJob(f.job), /PERMISSION_DENIED/);
            timeline.push("actual assertJob now rejects PERMISSION_DENIED");
            return [];
          };
          try {
            await f.service.runJob(f.job);
            const stored = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
            const active = await f.read();
            assert.equal(stored.status, "failed");
            assert.match(stored.error, /PERMISSION_DENIED/);
            assert.deepEqual(active, original());
            assert.equal(
              (await db.getRepository(ProblemJudgeInfoEntity).findOneBy({ problemId: f.problem.id })).submittable,
              false
            );
            evidence.push({
              mode,
              jobStatus: stored.status,
              error: stored.error,
              activatedTestcases: active.subtasks.flatMap(group => group.testcases).length,
              submittable: (await db.getRepository(ProblemJudgeInfoEntity).findOneBy({ problemId: f.problem.id }))
                .submittable,
              permissionDeniedBeforeCommit: true,
              timeline
            });
          } finally {
            if (previousDirectory === undefined) delete process.env.HYHOJ_AI_GENERATED_DIR;
            else process.env.HYHOJ_AI_GENERATED_DIR = previousDirectory;
            fs.rmSync(root, { recursive: true, force: true });
          }
        });
      for (const mode of ["UseAi", "object-ACL"])
        await t.test(`control: ${mode} revoked before testdata starts is rejected`, async () => {
          const f = await fixture(),
            timeline = [];
          const originalAssert = f.service.assertSnapshot.bind(f.service);
          f.service.assertSnapshot = async (...args) => {
            const r = await originalAssert(...args);
            timeline.push("external snapshot and current permissions passed");
            return r;
          };
          const originalAuthorize = f.service.authorizeTestdataCommit.bind(f.service);
          f.service.authorizeTestdataCommit = async (...args) => {
            await originalAuthorize(...args);
            timeline.push("transaction authorizeTestdataCommit passed");
            const manager = args[2],
              save = manager.save.bind(manager);
            manager.save = async (...a) => {
              const r = await save(...a);
              timeline.push("transaction judgeInfo save executed");
              return r;
            };
          };
          if (mode === "object-ACL") {
            f.problem.ownerId = 200;
            await db.getRepository(ProblemEntity).update({ id: f.problem.id }, { ownerId: 200 });
            await db.getRepository(PermissionForUserEntity).save({
              userId: 99,
              objectId: f.problem.id,
              objectType: PermissionObjectType.Problem,
              permissionLevel: 2
            });
            Object.assign(f.snapshot, await f.service.snapshot(f.problem));
          }
          await f.service.assertSnapshot(f.job, f.snapshot);
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyhoj-ai-commit-wiring-"));
          const previousDirectory = process.env.HYHOJ_AI_GENERATED_DIR;
          process.env.HYHOJ_AI_GENERATED_DIR = root;
          const directory = path.join(root, f.job.id);
          fs.mkdirSync(directory);
          f.job.state = {
            completed: [],
            plan: {
              subtasks: [{ id: 1, points: 100 }],
              needsSpj: false,
              timeLimitMs: 1000,
              memoryLimitMiB: 128,
              fileIo: null
            },
            makeCode: "int main(){}",
            stdCode: "int main(){}",
            validatorCode: "int main(){}",
            testdataSnapshotHash: f.service.testdataFingerprint(f.snapshot)
          };
          await db.getRepository(AiJobEntity).update({ id: f.job.id }, { state: f.job.state });
          f.service.readExistingAiHelpers = async () => ({});
          f.service.runSandbox = async () => {
            const files = [];
            for (let i = 1; i <= 5; i++)
              for (const extension of ["in", "out"]) {
                const name = `${i}.${extension}`;
                fs.writeFileSync(path.join(directory, name), "1\n");
                files.push(name);
              }
            return { directory, files, validation: { samplesPassed: 0, inputsPassed: 5, sampleInputsPassed: 0 } };
          };
          f.service.putFile = async () => {};
          f.service.cleanupSandbox = async () => {};
          f.service.execute = () => f.service.testdata(f.job, f.user, f.problem, {}, f.snapshot, 0, 100);
          if (mode === "object-ACL")
            await db
              .getRepository(PermissionForUserEntity)
              .delete({ userId: 99, objectId: f.problem.id, objectType: PermissionObjectType.Problem });
          else await db.getRepository(UserPermissionRuleEntity).save({ userId: 99, permission: mode, allowed: false });
          f.problems.getProblemFiles = async () => {
            throw new Error("must not reach publication after early denial");
          };
          try {
            await f.service.runJob(f.job);
            const stored = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
            const active = await f.read();
            assert.equal(stored.status, "failed");
            assert.match(stored.error, /PERMISSION_DENIED/);
            assert.equal(active.subtasks.length, 0);
            evidence.push({
              control: true,
              mode,
              jobStatus: stored.status,
              error: stored.error,
              activatedTestcases: 0,
              phase: "revoked before testdata starts"
            });
          } finally {
            if (previousDirectory === undefined) delete process.env.HYHOJ_AI_GENERATED_DIR;
            else process.env.HYHOJ_AI_GENERATED_DIR = previousDirectory;
            fs.rmSync(root, { recursive: true, force: true });
          }
        });
      await t.test("an unchanged, currently authorized job activates generated testcases", async () => {
        const f = await fixture();
        assert.equal(await f.publish(), null);
        assert.deepEqual(await f.read(), generated());
        assert.equal(
          (await db.getRepository(ProblemJudgeInfoEntity).findOneBy({ problemId: f.problem.id })).submittable,
          true
        );
        evidence.push({ mode: "authorized publication", activatedTestcases: 5, submittable: true });
      });
      for (const revoked of ["ImportProblem", "CreateProblem", "UseAi"])
        await t.test(`regression: ${revoked} revoked while import extraction is pending`, async () => {
          const f = await fixture(),
            timeline = [];
          const realCreate = f.problems.createProblem.bind(f.problems);
          f.problems.createProblem = async (...a) => {
            timeline.push("actual createProblem starts");
            const r = await realCreate(...a);
            timeline.push("new problem transaction committed");
            return r;
          };
          f.job.problemId = null;
          f.job.action = "import";
          f.job.input = { count: 5, markdown: "Read integer n from 0 to 10 and output n." };
          f.job.state = { completed: [] };
          await db
            .getRepository(AiJobEntity)
            .update({ id: f.job.id }, { problemId: null, action: "import", input: f.job.input, state: f.job.state });
          const initialCount = await db.getRepository(ProblemEntity).count();
          f.service.model = async () => {
            timeline.push("extraction request started after initial authorization");
            await db.getRepository(UserPermissionRuleEntity).save({ userId: 99, permission: revoked, allowed: false });
            assert.equal(await f.service.privileges.userHasPrivilege(f.user, revoked), false);
            timeline.push("revocation committed and actual permission decision false");
            return {
              problemType: "Traditional",
              localizedContents: [
                {
                  locale: "en_US",
                  title: "Isolated revoke fixture",
                  description: "Read n and output n.",
                  input: "n",
                  output: "n",
                  limitsAndHints: "0 <= n <= 10"
                }
              ],
              samples: [{ inputData: "1\n", outputData: "1\n" }],
              judgeInfo: { timeLimit: 1000, memoryLimit: 128, fileIo: null }
            };
          };
          f.service.installAttachment = async () => {};
          f.service.execute = () => f.service.importProblem(f.job, f.user, {});
          await f.service.runJob(f.job);
          const row = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
          const finalCount = await db.getRepository(ProblemEntity).count();
          assert.equal(row.status, "failed");
          assert.match(row.error, /PERMISSION_DENIED/);
          assert.equal(finalCount, initialCount);
          assert.equal(f.job.problemId, null);
          evidence.push({
            mode: revoked,
            phase: "after-model-start-before-create",
            permissionDeniedBeforeCreate: true,
            jobStatus: row.status,
            createdProblemCount: finalCount - initialCount,
            timeline
          });
          if (f.job.problemId) problemId = Math.max(problemId, f.job.problemId);
        });
      for (const revoked of ["ImportProblem", "CreateProblem"])
        await t.test(`control: ${revoked} denied before extraction prevents creation`, async () => {
          const f = await fixture();
          f.job.problemId = null;
          f.job.action = "import";
          f.job.input = { count: 5, markdown: "Read n and output n." };
          f.job.state = { completed: [] };
          await db
            .getRepository(AiJobEntity)
            .update({ id: f.job.id }, { problemId: null, action: "import", input: f.job.input, state: f.job.state });
          await db.getRepository(UserPermissionRuleEntity).save({ userId: 99, permission: revoked, allowed: false });
          let modelCalled = false;
          f.service.model = async () => {
            modelCalled = true;
            throw new Error("must not call model");
          };
          const count = await db.getRepository(ProblemEntity).count();
          await assert.rejects(f.service.importProblem(f.job, f.user, {}), /PERMISSION_DENIED/);
          assert.equal(modelCalled, false);
          assert.equal(await db.getRepository(ProblemEntity).count(), count);
          evidence.push({
            control: true,
            mode: revoked,
            phase: "denied before extraction",
            modelCalled,
            createdProblemCount: 0,
            error: "PERMISSION_DENIED"
          });
        });
      for (const mode of ["group-ACL", "group-membership"])
        await t.test(`group authorization uses current transaction state: ${mode}`, async () => {
          const f = await fixture();
          f.problem.ownerId = 200;
          await db.getRepository(ProblemEntity).update({ id: f.problem.id }, { ownerId: 200 });
          const membership = await db
            .getRepository(GroupMembershipEntity)
            .save({ userId: 99, groupId: 7, isGroupAdmin: false });
          await db
            .getRepository(PermissionForGroupEntity)
            .save({ groupId: 7, objectId: f.problem.id, objectType: PermissionObjectType.Problem, permissionLevel: 2 });
          // An external group cache can still contain a membership that has been removed.
          f.problems.permissionService.groupService.getGroupIdsByUserId = async () => [7];
          Object.assign(f.snapshot, await f.service.snapshot(f.problem));
          await f.service.assertSnapshot(f.job, f.snapshot);
          f.problems.getProblemFiles = async () => {
            if (mode === "group-ACL")
              await db
                .getRepository(PermissionForGroupEntity)
                .delete({ groupId: 7, objectId: f.problem.id, objectType: PermissionObjectType.Problem });
            else await db.getRepository(GroupMembershipEntity).delete({ id: membership.id });
            return [];
          };
          await assert.rejects(f.publish(), /PERMISSION_DENIED/);
          assert.deepEqual(await f.read(), original());
          await db.getRepository(GroupMembershipEntity).delete({ userId: 99 });
          evidence.push({ mode, phase: "before publication transaction", activatedTestcases: 0 });
        });
      await t.test("an administrator demoted before final authorization cannot use a stale admin user", async () => {
        const f = await fixture();
        f.user.isAdmin = true;
        await db.getRepository(UserEntity).update({ id: f.user.id }, { isAdmin: true });
        await db
          .getRepository(UserPermissionRuleEntity)
          .update({ userId: 99, permission: "UseAi" }, { allowed: false });
        await f.service.assertSnapshot(f.job, f.snapshot);
        f.problems.getProblemFiles = async () => {
          await db.getRepository(UserEntity).update({ id: f.user.id }, { isAdmin: false });
          return [];
        };
        await assert.rejects(f.publish(), /PERMISSION_DENIED/);
        assert.deepEqual(await f.read(), original());
        assert.equal(f.user.isAdmin, true);
        evidence.push({
          mode: "administrator demotion before commit",
          activatedTestcases: 0,
          staleAdminUserRetained: true
        });
      });
      await t.test("administrator demotion waits for a publication that already locked the current user", async () => {
        const f = await fixture();
        f.user.isAdmin = true;
        await db.getRepository(UserEntity).update({ id: f.user.id }, { isAdmin: true });
        await db
          .getRepository(UserPermissionRuleEntity)
          .update({ userId: 99, permission: "UseAi" }, { allowed: false });
        const gate = pauseBeforeSave(f),
          publication = f.publish();
        await gate.entered.promise;
        let demoted = false;
        const demotion = db
          .getRepository(UserEntity)
          .update({ id: f.user.id }, { isAdmin: false })
          .then(() => {
            demoted = true;
          });
        try {
          await pause(75);
          assert.equal(demoted, false);
        } finally {
          gate.released.resolve();
        }
        await publication;
        await demotion;
        assert.deepEqual(await f.read(), generated());
        const currentUser = await db.getRepository(UserEntity).findOneBy({ id: f.user.id });
        assert.equal(await f.service.privileges.userHasPrivilege(currentUser, "UseAi"), false);
        evidence.push({
          mode: "administrator demotion after authorization",
          blockedUntilCommit: true,
          activatedTestcases: 5
        });
      });
      await t.test(
        "transaction permission reads reject committed revocations despite an older repeatable-read snapshot",
        async () => {
          const f = await fixture();
          await db
            .getRepository(PermissionForUserEntity)
            .save({ userId: 99, objectId: f.problem.id, objectType: PermissionObjectType.Problem, permissionLevel: 2 });
          const outcomes = {};
          const denyOrConflict = async (name, check) => {
            try {
              assert.equal(await check(), false);
              outcomes[name] = "denied";
            } catch (error) {
              // MariaDB can reject a locking current read when this transaction
              // has already observed an older version. That conflict must abort
              // authorization, never allow a stale grant or trigger a retry here.
              assert.equal(error.driverError?.code || error.code, "ER_CHECKREAD");
              outcomes[name] = "ER_CHECKREAD";
            }
          };
          const runner = db.createQueryRunner();
          await runner.connect();
          await runner.startTransaction("REPEATABLE READ");
          try {
            assert.equal(
              (await runner.manager.findOneBy(UserPermissionRuleEntity, { userId: 99, permission: "UseAi" })).allowed,
              true
            );
            assert.equal(
              (
                await runner.manager.findOneBy(PermissionForUserEntity, {
                  userId: 99,
                  objectId: f.problem.id,
                  objectType: PermissionObjectType.Problem
                })
              ).permissionLevel,
              2
            );
            await db
              .getRepository(UserPermissionRuleEntity)
              .update({ userId: 99, permission: "UseAi" }, { allowed: false });
            await db
              .getRepository(PermissionForUserEntity)
              .delete({ userId: 99, objectId: f.problem.id, objectType: PermissionObjectType.Problem });
            // Confirm the non-locking snapshot still returns the old values.
            assert.equal(
              (await runner.manager.findOneBy(UserPermissionRuleEntity, { userId: 99, permission: "UseAi" })).allowed,
              true
            );
            await denyOrConflict("capability", () =>
              f.service.privileges.userHasPrivilege(f.user, "UseAi", runner.manager)
            );
            await denyOrConflict("objectAcl", () =>
              f.problems.permissionService.userOrItsGroupsHavePermission(
                f.user,
                f.problem.id,
                PermissionObjectType.Problem,
                2,
                runner.manager
              )
            );
          } finally {
            await runner.rollbackTransaction();
            await runner.release();
          }
          assert.deepEqual(await f.read(), original());
          evidence.push({
            mode: "repeatable-read stale snapshot",
            authorizationRejected: true,
            activatedTestcases: 0,
            outcomes
          });
        }
      );
      await t.test("an accepted UseAi grant cannot be revoked before publication commits", async () => {
        const f = await fixture(),
          gate = pauseBeforeSave(f);
        const publication = f.publish();
        await gate.entered.promise;
        let revoked = false;
        const revocation = db
          .getRepository(UserPermissionRuleEntity)
          .update({ userId: 99, permission: "UseAi" }, { allowed: false })
          .then(() => {
            revoked = true;
          });
        try {
          await pause(75);
          assert.equal(revoked, false);
          assert.deepEqual(await f.read(), original());
        } finally {
          gate.released.resolve();
        }
        await publication;
        await revocation;
        assert.deepEqual(await f.read(), generated());
        assert.equal(await f.service.privileges.userHasPrivilege(f.user, "UseAi"), false);
        evidence.push({
          mode: "UseAi",
          phase: "revocation waits for accepted publication",
          blockedUntilCommit: true,
          activatedTestcases: 5
        });
      });
      await t.test(
        "default CreateProblem authorization locks a missing deny override until creation commits",
        async () => {
          const f = await fixture();
          await db.getRepository(UserPermissionRuleEntity).delete({ userId: 99, permission: "CreateProblem" });
          f.job.problemId = null;
          f.job.action = "import";
          f.job.input = { count: 5, markdown: "Read n and output n. 0 <= n <= 10." };
          f.job.state = { completed: [] };
          await db
            .getRepository(AiJobEntity)
            .update({ id: f.job.id }, { problemId: null, action: "import", input: f.job.input, state: f.job.state });
          f.service.model = async () => ({
            problemType: "Traditional",
            localizedContents: [
              {
                locale: "en_US",
                title: "Default permission import",
                description: "Read n and output n.",
                input: "n",
                output: "n",
                limitsAndHints: "0 <= n <= 10"
              }
            ],
            samples: [{ inputData: "1\n", outputData: "1\n" }],
            judgeInfo: { timeLimit: 1000, memoryLimit: 128, fileIo: null }
          });
          f.service.installAttachment = async () => {};
          const gate = pauseBeforeSave(f);
          const creation = f.service.importProblem(f.job, f.user, {});
          await gate.entered.promise;
          let revoked = false;
          const revocation = db
            .getRepository(UserPermissionRuleEntity)
            .insert({ userId: 99, permission: "CreateProblem", allowed: false })
            .then(() => {
              revoked = true;
            });
          try {
            await pause(75);
            assert.equal(revoked, false);
          } finally {
            gate.released.resolve();
          }
          await creation;
          await revocation;
          assert(f.job.problemId);
          assert.equal((await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id })).problemId, f.job.problemId);
          assert.equal(await f.problems.userHasCreateProblemPermission(f.user), false);
          problemId = Math.max(problemId, f.job.problemId);
          evidence.push({
            mode: "CreateProblem missing override",
            phase: "deny insert waits for accepted import creation",
            blockedUntilCommit: true,
            createdProblemCount: 1
          });
        }
      );
      for (const mode of ["success", "ImportProblem", "CreateProblem", "UseAi", "cancel", "lease"])
        await t.test(`import create transaction guard: ${mode}`, async () => {
          const f = await fixture();
          f.job.problemId = null;
          f.job.action = "import";
          f.job.input = { count: 5, markdown: "Read n and output n. 0 <= n <= 10." };
          f.job.state = { completed: [] };
          await db
            .getRepository(AiJobEntity)
            .update({ id: f.job.id }, { problemId: null, action: "import", input: f.job.input, state: f.job.state });
          f.service.model = async () => ({
            problemType: "Traditional",
            localizedContents: [
              {
                locale: "en_US",
                title: "Authorized import",
                description: "Read n and output n.",
                input: "n",
                output: "n",
                limitsAndHints: "0 <= n <= 10"
              }
            ],
            samples: [{ inputData: "1\n", outputData: "1\n" }],
            judgeInfo: { timeLimit: 1000, memoryLimit: 128, fileIo: null }
          });
          f.service.installAttachment = async () => {};
          const create = f.problems.createProblem.bind(f.problems);
          f.problems.createProblem = async (...args) => {
            // This occurs after all external checks and before the real transaction.
            if (["ImportProblem", "CreateProblem", "UseAi"].includes(mode))
              await db.getRepository(UserPermissionRuleEntity).save({ userId: 99, permission: mode, allowed: false });
            if (mode === "cancel") await f.service.cancel(f.user, f.job.id);
            if (mode === "lease")
              await db.getRepository(AiJobEntity).update({ id: f.job.id }, { runToken: crypto.randomUUID() });
            return create(...args);
          };
          const count = await db.getRepository(ProblemEntity).count();
          f.service.execute = () => f.service.importProblem(f.job, f.user, {});
          await f.service.runJob(f.job);
          const row = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
          const created = (await db.getRepository(ProblemEntity).count()) - count;
          assert.equal(created, mode === "success" ? 1 : 0);
          assert.equal(
            row.status,
            mode === "success" ? "completed" : mode === "cancel" ? "cancelled" : mode === "lease" ? "running" : "failed"
          );
          if (mode === "success") {
            assert.equal(row.problemId, f.job.problemId);
            problemId = Math.max(problemId, f.job.problemId);
          } else assert.equal(row.problemId, null);
          evidence.push({
            mode,
            phase: "inside create transaction guard",
            jobStatus: row.status,
            createdProblemCount: created
          });
        });
    } finally {
      if (initialized) {
        for (const [, name] of definitions.slice().reverse())
          await db.query(`DROP TABLE IF EXISTS \`${prefix + name}\``);
        const remaining = await db.query(
          "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE ?",
          [prefix + "%"]
        );
        if (process.env.HYHOJ_AI_TEST_RESULTS)
          fs.writeFileSync(
            process.env.HYHOJ_AI_TEST_RESULTS,
            JSON.stringify(
              {
                method:
                  "real MariaDB isolated tables; actual product permission and publication methods; synthetic model/sandbox/file I/O",
                prefix,
                tableCount: definitions.length,
                remainingTables: Number(remaining[0].n),
                evidence
              },
              null,
              2
            )
          );
        await db.destroy();
      }
    }
  }
);
