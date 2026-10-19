// Independent authorization audit; randomized tables are always cleaned up in the explicit isolation database.
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), crypto = require("node:crypto"), ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
String.prototype.format ||= function (...args) { return require("node:util").format(this, ...args); };
const { DataSource, EntitySchema } = require("typeorm"), acl = require("./team-access.ts");
const { TeamService } = require("./team.service.ts"), { TeamEntity, TeamMemberEntity, TeamResourceEntity, TeamAssignmentEntity, TeamFileEntity } = require("./team.entity.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts"), { ProblemService, ProblemPermissionType } = require("../problem/problem.service.ts");
const { ProblemController } = require("../problem/problem.controller.ts"), { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts"), { ProblemFileEntity, ProblemFileType } = require("../problem/problem-file.entity.ts");
const { DiscussionEntity } = require("../discussion/discussion.entity.ts"), { DiscussionService, DiscussionPermissionType } = require("../discussion/discussion.service.ts");
const { DiscussionContentEntity } = require("../discussion/discussion-content.entity.ts"), { DiscussionReplyEntity } = require("../discussion/discussion-reply.entity.ts");
const { ContestEntity } = require("../contest/contest.entity.ts"), { ContestService } = require("../contest/contest.service.ts"), { ContestAccessService } = require("../contest/contest-access.service.ts");
const { SubmissionEntity } = require("../submission/submission.entity.ts"), { SubmissionService } = require("../submission/submission.service.ts"), { SubmissionAccessService, SubmissionPermissionType } = require("../submission/submission-access.service.ts");
const { GroupEntity } = require("../group/group.entity.ts"), { GroupService } = require("../group/group.service.ts");
const { UserPermissionRuleEntity } = require("../access/user-permission-rule.entity.ts");
const { UserPrivilegeEntity } = require("../user/user-privilege.entity.ts");
test("team direct links, list counts, archival, disqualified work and removal respect the same ACL (real MariaDB)", {
  skip: !process.env.LLMOJ_TEAM_AUDIT_DB_CONFIG, timeout: 60000
}, async t => {
  const cfg = require("js-yaml").load(fs.readFileSync(process.env.LLMOJ_TEAM_AUDIT_DB_CONFIG, "utf8")).services.database;
  const prefix = "qa_team_audit_" + crypto.randomBytes(8).toString("hex") + "_", n = { type: Number }, str = { type: String }, flag = { type: Boolean }, json = { type: "json" };
  const defs = [
    [UserPermissionRuleEntity, "permission_rule", { userId: { ...n, primary: true }, permission: { ...str, primary: true }, allowed: flag }],
    [UserPrivilegeEntity, "privilege", { userId: { ...n, primary: true }, privilegeType: { ...str, primary: true } }],
    [TeamEntity, "team", { id: { ...n, primary: true }, ownerId: n, archived: flag, permissionGroupId: n }],
    [TeamMemberEntity, "member", { id: { ...n, primary: true }, teamId: n, userId: n, status: str, permissions: json, groupId: { ...n, nullable: true } }],
    [TeamResourceEntity, "resource", { id: { ...n, primary: true }, teamId: n, resourceId: n, kind: str, visibility: str, invitedUserIds: json, archived: flag }],
    [ProblemEntity, "problem", { id: { ...n, primary: true }, ownerId: n, isPublic: flag, displayId: { ...n, nullable: true }, difficulty: n, locales: json, type: str }],
    [ProblemJudgeInfoEntity, "judge_info", { problemId: { ...n, primary: true }, judgeInfo: json, submittable: flag }],
    [ProblemFileEntity, "problem_file", { problemId: { ...n, primary: true }, type: { ...str, primary: true }, filename: { ...str, primary: true }, uuid: str }],
    [DiscussionEntity, "discussion", { id: { ...n, primary: true }, publisherId: n, problemId: { ...n, nullable: true }, isPublic: flag, type: str, title: str, sortTime: { type: Date }, publishTime: { type: Date }, editTime: { type: Date, nullable: true }, replyCount: n }],
    [DiscussionContentEntity, "discussion_content", { discussionId: { ...n, primary: true }, content: str }],
    [DiscussionReplyEntity, "reply", { id: { ...n, primary: true, generated: true }, discussionId: n, publisherId: n, content: str, isPublic: flag, publishTime: { type: Date }, editTime: { type: Date, nullable: true } }],
    [ContestEntity, "contest", { id: { ...n, primary: true }, ownerId: n, adminIds: json, isPublic: flag, startTime: { type: Date }, endTime: { type: Date } }],
    [SubmissionEntity, "submission", { id: { ...n, primary: true }, problemId: n, submitterId: n, contestId: { ...n, nullable: true }, isPublic: flag, status: str, codeLanguage: str, score: n, submitTime: { type: Date } }],
    [TeamAssignmentEntity, "assignment", { id: { ...n, primary: true }, teamId: n, archived: flag, assignedUserIds: json, assignedGroupIds: json, items: json, deadline: { type: Date } }],
    [TeamFileEntity, "file", { id: { ...n, primary: true }, teamId: n, archived: flag, uuid: str, name: str }],
    [GroupEntity, "group", { id: { ...n, primary: true }, name: str, memberCount: n }]
  ];
  const db = new DataSource({ ...cfg, entities: defs.map(([target, name, columns]) => new EntitySchema({ name: target.name, target, tableName: prefix + name, columns })), synchronize: true, logging: false });
  const originalSql = acl.teamResourceVisibilitySql;
  acl.teamResourceVisibilitySql = (...args) => originalSql(...args).replace(/\bteam_resource\b/g, "`" + prefix + "resource`").replace(/\bteam_member\b/g, "`" + prefix + "member`").replace(/\bteam\b/g, "`" + prefix + "team`").replace(/\buser_permission_rule\b/g, "`" + prefix + "permission_rule`").replace(/\buser_privilege\b/g, "`" + prefix + "privilege`");
  try {
    await db.initialize();
    await db.getRepository(TeamEntity).save({ id: 10, ownerId: 1, archived: false, permissionGroupId: 50 });
    for (const [id, status, permissions] of [[1, "member", []], [3, "member", []], [4, "member", ["problems", "contests", "discussions", "assignments", "files"]], [5, "blocked", []], [6, "applicant", []], [7, "member", []]])
      await db.getRepository(TeamMemberEntity).save({ id, teamId: 10, userId: id, status, permissions, groupId: null });
    const resource = (id, kind, resourceId, visibility = "private", invitedUserIds = []) => ({ id, teamId: 10, kind, resourceId, visibility, invitedUserIds, archived: false });
    await db.getRepository(TeamResourceEntity).save([resource(1, "problem", 1), resource(2, "discussion", 11), resource(3, "contest", 21), resource(4, "contest", 23, "invite", [2])]);
    await db.getRepository(ProblemEntity).save([{ id: 1, ownerId: 2, isPublic: true, displayId: null, difficulty: 1, locales: ["zh_CN"], type: "Traditional" }, { id: 2, ownerId: 2, isPublic: true, displayId: 2, difficulty: 1, locales: ["zh_CN"], type: "Traditional" }]);
    await db.getRepository(DiscussionEntity).save([{ id: 11, publisherId: 2, problemId: null, isPublic: true, type: "Discussion", title: "private team discussion", sortTime: new Date(), publishTime: new Date(), editTime: null, replyCount: 1 }, { id: 12, publisherId: 2, problemId: null, isPublic: true, type: "Discussion", title: "ordinary discussion", sortTime: new Date(), publishTime: new Date(), editTime: null, replyCount: 0 }]);
    await db.getRepository(DiscussionContentEntity).save({ discussionId: 11, content: "preserved original discussion" });
    await db.getRepository(DiscussionReplyEntity).save({ id: 81, discussionId: 11, publisherId: 1, content: "preserved original reply", isPublic: true, publishTime: new Date(), editTime: null });
    await db.getRepository(ContestEntity).save([21, 22, 23].map(id => ({ id, ownerId: 2, adminIds: [2], isPublic: true, startTime: new Date(0), endTime: new Date("2099-01-01") })));
    const submission = (id, problemId, submitterId = 2, contestId = null, status = "Accepted", score = 100, submitTime = new Date(0)) => ({ id, problemId, submitterId, contestId, isPublic: true, status, codeLanguage: "cpp", score, submitTime });
    await db.getRepository(SubmissionEntity).save([submission(31, 1), submission(32, 2), submission(33, 1, 2, 21)]);
    await db.getRepository(TeamFileEntity).save({ id: 41, teamId: 10, archived: false, uuid: "private-file", name: "evidence.txt" });
    await db.getRepository(GroupEntity).save([{ id: 50, name: "team-acl", memberCount: 4 }, { id: 51, name: "ordinary", memberCount: 1 }]);
    const former = { id: 2, isAdmin: false }, member = { id: 3, isAdmin: false }, editor = { id: 4, isAdmin: false }, owner = { id: 1, isAdmin: false };
    const denied = new Set(), privileges = { userHasPrivilege: async (_u, p) => {
      if (denied.has(p)) return false;
      if (["ViewTeam", "ManageTeams"].includes(p)) {
        if (_u?.isAdmin) return true;
        if (!_u) return p === "ViewTeam";
        const rule = await db.getRepository(UserPermissionRuleEntity).findOneBy({ userId: _u.id, permission: p });
        return rule ? rule.allowed : p === "ViewTeam" || !!(await db.getRepository(UserPrivilegeEntity).countBy({ userId: _u.id, privilegeType: p }));
      }
      return true;
    }, permissionDecision: async (_u, p, fallback) => !denied.has(p) && fallback };
    const problems = Object.create(ProblemService.prototype); Object.assign(problems, { connection: db, problemRepository: db.getRepository(ProblemEntity), userPrivilegeService: privileges, permissionService: { userOrItsGroupsHavePermission: async () => true }, getProblemLocalizedTitle: async p => "Problem " + p.id });
    const discussionRepository = db.getRepository(DiscussionEntity);
    const originalDiscussionBuilder = discussionRepository.createQueryBuilder.bind(discussionRepository);
    discussionRepository.createQueryBuilder = (...args) => {
      const qb = originalDiscussionBuilder(...args);
      for (const method of ["where", "andWhere", "orWhere"]) {
        const original = qb[method].bind(qb);
        qb[method] = (condition, ...params) => original(typeof condition === "string" ? condition
          .replace(/\bteam_resource\b/g, "`"+prefix+"resource`")
          .replace(/\bproblem\b/g, "`"+prefix+"problem`") : condition, ...params);
      }
      return qb;
    };
    const discussions = Object.create(DiscussionService.prototype); Object.assign(discussions, { connection: db, discussionRepository: db.getRepository(DiscussionEntity), discussionContentRepository: db.getRepository(DiscussionContentEntity), discussionReplyRepository: db.getRepository(DiscussionReplyEntity), problemService: problems, userPrivilegeService: privileges, permissionService: { userOrItsGroupsHavePermission: async () => true }, configService: { config: { preference: { security: { discussionReplyDefaultPublic: true } } } } });
    const submissions = Object.create(SubmissionService.prototype); Object.assign(submissions, { connection: db, submissionRepository: db.getRepository(SubmissionEntity), problemService: problems, userPrivilegeService: privileges });
    const submissionAccess = Object.assign(Object.create(SubmissionAccessService.prototype), submissions);
    const contestAccess = Object.assign(Object.create(ContestAccessService.prototype), { db, privileges }); const contests = Object.create(ContestService.prototype); Object.assign(contests, { db, access: contestAccess, submissions });
    const teams = Object.create(TeamService.prototype); Object.assign(teams, { db, privileges, problems, users: { findUsersByExistingIds: async ids => ids.map(id => ({ id, username: "user" + id })) }, files: { signDownloadLink: async args => { assert.equal(args.expiresSeconds, 60); return "signed"; } } });
    const groups = Object.create(GroupService.prototype);
    Object.assign(groups, { groupRepository: { createQueryBuilder: alias => {
      const qb = db.getRepository(GroupEntity).createQueryBuilder(alias);
      for (const method of ["where", "andWhere", "orWhere"]) {
        const original = qb[method].bind(qb);
        qb[method] = (condition, ...args) => original(typeof condition === "string" ? condition.replace(/\bteam_resource\b/g, "`"+prefix+"resource`").replace(/\bteam_member\b/g, "`"+prefix+"member`").replace(/\bteam\b/g, "`" + prefix + "team`").replace(/\bproblem\b/g, "`"+prefix+"problem`").replace(/\buser_permission_rule\b/g, "`"+prefix+"permission_rule`").replace(/\buser_privilege\b/g, "`"+prefix+"privilege`") : condition, ...args);
      }
      return qb;
    } } });
    await t.test("direct owner, publisher, public and global-manager shortcuts cannot escape team ACL", async () => {
      const p = await problems.findProblemById(1), d = await discussions.findDiscussionById(11), c = await db.getRepository(ContestEntity).findOneBy({ id: 21 });
      for (const permission of Object.values(ProblemPermissionType)) assert.equal(await problems.userHasPermission(former, p, permission), false);
      for (const permission of Object.values(DiscussionPermissionType)) assert.equal(await discussions.userHasPermission(former, d, permission), false);
      for (const id of [31, 33]) for (const permission of Object.values(SubmissionPermissionType)) assert.equal(await submissionAccess.userHasPermission(former, await submissions.findSubmissionById(id), permission), false);
      assert.equal(await contestAccess.manager(former, c), false); await assert.rejects(contestAccess.get(former, 21));
      await assert.rejects(teams.downloadFile(former, { teamId: 10, id: 41 }), /membership/i);
      assert.deepEqual(await teams.downloadFile(member, { teamId: 10, id: 41 }), { url: "signed" });
      assert.equal(await groups.findGroupById(50), null); assert.deepEqual((await groups.getAllGroups()).map(g => g.id), [51]);
    });
    await t.test("list predicates apply before counting and cannot be bypassed through legacy OR branches", async () => {
      const [p, pc] = await problems.queryProblemsAndCount(former, true, null, [], 2, false, 0, 20); assert.deepEqual(p.map(x => x.id), [2]); assert.equal(pc, 1);
      const [d, dc] = await discussions.queryDiscussionsAndCount(former, true, null, -2, 2, false, 0, 20); assert.deepEqual(d.map(x => x.id), [12]); assert.equal(dc, 1);
      assert.deepEqual((await submissions.querySubmissions(null, 2, null, null, null, null, false, 20, former)).result.map(s => s.id), [32]);
      for (const restrictManagement of [false, true]) {
        if (restrictManagement) denied.add("ManageContest");
        const list = await contests.list(former); assert.deepEqual(list.contests.map(c => c.id).sort((a,b)=>a-b), [22,23]); assert.equal(list.total, 2);
        denied.delete("ManageContest");
      }
    });
    await t.test("helper read/write and visibility SQL agree, including invited nonmembers and archival", async () => {
      for (const [kind, id] of [["problem", 1], ["discussion", 11], ["contest", 21]]) for (const user of [null, former, member, editor, owner, { id: 5 }, { id: 6 }, { id: 9, isAdmin: true }]) {
        const rows = await db.query("SELECT " + acl.teamResourceVisibilitySql(kind, String(id), user) + " AS allowed");
        assert.equal(Boolean(rows[0].allowed), await acl.teamResourceAccess(db, user, kind, id));
      }
      assert.equal(await acl.teamResourceAccess(db, former, "contest", 23), true); assert.equal(await acl.teamResourceAccess(db, former, "contest", 23, "contests"), false);
      await db.getRepository(TeamResourceEntity).update({ kind: "discussion", resourceId: 11 }, { archived: true });
      await db.getRepository(DiscussionEntity).update(11, { publisherId: owner.id });
      const archived = await discussions.findDiscussionById(11);
      assert.equal(await discussions.userHasPermission(owner, archived, DiscussionPermissionType.View), true);
      assert.equal(await discussions.userHasPermission(owner, archived, DiscussionPermissionType.Modify), false);
      assert.equal(await discussions.userHasModifyDiscussionReplyPermission(owner, { discussionId: 11, publisherId: owner.id }), false);
      await db.getRepository(TeamResourceEntity).update({ kind: "discussion", resourceId: 11 }, { archived: false });
    });
    await t.test("explicit site denials still constrain delegated team editing", async () => {
      assert.equal(await problems.userHasPermission(editor, await problems.findProblemById(1), ProblemPermissionType.Modify), true);
      denied.add("EditAnyProblem"); assert.equal(await problems.userHasPermission(editor, await problems.findProblemById(1), ProblemPermissionType.Modify), false); denied.clear();
      assert.equal(await contestAccess.manager(editor, await db.getRepository(ContestEntity).findOneBy({ id: 21 })), true);
      denied.add("EditContest"); assert.equal(await contestAccess.manager(editor, await db.getRepository(ContestEntity).findOneBy({ id: 21 })), false); denied.clear();
    });
    await t.test("assignment scores exclude late/contest work and score Fake zero even if its stored score is inconsistent", async () => {
      const deadline = new Date("2026-01-01T12:00:00Z"), early = new Date(+deadline - 1000), late = new Date(+deadline + 1000);
      await db.getRepository(TeamAssignmentEntity).save({ id: 61, teamId: 10, archived: false, assignedUserIds: [3], assignedGroupIds: [], items: [{ problemId: 1, section: "A", note: "" }], deadline });
      await db.getRepository(SubmissionEntity).save([submission(71, 1, 3, null, "Fake", 100, early), submission(72, 1, 3, null, "PartiallyCorrect", 40, early), submission(73, 1, 3, null, "Accepted", 100, late), submission(74, 1, 3, 21, "Accepted", 100, early)]);
      const result = await teams.assignment(member, { teamId: 10, id: 61 }); assert.equal(result.rows[0].total, 40); assert.equal(result.rows[0].problems[1].submissionId, 72);
      await assert.rejects(teams.assignment({ id: 7 }, { teamId: 10, id: 61 }), /assigned/i);
    });
    await t.test("an archival committed after the initial permission check prevents every actual discussion/reply mutation", async () => {
      const stale = await discussions.findDiscussionById(11), reply = await db.getRepository(DiscussionReplyEntity).findOneBy({ id: 81 });
      assert.equal(await discussions.userHasPermission(owner, stale, DiscussionPermissionType.Modify), true);
      await teams.archiveResource(owner, { teamId: 10, kind: "discussion", resourceId: 11, archived: true });
      await assert.rejects(discussions.updateDiscussionTitleAndContent(stale, "unauthorized changed title", "unauthorized content", undefined, owner));
      await assert.rejects(discussions.updateReplyContent(reply, "unauthorized reply", owner));
      await assert.rejects(discussions.addReply(owner, stale, "unauthorized new reply"));
      await assert.rejects(discussions.deleteReply(reply, owner));
      assert.equal((await db.getRepository(DiscussionEntity).findOneBy({ id: 11 })).title, "private team discussion");
      assert.equal((await db.getRepository(DiscussionContentEntity).findOneBy({ discussionId: 11 })).content, "preserved original discussion");
      assert.equal((await db.getRepository(DiscussionReplyEntity).findOneBy({ id: 81 })).content, "preserved original reply");
      await db.getRepository(TeamResourceEntity).update({ kind: "discussion", resourceId: 11 }, { archived: false });
    });
    await t.test("archive locking team before resource cannot deadlock a pending reply authorization", async () => {
      const signal = () => { let resolve; const promise = new Promise(done => resolve = done); return { resolve, promise }; };
      const bounded = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => reject(Error("coordination timeout")), 5000))]); } finally { clearTimeout(timer); } };
      const teamLocked = signal(), allowArchive = signal(), resourceLocated = signal();
      const originalActive = teams.activeAccess, originalConnection = discussions.connection;
      teams.activeAccess = async (...args) => { const result = await originalActive.apply(teams, args); teamLocked.resolve(); await allowArchive.promise; return result; };
      discussions.connection = { transaction: (level, callback) => db.transaction(level, manager => {
        const getRepository = manager.getRepository.bind(manager); let hooked = false;
        manager.getRepository = target => {
          const repo = getRepository(target);
          if (target === TeamResourceEntity && !hooked) {
            hooked = true; const findOne = repo.findOne.bind(repo);
            repo.findOne = async options => { const result = await findOne(options); resourceLocated.resolve(); return result; };
          }
          return repo;
        };
        return callback(manager);
      }) };
      const archival = teams.archiveResource(owner, { teamId: 10, kind: "discussion", resourceId: 11, archived: true });
      let writing;
      try {
        await bounded(teamLocked.promise);
        writing = discussions.updateReplyContent(await db.getRepository(DiscussionReplyEntity).findOneBy({ id: 81 }), "must not commit", owner);
        const observedWriting = writing.then(() => ({ fulfilled: true }), error => ({ error }));
        await bounded(resourceLocated.promise);
        allowArchive.resolve();
        await bounded(archival);
        const outcome = await bounded(observedWriting); assert.equal(outcome.error?.getStatus(), 403);
        assert.equal((await db.getRepository(DiscussionReplyEntity).findOneBy({ id: 81 })).content, "preserved original reply");
      } finally {
        allowArchive.resolve(); teams.activeAccess = originalActive; discussions.connection = originalConnection;
        await Promise.allSettled([archival, ...(writing ? [writing] : [])]);
        await db.getRepository(TeamResourceEntity).update({ kind: "discussion", resourceId: 11 }, { archived: false });
      }
    });
    await t.test("membership revoked after a check also prevents an original publisher's pending write", async () => {
      await db.getRepository(DiscussionEntity).update(11, { publisherId: member.id });
      const stale = await discussions.findDiscussionById(11); assert.equal(await discussions.userHasPermission(member, stale, DiscussionPermissionType.Modify), true);
      await db.getRepository(TeamMemberEntity).delete({ teamId: 10, userId: member.id });
      await assert.rejects(discussions.updateDiscussionTitleAndContent(stale, "departed publisher title", "departed publisher content", undefined, member));
      assert.equal((await db.getRepository(DiscussionContentEntity).findOneBy({ discussionId: 11 })).content, "preserved original discussion");
      await db.getRepository(TeamMemberEntity).save({ id: member.id, teamId: 10, userId: member.id, status: "member", permissions: [], groupId: null });
    });
    await t.test("problem HTTP save callbacks recheck team access inside the actual statement and judge transactions", async () => {
      await db.getRepository(ProblemEntity).save({ id: 3, ownerId: 2, isPublic: false, displayId: null, difficulty: 1, locales: ["zh_CN"], type: "Traditional" });
      await db.getRepository(TeamResourceEntity).save(resource(5, "problem", 3));
      await db.getRepository(ProblemJudgeInfoEntity).save({ problemId: 3, judgeInfo: { timeLimit: 1 }, submittable: true });
      await db.getRepository(ProblemFileEntity).save({ problemId: 3, type: ProblemFileType.TestData, filename: "original.in", uuid: "preserved-evidence" });
      Object.assign(problems, { problemJudgeInfoRepository: db.getRepository(ProblemJudgeInfoEntity), problemFileRepository: db.getRepository(ProblemFileEntity),
        findProblemTagsByExistingIds: async () => [], getProblemAllLocalizedContents: async () => [{ locale: "zh_CN", title: "original", contentSections: [] }],
        getProblemTagIdsByProblem: async () => [], getProblemSamples: async () => [],
        problemTypeFactoryService: { type: () => ({ validateAndFilterJudgeInfo: () => {}, getDefaultJudgeInfo: () => ({}) }) },
        redisService: { cacheDelete: async () => {} }, submissionService: submissions,
        lockService: { lockReadWrite: async (_key, _kind, callback) => callback(), lock: async (_key, callback) => callback() },
        fileService: { processUploadRequest: async () => { throw Error("storage called before authorization"); }, deleteFile: async () => { throw Error("storage deletion before authorization"); } }
      });
      const controller = Object.create(ProblemController.prototype);
      Object.assign(controller, { problemService: problems, userPrivilegeService: privileges, auditService: { log: async () => {} } });
      const restore = async () => {
        await db.getRepository(TeamMemberEntity).save({ id: 4, teamId: 10, userId: 4, status: "member", permissions: ["problems", "contests", "discussions", "assignments", "files"], groupId: null });
        await db.getRepository(TeamResourceEntity).update({ kind: "problem", resourceId: 3 }, { archived: false });
      };
      for (const revoke of [
        async () => db.getRepository(TeamMemberEntity).delete({ teamId: 10, userId: 4 }),
        async () => db.getRepository(TeamResourceEntity).update({ kind: "problem", resourceId: 3 }, { archived: true })
      ]) {
        for (const method of ["updateProblemStatement", "updateProblemJudgeInfo"]) {
          await restore(); const original = problems[method];
          problems[method] = async (...args) => { await revoke(); return original.apply(problems, args); };
          try {
            const request = method === "updateProblemStatement"
              ? { problemId: 3, problemTagIds: [], samples: [], localizedContents: [{ locale: "zh_CN", title: "changed", contentSections: [] }] }
              : { problemId: 3, judgeInfo: { timeLimit: 999 }, submittable: false };
            const endpoint = method === "updateProblemStatement" ? "updateStatement" : method;
            await assert.rejects(controller[endpoint](editor, request), error => error.getStatus?.() === 403);
            assert.deepEqual((await db.getRepository(ProblemJudgeInfoEntity).findOneBy({ problemId: 3 })).judgeInfo, { timeLimit: 1 });
          } finally { problems[method] = original; }
        }
        await restore(); const stale = await problems.findProblemById(3);
        assert.equal(await problems.userHasPermission(editor, stale, ProblemPermissionType.Modify), true);
        await revoke();
        for (const action of [
          () => problems.addProblemFile(stale, ProblemFileType.TestData, { uuid: "new-object", size: 10 }, "new.in", true, editor),
          () => problems.removeProblemFiles(stale, ProblemFileType.TestData, ["original.in"], editor),
          () => problems.renameProblemFile(stale, ProblemFileType.TestData, "original.in", "renamed.in", editor),
          () => problems.changeProblemType(stale, "SubmitAnswer", editor)
        ]) await assert.rejects(action(), error => error.getStatus?.() === 403);
        assert.equal((await db.getRepository(ProblemFileEntity).findOneBy({ problemId: 3, filename: "original.in" })).uuid, "preserved-evidence");
        assert.equal((await problems.findProblemById(3)).type, "Traditional");
      }
      await restore();
    });
    await t.test("global team managers and explicit team bans apply equally to direct reads and SQL counts", async () => {
      const outsider = { id: 20, isAdmin: false };
      await db.getRepository(UserPrivilegeEntity).save({ userId: 20, privilegeType: "ManageTeams" });
      assert.equal(await acl.teamResourceAccess(db, outsider, "problem", 1, "problems"), true);
      assert.equal((await teams.access(outsider, 10, "problems")).isTeamManager, true);
      assert.equal(Number((await db.query("SELECT " + acl.teamResourceVisibilitySql("problem", "1", outsider) + " AS allowed"))[0].allowed), 1);
      await db.getRepository(UserPermissionRuleEntity).save({ userId: 20, permission: "ViewTeam", allowed: false });
      assert.equal(await acl.teamResourceAccess(db, outsider, "problem", 1), false);
      assert.equal(Number((await db.query("SELECT " + acl.teamResourceVisibilitySql("problem", "1", outsider) + " AS allowed"))[0].allowed), 0);
      await assert.rejects(teams.access(outsider, 10), /Forbidden/);
      await db.getRepository(UserPermissionRuleEntity).delete({ userId: 20 });
      await db.getRepository(UserPrivilegeEntity).delete({ userId: 20 });
    });
    await t.test("membership removal immediately revokes resource and file access", async () => {
      assert.equal(await problems.userHasPermission(member, await problems.findProblemById(1), ProblemPermissionType.View), true);
      await db.getRepository(TeamMemberEntity).delete({ teamId: 10, userId: 3 });
      assert.equal(await problems.userHasPermission(member, await problems.findProblemById(1), ProblemPermissionType.View), false);
      await assert.rejects(teams.downloadFile(member, { teamId: 10, id: 41 }), /membership/i);
    });
  } finally {
    acl.teamResourceVisibilitySql = originalSql;
    if (db.isInitialized) {
      for (const [, name] of [...defs].reverse()) await db.query("DROP TABLE IF EXISTS `" + prefix + name + "`");
      const remaining = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LEFT(TABLE_NAME,?)=?", [prefix.length, prefix]);
      assert.equal(remaining.length, 0); await db.destroy();
    }
  }
});
