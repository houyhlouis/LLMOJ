// Opt-in workflows use a disposable database, actual TypeORM entities/services, and a local object-storage substitute.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
String.prototype.format ||= function (...args) { return require('node:util').format(this, ...args); };
const { DataSource } = require('typeorm');
const { TeamService, teamCsvCell } = require('./team.service.ts');
const { teamResourceAccess } = require('./team-access.ts');
const { TeamEntity, TeamMemberEntity, TeamResourceEntity, TeamFileEntity, TeamInvitationEntity, TeamFileUploadEntity, TEAM_FILE_QUOTA, TEAM_FILE_PART_SIZE } = require('./team.entity.ts');
const { UserEntity } = require('../user/user.entity.ts');
const { UserPrivilegeService, UserPrivilegeType: P } = require('../user/user-privilege.service.ts');
const { UserPrivilegeEntity } = require('../user/user-privilege.entity.ts');
const { UserPermissionRuleEntity } = require('../access/user-permission-rule.entity.ts');
const { GroupEntity } = require('../group/group.entity.ts');
const { GroupMembershipEntity } = require('../group/group-membership.entity.ts');
const { GroupService } = require('../group/group.service.ts');
const { ProblemEntity, ProblemType } = require('../problem/problem.entity.ts');
const { ProblemService, ProblemPermissionType } = require('../problem/problem.service.ts');
const { ProblemFileEntity, ProblemFileType } = require('../problem/problem-file.entity.ts');
const { ProblemJudgeInfoEntity } = require('../problem/problem-judge-info.entity.ts');
const { ProblemSampleEntity } = require('../problem/problem-sample.entity.ts');
const { ProblemTagMapEntity } = require('../problem/problem-tag-map.entity.ts');
const { ProblemTagEntity } = require('../problem/problem-tag.entity.ts');
const { LocalizedContentEntity } = require('../localized-content/localized-content.entity.ts');
const { DiscussionService, DiscussionPermissionType } = require('../discussion/discussion.service.ts');
const { DiscussionEntity } = require('../discussion/discussion.entity.ts');
const { DiscussionContentEntity } = require('../discussion/discussion-content.entity.ts');
const { DiscussionReplyEntity } = require('../discussion/discussion-reply.entity.ts');
const { ContestService } = require('../contest/contest.service.ts');
const { ContestAccessService } = require('../contest/contest-access.service.ts');
const { ContestProblemService } = require('../contest/contest-problem.service.ts');
const { ContestScoreService } = require('../contest/contest-score.service.ts');
const { ContestProblemEntity } = require('../contest/contest-problem.entity.ts');
const { SubmissionEntity } = require('../submission/submission.entity.ts');
const { FileService, MinioSignFor } = require('../file/file.service.ts');
const { FileEntity } = require('../file/file.entity.ts');

