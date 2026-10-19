// Compare SQL count/pagination with the existing independent detail View ACL.
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { DataSource } = require("typeorm");
const { DiscussionService, DiscussionPermissionType } = require("./discussion.service.ts");
const { ProblemService } = require("../problem/problem.service.ts");
const { bareProblemServices } = require("../problem/problem-test-services.cjs");
const { UserPrivilegeService } = require("../user/user-privilege.service.ts");
const { PermissionService } = require("../permission/permission.service.ts");
const { GroupService } = require("../group/group.service.ts");
const { DiscussionEntity } = require("./discussion.entity.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { UserPrivilegeEntity } = require("../user/user-privilege.entity.ts");
const { GroupMembershipEntity } = require("../group/group-membership.entity.ts");
const { PermissionForUserEntity } = require("../permission/permission-for-user.entity.ts");
const { PermissionForGroupEntity } = require("../permission/permission-for-group.entity.ts");
test("all discussion pages/counts apply private-problem/team/global/object ACLs before pagination (real MariaDB)",
  { skip: !process.env.HYHOJ_DISCUSSION_TEST_DB_CONFIG, timeout: 90000 }, async () => {
  const config = require("js-yaml").load(fs.readFileSync(process.env.HYHOJ_DISCUSSION_TEST_DB_CONFIG, "utf8")).services.database;
  assert.equal(config.database, "llmoj_features_discussion", "Only use the dedicated disposable discussion database");
  const db = new DataSource({ ...config, entities: [path.join(__dirname, "../**/*.entity.ts")], synchronize: false, logging: false });
  let owned = false;
  try {
    await db.initialize();
    assert.equal((await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()")).length, 0, "Existing tables are never removed");
    owned = true;
    await db.synchronize(false);
    for (let id = 1; id <= 9; id++) await db.query("INSERT INTO user(id,username,email,nickname,bio,avatarInfo,isAdmin,acceptedProblemCount,submissionCount,rating,publicEmail) VALUES (?,?,?,'','','gravatar:',?,0,0,0,0)", [id, "viewer_" + id, "viewer_" + id + "@example.invalid", id === 1]);
    for (const [id, ownerId, isPublic] of [[20, 2, true], [21, 2, false], [22, 2, false], [23, 3, true], [24, 8, false]])
      await db.query("INSERT INTO problem(id,type,isPublic,ownerId,locales,submissionCount,acceptedSubmissionCount) VALUES (?,'Traditional',?,?,'[\"zh_CN\"]',0,0)", [id, isPublic, ownerId]);
    await db.query("INSERT INTO `group`(id,name,memberCount) VALUES (50,'ACL fixture',1)");
    await db.query("INSERT INTO group_membership(groupId,userId,isGroupAdmin) VALUES (50,7,0)");
    await db.query("INSERT INTO permission_for_user(objectId,objectType,userId,permissionLevel) VALUES (22,'Problem',6,1),(106,'Discussion',6,1)");
    await db.query("INSERT INTO permission_for_group(objectId,objectType,groupId,permissionLevel) VALUES (22,'Problem',50,1),(108,'Discussion',50,1)");
    await db.query("INSERT INTO user_privilege(userId,privilegeType) VALUES (5,'ManageProblem'),(5,'ManageDiscussion')");
    await db.query("INSERT INTO team(id,name,description,announcement,ownerId,permissionGroupId,createdAt) VALUES (100,'Private fixture','','',8,50,NOW())");
    for (const userId of [8, 9]) await db.query("INSERT INTO team_member(teamId,userId,status,permissions,joinedAt) VALUES (100,?,'member','[]',NOW())", [userId]);
    for (const [id, problemId, isPublic, publisherId] of [
      [100,20,true,3], [101,21,true,3], [102,21,false,2], [103,22,true,3], [104,23,true,3],
      [105,24,true,8], [106,20,false,3], [107,null,true,3], [108,null,false,2],
      [109,20,true,3], [110,20,false,8], [111,20,false,8], [112,null,false,3]
    ]) await db.query("INSERT INTO discussion(id,title,type,publishTime,sortTime,replyCount,isPublic,publisherId,problemId) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)", [
      id, "Visibility fixture " + id, problemId ? "Solution" : "Discussion", new Date(1700000000000 + id * 1000),
      new Date(1700000000000 + id * 1000), isPublic, publisherId, problemId
    ]);
    for (const [kind, resourceId] of [["problem",23], ["problem",24], ["discussion",109], ["discussion",110]])
      await db.query("INSERT INTO team_resource(teamId,kind,resourceId,invitedUserIds) VALUES (100,?,?,'[]')", [kind, resourceId]);
    const privileges = Object.assign(Object.create(UserPrivilegeService.prototype), { connection: db, userPrivilegeRepository: db.getRepository(UserPrivilegeEntity) });
    const groups = Object.assign(Object.create(GroupService.prototype), { groupMembershipRepository: db.getRepository(GroupMembershipEntity) });
    const permissions = Object.assign(Object.create(PermissionService.prototype), { connection: db, groupService: groups,
      permissionForUserRepository: db.getRepository(PermissionForUserEntity), permissionForGroupRepository: db.getRepository(PermissionForGroupEntity) });
    const problems = Object.assign(bareProblemServices(), { connection: db, problemRepository: db.getRepository(ProblemEntity), userPrivilegeService: privileges, permissionService: permissions });
    const service = Object.assign(Object.create(DiscussionService.prototype), { connection: db, discussionRepository: db.getRepository(DiscussionEntity),
      userPrivilegeService: privileges, permissionService: permissions, problemService: problems, problemAccess: problems, problemFiles: problems, problemTags: problems, problemLocks: problems });
    const users = await db.getRepository(UserEntity).find({ order: { id: "ASC" } });
    const rows = await db.getRepository(DiscussionEntity).find({ order: { sortTime: "DESC" } });
    async function compare(user, type, publisherId) {
      const selected = rows.filter(row => (!type || row.type === type) && (!publisherId || row.publisherId === publisherId));
      const decisions = await Promise.all(selected.map(row => service.userHasPermission(user, row, DiscussionPermissionType.View)));
      const expected = selected.filter((_row, index) => decisions[index]).map(row => row.id);
      const paged = [];
      for (let skip = 0; skip <= expected.length + 1; skip += 2) {
        const [page, count] = await service.queryDiscussionsAndCount(user, false, null, -2, publisherId, false, skip, 2, type);
        assert.equal(count, expected.length, "No inaccessible row may affect totals for " + (user?.id || "guest"));
        assert.deepEqual(page.map(row => row.id), expected.slice(skip, skip + 2), "No empty/short page caused by filtering after LIMIT");
        paged.push(...page.map(row => row.id));
      }
      assert.deepEqual(paged, expected);
      return expected;
    }
    for (const user of [null, ...users]) {
      await compare(user);
      await compare(user, "Solution");
      if (user) await compare(user, undefined, user.id);
    }
    const author = users.find(user => user.id === 3), ordinary = users.find(user => user.id === 4), moderator = users.find(user => user.id === 5);
    const authorIds = await compare(author);
    assert(!authorIds.includes(101) && !authorIds.includes(104) && !authorIds.includes(109), "Author identity cannot bypass problem/team floors");
    assert((await compare(users.find(user => user.id === 6))).includes(103), "User read ACL permits a private problem");
    assert((await compare(users.find(user => user.id === 7))).includes(108), "Group read ACL permits a private discussion");
    await db.query("INSERT INTO user_permission_rule(userId,permission,allowed) VALUES (5,'ViewHiddenProblem',0)");
    assert(!(await compare(moderator)).includes(101), "Explicit hidden-problem denial wins over manager privilege");
    await db.query("INSERT INTO user_permission_rule(userId,permission,allowed) VALUES (4,'ViewHiddenProblem',1)");
    assert((await compare(ordinary)).includes(101), "Explicit hidden-problem allow applies with no object ACL");
    await db.query("INSERT INTO user_permission_rule(userId,permission,allowed) VALUES (4,'ViewProblem',0)");
    assert((await compare(ordinary)).every(id => [107,108,112].includes(id)), "Global problem denial also hides public and owned linked discussions");
    await db.query("INSERT INTO user_permission_rule(userId,permission,allowed) VALUES (3,'ViewDiscussion',0)");
    assert.deepEqual(await compare(author), [], "Global discussion denial hides authors' own posts and totals");
    await db.query("DELETE FROM team_member WHERE teamId=100 AND userId=9");
    const departed = await compare(users.find(user => user.id === 9));
    assert(!departed.includes(104) && !departed.includes(110), "Membership removal immediately removes private problem and discussion counts");
    await db.query("UPDATE team SET archived=1 WHERE id=100");
    const ownerIds = await compare(users.find(user => user.id === 8));
    assert(ownerIds.includes(104) && ownerIds.includes(110), "Team owner retains read access after archive");
  } finally {
    if (db.isInitialized && owned) {
      const runner = db.createQueryRunner(); await runner.connect();
      try {
        await runner.query("SET FOREIGN_KEY_CHECKS=0");
        for (const { name } of await runner.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"))
          await runner.query("DROP TABLE `" + name.replaceAll("`", "``") + "`");
      } finally { await runner.query("SET FOREIGN_KEY_CHECKS=1"); await runner.release(); }
    }
    if (db.isInitialized) await db.destroy();
  }
});
