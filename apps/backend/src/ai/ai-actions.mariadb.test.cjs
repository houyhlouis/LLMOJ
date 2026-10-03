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
  "AI action writes enforce current job, permissions and snapshot (real MariaDB)",
  { skip: !process.env.HYHOJ_AI_TEST_DB_CONFIG, timeout: 60000 },
  async t => {
    const config = backendRequire("js-yaml").load(fs.readFileSync(process.env.HYHOJ_AI_TEST_DB_CONFIG, "utf8")).services
      .database;
    const prefix = `qa_ai_translate_${crypto.randomBytes(8).toString("hex")}_`;
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
      const scenarios = [
        {mode:'success', phase:'none'},
        {mode:'cancel', phase:'model'},
        {mode:'UseAi', phase:'model'},
        {mode:'cancel', phase:'after-snapshot'},
        {mode:'UseAi', phase:'after-snapshot'},
        {mode:'object-ACL', phase:'after-snapshot'},
        {mode:'lease', phase:'after-snapshot'},
        {mode:'human-edit', phase:'after-snapshot'}
      ];
      for (const scenario of scenarios) await t.test(`translate ${scenario.mode} ${scenario.phase}`, async () => {
        const f = await fixture(), timeline = [];
        f.job.action='translate'; f.job.step='translate';
        await db.getRepository(AiJobEntity).update({id:f.job.id},{action:'translate',step:'translate'});
        if(scenario.mode==='object-ACL') {
          f.problem.ownerId=200;
          await db.getRepository(ProblemEntity).update({id:f.problem.id},{ownerId:200});
          await db.getRepository(PermissionForUserEntity).save({userId:99,objectId:f.problem.id,objectType:PermissionObjectType.Problem,permissionLevel:2});
          Object.assign(f.snapshot,await f.service.snapshot(f.problem));
        }
        async function mutate(){
          if(scenario.mode==='cancel') {
            await f.service.cancel(f.user,f.job.id);
            assert.equal((await db.getRepository(AiJobEntity).findOneBy({id:f.job.id})).status,'cancelled');
            timeline.push('actual cancel returned and cancelled row committed');
          } else if(scenario.mode==='UseAi') {
            await db.getRepository(UserPermissionRuleEntity).save({userId:99,permission:'UseAi',allowed:false});
            timeline.push('UseAi deny committed');
          } else if(scenario.mode==='object-ACL') {
            await db.getRepository(PermissionForUserEntity).delete({userId:99,objectId:f.problem.id,objectType:PermissionObjectType.Problem});
            timeline.push('object ACL removal committed');
          } else if(scenario.mode==='lease') {
            await db.getRepository(AiJobEntity).update({id:f.job.id},{runToken:crypto.randomUUID()});
            timeline.push('new worker lease committed');
          } else if(scenario.mode==='human-edit') {
            const p=await db.getRepository(ProblemEntity).findOneBy({id:f.problem.id});
            await f.problems.updateProblemStatement(p,{problemId:p.id,localizedContents:[{locale:'zh_CN',title:'Human updated title',contentSections:[]}],samples:[],problemTagIds:[]},[]);
            assert.equal((await f.problems.getProblemAllLocalizedContents(p))[0].title,'Human updated title');
            timeline.push('actual updateProblemStatement human edit committed');
          }
          if(scenario.mode!=='success') {
            await assert.rejects(f.service.assertSnapshot(f.job,f.snapshot));
            timeline.push('actual fresh assertSnapshot rejects before translation write');
          }
        }
        f.service.model=async()=>{
          if(scenario.phase==='model') await mutate();
          return {locale:'en_US',title:'AI translated title',description:'Output the input integer.',input:'An integer.',output:'The same integer.',limitsAndHints:''};
        };
        const originalAssert=f.service.assertSnapshot.bind(f.service);
        f.service.assertSnapshot=async(...args)=>{const result=await originalAssert(...args);timeline.push('actual external assertSnapshot accepted');return result;};
        // Product awaits this normal metadata lookup after its last assertion.
        // The isolated schema has no tags; empty lookup plus deterministic scheduling is synthetic.
        f.problems.getProblemTagsByProblem=async()=>{
          timeline.push('normal awaited tag lookup entered after last external assertion');
          if(scenario.phase==='after-snapshot') await mutate();
          return [];
        };
        const originalUpdate=f.problems.updateProblemStatement.bind(f.problems);
        f.problems.updateProblemStatement=async(...args)=>{const result=await originalUpdate(...args);timeline.push('actual updateProblemStatement transaction committed');return result;};
        f.service.execute=()=>f.service.edit(f.job,f.user,f.problem,{llm:{},search:{}},f.snapshot,'translate');
        await f.service.runJob(f.job);
        const row=await db.getRepository(AiJobEntity).findOneBy({id:f.job.id});
        const p=await db.getRepository(ProblemEntity).findOneBy({id:f.problem.id});
        const localized=await f.problems.getProblemAllLocalizedContents(p);
        const translated=localized.some(x=>x.locale==='en_US'&&x.title==='AI translated title');
        const zhTitle=localized.find(x=>x.locale==='zh_CN')?.title;
        assert.equal(translated,scenario.mode==='success');
        if(scenario.phase==='model') assert(['cancelled','failed'].includes(row.status));
        else if(scenario.mode==='success') assert.equal(row.status,'completed');
        else if(scenario.mode==='cancel') assert.equal(row.status,'cancelled');
        else if(scenario.mode==='lease') assert.equal(row.status,'running');
        else assert.equal(row.status,'failed');
        if(scenario.mode==='human-edit') assert.equal(zhTitle,'Human updated title');
        if (!['success','cancel','lease'].includes(scenario.mode))
          assert.equal(row.error, scenario.mode==='human-edit' ? 'PROBLEM_CHANGED_DURING_AI' : 'PERMISSION_DENIED');
        evidence.push({...scenario,expectation:'guarded publication must reject invalidated tasks without persisting translation',jobStatus:row.status,error:row.error,translationPersisted:translated,zhTitle,timeline});
      });
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
        timeline.push(`${mode} invalidation committed before publication transaction`);
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
      for (const kind of ['source', 'difficulty-model', 'difficulty-official', 'tags', 'tutorial']) {
        const action = kind.startsWith('difficulty') ? 'difficulty' : kind;
        const modes = ['success', 'cancel', 'UseAi', 'object-ACL', 'lease', 'human-edit'];
        if (kind === 'tags') modes.push('ManageProblemTags');
        if (kind === 'tutorial') modes.push('CreateDiscussion');
        if (kind === 'source') modes.push('source-title');
        for (const mode of modes) await t.test(`${kind} ${mode} at commit`, async () => {
          const f = await actionFixture(action, mode), timeline = [];
          const originalDiscovery = sourceSearch.discoverProblemSource;
          let existingTag;
          if (kind === 'difficulty-official') {
            f.problem.originalProblem = 'https://codeforces.com/problemset/problem/2264/A';
            await db.getRepository(ProblemEntity).update({id: f.problem.id}, {originalProblem: f.problem.originalProblem});
            f.snapshot = await f.service.snapshot(f.problem);
          }
          if (kind === 'tags') existingTag = await f.problems.createProblemTag([['zh_CN', `现有标签 ${f.problem.id}`]], 'red');
          const beforeTags = await db.getRepository(ProblemTagEntity).count();
          f.service.references = async () => 'Synthetic source evidence, no network';
          f.service.model = async () => kind === 'tags' ? {tags: [
            {id: null, zh_CN: `新标签 ${f.problem.id}`, en_US: `New tag ${f.problem.id}`},
            {id: existingTag.id, zh_CN: `现有标签 ${f.problem.id}`, en_US: `Repaired tag ${f.problem.id}`}
          ]} : kind === 'tutorial' ? {zh_CN: '逐字输出输入整数。', en_US: 'Print the input integer.'} :
            {difficulty: 1200, rationale: 'Synthetic difficulty rationale'};
          sourceSearch.discoverProblemSource = async () => ({status: 'verified', url: 'https://example.org/task',
            title: 'Synthetic verified source', trace: {searchCount: 1}, reason: 'Synthetic source fixture'});
          let injected = false;
          const before = async () => {
            if (injected) return;
            injected = true;
            await f.service.assertSnapshot(f.job, f.snapshot);
            timeline.push('actual external snapshot accepted before commit');
            if (mode !== 'success') await invalidate(f, mode, timeline);
          };
          if (kind === 'tutorial') interceptTransactions(f.discussions, 'connection', before);
          else interceptTransactions(f.service, 'db', before);
          try {
            f.service.execute = () => f.service.edit(f.job, f.user, f.problem, {llm: {}, search: {apiKey: 'synthetic'}}, f.snapshot, action);
            await f.service.runJob(f.job);
            assert(injected, 'test must reach the final commit boundary');
            const row = await db.getRepository(AiJobEntity).findOneBy({id: f.job.id});
            const problem = await db.getRepository(ProblemEntity).findOneBy({id: f.problem.id});
            const discussions = await db.getRepository(DiscussionEntity).findBy({problemId: f.problem.id});
            const selectedTags = await f.problems.getProblemTagIdsByProblem(problem);
            const zhTitle = (await f.problems.getProblemAllLocalizedContents(problem)).find(x => x.locale === 'zh_CN').title;
            if (mode === 'success') assert.equal(row.status, 'completed');
            else if (mode === 'cancel') assert.equal(row.status, 'cancelled');
            else if (mode === 'lease') assert.equal(row.status, 'running');
            else {assert.equal(row.status, 'failed'); assert.equal(row.error,
              ['human-edit', 'source-title'].includes(mode) ? 'PROBLEM_CHANGED_DURING_AI' : 'PERMISSION_DENIED');}
            if (kind === 'source') {assert.equal(problem.originalProblem, mode === 'success' ? 'https://example.org/task' : '');
              assert.equal(problem.originalProblemTitle, mode === 'success' ? 'Synthetic verified source' : mode === 'source-title' ? 'Human source title' : '');}
            if (kind.startsWith('difficulty')) assert.equal(problem.difficulty, mode === 'success' ?
              (kind === 'difficulty-official' ? 800 : 1200) : null);
            if (kind === 'tags') {
              assert.equal(await db.getRepository(ProblemTagEntity).count(), beforeTags + (mode === 'success' ? 1 : 0));
              assert.equal(selectedTags.length, mode === 'success' ? 2 : 0);
              const names = await f.problems.getProblemTagAllLocalizedNames(existingTag);
              assert.equal(names.en_US, mode === 'success' ? `Repaired tag ${f.problem.id}` : undefined);
            }
            assert.equal(discussions.length, kind === 'tutorial' && mode === 'success' ? 2 : 0);
            if (kind === 'tutorial' && mode === 'success') {
              assert(discussions.every(d => d.isPublic === false), 'hidden problem tutorials stay private');
              assert.equal(row.state.discussionIds.zh_CN, discussions.find(d => d.title === '题解-AI').id);
              assert.equal(row.state.discussionIds.en_US, discussions.find(d => d.title === 'Tutorial-AI').id);
            }
            assert.equal(zhTitle, mode === 'human-edit' ? 'Human updated title' : 'Original title');
            evidence.push({action: kind, mode, phase: 'before-commit', expectation: 'invalidated commit has zero side effects',
              jobStatus: row.status, error: row.error, difficulty: problem.difficulty, source: problem.originalProblem,
              discussionCount: discussions.length, selectedTags, zhTitle, timeline});
          } finally {sourceSearch.discoverProblemSource = originalDiscovery;}
        });
      }
      // Exercise the signed attachment token, actual safe ZIP extraction, both
      // registration methods, immutable-file preparation, flags and DB guard.
      const archiveRoot = fs.mkdtempSync(path.join(path.dirname(process.env.HYHOJ_AI_TEST_RESULTS || path.join(os.tmpdir(), 'hyhoj-ai-actions-results.json')), 'hyhoj-ai-attachment-actions-'));
      const oldArchiveRoot = process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY;
      process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY = archiveRoot;
      const archive = path.join(archiveRoot, 'fixture.zip');
      backendRequire('node:child_process').execFileSync('python3', ['-c',
        'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("sample.in","7\\n")\n z.writestr("sample.out","7\\n")', archive]);
      try {
        for (const stage of ['additional', 'hidden']) {
          for (const mode of ['success', 'cancel', 'UseAi', 'ImportProblem', 'CreateProblem', 'GenerateTestdata',
            'EditProblemData', 'object-ACL', 'lease', 'human-edit']) await t.test(`attachment ${stage} ${mode} at registration`, async () => {
            const f = await actionFixture('import', mode), timeline = [];
            f.service.key = Buffer.alloc(32, 1); f.job.createdAt = new Date();
            const attachment = {ownerId: f.user.id, uuid: crypto.randomUUID(), filename: 'fixture.zip',
              size: fs.statSync(archive).size, expires: Date.now() + 60000};
            f.job.input.attachmentToken = signAiAttachment(f.service.key, attachment);
            f.files.downloadFileToPath = async (_uuid, destination) => {fs.copyFileSync(archive, destination); return attachment.size;};
            let transactions = 0, injected = false;
            const before = async () => {
              transactions++;
              if (transactions !== (stage === 'additional' ? 1 : 2)) return;
              injected = true;
              timeline.push('external attachment authorization accepted and immutable files prepared');
              if (mode !== 'success') {
                // Human edits use the real unwrapped connection.
                const wrapped = f.problems.connection; f.problems.connection = db;
                try {await invalidate(f, mode, timeline);} finally {f.problems.connection = wrapped;}
              }
            };
            interceptTransactions(f.problems, 'connection', before);
            let executionError;
            f.service.execute = async () => {try {return await f.service.installAttachment(f.job, f.user);} catch (error) {executionError = error.stack; throw error;}};
            await f.service.runJob(f.job);
            assert(injected, executionError || 'test must reach the target registration boundary');
            const row = await db.getRepository(AiJobEntity).findOneBy({id: f.job.id});
            const registered = await db.getRepository(ProblemFileEntity).findBy({problemId: f.problem.id});
            const info = await f.read();
            const additionalCount = registered.filter(file => file.type === ProblemFileType.AdditionalFile).length;
            const testdataCount = registered.filter(file => file.type === ProblemFileType.TestData).length;
            const hiddenCount = (info.hiddenSamples || []).length;
            const expectedAdditional = mode === 'success' || stage === 'hidden' ? 3 : 0;
            assert.equal(additionalCount, expectedAdditional);
            assert.equal(testdataCount, mode === 'success' ? 2 : 0);
            assert.equal(hiddenCount, mode === 'success' ? 1 : 0);
            assert.equal(f.uploaded.size, registered.length, 'unregistered immutable objects must be cleaned');
            assert.equal(!!row.state.attachmentAdditionalDone, expectedAdditional > 0);
            assert.equal(!!row.state.attachmentHiddenDone, mode === 'success');
            if (mode === 'success') assert.equal(row.status, 'completed');
            else if (mode === 'cancel') assert.equal(row.status, 'cancelled');
            else if (mode === 'lease') assert.equal(row.status, 'running');
            else {assert.equal(row.status, 'failed'); assert.equal(row.error,
              ['human-edit', 'source-title'].includes(mode) ? 'PROBLEM_CHANGED_DURING_AI' : 'PERMISSION_DENIED');}
            evidence.push({action: 'attachment', stage, mode, phase: 'before-registration', jobStatus: row.status,
              error: row.error, additionalCount, testdataCount, hiddenCount, preparedObjectsRemaining: f.uploaded.size,
              flags: {additional: !!row.state.attachmentAdditionalDone, hidden: !!row.state.attachmentHiddenDone}, timeline});
          });
        }
      } finally {
        if (oldArchiveRoot === undefined) delete process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY;
        else process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY = oldArchiveRoot;
        fs.rmSync(archiveRoot, {recursive: true, force: true});
      }
      // If a valid commit obtains its locks first, a concurrent explicit deny
      // waits until publication commits. This is the valid inverse serial order.
      for (const missingRule of [false, true]) await t.test(`translation locks ${missingRule ? 'missing' : 'existing'} UseAi rule through commit`, async () => {
        const f = await actionFixture('translate', 'success'), entered = deferred(), release = deferred();
        if (missingRule) await db.getRepository(UserPermissionRuleEntity).delete({userId: 99, permission: 'UseAi'});
        const originalGuard = f.service.authorizeProblemCommit.bind(f.service);
        f.service.authorizeProblemCommit = async (...args) => {const user = await originalGuard(...args); entered.resolve(); await release.promise; return user;};
        f.service.model = async () => ({locale: 'en_US', title: 'AI translated title', description: 'Output the input integer.', input: '', output: '', limitsAndHints: ''});
        const edit = f.service.edit(f.job, f.user, f.problem, {llm: {}, search: {}}, f.snapshot, 'translate');
        await entered.promise;
        let denied = false;
        const deny = db.getRepository(UserPermissionRuleEntity).save({userId: 99, permission: 'UseAi', allowed: false}).then(() => {denied = true;});
        await pause(100);
        assert.equal(denied, false, 'concurrent deny waits on current locking permission read');
        release.resolve(); await edit; await deny;
        assert((await f.problems.getProblemAllLocalizedContents(f.problem)).some(x => x.locale === 'en_US'));
        evidence.push({action: 'translate', mode: missingRule ? 'deny-insert-blocked' : 'deny-update-blocked',
          phase: 'during-guard', expectation: 'authorized publication commits before waiting deny', translationPersisted: true});
      });
      for (const phase of ['download', 'between-registrations']) await t.test(`attachment detects changed problem type ${phase}`, async () => {
        const f = await actionFixture('import', 'success');
        const root = fs.mkdtempSync(path.join(path.dirname(process.env.HYHOJ_AI_TEST_RESULTS || path.join(os.tmpdir(), 'hyhoj-ai-actions-results.json')), 'hyhoj-ai-type-conflict-'));
        const oldRoot = process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY;
        process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY = root;
        const zip = path.join(root, 'fixture.zip');
        backendRequire('node:child_process').execFileSync('python3', ['-c',
          'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("sample.in","7\\n")\n z.writestr("sample.out","7\\n")', zip]);
        f.service.key = Buffer.alloc(32, 1); f.job.createdAt = new Date();
        const attachment = {ownerId: f.user.id, uuid: crypto.randomUUID(), filename: 'fixture.zip', size: fs.statSync(zip).size, expires: Date.now() + 60000};
        f.job.input.attachmentToken = signAiAttachment(f.service.key, attachment);
        let changed = false;
        const mutateType = async () => {await db.getRepository(ProblemEntity).update({id: f.problem.id}, {type: 'Interaction'}); changed = true;};
        f.files.downloadFileToPath = async (_uuid, destination) => {fs.copyFileSync(zip, destination); if (phase === 'download') await mutateType(); return attachment.size;};
        let transactions = 0;
        if (phase === 'between-registrations') interceptTransactions(f.problems, 'connection', async () => {
          if (++transactions === 2) await mutateType();
        });
        try {
          f.service.execute = () => f.service.installAttachment(f.job, f.user);
          await f.service.runJob(f.job);
          const row = await db.getRepository(AiJobEntity).findOneBy({id: f.job.id});
          assert(changed); assert.equal(row.status, 'failed'); assert.equal(row.error, 'PROBLEM_CHANGED_DURING_AI');
          const files = await db.getRepository(ProblemFileEntity).findBy({problemId: f.problem.id});
          assert.equal(files.filter(x => x.type === ProblemFileType.AdditionalFile).length, phase === 'download' ? 0 : 3);
          assert.equal(files.filter(x => x.type === ProblemFileType.TestData).length, 0);
          assert.equal((await f.read()).hiddenSamples, undefined);
          assert.equal(f.uploaded.size, files.length);
          evidence.push({action: 'attachment', mode: 'problem-type', phase, jobStatus: row.status, error: row.error,
            additionalCount: files.length, testdataCount: 0});
        } finally {
          if (oldRoot === undefined) delete process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY; else process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY = oldRoot;
          fs.rmSync(root, {recursive: true, force: true});
        }
      });
      await t.test('guarded statement evicts old title cached immediately before commit', async () => {
        const f = await actionFixture('translate', 'success');
        let refilled = false;
        const wrapped = Object.create(db);
        wrapped.transaction = (level, callback) => db.transaction(level, async manager => {
          const result = await callback(manager);
          // Ordinary read uses a separate connection and READ COMMITTED visibility,
          // so it can repopulate the old title while the write remains uncommitted.
          assert.equal(await f.problems.getProblemLocalizedTitle(f.problem, 'zh_CN'), 'Original title');
          assert(f.cache.size > 0); refilled = true;
          return result;
        });
        f.problems.connection = wrapped;
        await f.problems.updateProblemStatement(f.problem, {problemId: f.problem.id, localizedContents: [
          {locale: 'zh_CN', title: 'New authorized title', contentSections: f.snapshot.statements[0].contentSections}
        ], samples: [], problemTagIds: []}, [], (manager, currentProblem) =>
          f.service.authorizeProblemCommit(f.job, f.snapshot, manager, currentProblem));
        assert(refilled); assert.equal(f.cache.size, 0, 'post-commit eviction removes the refilled old title');
        assert.equal(await f.problems.getProblemLocalizedTitle(f.problem, 'zh_CN'), 'New authorized title');
        evidence.push({action: 'statement-cache', mode: 'precommit-refill', staleCacheEvicted: true, freshTitle: 'New authorized title'});
      });
      await t.test('tag transaction evicts old repaired names cached immediately before commit', async () => {
        const f = await actionFixture('tags', 'success');
        const tag = await f.problems.createProblemTag([['zh_CN', 'Old existing name']], 'red');
        f.service.model = async () => ({tags: [{id: tag.id, zh_CN: 'Ignored model rename', en_US: 'New bilingual name'}]});
        // The global tag repair preserves existing names, so an omitted old locale
        // is repaired to the current model value while the known locale remains.
        let refilled = false;
        const wrapped = Object.create(db);
        wrapped.transaction = (level, callback) => db.transaction(level, async manager => {
          const result = await callback(manager);
          assert.equal(await f.problems.getProblemTagLocalizedName(tag, 'zh_CN'), 'Old existing name');
          assert(f.cache.size > 0); refilled = true;
          return result;
        });
        f.service.db = wrapped;
        await f.service.edit(f.job, f.user, f.problem, {llm: {}, search: {}}, f.snapshot, 'tags');
        assert(refilled); assert.equal(f.cache.size, 0, 'post-commit eviction removes every selected tag locale');
        assert.equal(await f.problems.getProblemTagLocalizedName(tag, 'en_US'), 'New bilingual name');
        evidence.push({action: 'tags-cache', mode: 'precommit-refill', staleCacheEvicted: true, freshName: 'New bilingual name'});
      });
      await t.test('tag creation and repair roll back together on later write failure', async () => {
        const f = await actionFixture('tags', 'success');
        const existing = await f.problems.createProblemTag([['zh_CN', 'Existing rollback tag']], 'red');
        const before = await db.getRepository(ProblemTagEntity).count();
        f.service.model = async () => ({tags: [
          {id: null, zh_CN: '临时新标签', en_US: 'Uncommitted tag'},
          {id: existing.id, zh_CN: 'Existing rollback tag', en_US: 'Uncommitted repaired name'}
        ]});
        const update = f.problems.updateProblemTag.bind(f.problems);
        let wrote = false;
        f.problems.updateProblemTag = async (...args) => {await update(...args); wrote = true; throw new Error('Synthetic failure after real tag writes');};
        await assert.rejects(f.service.edit(f.job, f.user, f.problem, {llm: {}, search: {}}, f.snapshot, 'tags'), /Synthetic failure/);
        assert(wrote); assert.equal(await db.getRepository(ProblemTagEntity).count(), before);
        assert.equal((await f.problems.getProblemTagAllLocalizedNames(existing)).en_US, undefined);
        assert.deepEqual(await f.problems.getProblemTagIdsByProblem(f.problem), []);
        assert.equal(await db.getRepository(LocalizedContentEntity).countBy({type: LocalizedContentType.ProblemTagName, data: 'Uncommitted tag'}), 0);
        evidence.push({action: 'tags', mode: 'late-write-failure', rolledBackNewTagAndRepair: true, selectedTags: []});
      });
      await t.test('tutorial discussion and durable binding roll back on callback failure', async () => {
        const f = await actionFixture('tutorial', 'success');
        f.service.model = async () => ({zh_CN: '中文原创题解', en_US: 'Original English tutorial'});
        const create = f.discussions.createDiscussion.bind(f.discussions);
        let wrote = false;
        f.discussions.createDiscussion = (_user, title, content, problem, onCreated, guard) => create(_user, title, content, problem,
          async (created, manager) => {await onCreated(created, manager); wrote = true; throw new Error('Synthetic callback failure');}, guard);
        f.service.execute = () => f.service.edit(f.job, f.user, f.problem, {llm: {}, search: {}}, f.snapshot, 'tutorial');
        await f.service.runJob(f.job);
        const row = await db.getRepository(AiJobEntity).findOneBy({id: f.job.id});
        assert(wrote); assert.equal(row.status, 'failed'); assert.equal(row.error, 'INTERNAL_ERROR');
        assert.equal(await db.getRepository(DiscussionEntity).countBy({problemId: f.problem.id}), 0);
        assert.equal(row.state.discussionIds, undefined);
        evidence.push({action: 'tutorial', mode: 'late-callback-failure', rolledBackDiscussionAndBinding: true});
      });
      for (const stage of ['additional', 'hidden']) await t.test(`attachment ${stage} files and durable flag roll back on callback failure`, async () => {
        const f = await actionFixture('import', 'success');
        const root = fs.mkdtempSync(path.join(path.dirname(process.env.HYHOJ_AI_TEST_RESULTS || path.join(os.tmpdir(), 'hyhoj-ai-actions-results.json')), 'hyhoj-ai-rollback-'));
        const oldRoot = process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY;
        process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY = root;
        const zip = path.join(root, 'fixture.zip');
        backendRequire('node:child_process').execFileSync('python3', ['-c',
          'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("sample.in","7\\n")\n z.writestr("sample.out","7\\n")', zip]);
        f.service.key = Buffer.alloc(32, 1); f.job.createdAt = new Date();
        const attachment = {ownerId: f.user.id, uuid: crypto.randomUUID(), filename: 'fixture.zip', size: fs.statSync(zip).size, expires: Date.now() + 60000};
        f.job.input.attachmentToken = signAiAttachment(f.service.key, attachment);
        f.files.downloadFileToPath = async (_uuid, destination) => {fs.copyFileSync(zip, destination); return attachment.size;};
        const add = f.problems.addProblemFilesFromDisk.bind(f.problems);
        let wrote = false;
        f.problems.addProblemFilesFromDisk = (problem, type, files, options) => add(problem, type, files, {
          ...options, onRegistered: async manager => {
            await options.onRegistered(manager);
            if (type === (stage === 'additional' ? ProblemFileType.AdditionalFile : ProblemFileType.TestData)) {
              wrote = true; throw new Error('Synthetic registration callback failure');
            }
          }
        });
        try {
          f.service.execute = () => f.service.installAttachment(f.job, f.user);
          await f.service.runJob(f.job);
          const row = await db.getRepository(AiJobEntity).findOneBy({id: f.job.id});
          const registered = await db.getRepository(ProblemFileEntity).findBy({problemId: f.problem.id});
          assert(wrote); assert.equal(row.status, 'failed'); assert.equal(row.error, 'INTERNAL_ERROR');
          assert.equal(registered.length, stage === 'additional' ? 0 : 3);
          assert.equal(f.uploaded.size, registered.length);
          assert.equal((await f.read()).hiddenSamples, undefined);
          assert.equal(!!row.state.attachmentAdditionalDone, stage === 'hidden');
          assert.equal(row.state.attachmentHiddenDone, undefined);
          evidence.push({action: 'attachment', stage, mode: 'late-callback-failure', rolledBackFilesSamplesAndFlag: true,
            retainedAuthorizedAdditionalFiles: registered.length, preparedObjectsRemaining: f.uploaded.size});
        } finally {
          if (oldRoot === undefined) delete process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY; else process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY = oldRoot;
          fs.rmSync(root, {recursive: true, force: true});
        }
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
