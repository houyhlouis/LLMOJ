/* Real database regression with uniquely named, isolated tables. Opt in with
   HYHOJ_AI_TEST_DB_CONFIG=/path/to/backend.yaml; no production row is read or
   written, and every created table is dropped in finally. No model/sandbox I/O. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
String.prototype.format ||= function (...args) { return require("node:util").format(this, ...args); };
const { DataSource, EntitySchema } = require("typeorm");
const { AiService } = require("./ai.service.ts");
const { AiJobEntity } = require("./ai.entity.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { ProblemService } = require("../problem/problem.service.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts");
const { ProblemSampleEntity } = require("../problem/problem-sample.entity.ts");
const { ProblemTagMapEntity } = require("../problem/problem-tag-map.entity.ts");
const { LocalizedContentEntity, LocalizedContentType } = require("../localized-content/localized-content.entity.ts");
const { LocalizedContentService } = require("../localized-content/localized-content.service.ts");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const original = () => ({ timeLimit: 1000, memoryLimit: 128, fileIo: null, extraSourceFiles: {},
  checker: { type: "tokens", caseSensitive: true }, subtasks: [] });
const generated = () => ({ ...original(), subtasks: [{ points: 100, scoringType: "Sum",
  testcases: Array.from({ length: 5 }, (_, i) => ({ inputFile: `${i + 1}.in`, outputFile: `${i + 1}.out` })) }] });

test("AI final publication is atomic against cancel, lease loss and human edits (real MariaDB)",
  { skip: !process.env.HYHOJ_AI_TEST_DB_CONFIG, timeout: 30000 }, async t => {
  const config = require("js-yaml").load(fs.readFileSync(process.env.HYHOJ_AI_TEST_DB_CONFIG, "utf8")).services.database;
  const prefix = `qa_ai_commit_${crypto.randomBytes(8).toString("hex")}_`;
  const integer = { type: Number }, text = { type: String, length: 255 }, json = { type: "json" };
  const definitions = [
    [UserEntity, "user", { id: { ...integer, primary: true } }],
    [ProblemEntity, "problem", { id: { ...integer, primary: true }, type: text, ownerId: integer, isPublic: { type: Boolean },
      difficulty: { ...integer, nullable: true }, originalProblem: text, locales: json }],
    [ProblemJudgeInfoEntity, "judge", { problemId: { ...integer, primary: true }, judgeInfo: json, submittable: { type: Boolean } }],
    [ProblemSampleEntity, "sample", { problemId: { ...integer, primary: true }, data: json }],
    [ProblemTagMapEntity, "tags", { id: { ...integer, primary: true, generated: true }, problemId: integer, problemTagId: integer }],
    [LocalizedContentEntity, "content", { objectId: { ...integer, primary: true }, type: { ...text, primary: true },
      locale: { ...text, primary: true }, data: { type: "text" } }],
    [AiJobEntity, "job", { id: { ...text, primary: true }, ownerId: integer, problemId: integer, action: text,
      status: text, runToken: text, step: text, state: json, input: json, progress: integer, error: { type: "text", nullable: true } }]
  ];
  const entities = definitions.map(([target, name, columns]) => new EntitySchema({ name: target.name, target,
    tableName: prefix + name, columns }));
  const db = new DataSource({ ...config, entities, synchronize: true, logging: false });
  let initialized = false;
  try {
    await db.initialize(); initialized = true;
    let problemId = 0;
    async function fixture() {
      const user = await db.getRepository(UserEntity).save({ id: 99 });
      const problemRepository = db.getRepository(ProblemEntity);
      const problem = await problemRepository.save(problemRepository.create({ id: ++problemId, type: "Traditional", ownerId: user.id,
        isPublic: false, difficulty: null, originalProblem: "", locales: ["zh_CN"] }));
      await db.getRepository(ProblemJudgeInfoEntity).save({ problemId: problem.id, judgeInfo: original(), submittable: false });
      await db.getRepository(ProblemSampleEntity).save({ problemId: problem.id, data: [] });
      await db.getRepository(LocalizedContentEntity).save([
        { objectId: problem.id, type: LocalizedContentType.ProblemTitle, locale: "zh_CN", data: "Original title" },
        { objectId: problem.id, type: LocalizedContentType.ProblemContent, locale: "zh_CN", data: "[]" }
      ]);
      const job = await db.getRepository(AiJobEntity).save({ id: crypto.randomUUID(), ownerId: user.id,
        problemId: problem.id, action: "testdata", status: "running", step: "testdata", runToken: crypto.randomUUID(), state: {}, input: { count: 5 }, progress: 0, error: null });
      const redis = { cacheDelete: async () => {} };
      const problems = Object.create(ProblemService.prototype);
      Object.assign(problems, { connection: db, problemRepository: db.getRepository(ProblemEntity),
        problemJudgeInfoRepository: db.getRepository(ProblemJudgeInfoEntity), problemSampleRepository: db.getRepository(ProblemSampleEntity),
        problemTagMapRepository: db.getRepository(ProblemTagMapEntity), redisService: redis,
        localizedContentService: new LocalizedContentService(db.getRepository(LocalizedContentEntity), redis),
        problemTypeFactoryService: { type: () => ({ validateAndFilterJudgeInfo: () => {} }) }, getProblemFiles: async () => [] });
      const privileges = { userHasPrivilege: async () => true, permissionDecision: async () => true };
      problems.userPrivilegeService = privileges;
      problems.configService = { config: { preference: { security: { allowNonPrivilegedUserEditPublicProblem: false } } } };
      const service = new AiService(db, {}, db.getRepository(AiJobEntity), privileges, problems, {}, {});
      service.editable = async (_user, id) => problems.findProblemById(id);
      service.recordAiAudit = async () => {};
      const snapshot = await service.snapshot(problem);
      const read = async () => (await db.getRepository(ProblemJudgeInfoEntity).findOneBy({ problemId: problem.id })).judgeInfo;
      const publish = () => problems.updateProblemJudgeInfo(problem, generated(), true, true,
        (manager, currentProblem) => service.authorizeTestdataCommit(job, snapshot, manager, currentProblem));
      return { user, problem, job, service, problems, snapshot, read, publish };
    }
    function pauseBeforeSave(f) {
      const entered = deferred(), released = deferred();
      f.problems.connection = { transaction: (isolation, callback) => db.transaction(isolation, async manager => {
        const save = manager.save.bind(manager);
        manager.save = async (...args) => { entered.resolve(); await released.promise; return save(...args); };
        return callback(manager);
      }) };
      return { entered, released };
    }
    for (const mode of ["cancel", "manual-edit"]) await t.test(`actual runJob/testdata final save rejects the ${mode} race`, async () => {
      const f = await fixture();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyhoj-ai-commit-wiring-"));
      const previousDirectory = process.env.HYHOJ_AI_GENERATED_DIR;
      process.env.HYHOJ_AI_GENERATED_DIR = root;
      const directory = path.join(root, f.job.id); fs.mkdirSync(directory);
      f.job.state = { completed: [], plan: { subtasks: [{ id: 1, points: 100 }], needsSpj: false,
        timeLimitMs: 1000, memoryLimitMiB: 128, fileIo: null }, makeCode: "int main(){}", stdCode: "int main(){}",
        validatorCode: "int main(){}", testdataSnapshotHash: f.service.testdataFingerprint(f.snapshot) };
      await db.getRepository(AiJobEntity).update({ id: f.job.id }, { state: f.job.state });
      f.service.readExistingAiHelpers = async () => ({});
      f.service.runSandbox = async () => {
        const files = [];
        for (let i = 1; i <= 5; i++) for (const extension of ["in", "out"]) {
          const name = `${i}.${extension}`; fs.writeFileSync(path.join(directory, name), "1\n"); files.push(name);
        }
        return { directory, files, validation: { samplesPassed: 0, inputsPassed: 5, sampleInputsPassed: 0 } };
      };
      f.service.putFile = async () => {};
      f.service.cleanupSandbox = async () => {};
      f.service.execute = () => f.service.testdata(f.job, f.user, f.problem, {}, f.snapshot, 0, 100);
      f.problems.getProblemFiles = async () => {
        if (mode === "cancel") await f.service.cancel(f.user, f.job.id);
        else await db.getRepository(ProblemJudgeInfoEntity).update({ problemId: f.problem.id },
          { judgeInfo: { ...original(), memoryLimit: 777 } });
        return [];
      };
      try {
        await f.service.runJob(f.job);
        const stored = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
        assert.equal(stored.status, mode === "cancel" ? "cancelled" : "failed");
        if (mode === "manual-edit") assert.match(stored.error, /PROBLEM_CHANGED_DURING_AI/);
        assert.equal((await f.read()).memoryLimit, mode === "cancel" ? 128 : 777);
        assert.equal((await f.read()).subtasks.length, 0);
      } finally {
        if (previousDirectory === undefined) delete process.env.HYHOJ_AI_GENERATED_DIR;
        else process.env.HYHOJ_AI_GENERATED_DIR = previousDirectory;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    await t.test("cancel returns during file validation, then publication cannot activate", async () => {
      const f = await fixture(); let cancelled = false;
      f.problems.getProblemFiles = async () => { await f.service.cancel(f.user, f.job.id); cancelled = true; return []; };
      await assert.rejects(f.publish(), /JOB_CANCELLED/);
      assert(cancelled); assert.deepEqual(await f.read(), original());
      assert.equal((await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id })).status, "cancelled");
    });
    await t.test("a human memory-limit edit committed during validation survives the old AI snapshot", async () => {
      const f = await fixture();
      f.problems.getProblemFiles = async () => {
        await db.getRepository(ProblemJudgeInfoEntity).update({ problemId: f.problem.id }, { judgeInfo: { ...original(), memoryLimit: 777 } });
        return [];
      };
      await assert.rejects(f.publish(), /PROBLEM_CHANGED_DURING_AI/);
      assert.equal((await f.read()).memoryLimit, 777); assert.equal((await f.read()).subtasks.length, 0);
    });
    await t.test("human changes to the submission-enabled flag cannot be overwritten by AI activation", async () => {
      const f = await fixture();
      await db.getRepository(ProblemJudgeInfoEntity).update({ problemId: f.problem.id }, { submittable: true });
      f.snapshot.submittable = true;
      f.problems.getProblemFiles = async () => {
        await db.getRepository(ProblemJudgeInfoEntity).update({ problemId: f.problem.id }, { submittable: false });
        return [];
      };
      await assert.rejects(f.publish(), /PROBLEM_CHANGED_DURING_AI/);
      assert.deepEqual(await f.read(), original());
      assert.equal((await db.getRepository(ProblemJudgeInfoEntity).findOneBy({ problemId: f.problem.id })).submittable, false);
    });
    await t.test("a human statement edit committed during validation invalidates the complete snapshot", async () => {
      const f = await fixture();
      f.problems.getProblemFiles = async () => {
        await f.problems.updateProblemStatement(f.problem, { localizedContents: [
          { locale: "zh_CN", title: "Human title", contentSections: [] } ], samples: [] }, []);
        return [];
      };
      await assert.rejects(f.publish(), /PROBLEM_CHANGED_DURING_AI/); assert.deepEqual(await f.read(), original());
      assert.equal((await f.problems.getProblemAllLocalizedContents(f.problem))[0].title, "Human title");
    });
    await t.test("a replaced worker lease cannot activate a prepared generation", async () => {
      const f = await fixture();
      f.problems.getProblemFiles = async () => { await db.getRepository(AiJobEntity).update({ id: f.job.id }, { runToken: crypto.randomUUID() }); return []; };
      await assert.rejects(f.publish(), /JOB_LEASE_LOST/); assert.deepEqual(await f.read(), original());
    });
    await t.test("an unchanged running job can activate all generated testcases", async () => {
      const f = await fixture(); assert.equal(await f.publish(), null); assert.deepEqual(await f.read(), generated());
    });
    await t.test("cancel waits when publication already holds the job lock and cannot return ahead of commit", async () => {
      const f = await fixture(), gate = pauseBeforeSave(f);
      const publication = f.publish(); await gate.entered.promise;
      let cancelReturned = false;
      const cancellation = f.service.cancel(f.user, f.job.id).then(() => { cancelReturned = true; });
      await pause(75); assert.equal(cancelReturned, false); assert.deepEqual(await f.read(), original());
      gate.released.resolve(); await publication; await cancellation;
      assert.deepEqual(await f.read(), generated());
      assert.equal((await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id })).status, "cancelled");
    });
    await t.test("a human judge-info edit waiting on publication commits afterwards and retains its memory limit", async () => {
      const f = await fixture(), gate = pauseBeforeSave(f);
      const publication = f.publish(); await gate.entered.promise;
      let edited = false;
      const edit = db.getRepository(ProblemJudgeInfoEntity).update({ problemId: f.problem.id },
        { judgeInfo: { ...original(), memoryLimit: 777 } }).then(() => { edited = true; });
      await pause(75); assert.equal(edited, false);
      gate.released.resolve(); await publication; await edit; assert.equal((await f.read()).memoryLimit, 777);
    });
    await t.test("a human translation inserted after the snapshot read waits for the publication transaction", async () => {
      const f = await fixture(), gate = pauseBeforeSave(f);
      const publication = f.publish(); await gate.entered.promise;
      let inserted = false;
      const insert = db.transaction(async manager => {
        await manager.save(LocalizedContentEntity, [
          { objectId: f.problem.id, type: LocalizedContentType.ProblemTitle, locale: "en_US", data: "Human translation" },
          { objectId: f.problem.id, type: LocalizedContentType.ProblemContent, locale: "en_US", data: "[]" }
        ]);
      }).then(() => { inserted = true; });
      await pause(75); assert.equal(inserted, false);
      gate.released.resolve(); await publication; await insert;
      assert.equal((await f.problems.getProblemAllLocalizedContents(f.problem)).find(x => x.locale === "en_US").title, "Human translation");
    });
  } finally {
    if (initialized) {
      for (const [, name] of definitions.slice().reverse()) await db.query(`DROP TABLE IF EXISTS \`${prefix + name}\``);
      await db.destroy();
    }
  }
});