test('team creation, membership, private resources, assignments and files (real MariaDB)', {
  skip: !process.env.LLMOJ_TEAM_TEST_DB_CONFIG, timeout: 120000
}, async t => {
  const cfg = require('js-yaml').load(fs.readFileSync(process.env.LLMOJ_TEAM_TEST_DB_CONFIG, 'utf8')).services.database;
  if (!/^llmoj_(?:features|test)_/.test(cfg.database)) throw new Error('This test resets a disposable llmoj_features_* or llmoj_test_* database only.');
  const db = new DataSource({ ...cfg, entities: [path.join(__dirname, '../**/*.entity.ts')], synchronize: false, logging: false });
  const report = { cases: [] };
  try {
    await db.initialize(); await db.dropDatabase(); await db.synchronize();
    const userRepo = db.getRepository(UserEntity), ruleRepo = db.getRepository(UserPermissionRuleEntity);
    const users = [];
    for (let i = 0; i < 8; i++) users.push(await userRepo.save(userRepo.create({ username: 'team-user-' + i, email: 'team' + i + '@example.invalid', nickname: '', bio: '', avatarInfo: 'gravatar:', isAdmin: false, acceptedProblemCount: 0, submissionCount: 0, rating: 0, publicEmail: false, registrationTime: new Date() })));
    const [owner, applicant, member, moderator, outsider, invited, newcomer, banned] = users;
    const privilege = Object.create(UserPrivilegeService.prototype);
    Object.assign(privilege, { connection: db, userPrivilegeRepository: db.getRepository(UserPrivilegeEntity) });
    const objectData = new Map(), objectSizes = new Map(), signedSizes = new Map();
    const storage = {
      statObject: async (_bucket, id) => { if (!objectData.has(id) && !objectSizes.has(id)) throw new Error('The specified key does not exist.'); return { size: objectSizes.get(id) ?? objectData.get(id).length, etag: 'test-etag' }; },
      getObject: async (_bucket, id) => Readable.from(objectData.get(id)),
      fPutObject: async (_bucket, id, local) => objectData.set(id, await fsp.readFile(local)),
      putObject: async (_bucket, id, value) => { if (Buffer.isBuffer(value)) objectData.set(id, value); else { const chunks = []; for await (const chunk of value) chunks.push(chunk); objectData.set(id, Buffer.concat(chunks)); } },
      removeObject: async (_bucket, id) => objectData.delete(id),
      removeObjects: async (_bucket, ids) => ids.forEach(id => { objectData.delete(id); objectSizes.delete(id); }),
      composeObject: async (destination, sources) => objectSizes.set(destination.Object, sources.reduce((sum, source) => sum + (objectSizes.get(source.Object) ?? objectData.get(source.Object).length), 0)),
      presignedGetObject: async (_bucket, id, seconds) => { assert.equal(seconds, 60); return 'https://storage.example.invalid/' + id; }
    };
    const files = Object.create(FileService.prototype);
    Object.assign(files, { fileRepository: db.getRepository(FileEntity), bucket: 'test', minioClient: storage, minioSigner: { [MinioSignFor.UserDownload]: { client: storage, replaceUrl: url => url } } });
    files.signUploadRequest = async (min, max, objectUuid = crypto.randomUUID()) => { signedSizes.set(objectUuid, [min, max]); return { uuid: objectUuid, method: 'POST', url: 'https://storage.example.invalid/upload', extraFormData: {}, fileFieldName: 'file' }; };
    const localizedRepo = db.getRepository(LocalizedContentEntity);
    const localized = {
      get: async (objectId, type, locale) => (await localizedRepo.findOneBy({ objectId, type, locale }))?.data,
      getOfAllLocales: async (objectId, type) => Object.fromEntries((await localizedRepo.findBy({ objectId, type })).map(row => [row.locale, row.data])),
      createOrUpdate: async (objectId, type, locale, data, manager) => manager.save(LocalizedContentEntity, { objectId, type, locale, data })
    };
    const config = { config: { preference: { security: { allowEveryoneCreateDiscussion: true, discussionDefaultPublic: true, discussionReplyDefaultPublic: true, allowNonPrivilegedUserEditPublicProblem: false } } } };
    const problems = Object.create(ProblemService.prototype);
    Object.assign(problems, { connection: db, problemRepository: db.getRepository(ProblemEntity), problemJudgeInfoRepository: db.getRepository(ProblemJudgeInfoEntity), problemSampleRepository: db.getRepository(ProblemSampleEntity), problemFileRepository: db.getRepository(ProblemFileEntity), problemTagMapRepository: db.getRepository(ProblemTagMapEntity), userPrivilegeService: privilege, configService: config, localizedContentService: localized, permissionService: { userOrItsGroupsHavePermission: async () => false }, problemTypeFactoryService: { type: () => ({ getDefaultJudgeInfo: () => ({ timeLimit: 1000, memoryLimit: 128000 }) }) } });
    const discussions = Object.create(DiscussionService.prototype);
    Object.assign(discussions, { connection: db, discussionRepository: db.getRepository(DiscussionEntity), discussionContentRepository: db.getRepository(DiscussionContentEntity), discussionReplyRepository: db.getRepository(DiscussionReplyEntity), userPrivilegeService: privilege, problemService: problems, configService: config, permissionService: { userOrItsGroupsHavePermission: async () => false } });
    const userService = {
      findUsersByExistingIds: async ids => { const found = await userRepo.find(); return ids.map(id => found.find(user => user.id === id)); },
      getUserMeta: async user => ({ id: user.id, username: user.username, nickname: user.nickname })
    };
    const audit = { log: async () => {} };
    const teams = new TeamService(db, userService, privilege, problems, discussions, files, audit);
    const contestAccess = new ContestAccessService(db, privilege);
    const contestProblems = new ContestProblemService(db, contestAccess, problems, files);
    const contests = new ContestService(db, contestAccess, new ContestScoreService(db), contestProblems, {}, files);
    const groups = Object.create(GroupService.prototype);
    Object.assign(groups, { groupRepository: db.getRepository(GroupEntity), groupMembershipRepository: db.getRepository(GroupMembershipEntity) });
    const teamRepo = db.getRepository(TeamEntity), membershipRepo = db.getRepository(TeamMemberEntity);
    let teamId, privateProblemId, assignmentId, fileId, copiedProblemId;
    async function run(name, callback) { await t.test(name, async () => { await callback(); report.cases.push({ name, passed: true }); }); }
    const savedSettings = async extras => { const team = await teamRepo.findOneBy({ id: teamId }); return teams.save(owner, { teamId, name: team.name, description: team.description, announcement: team.announcement, joinPolicy: team.joinPolicy, groupChangeLocked: team.groupChangeLocked, ...extras }); };
    await run('create a team and atomically hide its permission group from generic group management', async () => {
      teamId = (await teams.create(owner, { name: 'Workflow Team', description: 'Private description', joinPolicy: 'approval' })).teamId;
      const team = await teamRepo.findOneBy({ id: teamId });
      assert.equal(team.memberCount, 1);
      assert.equal(await groups.findGroupById(team.permissionGroupId), null);
      assert.equal((await groups.getUserJoinedGroups(owner))[0].length, 0);
      assert.equal((await groups.getAllGroups()).length, 0);
      assert.equal((await groups.searchGroup('team:', 'Both', 20)).length, 0);
      assert.deepEqual((await teams.get(owner, teamId)).permissions, ['settings', 'members', 'problems', 'contests', 'assignments', 'discussions', 'files']);
      await assert.rejects(teams.get(outsider, teamId), /membership required/);
      await assert.rejects(teams.get(null, teamId), /membership required/);
      await assert.rejects(teams.list(null), /Login required/);
      assert.equal((await teams.list(outsider, false)).total, 0);
      assert.equal((await teams.list(owner, false)).total, 1);
      const preview = await teams.joinPreview(outsider, teamId);
      assert.deepEqual(preview, { team: { id: teamId, name: 'Workflow Team', joinPolicy: 'approval' }, membership: null });
      await assert.rejects(teams.joinPreview(null, teamId), /Login required/);
      await assert.rejects(teams.create(applicant, { name: 'Workflow Team' }), /already exists/);
    });
    await run('apply, approve, and keep membership/count/group grants consistent under duplicate concurrent joins', async () => {
      assert.deepEqual(await teams.join(applicant, { teamId, message: 'Please approve' }), { status: 'applicant' });
      const pending = await teams.get(applicant, teamId);
      assert.deepEqual(Object.keys(pending.team).sort(), ['id', 'joinPolicy', 'name']);
      assert.deepEqual(pending.membership, { status: 'applicant', userId: applicant.id, application: 'Please approve' });
      assert.deepEqual(pending.groups, []); assert.deepEqual(pending.permissions, []);
      assert(Object.values(pending.resources).every(resources => resources.length === 0));
      const pendingList = await teams.list(applicant, false, 'Workflow');
      assert.equal(pendingList.total, 1);
      assert.deepEqual(Object.keys(pendingList.teams[0]).sort(), ['id', 'joinPolicy', 'membershipStatus', 'name']);
      assert.equal((await teams.joinPreview(applicant, teamId)).membership.application, 'Please approve');
      await assert.rejects(teams.members(applicant, teamId), /membership required/);
      await teams.join(banned, { teamId, message: 'Temporary application' });
      await teams.leave(banned, teamId);
      assert.equal((await teams.list(banned, false)).total, 0);
      await assert.rejects(teams.get(banned, teamId), /membership required/);
      await teams.manageMembers(owner, { teamId, userIds: [applicant.id], action: 'approve' });
      await savedSettings({ joinPolicy: 'open' });
      const joins = await Promise.allSettled([teams.join(member, { teamId }), teams.join(member, { teamId })]);
      assert(joins.every(result => result.status === 'fulfilled'));
      await teams.join(moderator, { teamId });
      const team = await teamRepo.findOneBy({ id: teamId });
      assert.equal(team.memberCount, 4);
      assert.equal(await db.getRepository(GroupMembershipEntity).countBy({ groupId: team.permissionGroupId }), 4);
      assert.equal(await membershipRepo.countBy({ teamId, userId: member.id }), 1);
      assert.equal((await teams.list(newcomer, false, 'Workflow')).total, 0);
      await assert.rejects(teams.get(newcomer, teamId), /membership required/);
      assert.equal((await teams.joinPreview(newcomer, teamId)).team.joinPolicy, 'open');
    });
    await run('only the owner delegates administration; blacklist, groups, notes and locked group changes are atomic', async () => {
      await teams.manageMembers(owner, { teamId, userIds: [moderator.id], action: 'permissions', permissions: ['members', 'problems'] });
      await assert.rejects(teams.manageMembers(moderator, { teamId, userIds: [member.id], action: 'permissions', permissions: ['settings'] }), /Only the owner/);
      await assert.rejects(teams.manageMembers(moderator, { teamId, userIds: [owner.id], action: 'remove' }), /owner cannot/);
      const groupId = (await teams.saveGroup(owner, { teamId, name: 'Group A' })).id;
      await teams.changeGroup(member, { teamId, groupId });
      await teams.manageMembers(owner, { teamId, userIds: [applicant.id, member.id], action: 'note', note: '=external-link' });
      await savedSettings({ groupChangeLocked: true });
      await assert.rejects(teams.changeGroup(member, { teamId, groupId: null }), /locked/);
      await teams.manageMembers(moderator, { teamId, userIds: [applicant.id], action: 'setGroup', groupId });
      await teams.manageMembers(owner, { teamId, userIds: [outsider.id], action: 'block' });
      await assert.rejects(teams.join(outsider, { teamId }), /blacklist/);
      await assert.rejects(teams.joinPreview(outsider, teamId), /blacklist/);
      await teams.manageMembers(owner, { teamId, userIds: [outsider.id], action: 'unblock' });
      await assert.rejects(teams.manageMembers(owner, { teamId, userIds: [applicant.id, 999999], action: 'remove' }), /not found/);
      assert.equal((await membershipRepo.findOneBy({ teamId, userId: applicant.id })).status, 'member');
    });
    await run('targeted and shared invitations bypass closed joins but enforce recipient, blacklist and use counts', async () => {
      await savedSettings({ joinPolicy: 'closed' });
      await assert.rejects(teams.join(invited, { teamId }), /not accepting/);
      const single = (await teams.createInvitation(owner, { teamId, userId: invited.id })).invitation;
      await assert.rejects(teams.acceptInvitation(newcomer, single.token), /another user/);
      await teams.acceptInvitation(invited, single.token);
      assert.equal((await db.getRepository(TeamInvitationEntity).findOneBy({ id: single.id })).uses, 1);
      const shared = (await teams.createInvitation(owner, { teamId, maxUses: 1 })).invitation;
      const joins = await Promise.allSettled([teams.acceptInvitation(outsider, shared.token), teams.acceptInvitation(newcomer, shared.token)]);
      assert.equal(joins.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((await db.getRepository(TeamInvitationEntity).findOneBy({ id: shared.id })).uses, 1);
      await teams.manageMembers(owner, { teamId, userIds: [banned.id], action: 'block' });
      const blocked = (await teams.createInvitation(owner, { teamId, userId: banned.id })).invitation;
      await assert.rejects(teams.acceptInvitation(banned, blocked.token), /blacklist/);
      await teams.deactivateInvitation(owner, { teamId, id: blocked.id });
      await assert.rejects(teams.acceptInvitation(banned, blocked.token), /expired/);
    });
    await run('create and fully copy private problem statements, samples, judge metadata, tags and independent objects', async () => {
      privateProblemId = (await teams.createProblem(owner, { teamId })).problemId;
      const source = await problems.findProblemById(privateProblemId);
      const objectId = crypto.randomUUID(); objectData.set(objectId, Buffer.from('judge-input'));
      await db.getRepository(FileEntity).save({ uuid: objectId, size: 11, uploadTime: new Date() });
      await db.getRepository(ProblemFileEntity).save({ problemId: source.id, type: ProblemFileType.TestData, filename: '1.in', uuid: objectId });
      await db.getRepository(ProblemSampleEntity).update(source.id, { data: [{ inputData: '1', outputData: '2' }] });
      await db.getRepository(ProblemJudgeInfoEntity).update(source.id, { judgeInfo: { timeLimit: 2000, memoryLimit: 256000, testcases: ['1.in'] }, submittable: true });
      const tag = await db.getRepository(ProblemTagEntity).save({ locales: ['zh_CN'], color: 'red' });
      await db.getRepository(ProblemTagMapEntity).save({ problemId: source.id, problemTagId: tag.id });
      copiedProblemId = (await teams.createProblem(owner, { teamId, sourceProblemId: source.id })).problemId;
      const copy = await problems.findProblemById(copiedProblemId);
      assert.equal(copy.isPublic, false); assert.equal(copy.displayId, null); assert.equal(copy.submissionCount, 0);
      assert.deepEqual((await db.getRepository(ProblemSampleEntity).findOneBy({ problemId: copy.id })).data, [{ inputData: '1', outputData: '2' }]);
      assert.deepEqual((await db.getRepository(ProblemJudgeInfoEntity).findOneBy({ problemId: copy.id })).judgeInfo, { timeLimit: 2000, memoryLimit: 256000, testcases: ['1.in'] });
      assert.equal((await db.getRepository(ProblemTagMapEntity).findOneBy({ problemId: copy.id })).problemTagId, tag.id);
      assert.deepEqual(await problems.getProblemAllLocalizedContents(copy), await problems.getProblemAllLocalizedContents(source));
      const copiedFile = await db.getRepository(ProblemFileEntity).findOneBy({ problemId: copy.id, filename: '1.in' });
      assert.notEqual(copiedFile.uuid, objectId); assert.deepEqual(objectData.get(copiedFile.uuid), objectData.get(objectId));
      assert.equal(await problems.userHasPermission(member, copy, ProblemPermissionType.View), true);
      assert.equal(await problems.userHasPermission(banned, copy, ProblemPermissionType.View), false);
      assert.equal(await problems.userHasPermission(member, copy, ProblemPermissionType.Modify), false);
      await assert.rejects(teams.createProblem(member, { teamId, sourceProblemId: source.id }), /permission required/);
      await teams.archiveResource(owner, { teamId, kind: 'problem', resourceId: copy.id, archived: true });
      assert.equal(await problems.userHasPermission(member, copy, ProblemPermissionType.View), false);
      await teams.archiveResource(owner, { teamId, kind: 'problem', resourceId: copy.id, archived: false });
      assert.equal(await problems.userHasPermission(member, copy, ProblemPermissionType.View), true);
    });
    await run('team contests support private, public, explicit invite and shared invitations without exposing source problems', async () => {
      const contestId = (await teams.createContest(owner, { teamId, title: 'Team Contest', rule: 'ioi', startTime: '2026-01-01T00:00:00Z', endTime: '2099-01-01T00:00:00Z', visibility: 'private' })).contestId;
      assert.equal((await contestAccess.get(member, contestId)).manager, false);
      await assert.rejects(contestAccess.get(banned, contestId));
      await contestProblems.saveProblem(owner, contestId, { problemId: privateProblemId, position: 1, weight: 100 });
      await teams.updateContestAccess(owner, { teamId, contestId, visibility: 'public', invitedUserIds: [] });
      assert.equal((await contestAccess.get(null, contestId)).manager, false);
      const cp = await db.getRepository(ContestProblemEntity).findOneBy({ contestId, problemId: privateProblemId });
      assert.equal((await contestProblems.problem(null, contestId, cp.id, 'zh_CN')).title, '新建团队题目');
      assert.equal(await problems.userHasPermission(null, await problems.findProblemById(privateProblemId), ProblemPermissionType.View), false);
      const code = (await teams.updateContestAccess(owner, { teamId, contestId, visibility: 'invite', invitedUserIds: [] })).inviteCode;
      await assert.rejects(contestAccess.get(banned, contestId));
      const stranger = await membershipRepo.findOneBy({ teamId, userId: outsider.id }) ? newcomer : outsider;
      await teams.acceptContestInvitation(stranger, code);
      assert.equal((await contestAccess.get(stranger, contestId)).manager, false);
      await assert.rejects(teams.acceptContestInvitation(banned, code));
      await assert.rejects(contests.delete(owner, contestId), /Archive team contests/);
    });
    await run('copy and source editing keep one lock order and safely retry serialization conflicts', async () => {
      const transaction = db.transaction.bind(db);
      let editorReady, copyAttempt;
      const ready = new Promise(resolve => { editorReady = resolve; });
      const attempted = new Promise(resolve => { copyAttempt = resolve; });
      db.transaction = async (isolation, callback) => transaction(isolation, async manager => {
        const find = manager.findOne.bind(manager);
        manager.findOne = (entity, options) => {
          if (entity === ProblemEntity && options?.where?.id === privateProblemId && options?.lock?.mode === 'pessimistic_read') copyAttempt();
          return find(entity, options);
        };
        return callback(manager);
      });
      try {
        const editing = transaction('READ COMMITTED', async manager => {
          await manager.findOne(ProblemEntity, { where: { id: privateProblemId }, lock: { mode: 'pessimistic_write' } });
          editorReady();
          await attempted;
          assert.equal(await teamResourceAccess(manager, owner, 'problem', privateProblemId, 'problems'), true);
          await manager.update(ProblemEntity, privateProblemId, { difficulty: 3000 });
        });
        await ready;
        const copying = teams.createProblem(owner, { teamId, sourceProblemId: privateProblemId });
        const result = await Promise.allSettled([editing, copying]);
        assert.equal(result[0].status, 'fulfilled', 'Source editor must complete without the former copy/team lock cycle.');
        let copied;
        if (result[1].status === 'rejected') {
          assert.equal(result[1].reason.getStatus?.(), 409, 'A serialization conflict must be safely retryable.');
          copied = await teams.createProblem(owner, { teamId, sourceProblemId: privateProblemId });
        } else copied = result[1].value;
        const copy = await problems.findProblemById(copied.problemId);
        assert.equal(copy.difficulty, 3000);
      } finally { db.transaction = transaction; }
    });
    await run('team discussions share existing discussion/reply infrastructure and obey site posting bans', async () => {
      const discussionId = (await teams.createDiscussion(member, { teamId, title: 'Private topic', content: 'Body', problemId: privateProblemId })).discussionId;
      const discussion = await discussions.findDiscussionById(discussionId);
      assert.equal(discussion.isPublic, false);
      assert.equal(await discussions.userHasPermission(member, discussion, DiscussionPermissionType.View), true);
      assert.equal(await discussions.userHasPermission(banned, discussion, DiscussionPermissionType.View), false);
      const reply = await discussions.addReply(member, discussion, 'Reply');
      await discussions.updateReplyContent(reply, 'Updated', member);
      assert.equal((await discussions.findDiscussionReplyById(reply.id)).content, 'Updated');
      await ruleRepo.save({ userId: member.id, permission: P.CreateDiscussion, allowed: false });
      await assert.rejects(teams.createDiscussion(member, { teamId, title: 'Denied', content: '' }), /disabled/);
      await ruleRepo.delete({ userId: member.id, permission: P.CreateDiscussion });
      await teams.archiveResource(owner, { teamId, kind: 'discussion', resourceId: discussionId, archived: true });
      await assert.rejects(discussions.addReply(member, discussion, 'Must not commit'));
      await assert.rejects(discussions.updateReplyContent(reply, 'Must not commit', member));
      await teams.archiveResource(owner, { teamId, kind: 'discussion', resourceId: discussionId, archived: false });
    });
    await run('ordered homework, targeted groups, deadline scoring, Fake zero and formula-safe CSV', async () => {
      const memberGroup = (await membershipRepo.findOneBy({ teamId, userId: member.id })).groupId;
      assignmentId = (await teams.saveAssignment(owner, { teamId, title: 'Homework', description: 'Ordered problems', items: [{ problemId: copiedProblemId, section: 'First', note: '' }, { problemId: privateProblemId, section: 'Second', note: 'Practice' }], assignedUserIds: [], assignedGroupIds: [memberGroup], deadline: '2026-10-01T00:00:00Z' })).id;
      const submit = async (problemId, status, score, time, contestId = null) => db.getRepository(SubmissionEntity).save({ problemId, submitterId: member.id, contestId, isPublic: false, status, score, submitTime: new Date(time) });
      await submit(copiedProblemId, 'PartiallyCorrect', 60, '2026-09-01T00:00:00Z');
      await submit(copiedProblemId, 'Accepted', 100, '2026-10-02T00:00:00Z');
      await submit(privateProblemId, 'Fake', 0, '2026-09-01T00:00:00Z');
      await submit(privateProblemId, 'Accepted', 100, '2026-09-01T00:00:00Z', 999);
      const own = await teams.assignment(member, { teamId, id: assignmentId });
      assert.deepEqual(own.assignment.items.map(item => item.problemId), [copiedProblemId, privateProblemId]);
      assert.equal(own.rows.length, 1); assert.equal(own.rows[0].total, 60); assert.equal(own.rows[0].problems[privateProblemId].score, 0);
      await assert.rejects(teams.assignment(invited, { teamId, id: assignmentId }), /not assigned/);
      const csv = (await teams.exportAssignment(owner, { teamId, id: assignmentId })).csv;
      assert(csv.startsWith('\ufeff')); assert(csv.includes("'=external-link"));
      assert.equal(teamCsvCell(' \t=1+1'), '"\' \t=1+1"');
    });
    await run('member uploads and downloads, private links, quota checks and recoverable file archives', async () => {
      const prepared = await teams.prepareFileUpload(member, { teamId, size: 4 });
      objectData.set(prepared.signedUploadRequest.uuid, Buffer.from('data'));
      fileId = (await teams.uploadFile(member, { teamId, name: 'notes.txt', uploadInfo: { uuid: prepared.signedUploadRequest.uuid, size: 4 } })).fileId;
      assert.equal((await teamRepo.findOneBy({ id: teamId })).quotaUsed, '4');
      assert((await teams.downloadFile(member, { teamId, id: fileId })).url.includes(prepared.signedUploadRequest.uuid));
      await assert.rejects(teams.downloadFile(banned, { teamId, id: fileId }), /membership required/);
      const large = await teams.prepareFileUpload(member, { teamId, size: 64 * 1024 * 1024 + 1 });
      assert.equal(large.uploadSession.partCount, 3);
      await teams.cancelFileUpload(member, { teamId, uuid: large.uploadSession.uuid });
      await teamRepo.update(teamId, { quotaLimit: 4 });
      await assert.rejects(teams.prepareFileUpload(member, { teamId, size: 1 }), /TEAM_QUOTA_EXCEEDED/);
      await teams.archiveFile(owner, { teamId, id: fileId, archived: true });
      assert.equal((await teamRepo.findOneBy({ id: teamId })).quotaUsed, '4');
      await assert.rejects(teams.downloadFile(member, { teamId, id: fileId }));
      await teams.archiveFile(owner, { teamId, id: fileId, archived: false });
      assert.equal((await db.getRepository(TeamFileEntity).findOneBy({ id: fileId })).archived, false);
    });
    let fileTeamId;
    await run('team total quota is 10 GiB and reservations serialize concurrent capacity claims', async () => {
      fileTeamId = (await teams.create(owner, { name: 'Large File Team', joinPolicy: 'open' })).teamId;
      await teams.join(member, { teamId: fileTeamId });
      assert.equal(Number((await teamRepo.findOneBy({ id: fileTeamId })).quotaLimit), TEAM_FILE_QUOTA);
      const reservations = await Promise.allSettled([0, 1].map(() => teams.prepareFileUpload(owner, { teamId: fileTeamId, size: 6 * 1024 ** 3 })));
      assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 1);
      assert.match(reservations.find(r => r.status === 'rejected').reason.message, /TEAM_QUOTA_EXCEEDED/);
      await teams.cancelFileUpload(owner, { teamId: fileTeamId, uuid: reservations.find(r => r.status === 'fulfilled').value.uploadSession.uuid });
      const exact = await teams.prepareFileUpload(owner, { teamId: fileTeamId, size: TEAM_FILE_QUOTA });
      assert.equal(exact.uploadSession.partCount, 320);
      await assert.rejects(teams.prepareFileUpload(member, { teamId: fileTeamId, size: 1 }), /TEAM_QUOTA_EXCEEDED/);
      await teams.cancelFileUpload(owner, { teamId: fileTeamId, uuid: exact.uploadSession.uuid });
    });
    await run('chunk policies and completion bind UUIDs to their team, user, size and active membership', async () => {
      const size = TEAM_FILE_PART_SIZE + 7;
      const prepared = await teams.prepareFileUpload(owner, { teamId: fileTeamId, size });
      const objectUuid = prepared.uploadSession.uuid;
      const first = await teams.prepareFileUploadPart(owner, { teamId: fileTeamId, uuid: objectUuid, part: 1 });
      const last = await teams.prepareFileUploadPart(owner, { teamId: fileTeamId, uuid: objectUuid, part: 2 });
      assert.deepEqual(signedSizes.get(first.signedUploadRequest.uuid), [TEAM_FILE_PART_SIZE, TEAM_FILE_PART_SIZE]);
      assert.deepEqual(signedSizes.get(last.signedUploadRequest.uuid), [7, 7]);
      await assert.rejects(teams.prepareFileUploadPart(member, { teamId: fileTeamId, uuid: objectUuid, part: 1 }), /FILE_UPLOAD_EXPIRED/);
      await teams.cancelFileUpload(member, { teamId: fileTeamId, uuid: objectUuid });
      assert(await db.getRepository(TeamFileUploadEntity).findOneBy({ uuid: objectUuid }));
      await assert.rejects(teams.prepareFileUploadPart(owner, { teamId, uuid: objectUuid, part: 1 }), /FILE_UPLOAD_EXPIRED/);
      await assert.rejects(teams.uploadFile(owner, { teamId: fileTeamId, name: 'wrong-size', uploadInfo: { uuid: objectUuid, size: size + 1 } }), /FILE_SIZE_MISMATCH/);
      objectSizes.set(first.signedUploadRequest.uuid, TEAM_FILE_PART_SIZE);
      objectSizes.set(last.signedUploadRequest.uuid, 8);
      await assert.rejects(teams.uploadFile(owner, { teamId: fileTeamId, name: 'wrong-bytes', uploadInfo: { uuid: objectUuid, size } }), /FILE_SIZE_MISMATCH/);
      assert.equal(Number((await teamRepo.findOneBy({ id: fileTeamId })).quotaUsed), 0);
      await teams.cancelFileUpload(owner, { teamId: fileTeamId, uuid: objectUuid });
      assert.equal(objectSizes.has(first.signedUploadRequest.uuid), false);
      const own = await teams.prepareFileUpload(member, { teamId: fileTeamId, size });
      await teams.manageMembers(owner, { teamId: fileTeamId, userIds: [member.id], action: 'remove' });
      await assert.rejects(teams.prepareFileUploadPart(member, { teamId: fileTeamId, uuid: own.uploadSession.uuid, part: 1 }), /membership required/);
      await assert.rejects(teams.uploadFile(member, { teamId: fileTeamId, name: 'revoked', uploadInfo: { uuid: own.uploadSession.uuid, size } }), /membership required/);
      await teams.join(member, { teamId: fileTeamId });
      await teams.cancelFileUpload(member, { teamId: fileTeamId, uuid: own.uploadSession.uuid });
    });
    await run('expired reservations release capacity and cannot complete or expose registered objects', async () => {
      const prepared = await teams.prepareFileUpload(owner, { teamId: fileTeamId, size: TEAM_FILE_QUOTA });
      const reservation = await db.getRepository(TeamFileUploadEntity).findOneBy({ uuid: prepared.uploadSession.uuid });
      objectSizes.set(reservation.parts[0], TEAM_FILE_PART_SIZE);
      await db.getRepository(TeamFileUploadEntity).update(reservation.uuid, { expiresAt: new Date(Date.now() - 1000) });
      await assert.rejects(teams.uploadFile(owner, { teamId: fileTeamId, name: 'expired', uploadInfo: { uuid: reservation.uuid, size: reservation.size } }), /FILE_UPLOAD_EXPIRED/);
      const next = await teams.prepareFileUpload(member, { teamId: fileTeamId, size: 1 });
      assert.equal(await db.getRepository(TeamFileUploadEntity).findOneBy({ uuid: reservation.uuid }), null);
      assert.equal(objectSizes.has(reservation.parts[0]), false);
      await teams.cancelFileUpload(member, { teamId: fileTeamId, uuid: next.uploadSession.uuid });
      const protectedFile = await db.getRepository(FileEntity).findOneBy({ uuid: (await db.getRepository(TeamFileEntity).findOneBy({ id: fileId })).uuid });
      await assert.rejects(teams.uploadFile(owner, { teamId: fileTeamId, name: 'forged', uploadInfo: { uuid: protectedFile.uuid, size: protectedFile.size } }), /FILE_UPLOAD_EXPIRED/);
      assert(await db.getRepository(FileEntity).findOneBy({ uuid: protectedFile.uuid }));
    });
    await run('a file larger than 5 GiB persists as numeric bigint without buffering its bytes', async () => {
      const size = 6 * 1024 ** 3 + 1;
      const prepared = await teams.prepareFileUpload(member, { teamId: fileTeamId, size });
      const reservation = await db.getRepository(TeamFileUploadEntity).findOneBy({ uuid: prepared.uploadSession.uuid });
      reservation.parts.forEach((part, index) => objectSizes.set(part, Math.min(TEAM_FILE_PART_SIZE, size - index * TEAM_FILE_PART_SIZE)));
      const completed = await teams.uploadFile(member, { teamId: fileTeamId, name: 'large-data.bin', uploadInfo: { uuid: reservation.uuid, size } });
      assert.equal((await db.getRepository(TeamFileEntity).findOneBy({ id: completed.fileId })).size, size);
      assert.equal((await db.getRepository(FileEntity).findOneBy({ uuid: reservation.uuid })).size, size);
      assert.equal(Number((await teamRepo.findOneBy({ id: fileTeamId })).quotaUsed), size);
      assert.equal(reservation.parts.some(part => objectSizes.has(part)), false);
      assert.equal(await db.getRepository(TeamFileUploadEntity).findOneBy({ uuid: reservation.uuid }), null);
      await assert.rejects(teams.uploadFile(member, { teamId: fileTeamId, name: 'duplicate', uploadInfo: { uuid: reservation.uuid, size } }), /FILE_UPLOAD_EXPIRED/);
      assert.equal(Number((await teamRepo.findOneBy({ id: fileTeamId })).quotaUsed), size);
      assert((await teams.downloadFile(member, { teamId: fileTeamId, id: completed.fileId })).url.includes(reservation.uuid));
      await teams.archiveFile(owner, { teamId: fileTeamId, id: completed.fileId, archived: true });
      assert.equal(Number((await teamRepo.findOneBy({ id: fileTeamId })).quotaUsed), size);
    });
    await run('concurrent completions consume their reservations exactly once and finish at the total quota', async () => {
      const used = Number((await teamRepo.findOneBy({ id: fileTeamId })).quotaUsed);
      const sizes = [2 * 1024 ** 3, TEAM_FILE_QUOTA - used - 2 * 1024 ** 3];
      const prepared = await Promise.all(sizes.map(size => teams.prepareFileUpload(member, { teamId: fileTeamId, size })));
      const pending = await Promise.all(prepared.map(result => db.getRepository(TeamFileUploadEntity).findOneBy({ uuid: result.uploadSession.uuid })));
      pending.forEach(upload => upload.parts.forEach((part, index) => objectSizes.set(part, Math.min(TEAM_FILE_PART_SIZE, upload.size - index * TEAM_FILE_PART_SIZE))));
      const completed = await Promise.all(pending.map((upload, index) => teams.uploadFile(member, { teamId: fileTeamId, name: 'parallel-' + index + '.bin', uploadInfo: { uuid: upload.uuid, size: upload.size } })));
      assert.equal(completed.length, 2);
      assert.equal(Number((await teamRepo.findOneBy({ id: fileTeamId })).quotaUsed), TEAM_FILE_QUOTA);
      assert.equal(await db.getRepository(TeamFileUploadEntity).countBy({ teamId: fileTeamId }), 0);
      await assert.rejects(teams.prepareFileUpload(owner, { teamId: fileTeamId, size: 1 }), /TEAM_QUOTA_EXCEEDED/);
    });
    await run('ViewSite revocation blocks all team entry points and transferring ownership removes old-owner shortcuts', async () => {
      const pending = await teams.prepareFileUpload(member, { teamId: fileTeamId, size: 0 });
      await ruleRepo.save({ userId: member.id, permission: P.ViewSite, allowed: false });
      for (const action of [() => teams.get(member, teamId), () => teams.list(member, true), () => teams.create(member, { name: 'Forbidden' }), () => teams.join(member, { teamId }), () => teams.prepareFileUpload(member, { teamId, size: 0 })]) await assert.rejects(action());
      for (const action of [() => teams.prepareFileUploadPart(member, { teamId: fileTeamId, uuid: pending.uploadSession.uuid, part: 1 }),
        () => teams.uploadFile(member, { teamId: fileTeamId, name: 'banned', uploadInfo: { uuid: pending.uploadSession.uuid, size: 0 } }),
        () => teams.cancelFileUpload(member, { teamId: fileTeamId, uuid: pending.uploadSession.uuid })]) await assert.rejects(action());
      await ruleRepo.delete({ userId: member.id, permission: P.ViewSite });
      await teams.cancelFileUpload(member, { teamId: fileTeamId, uuid: pending.uploadSession.uuid });
      await teams.transfer(owner, { teamId, userId: applicant.id });
      await assert.rejects(teams.manageMembers(owner, { teamId, userIds: [member.id], action: 'permissions', permissions: ['settings'] }));
      await teams.leave(owner, teamId);
      assert.equal(await teamResourceAccess(db, owner, 'problem', privateProblemId), false);
      await assert.rejects(teams.downloadFile(owner, { teamId, id: fileId }));
      await teams.save(applicant, { teamId, name: 'Workflow Team', description: '', announcement: '', joinPolicy: 'closed', groupChangeLocked: true, archived: true });
      await assert.rejects(teams.list(null), /Login required/);
      await assert.rejects(teams.get(member, teamId));
      await teams.save(applicant, { teamId, name: 'Workflow Team', description: '', announcement: '', joinPolicy: 'closed', groupChangeLocked: true, archived: false });
      assert.equal((await teams.get(member, teamId)).team.archived, false);
    });
    if (process.env.LLMOJ_TEAM_TEST_REPORT) fs.writeFileSync(process.env.LLMOJ_TEAM_TEST_REPORT, JSON.stringify(report, null, 2));
  } finally {
    if (db.isInitialized) { await db.dropDatabase(); await db.destroy(); }
  }
});
