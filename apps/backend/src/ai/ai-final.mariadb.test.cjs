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
const { ProblemTagEntity } = backendRequire("../problem/problem-tag.entity.ts");
const { ProblemFileEntity, ProblemFileType } = backendRequire("../problem/problem-file.entity.ts");
const { FileEntity } = backendRequire("../file/file.entity.ts");
const { DiscussionService } = backendRequire("../discussion/discussion.service.ts");
const { DiscussionEntity } = backendRequire("../discussion/discussion.entity.ts");
const { DiscussionContentEntity } = backendRequire("../discussion/discussion-content.entity.ts");
const sourceSearch = backendRequire("./ai-source-search.ts");
const { signAiAttachment } = backendRequire("./ai-attachment.ts");
const { AiService } = backendRequire("./ai.service.ts");
const { AiResponseCheckpointEntity } = backendRequire("./ai-usage.entity.ts");
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
  "AI final recovery and transactional guard regression (real MariaDB)",
  { skip: !process.env.HYHOJ_AI_TEST_DB_CONFIG, timeout: 180000 },
  async t => {
    const config = backendRequire("js-yaml").load(fs.readFileSync(process.env.HYHOJ_AI_TEST_DB_CONFIG, "utf8")).services
      .database;
    const prefix = `qa_ai_finalfix_${crypto.randomBytes(8).toString("hex")}_`;
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
          originalProblemTitle: {...text, default: ""},
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
      [ProblemTagEntity, "tag", {id: {...integer, primary: true, generated: true}, color: text, locales: json}],
      [DiscussionEntity, "discussion", {id: {...integer, primary: true, generated: true}, title: text,
        publishTime: {type: Date}, sortTime: {type: Date}, replyCount: integer, isPublic: {type: Boolean},
        publisherId: integer, problemId: integer}],
      [DiscussionContentEntity, "discussion_content", {discussionId: {...integer, primary: true}, content: {type: "text"}}],
      [ProblemFileEntity, "problem_file", {problemId: {...integer, primary: true}, type: {...text, primary: true},
        filename: {...text, primary: true}, uuid: text}],
      [FileEntity, "file", {id: {...integer, primary: true, generated: true}, uuid: {...text, unique: true},
        size: integer, uploadTime: {type: Date}}],
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
    definitions.push([AiResponseCheckpointEntity, "response", {ownerId: {...integer, primary: true}, jobId: {...text, primary: true}, requestHash: {...text, primary: true}, responseId: text, createdAt: {type: Date, nullable: true}}]);
    const entities = definitions.map(
      ([target, name, columns]) => new EntitySchema({ name: target.name, target, tableName: prefix + name, columns, ...(target === ProblemTagMapEntity ? {indices:[{columns:["problemId","problemTagId"],unique:true},{columns:["problemId"]},{columns:["problemTagId"]}]} : {}) })
    );
    const db = new DataSource({ ...config, entities, synchronize: true, logging: false });
    let initialized = false;
    try {
      await db.initialize();
      initialized = true;
      let problemId = 0;
      async function fixture() {
        const user = await db.getRepository(UserEntity).save(db.getRepository(UserEntity).create({ id: 99, isAdmin: false }));
        await db.getRepository(UserPermissionRuleEntity).delete({ userId: 99 });
        await db
          .getRepository(UserPermissionRuleEntity)
          .save(
            ["UseAi", "GenerateTestdata", "EditProblemData", "ImportProblem", "CreateProblem", "ViewProblem", "ManageProblemTags", "CreateDiscussion"].map(
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
          { objectId: problem.id, type: LocalizedContentType.ProblemContent, locale: "zh_CN", data: JSON.stringify([{type:"Text",sectionTitle:"Description",text:"Output the input integer."}]) }
        ]);
        const job = await db.getRepository(AiJobEntity).save({
          id: crypto.randomUUID(),
          ownerId: user.id,
          problemId: problem.id,
          action: "testdata",
          status: "running",
          step: "testdata",
          runToken: crypto.randomUUID(),
          state: {completed: []},
          input: { count: 5 },
          progress: 0,
          error: null
        });
        const cache = new Map();
        const redis = {cacheDelete: async key => cache.delete(key), cacheGet: async key => cache.get(key), cacheSet: async (key, value) => cache.set(key, value)};
        const problems = Object.create(ProblemService.prototype);
        Object.assign(problems, {
          connection: db,
          problemRepository: db.getRepository(ProblemEntity),
          problemJudgeInfoRepository: db.getRepository(ProblemJudgeInfoEntity),
          problemSampleRepository: db.getRepository(ProblemSampleEntity),
          problemTagMapRepository: db.getRepository(ProblemTagMapEntity),
          problemTagRepository: db.getRepository(ProblemTagEntity),
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
              security: { allowEveryoneCreateProblem: true, allowNonPrivilegedUserEditPublicProblem: false, allowEveryoneCreateDiscussion: true, discussionDefaultPublic: true }
            }, resourceLimit: {problemTestdataFiles: 100, problemTestdataSize: 100000,
              problemAdditionalFileFiles: 100, problemAdditionalFileSize: 100000}
          }
        };
        problems.permissionService = new PermissionService(
          db,
          db.getRepository(PermissionForUserEntity),
          db.getRepository(PermissionForGroupEntity),
          { getGroupIdsByUserId: async () => [] }
        );
        const discussions = Object.create(DiscussionService.prototype);
        Object.assign(discussions, {connection: db, configService: problems.configService, userPrivilegeService: privileges});
        const uploaded = new Map(), removed = [];
        const files = {
          uploadFile: async (uuid, input) => {const chunks=[]; for await (const chunk of input) chunks.push(chunk); uploaded.set(uuid, Buffer.concat(chunks));},
          getFileSizes: async (uuids, manager) => Promise.all(uuids.map(async uuid => (await manager.findOneBy(FileEntity, {uuid})).size)),
          deleteUnfinishedUploadedFile: uuid => {uploaded.delete(uuid); removed.push(uuid);}
        };
        problems.fileService = files;
        problems.lockManageProblemFile = async (_id, _type, callback) => callback(await db.getRepository(ProblemEntity).findOneBy({id: problem.id}));
        const service = new AiService(db, {}, db.getRepository(AiJobEntity), privileges, problems, discussions, files);
        service.recordAiAudit = async () => {};
        const snapshot = await service.snapshot(problem);
        const read = async () =>
          (await db.getRepository(ProblemJudgeInfoEntity).findOneBy({ problemId: problem.id })).judgeInfo;
        const publish = () =>
          problems.updateProblemJudgeInfo(problem, generated(), true, true, (manager, currentProblem) =>
            service.authorizeTestdataCommit(job, snapshot, manager, currentProblem)
          );
        return { user, problem, job, service, problems, discussions, files, uploaded, removed, cache, snapshot, read, publish };
      }
      async function actionFixture(action, mode) {
        const f = await fixture();
        f.job.action = action; f.job.step = action;
        await db.getRepository(AiJobEntity).update({id: f.job.id}, {action, step: action});
        if (mode === 'object-ACL') {
          f.problem.ownerId = 200;
          await db.getRepository(ProblemEntity).update({id: f.problem.id}, {ownerId: 200});
          await db.getRepository(PermissionForUserEntity).save({userId: 99, objectId: f.problem.id,
            objectType: PermissionObjectType.Problem, permissionLevel: 2});
        }
        f.snapshot = await f.service.snapshot(f.problem);
        return f;
      }
      async function invalidate(f, mode, timeline) {
        if (mode === 'cancel') await f.service.cancel(f.user, f.job.id);
        else if (mode === 'lease') await db.getRepository(AiJobEntity).update({id: f.job.id}, {runToken: crypto.randomUUID()});
        else if (mode === 'object-ACL') await db.getRepository(PermissionForUserEntity).delete({userId: 99,
          objectId: f.problem.id, objectType: PermissionObjectType.Problem});
        else if (mode === 'human-edit') {
          const p = await db.getRepository(ProblemEntity).findOneBy({id: f.problem.id});
          await f.problems.updateProblemStatement(p, {problemId: p.id, localizedContents: [
            {locale: 'zh_CN', title: 'Human updated title', contentSections: []}
          ], samples: [], problemTagIds: []}, []);
        } else if (mode === 'source-title') await db.getRepository(ProblemEntity).update({id: f.problem.id}, {originalProblemTitle: 'Human source title'});
        else await db.getRepository(UserPermissionRuleEntity).save({userId: 99, permission: mode, allowed: false});
        timeline.push(`${mode} invalidation committed before publication write`);
      }
      // Delay entry into the real transaction, after the product's last external
      // assertion. The SQL callback, locking guard and business writes are unchanged.
      function interceptTransactions(target, field, before) {
        const wrapped = Object.create(db);
        wrapped.transaction = async (...args) => {
          await before();
          return db.transaction(...args);
        };
        target[field] = wrapped;
      }
      async function editToSquare(f) {
        const p = await db.getRepository(ProblemEntity).findOneBy({ id: f.problem.id });
        await f.problems.updateProblemStatement(p, {
          problemId: p.id, localizedContents: [{ locale: 'zh_CN', title: 'Human changed task to square',
            contentSections: [{ type: 'Text', sectionTitle: 'Description', text: 'Output the square of the input integer.' }] }],
          samples: [], problemTagIds: []
        }, []);
      }
      async function retryAndRun(f) {
        f.service.work = async () => {};
        await f.service.retry(f.user, f.job.id);
        const job = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
        assert.equal(job.status, 'queued');
        job.status = 'running'; job.runToken = crypto.randomUUID();
        await db.getRepository(AiJobEntity).update({ id: job.id }, { status: job.status, runToken: job.runToken });
        const problem = await db.getRepository(ProblemEntity).findOneBy({ id: f.problem.id });
        const snapshot = await f.service.snapshot(problem);
        f.service.execute = () => f.service.edit(job, f.user, problem, { llm: {}, search: {} }, snapshot, 'tutorial');
        await f.service.runJob(job);
        return db.getRepository(AiJobEntity).findOneBy({ id: job.id });
      }
      await t.test('tutorial conflict retry regenerates content for the actual new statement', async () => {
        const f = await actionFixture('tutorial', 'success'); let modelCalls = 0, injected = false;
        f.service.model = async (_config, prompt) => {
          modelCalls++;
          return prompt.includes('Output the square')
            ? { zh_CN: '新题：输出平方。', en_US: 'New task: output the square.' }
            : { zh_CN: '原题：原样输出。', en_US: 'Old task: print unchanged.' };
        };
        interceptTransactions(f.discussions, 'connection', async () => {
          if (injected) return; injected = true; await editToSquare(f);
        });
        f.service.execute = () => f.service.edit(f.job, f.user, f.problem, { llm: {}, search: {} }, f.snapshot, 'tutorial');
        await f.service.runJob(f.job);
        const failed = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
        assert.equal(failed.error, 'PROBLEM_CHANGED_DURING_AI');
        assert.equal(await db.getRepository(DiscussionEntity).countBy({ problemId: f.problem.id }), 0);
        assert.equal(failed.state.tutorialSnapshotHash, f.service.problemSnapshotFingerprint(f.snapshot));
        const retryState = f.service.retryState(failed);
        assert.equal(retryState.tutorialContents, undefined); assert.equal(retryState.tutorialSnapshotHash, undefined);
        const completed = await retryAndRun(f);
        const discussions = await db.getRepository(DiscussionEntity).findBy({ problemId: f.problem.id });
        const contents = await Promise.all(discussions.map(d => db.getRepository(DiscussionContentEntity).findOneBy({ discussionId: d.id })));
        assert.equal(completed.status, 'completed'); assert.equal(modelCalls, 2); assert.equal(contents.length, 2);
        assert(contents.some(x => x.content === 'New task: output the square.'));
        assert(contents.every(x => !x.content.includes('Old task') && !x.content.includes('原题')));
        evidence.push({ finding: 'FINAL-AI-01', scenario: 'unpublished conflict retry', modelCalls,
          firstError: failed.error, finalStatus: completed.status, contents });
      });
      for (const mode of ['changed', 'unchanged', 'legacy']) await t.test(`partial tutorial recovery ${mode}`, async () => {
        const f = await actionFixture('tutorial', 'success'); let modelCalls = 0, transactions = 0;
        f.service.model = async () => { modelCalls++; return { zh_CN: '原题：原样输出。', en_US: 'Old task: print unchanged.' }; };
        interceptTransactions(f.discussions, 'connection', async () => {
          if (++transactions !== 2) return;
          if (mode === 'changed') await editToSquare(f);
          else throw new Error('SYNTHETIC_INTERRUPTION_BEFORE_SECOND_DISCUSSION');
        });
        f.service.execute = () => f.service.edit(f.job, f.user, f.problem, { llm: {}, search: {} }, f.snapshot, 'tutorial');
        await f.service.runJob(f.job);
        let failed = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
        assert.equal(failed.status, 'failed'); assert(failed.state.discussionIds.zh_CN);
        assert.equal(await db.getRepository(DiscussionEntity).countBy({ problemId: f.problem.id }), 1);
        if (mode === 'legacy') {
          delete failed.state.tutorialSnapshotHash;
          await db.getRepository(AiJobEntity).update({ id: f.job.id }, { state: failed.state });
        }
        const result = await retryAndRun(f);
        const count = await db.getRepository(DiscussionEntity).countBy({ problemId: f.problem.id });
        assert.equal(modelCalls, 1);
        if (mode === 'unchanged') { assert.equal(result.status, 'completed'); assert.equal(count, 2); }
        else { assert.equal(result.status, 'failed'); assert.equal(result.error, 'PROBLEM_CHANGED_DURING_AI'); assert.equal(count, 1); }
        evidence.push({ finding: 'FINAL-AI-01', scenario: `partial ${mode}`, modelCalls, finalStatus: result.status,
          error: result.error, discussionCount: count });
      });
      await t.test('unknown legacy unpublished tutorial cache is regenerated', async () => {
        const f = await actionFixture('tutorial', 'success'); let modelCalls = 0;
        f.job.state.tutorialContents = { zh_CN: '未知旧题', en_US: 'Unknown legacy task' };
        f.service.model = async () => { modelCalls++; return { zh_CN: '原样输出', en_US: 'Print unchanged.' }; };
        f.service.execute = () => f.service.edit(f.job, f.user, f.problem, { llm: {}, search: {} }, f.snapshot, 'tutorial');
        await f.service.runJob(f.job);
        const row = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
        assert.equal(row.status, 'completed'); assert.equal(modelCalls, 1);
        assert.equal(row.state.tutorialSnapshotHash, f.service.problemSnapshotFingerprint(f.snapshot));
        evidence.push({ finding: 'FINAL-AI-01', scenario: 'legacy unpublished', finalStatus: row.status, modelCalls });
      });
      for (const mode of ['success', 'cancel', 'UseAi', 'GenerateTestdata', 'EditProblemData', 'object-ACL', 'lease', 'human-edit', 'source-title'])
        await t.test(`public header invalidation before registration transaction: ${mode}`, async () => {
          const f = await actionFixture('testdata', mode); const timeline = [];
          f.job.state.protocolExtraSourceFiles = { 'communication.h': '#pragma once\nint Alice(int);\n' };
          f.job.state.protocolPublicHeaderNames = ['communication.h'];
          f.problem.type = 'Communication'; await db.getRepository(ProblemEntity).update({ id: f.problem.id }, { type: 'Communication' });
          f.snapshot = await f.service.snapshot(f.problem);
          let injected = false;
          interceptTransactions(f.problems, 'connection', async () => {
            if (injected) return; injected = true;
            if (mode !== 'success') await invalidate(f, mode, timeline);
          });
          const oldRoot = process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR;
          const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-final-headers-')); process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR = root;
          try {
            f.service.execute = () => f.service.publishProtocolHeaders(f.job, f.problem, f.snapshot);
            await f.service.runJob(f.job);
            const row = await db.getRepository(AiJobEntity).findOneBy({ id: f.job.id });
            const registered = await db.getRepository(ProblemFileEntity).findBy({ problemId: f.problem.id, type: ProblemFileType.AdditionalFile });
            assert(injected); assert.equal(registered.length, mode === 'success' ? 1 : 0);
            assert.equal(f.uploaded.size, mode === 'success' ? 1 : 0);
            if (mode === 'success') assert.equal(row.status, 'completed');
            else if (mode === 'cancel') assert.equal(row.status, 'cancelled');
            else if (mode === 'lease') assert.equal(row.status, 'running');
            else { assert.equal(row.status, 'failed'); assert.equal(row.error,
              ['human-edit', 'source-title'].includes(mode) ? 'PROBLEM_CHANGED_DURING_AI' : 'PERMISSION_DENIED'); }
            assert.equal(await db.getRepository(FileEntity).countBy({ uuid: [...f.uploaded.keys()][0] || 'missing' }), mode === 'success' ? 1 : 0);
            evidence.push({ finding: 'FINAL-AI-02', scenario: 'before commit', mode, registeredFiles: registered.map(x => x.filename),
              uploadedObjects: f.uploaded.size, cleanedUploads: f.removed.length, jobStatus: row.status, error: row.error, timeline });
          } finally { if (oldRoot === undefined) delete process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR;
            else process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR = oldRoot; fs.rmSync(root, { recursive: true, force: true }); }
        });
      for (const mode of ['cancel', 'UseAi', 'object-ACL', 'lease', 'human-edit'])
        await t.test(`public header guard holds commit locks until registration finishes: ${mode}`, async () => {
          const f = await actionFixture('testdata', mode); const timeline = []; let mutation, mutationDone = false;
          f.job.state.protocolExtraSourceFiles = { 'communication.h': '#pragma once\nint Alice(int);\n' };
          f.job.state.protocolPublicHeaderNames = ['communication.h'];
          f.problem.type = 'Communication'; await db.getRepository(ProblemEntity).update({ id: f.problem.id }, { type: 'Communication' });
          f.snapshot = await f.service.snapshot(f.problem);
          const add = f.problems.addProblemFilesFromDisk.bind(f.problems);
          f.problems.addProblemFilesFromDisk = (p, type, files, options) => {
            assert.equal(typeof options.authorizeCommit, 'function');
            return add(p, type, files, { ...options, noLimit: async manager => {
              assert(manager); const result = await options.noLimit(manager);
              mutation = invalidate(f, mode, timeline).then(() => { mutationDone = true; });
              await pause(75); assert.equal(mutationDone, false, 'invalidation must wait for the authorized file commit');
              timeline.push('concurrent invalidation blocked while final guard and inserts share transaction');
              return result;
            } });
          };
          const oldRoot = process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR;
          const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-final-header-locks-')); process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR = root;
          try {
            await f.service.publishProtocolHeaders(f.job, f.problem, f.snapshot);
            await mutation; assert(mutationDone);
            const registered = await db.getRepository(ProblemFileEntity).findBy({ problemId: f.problem.id, type: ProblemFileType.AdditionalFile });
            assert.equal(registered.length, 1); assert.equal(f.uploaded.size, 1);
            await assert.rejects(f.service.assertSnapshot(f.job, f.snapshot),
              mode === 'cancel' ? /JOB_CANCELLED/ : mode === 'lease' ? /JOB_LEASE_LOST/ : mode === 'human-edit' ? /PROBLEM_CHANGED_DURING_AI/ : /PERMISSION_DENIED/);
            evidence.push({ finding: 'FINAL-AI-02', scenario: 'locked write boundary', mode, registeredFiles: registered.map(x => x.filename), timeline });
          } finally { await mutation; if (oldRoot === undefined) delete process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR;
            else process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR = oldRoot; fs.rmSync(root, { recursive: true, force: true }); }
        });
      for (const trial of [1, 2, 3, 4]) await t.test(`parallel tag commits recover actual MariaDB deadlocks, trial ${trial}`, async () => {
        const a = await actionFixture('tags', 'success'), b = await actionFixture('tags', 'success');
        const gate = deferred(); let readers = 0; const errors = [], modelCalls = [0, 0];
        const sameName = trial === 4;
        for (const [i, f] of [a, b].entries()) {
          f.service.model = async () => { modelCalls[i]++; return { tags: [{ id: null, zh_CN: `并发标签${trial}-${sameName ? 'same' : i}`,
            en_US: `Concurrent tag ${trial}-${sameName ? 'same' : i}` }] }; };
          const read = f.problems.getAllProblemTags.bind(f.problems); let firstRead = true;
          f.problems.getAllProblemTags = async manager => {
            const value = await read(manager);
            if (manager && firstRead) { firstRead = false; if (++readers === 2) gate.resolve(); await gate.promise; }
            return value;
          };
          const create = f.problems.createProblemTag.bind(f.problems);
          f.problems.createProblemTag = async (...args) => {
            try { return await create(...args); } catch (e) { errors.push({ code: e.code, sqlState: e.sqlState }); throw e; }
          };
          f.service.execute = () => f.service.edit(f.job, f.user, f.problem, { llm: {}, search: {} }, f.snapshot, 'tags');
        }
        await Promise.all([a.service.runJob(a.job), b.service.runJob(b.job)]);
        const rows = await Promise.all([a, b].map(f => db.getRepository(AiJobEntity).findOneBy({ id: f.job.id })));
        assert.equal(readers, 2); assert(errors.some(e => e.code === 'ER_LOCK_DEADLOCK'));
        assert(rows.every(x => x.status === 'completed')); assert.deepEqual(modelCalls, [1, 1]);
        const mappings = await db.getRepository(ProblemTagMapEntity).findBy({ problemId: backendRequire("typeorm").In([a.problem.id, b.problem.id]) });
        assert.equal(mappings.length, 2); assert.equal(new Set(mappings.map(x => x.problemTagId)).size, sameName ? 1 : 2);
        evidence.push({ finding: 'FINAL-AI-03', scenario: sameName ? 'same name proposals' : 'different proposals', trial,
          statuses: rows.map(x => x.status), modelCalls, actualDeadlocks: errors, assignedTagIds: mappings.map(x => x.problemTagId) });
      });
      for (const mode of ['cancel', 'lease', 'human-edit']) await t.test(`tag deadlock retry rechecks ${mode} after rollback`, async () => {
        const a = await actionFixture('tags', 'success'), b = await actionFixture('tags', 'success');
        const gate = deferred(); let readers = 0, victim; const timelines = [];
        for (const [i, f] of [a, b].entries()) {
          f.service.model = async () => ({ tags: [{ id: null, zh_CN: `重试失效${mode}-${i}`, en_US: `Retry invalidated ${mode}-${i}` }] });
          let firstRead = true; const read = f.problems.getAllProblemTags.bind(f.problems);
          f.problems.getAllProblemTags = async manager => {
            const result = await read(manager);
            if (manager && firstRead) { firstRead = false; if (++readers === 2) gate.resolve(); await gate.promise; }
            return result;
          };
          const wrapped = Object.create(db);
          wrapped.transaction = async (...args) => {
            try { return await db.transaction(...args); }
            catch (error) {
              if (error.code === 'ER_LOCK_DEADLOCK') {
                assert.equal(victim, undefined); victim = f;
                await invalidate(f, mode, timelines);
              }
              throw error;
            }
          };
          f.service.db = wrapped;
          f.service.execute = () => f.service.edit(f.job, f.user, f.problem, { llm: {}, search: {} }, f.snapshot, 'tags');
        }
        await Promise.all([a.service.runJob(a.job), b.service.runJob(b.job)]);
        assert(victim); const other = victim === a ? b : a;
        const row = await db.getRepository(AiJobEntity).findOneBy({ id: victim.job.id });
        assert.equal((await db.getRepository(AiJobEntity).findOneBy({ id: other.job.id })).status, 'completed');
        assert.equal(await db.getRepository(ProblemTagMapEntity).countBy({ problemId: victim.problem.id }), 0);
        if (mode === 'cancel') assert.equal(row.status, 'cancelled');
        else if (mode === 'lease') assert.equal(row.status, 'running');
        else { assert.equal(row.status, 'failed'); assert.equal(row.error, 'PROBLEM_CHANGED_DURING_AI'); }
        evidence.push({ finding: 'FINAL-AI-03', scenario: 'guard rechecked after actual deadlock', mode,
          victimStatus: row.status, error: row.error, timeline: timelines });
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
                  "real MariaDB isolated tables; actual AiService edit/runJob/cancel/installAttachment, permission service, problem statement/tag/file and discussion writes; synthetic provider/source evidence and in-memory object storage; real ZIP extraction; deterministic transaction-entry interleaving",
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
