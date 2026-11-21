const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const ts = require("typescript");
const { redisAvailable, startRedis } = require("../../test/temporary-redis.cjs");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );

const { DataSource } = require("typeorm");
const { bareProblemServices } = require("./problem-test-services.cjs");
const { ProblemEntity, ProblemType } = require("./problem.entity.ts");
const { ProblemDataVersionEntity } = require("./problem-data-version.entity.ts");
const { ProblemDataVersionService } = require("./problem-data-version.service.ts");
const { ProblemFileEntity, ProblemFileType } = require("./problem-file.entity.ts");
const { ProblemJudgeInfoEntity } = require("./problem-judge-info.entity.ts");
const { JUDGE_INFO_CACHE_SECONDS, preprocessedJudgeInfoCacheKey } = require("./problem-judge-info-cache.ts");
const { ProblemSampleEntity } = require("./problem-sample.entity.ts");
const { ProblemTypeFactoryService } = require("../problem-type/problem-type-factory.service.ts");
const { ProblemTypeTraditionalService } = require("../problem-type/types/traditional/problem-type.service.ts");
const { ProblemTypeSubmitAnswerService } = require("../problem-type/types/submit-answer/problem-type.service.ts");
const { ProblemTypeInteractionService } = require("../problem-type/types/interaction/problem-type.service.ts");
const { ProblemTypeCommunicationService } = require("../problem-type/types/communication/problem-type.service.ts");
const { GenerationCache } = require("../redis/generation-cache.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { UserAuthEntity } = require("../auth/user-auth.entity.ts");
const { SubmissionEntity } = require("../submission/submission.entity.ts");
const { SubmissionDetailEntity } = require("../submission/submission-detail.entity.ts");
const { SubmissionService } = require("../submission/submission.service.ts");
const { FileEntity } = require("../file/file.entity.ts");
const { FileService } = require("../file/file.service.ts");

const configPath = process.env.LLMOJ_JUDGE_INFO_CACHE_TEST_DB_CONFIG;
const json = value => JSON.parse(JSON.stringify(value));

test(
  "problem judge info cache and pinned versions (real MariaDB and Redis)",
  {
    skip: (!configPath && "needs LLMOJ_JUDGE_INFO_CACHE_TEST_DB_CONFIG") || (!redisAvailable && "needs redis-server"),
    timeout: 90000
  },
  async t => {
    const redis = await startRedis(t);
    // Parents first so cleanup can drop just this run's tables in reverse foreign key order.
    const entities = [
      UserEntity,
      UserAuthEntity,
      FileEntity,
      ProblemEntity,
      ProblemSampleEntity,
      ProblemJudgeInfoEntity,
      ProblemFileEntity,
      ProblemDataVersionEntity,
      SubmissionEntity,
      SubmissionDetailEntity
    ];
    const prefix = `jic_${crypto.randomBytes(6).toString("hex")}_`;
    const db = new DataSource({
      ...require("js-yaml").load(fs.readFileSync(configPath, "utf8")).services.database,
      entityPrefix: prefix,
      entities,
      dropSchema: false,
      synchronize: false,
      migrationsRun: false,
      logging: false
    });
    await db.initialize();
    t.after(async () => {
      try {
        for (const entity of [...entities].reverse()) {
          const name = db.getMetadata(entity).tableName;
          assert.ok(name.startsWith(prefix));
          await db.query(`DROP TABLE IF EXISTS \`${name}\``);
        }
      } finally {
        await db.destroy();
      }
    });
    await db.synchronize();
    const config = {
      config: { resourceLimit: { problemTimeLimit: 1800, problemMemoryLimit: 256, problemSamplesToRun: 1 } }
    };
    const interaction = new ProblemTypeInteractionService(config, {});
    const factory = new ProblemTypeFactoryService(
      new ProblemTypeTraditionalService(config, {}),
      interaction,
      new ProblemTypeCommunicationService(interaction),
      new ProblemTypeSubmitAnswerService(config, {})
    );
    const defaults = type => factory.type(type).getDefaultJudgeInfo();
    const repo = entity => db.getRepository(entity);
    const harness = bareProblemServices();
    Object.assign(harness, {
      connection: db,
      problemRepository: repo(ProblemEntity),
      problemJudgeInfoRepository: repo(ProblemJudgeInfoEntity),
      problemSampleRepository: repo(ProblemSampleEntity),
      problemFileRepository: repo(ProblemFileEntity),
      problemTypeFactoryService: factory,
      submissionService: Object.assign(Object.create(SubmissionService.prototype), {
        submissionRepository: repo(SubmissionEntity)
      }),
      redisService: { generationCache: new GenerationCache(redis) }
    });
    const { problemService: service, problemFiles } = harness.services;
    const versions = new ProblemDataVersionService(
      repo(ProblemDataVersionEntity),
      service,
      problemFiles,
      Object.assign(Object.create(FileService.prototype), { fileRepository: repo(FileEntity) }),
      config
    );
    const owner = await repo(UserEntity).save({
      username: "cache-owner",
      email: "cache-owner@example.test",
      nickname: "",
      bio: "",
      avatarInfo: "",
      isAdmin: false,
      acceptedProblemCount: 0,
      submissionCount: 0,
      rating: 0,
      publicEmail: false
    });
    const samples = [{ inputData: "9 12", outputData: "21" }];
    async function fixture(submittable, judgeInfo = defaults(ProblemType.Traditional)) {
      const p = await repo(ProblemEntity).save({
        type: ProblemType.Traditional,
        ownerId: owner.id,
        isPublic: false,
        locales: ["en_US"],
        submissionCount: 0,
        acceptedSubmissionCount: 0
      });
      await repo(ProblemSampleEntity).insert({ problemId: p.id, data: samples });
      await repo(ProblemJudgeInfoEntity).insert({ problemId: p.id, judgeInfo, submittable });
      for (const filename of ["case7.in", "case7.out"]) {
        const uuid = crypto.randomUUID();
        await repo(FileEntity).insert({ uuid, size: 1, uploadTime: new Date() });
        await repo(ProblemFileEntity).insert({ problemId: p.id, type: ProblemFileType.TestData, filename, uuid });
      }
      return p;
    }
    // A second read must be an actual Redis hit.
    const cacheOnly = Object.assign(Object.create(service), {
      getProblemJudgeInfo() {
        assert.fail("warm judge info required another SQL read");
      }
    });
    async function assertSettings(p, type, raw, submittable) {
      const current = await service.findProblemById(p.id);
      assert.equal(current.type, type);
      assert.deepEqual(await service.getProblemJudgeInfo(current), [raw, submittable]);
      const files = await problemFiles.getProblemFiles(current, ProblemFileType.TestData);
      const prepared = json(factory.type(type).preprocessJudgeInfo(raw, files));
      assert.deepEqual(json(await service.getProblemPreprocessedJudgeInfo(current)), [prepared, submittable]);
      assert.deepEqual(await cacheOnly.getProblemPreprocessedJudgeInfo(current), [prepared, submittable]);
      const ttl = await redis.ttl(preprocessedJudgeInfoCacheKey(p.id));
      assert.ok(ttl > 0 && ttl <= JUDGE_INFO_CACHE_SECONDS);
      const version = await versions.current(current);
      const stored = await versions.findById(version.id);
      assert.equal(stored.problemType, type);
      assert.deepEqual(stored.judgeInfo, prepared);
      assert.deepEqual(
        stored.testData,
        files.map(({ filename, uuid }) => ({ filename, uuid })).sort((a, b) => a.filename.localeCompare(b.filename))
      );
      assert.deepEqual(stored.samples, raw.runSamples ? samples : null);
      return stored.id;
    }

    for (const submittable of [true, false]) {
      await t.test(
        `raw, cached and pinned settings agree through all four types with submittable=${submittable}`,
        async () => {
          const p = await fixture(submittable);
          // This is the exact unversioned key and JSON tuple written by a pre-upgrade backend.
          await redis.set(
            `problem-preprocessed-judge-info-and-submittable:${p.id}`,
            JSON.stringify([{ retired: true }, !submittable])
          );
          const initial = await assertSettings(
            p,
            ProblemType.Traditional,
            defaults(ProblemType.Traditional),
            submittable
          );
          for (const type of [
            ProblemType.Interaction,
            ProblemType.SubmitAnswer,
            ProblemType.Communication,
            ProblemType.Traditional
          ]) {
            assert.equal(await service.changeProblemType(p, type), true);
            const id = await assertSettings(p, type, defaults(type), submittable);
            if (type === ProblemType.Traditional)
              assert.equal(id, initial, "returning to equal content reuses the pinned version");
          }
        }
      );
    }

    await t.test("a SQL reader paused across conversion and back cannot refill the current type", async () => {
      const type = ProblemType.Traditional;
      const oldRaw = { ...defaults(type), timeLimit: 733 };
      const p = await fixture(true, oldRaw);
      const selected = Promise.withResolvers();
      const release = Promise.withResolvers();
      const slowReader = Object.assign(Object.create(service), {
        async getProblemJudgeInfo(problem) {
          const row = await service.getProblemJudgeInfo(problem);
          selected.resolve();
          await release.promise;
          return row;
        }
      });
      const oldRead = slowReader.getProblemPreprocessedJudgeInfo(await service.findProblemById(p.id));
      let oldTuple;
      try {
        await Promise.race([selected.promise, oldRead.then(() => assert.fail("expected a cache miss"))]);
        const next = ProblemType.SubmitAnswer;
        assert.equal(await service.changeProblemType(p, next), true);
        await assertSettings(p, next, defaults(next), true);
        assert.equal(await service.changeProblemType(p, type), true);
      } finally {
        release.resolve();
        oldTuple = await oldRead;
      }
      assert.equal(oldTuple[0].timeLimit, oldRaw.timeLimit, "reader had already fetched the pre-conversion row");
      await assertSettings(p, type, defaults(type), true);
    });

    await t.test(
      "an existing submission prevents conversion and a same-type settings edit replaces the warm value",
      async () => {
        const type = ProblemType.Traditional;
        const raw = defaults(type);
        const p = await fixture(true, raw);
        await assertSettings(p, type, raw, true);
        await repo(SubmissionEntity).insert({
          problemId: p.id,
          submitterId: owner.id,
          isPublic: false,
          status: "Pending",
          submitTime: new Date()
        });
        assert.equal(await service.changeProblemType(p, ProblemType.Interaction), false);
        await assertSettings(p, type, raw, true);
        const edited = { ...raw, memoryLimit: 96 };
        assert.equal(await service.updateProblemJudgeInfo(p, edited, false, false), null);
        await assertSettings(p, type, edited, false);
      }
    );

    await t.test("a rolled back conversion leaves the current type and its warm generation intact", async () => {
      const type = ProblemType.Traditional;
      const raw = defaults(type);
      const p = await fixture(false, raw);
      const version = await assertSettings(p, type, raw, false);
      const failing = Object.assign(Object.create(service), {
        connection: {
          transaction: (level, change) =>
            db.transaction(level, async manager => {
              await change(manager);
              throw new Error("rollback conversion");
            })
        }
      });
      await assert.rejects(failing.changeProblemType(p, ProblemType.Communication), /rollback conversion/);
      assert.equal(p.type, type);
      await cacheOnly.getProblemPreprocessedJudgeInfo(p);
      assert.equal(await assertSettings(p, type, raw, false), version);
    });
  }
);
