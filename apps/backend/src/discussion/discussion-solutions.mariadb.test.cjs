// Actual service and SQL/upgrade helper against randomized, isolated MariaDB tables.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true,
    emitDecoratorMetadata: true } }).outputText, filename);
const { DataSource, EntitySchema } = require("typeorm");
const { DiscussionService } = require("./discussion.service.ts");
const { DiscussionEntity } = require("./discussion.entity.ts");
const { DiscussionReplyEntity } = require("./discussion-reply.entity.ts");
const { DiscussionContentEntity } = require("./discussion-content.entity.ts");
const { DiscussionType } = require("./discussion-type.enum.ts");

test("solution creation, preserved IDs/replies, My discussions, pagination and idempotent upgrade (MariaDB)",
  { skip: !process.env.HYHOJ_DISCUSSION_TEST_DB_CONFIG, timeout: 60000 }, async () => {
  const config = require("js-yaml").load(fs.readFileSync(process.env.HYHOJ_DISCUSSION_TEST_DB_CONFIG, "utf8")).services.database;
  const prefix = "qa_solutions_" + crypto.randomBytes(6).toString("hex") + "_";
  const integer = { type: Number }, date = { type: "datetime" };
  const definitions = [
    [DiscussionEntity, "discussion", { id: { ...integer, primary: true, generated: true }, title: { type: String },
      type: { type: String, default: "Discussion" }, isPublic: { type: Boolean }, publisherId: integer,
      problemId: { ...integer, nullable: true }, replyCount: integer, publishTime: date,
      editTime: { ...date, nullable: true }, sortTime: date }],
    [DiscussionReplyEntity, "reply", { id: { ...integer, primary: true, generated: true }, discussionId: integer,
      content: { type: "text" }, publishTime: date, editTime: { ...date, nullable: true }, isPublic: { type: Boolean }, publisherId: integer }],
    [DiscussionContentEntity, "content", { discussionId: { ...integer, primary: true }, content: { type: "text" } }]
  ];
  const db = new DataSource({ ...config, entities: definitions.map(([target, name, columns]) =>
    new EntitySchema({ name: target.name, target, tableName: prefix + name, columns })), synchronize: true, logging: false });
  const teamAccess = require("../team/team-access.ts");
  const originalVisibility = teamAccess.teamResourceVisibilitySql;
  const originalAccess = teamAccess.teamResourceAccess;
  // Model ordinary write transactions in this lightweight entity fixture;
  // retain the real team SQL predicate to exercise board/count isolation.
  teamAccess.teamResourceAccess = async () => null;
  teamAccess.teamResourceVisibilitySql = (...args) => originalVisibility(...args)
    .replace(/\bteam_resource\b/g, prefix + "team_resource")
    .replace(/\bteam_member\b/g, prefix + "team_member")
    .replace(/\buser_permission_rule\b/g, prefix + "user_permission_rule")
    .replace(/\buser_privilege\b/g, prefix + "user_privilege")
    .replace(/\bteam\b/g, prefix + "team");
  const extras = ["team_resource", "team_member", "team", "user_permission_rule", "user_privilege", "problem", "permission_for_user", "permission_for_group", "group_membership", "migration_discussion", "migration_ai_job"];
  let connected = false;
  try {
    await db.initialize(); connected = true;
    await db.query("CREATE TABLE " + prefix + "team (id int PRIMARY KEY, ownerId int, archived boolean)");
    await db.query("CREATE TABLE " + prefix + "team_member (teamId int, userId int, status varchar(16), permissions json)");
    await db.query("CREATE TABLE " + prefix + "team_resource (teamId int, kind varchar(16), resourceId int, archived boolean)");
    await db.query("CREATE TABLE " + prefix + "user_permission_rule (userId int, permission varchar(80), allowed boolean, PRIMARY KEY (userId, permission))");
    await db.query("CREATE TABLE " + prefix + "user_privilege (userId int, privilegeType varchar(80), PRIMARY KEY (userId, privilegeType))");
    await db.query("CREATE TABLE " + prefix + "problem (id int PRIMARY KEY, ownerId int, isPublic boolean)");
    await db.query("INSERT INTO " + prefix + "problem VALUES (20, 1, 1)");
    await db.query("CREATE TABLE " + prefix + "permission_for_user (objectId int, objectType varchar(20), userId int, permissionLevel int)");
    await db.query("CREATE TABLE " + prefix + "permission_for_group (objectId int, objectType varchar(20), groupId int, permissionLevel int)");
    await db.query("CREATE TABLE " + prefix + "group_membership (groupId int, userId int)");
    const dr = db.getRepository(DiscussionEntity), rr = db.getRepository(DiscussionReplyEntity), cr = db.getRepository(DiscussionContentEntity);
    const createQueryBuilder = dr.createQueryBuilder.bind(dr);
    dr.createQueryBuilder = (...args) => {
      const query = createQueryBuilder(...args), andWhere = query.andWhere.bind(query);
      query.andWhere = (sql, ...parameters) => andWhere(typeof sql === "string" ? sql.replace(/\b(FROM|JOIN)\s+(problem|permission_for_user|permission_for_group|group_membership|team_resource|team_member|team|user_permission_rule|user_privilege)\b/g,
        (_match, verb, table) => verb + " " + prefix + table) : sql, ...parameters);
      return query;
    };
    const service = Object.assign(Object.create(DiscussionService.prototype), {
      connection: db, discussionRepository: dr, discussionReplyRepository: rr, discussionContentRepository: cr,
      userPrivilegeService: {
        userHasPrivilege: async (_user, privilege) => ["ViewDiscussion", "ViewProblem"].includes(privilege),
        permissionDecision: async (user, _privilege, fallback) => !!user && fallback
      },
      configService: { config: { preference: { security: { discussionDefaultPublic: true, discussionReplyDefaultPublic: true } } } }
    });
    const owner = { id: 1 }, problem = { id: 20 };
    const general = await service.createDiscussion(owner, "General discussion", "general", null);
    const ordinary = await service.createDiscussion(owner, "Problem discussion", "ordinary", problem);
    const solution = await service.createDiscussion(owner, "Proof", "original", problem, undefined, undefined, DiscussionType.Solution);
    await service.addReply(owner, ordinary, "Existing reply");
    const oldReply = await rr.findOneBy({ discussionId: ordinary.id });
    await service.updateDiscussionTitleAndContent(ordinary, "Converted proof", "converted", { type: DiscussionType.Solution, problemId: 20 });
    assert.equal((await dr.findOneBy({ id: ordinary.id })).type, "Solution");
    assert.equal((await rr.findOneBy({ discussionId: ordinary.id })).id, oldReply.id);
    assert.equal((await dr.findOneBy({ id: ordinary.id })).replyCount, 1);
    assert.equal(await service.getDiscussionContent(ordinary), "converted");
    const [solutions, count] = await service.queryDiscussionsAndCount(null, false, null, -1, null, false, 0, 10, DiscussionType.Solution);
    assert.equal(count, 2);
    assert.deepEqual(solutions.map(row => row.id).sort(), [ordinary.id, solution.id].sort());
    const [mine, myCount] = await service.queryDiscussionsAndCount(owner, false, null, -2, 1, false, 0, 10);
    assert.equal(myCount, 3);
    assert.deepEqual(mine.map(row => row.id).sort(), [general.id, ordinary.id, solution.id].sort());
    const [page, pageCount] = await service.queryDiscussionsAndCount(owner, false, null, -2, 1, false, 1, 1);
    assert.equal(page.length, 1); assert.equal(pageCount, 3);
    await assert.rejects(service.createDiscussion(owner, "Unlinked proof", "x", null, undefined, undefined, DiscussionType.Solution), /SOLUTION_REQUIRES_PROBLEM/);
    assert.equal(await dr.count(), 3); assert.equal(await cr.count(), 3);
    await db.query("INSERT INTO " + prefix + "team VALUES (7, 99, 0)");
    await db.query("INSERT INTO " + prefix + "team_resource VALUES (7, 'discussion', ?, 0)", [solution.id]);
    const [publicRows, publicCount] = await service.queryDiscussionsAndCount(null, false, null, -1, null, false, 0, 10, DiscussionType.Solution);
    assert.equal(publicCount, 1); assert.deepEqual(publicRows.map(row => row.id), [ordinary.id]);
    const [privateMine, privateCount] = await service.queryDiscussionsAndCount(owner, false, null, -2, 1, false, 0, 10);
    assert.equal(privateCount, 2); assert(!privateMine.some(row => row.id === solution.id));
    await db.query("INSERT INTO " + prefix + "team_member VALUES (7, 1, 'member', JSON_ARRAY())");
    const [memberMine, memberCount] = await service.queryDiscussionsAndCount(owner, false, null, -2, 1, false, 0, 10);
    assert.equal(memberCount, 3); assert(memberMine.some(row => row.id === solution.id));
    // The site ViewTeam deny must constrain even a member with a global team-management grant.
    await db.query("INSERT INTO " + prefix + "user_privilege VALUES (1, 'ManageTeams')");
    await db.query("INSERT INTO " + prefix + "user_permission_rule VALUES (1, 'ViewTeam', 0)");
    const [deniedMine, deniedCount] = await service.queryDiscussionsAndCount(owner, false, null, -2, 1, false, 0, 10);
    assert.equal(deniedCount, 2); assert(!deniedMine.some(row => row.id === solution.id));
    const [deniedSolutions, deniedSolutionCount] = await service.queryDiscussionsAndCount(owner, false, null, -1, null, false, 0, 10, DiscussionType.Solution);
    assert.equal(deniedSolutionCount, 1); assert.deepEqual(deniedSolutions.map(row => row.id), [ordinary.id]);
    await db.query("DELETE FROM " + prefix + "user_permission_rule WHERE userId=1 AND permission='ViewTeam'");
    const [restoredMine, restoredCount] = await service.queryDiscussionsAndCount(owner, false, null, -2, 1, false, 0, 10);
    assert.equal(restoredCount, 3); assert(restoredMine.some(row => row.id === solution.id));
    // The problem page counts its discussions and solutions separately, exactly as their own lists show them.
    await service.createDiscussion(owner, "Question", "question", problem);
    assert.equal(await service.getDiscussionCountOfProblem(owner, problem, DiscussionType.Discussion), 1);
    assert.equal(await service.getDiscussionCountOfProblem(owner, problem, DiscussionType.Solution), 2);
    assert.equal(await service.getDiscussionCountOfProblem(null, problem, DiscussionType.Discussion), 1);
    assert.equal(await service.getDiscussionCountOfProblem(null, problem, DiscussionType.Solution), 1);
    await db.query("CREATE TABLE " + prefix + "migration_discussion (id int PRIMARY KEY, publisherId int, problemId int NULL, title varchar(80))");
    await db.query("CREATE TABLE " + prefix + "migration_ai_job (id int PRIMARY KEY, ownerId int, problemId int NULL, state json)");
    await db.query("INSERT INTO " + prefix + "migration_discussion VALUES (101, 1, 20, '题解'), (102, 1, 20, 'AI proof'), (103, 2, 20, 'Different author')");
    await db.query("INSERT INTO " + prefix + "migration_ai_job VALUES (1, 1, 20, ?)", [JSON.stringify({ discussionIds: { zh_CN: 102, en_US: 103 } })]);
    const rewrite = sql => sql.replace(/\bdiscussion\b/g, prefix + "migration_discussion").replace(/\bai_job\b/g, prefix + "migration_ai_job");
    const migration = rewrite(fs.readFileSync(path.resolve(__dirname, "../../../../deploy/solutions-migration.sql"), "utf8").replace(/^\s*--.*$/gm, ""));
    const statements = migration.split(";").map(part => part.trim()).filter(Boolean);
    const helpers = await import(require("node:url").pathToFileURL(path.resolve(__dirname, "../../../../deploy/community-solutions.mjs")).href);
    const isolated = { query: sql => db.query(rewrite(sql)) };
    assert.deepEqual(await helpers.inspectVerifiedSolutions(isolated), { pending: 0, schemaPending: true });
    await db.query(statements[0]); await db.query(statements[1]);
    assert.deepEqual(await helpers.inspectVerifiedSolutions(isolated), { pending: 1, schemaPending: false });
    assert.deepEqual(await helpers.migrateVerifiedSolutions(isolated), { before: 1, after: 0, classified: 1 });
    assert.deepEqual(await helpers.migrateVerifiedSolutions(isolated), { before: 0, after: 0, classified: 0 });
    for (let run = 0; run < 2; run++) for (const statement of statements) await db.query(statement);
    const migrated = await db.query("SELECT id, type FROM " + prefix + "migration_discussion ORDER BY id");
    assert.deepEqual(migrated.map(row => [row.id, row.type]), [[101, "Discussion"], [102, "Solution"], [103, "Discussion"]]);
  } finally {
    teamAccess.teamResourceVisibilitySql = originalVisibility;
    teamAccess.teamResourceAccess = originalAccess;
    if (connected) {
      for (const name of [...extras, "reply", "content", "discussion"]) await db.query("DROP TABLE IF EXISTS " + prefix + name);
      await db.destroy();
    }
  }
});
