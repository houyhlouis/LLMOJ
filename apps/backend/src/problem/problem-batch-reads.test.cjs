// Lists read titles, tags and team ownership for all their problems together instead of once per problem. Each batch
// read must give exactly what the single reads give.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

require("reflect-metadata");
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
const main = require.resolve("../main.ts");
require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
String.prototype.format ||= function format(...args) {
  return require("node:util").format(String(this), ...args);
};

const { DataSource, EntityManager } = require("typeorm");
const { DatabaseSync } = require("node:sqlite");
const { LocalizedContentService } = require("../localized-content/localized-content.service.ts");
const { LocalizedContentType } = require("../localized-content/localized-content.entity.ts");
const { ProblemService } = require("./problem.service.ts");
const { ProblemController } = require("./problem.controller.ts");
const { DiscussionController } = require("../discussion/discussion.controller.ts");
const { DiscussionService } = require("../discussion/discussion.service.ts");
const { GroupEntity } = require("../group/group.entity.ts");
const { GroupService } = require("../group/group.service.ts");
const { PermissionService } = require("../permission/permission.service.ts");
const { PermissionForUserEntity } = require("../permission/permission-for-user.entity.ts");
const { PermissionForGroupEntity } = require("../permission/permission-for-group.entity.ts");
const { UserAuthEntity } = require("../auth/user-auth.entity.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { UserService } = require("../user/user.service.ts");
const { bareProblemServices } = require("./problem-test-services.cjs");
const { prefetchTeamResources, teamResourceAccess } = require("../team/team-access.ts");
const { TeamResourceEntity } = require("../team/team.entity.ts");
const { requestContext } = require("../common/request-context.ts");

function localizedContent(rows, cache = new Map()) {
  const queries = [];
  const stored = [];
  const service = new LocalizedContentService(
    {
      findBy: async where => {
        queries.push({ type: where.type, locale: where.locale, ids: [...where.objectId.value] });
        return rows.filter(
          row => row.type === where.type && row.locale === where.locale && where.objectId.value.includes(row.objectId)
        );
      },
      findOneBy: async where =>
        rows.find(row => row.type === where.type && row.locale === where.locale && row.objectId === where.objectId) ??
        null
    },
    {
      cacheGet: async key => cache.get(key) ?? null,
      cacheSet: async (key, value) => cache.set(key, value),
      cacheGetMany: async keys => keys.map(key => cache.get(key) ?? null),
      cacheSetMany: async entries => {
        stored.push(...entries);
        for (const [key, value] of entries) cache.set(key, value);
      }
    }
  );
  return { service, queries, stored, cache };
}

test("localized contents are read with one cache round trip and one query per type and locale", async () => {
  const rows = [
    { objectId: 1, type: LocalizedContentType.ProblemTitle, locale: "en_US", data: "One" },
    { objectId: 2, type: LocalizedContentType.ProblemTitle, locale: "en_US", data: "Two" },
    { objectId: 2, type: LocalizedContentType.ProblemTitle, locale: "zh_CN", data: "二" },
    { objectId: 3, type: LocalizedContentType.ProblemTitle, locale: "en_US", data: "" },
    { objectId: 4, type: LocalizedContentType.ProblemTagName, locale: "en_US", data: "Graphs" }
  ];
  const cache = new Map([["localized-content:ProblemTitle:1:en_US", "One (cached)"]]);
  const { service, queries, stored } = localizedContent(rows, cache);
  const items = [
    { objectId: 1, type: LocalizedContentType.ProblemTitle, locale: "en_US" },
    { objectId: 2, type: LocalizedContentType.ProblemTitle, locale: "en_US" },
    { objectId: 2, type: LocalizedContentType.ProblemTitle, locale: "zh_CN" },
    { objectId: 9, type: LocalizedContentType.ProblemTitle, locale: "en_US" },
    { objectId: 4, type: LocalizedContentType.ProblemTagName, locale: "en_US" }
  ];
  assert.deepEqual(await service.getMany(items), ["One (cached)", "Two", "二", null, "Graphs"]);
  assert.equal(queries.length, 3);
  // What was found is cached; what doesn't exist isn't
  assert.deepEqual(stored.map(([key]) => key).sort(), [
    "localized-content:ProblemTagName:4:en_US",
    "localized-content:ProblemTitle:2:en_US",
    "localized-content:ProblemTitle:2:zh_CN"
  ]);
  // The same answers one at a time
  const single = localizedContent(rows);
  assert.deepEqual(
    await Promise.all(items.map(item => single.service.get(item.objectId, item.type, item.locale))),
    ["One", "Two", "二", null, "Graphs"]
  );
  // An empty cached value counts as not cached, as in `get`
  const empty = localizedContent(rows, new Map([["localized-content:ProblemTitle:3:en_US", ""]]));
  assert.deepEqual(await empty.service.getMany([{ objectId: 3, type: LocalizedContentType.ProblemTitle, locale: "en_US" }]), [""]);
  assert.equal(empty.queries.length, 1);
  assert.deepEqual(await empty.service.getMany([]), []);
});

test("tags of many problems are read in two queries, as each problem's tags are", async () => {
  const maps = [
    { problemId: 1, problemTagId: 5 },
    { problemId: 1, problemTagId: 6 },
    { problemId: 2, problemTagId: 6 },
    { problemId: 2, problemTagId: 7 }
  ];
  const tags = { 5: { id: 5, locales: ["en_US"] }, 6: { id: 6, locales: ["zh_CN", "en_US"] } };
  let queries = 0;
  const service = Object.assign(bareProblemServices(), {
    problemTagMapRepository: {
      findBy: async where => {
        queries++;
        const ids = where.problemId.value ?? [where.problemId];
        return maps.filter(map => ids.includes(map.problemId));
      }
    },
    problemTagRepository: {
      findByIds: async ids => {
        queries++;
        return ids.map(id => tags[id]).filter(Boolean);
      }
    }
  });
  const problems = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const batch = await service.getProblemTagsByProblems(problems);
  assert.equal(queries, 2);
  assert.deepEqual([...batch.entries()].map(([id, list]) => [id, list.map(tag => tag.id)]), [
    [1, [5, 6]],
    [2, [6]],
    [3, []]
  ]);
  // Tag 7 no longer exists: one problem at a time it would be an undefined entry; the batch leaves it out
  assert.deepEqual((await service.getProblemTagsByProblem(problems[0])).map(tag => tag.id), [5, 6]);

  service.localizedContentService = localizedContent([
    { objectId: 5, type: LocalizedContentType.ProblemTagName, locale: "en_US", data: "Graphs" },
    { objectId: 6, type: LocalizedContentType.ProblemTagName, locale: "zh_CN", data: "动态规划" }
  ]).service;
  assert.deepEqual(await service.getProblemTagsLocalized([tags[5], tags[6]], "zh_CN"), [
    { id: 5, color: undefined, name: "Graphs", nameLocale: "en_US" },
    { id: 6, color: undefined, name: "动态规划", nameLocale: "zh_CN" }
  ]);
});

test("a request notes which of its problems belong to teams; checks of the others need no query", async () => {
  let lookups = 0;
  const db = {
    getRepository: entity => ({
      find: async ({ where }) =>
        entity === TeamResourceEntity ? where.resourceId.value.filter(id => id === 2).map(resourceId => ({ resourceId })) : [],
      findOne: async ({ where }) => {
        if (entity === TeamResourceEntity) {
          lookups++;
          return where.resourceId === 2 ? { teamId: 1, kind: "problem", resourceId: 2, archived: false } : null;
        }
        return null;
      }
    })
  };
  const user = { id: 9, isAdmin: false };
  const request = { res: { writableEnded: false } };
  await requestContext.run(request, async () => {
    await prefetchTeamResources(db, "problem", [1, 2, 3]);
    lookups = 0;
    // Not team resources: answered from the note
    assert.equal(await teamResourceAccess(db, user, "problem", 1), null);
    assert.equal(await teamResourceAccess(db, user, "problem", 3), null);
    assert.equal(lookups, 0);
    // A team resource, and one that wasn't noted, are checked in full
    assert.equal(await teamResourceAccess(db, user, "problem", 2), false);
    assert.equal(await teamResourceAccess(db, user, "problem", 4), null);
    // Another kind of resource with the same ID
    assert.equal(await teamResourceAccess(db, user, "discussion", 1), null);
    assert.equal(lookups, 3);
    // A transaction reads the database
    const manager = Object.assign(Object.create(EntityManager.prototype), { getRepository: db.getRepository });
    lookups = 0;
    assert.equal(await teamResourceAccess(manager, user, "problem", 1), null);
    assert.equal(lookups, 1);
  });
  // Outside the request, and after its response, nothing is shared
  lookups = 0;
  assert.equal(await teamResourceAccess(db, user, "problem", 1), null);
  request.res.writableEnded = true;
  await requestContext.run(request, async () => assert.equal(await teamResourceAccess(db, user, "problem", 1), null));
  assert.equal(lookups, 2);
});

test("problem and discussion permission views batch existing principals and keep their grant levels", async t => {
  // Execute the MariaDB query builders' SELECTs against local rows, including grants left behind by a deletion.
  const source = new DataSource({
    type: "mariadb", database: "permission_views",
    entities: [UserEntity, UserAuthEntity, GroupEntity, PermissionForUserEntity, PermissionForGroupEntity]
  });
  await source.buildMetadatas();
  const rows = new DatabaseSync(":memory:");
  t.after(() => rows.close());
  for (const table of source.entityMetadatas) {
    const columns = table.columns.map(column => '"' + column.databaseName + '"').join(", ");
    rows.exec('CREATE TABLE "' + table.tableName + '" (' + columns + ')');
  }
  rows.exec(`
    CREATE TABLE team (permissionGroupId INTEGER);
    INSERT INTO team VALUES (63);
    INSERT INTO user (id, username, email, avatarInfo) VALUES
      (14, 'reader', 'reader@example.invalid', 'github:reader'), (15, 'gone', '', '');
    INSERT INTO "group" (id, name, memberCount) VALUES
      (61, 'Graphs', 4), (62, 'Algebra', 2), (63, 'Internal group', 3), (64, 'Removed group', 0);
    INSERT INTO permission_for_user (objectId, objectType, userId, permissionLevel) VALUES
      (51, 'Problem', 14, 1), (51, 'Problem', 15, 2), (51, 'Discussion', 14, 2), (51, 'Discussion', 15, 1);
    INSERT INTO permission_for_group (objectId, objectType, groupId, permissionLevel) VALUES
      (51, 'Problem', 61, 2), (51, 'Problem', 62, 1), (51, 'Problem', 63, 1), (51, 'Problem', 64, 2),
      (51, 'Discussion', 61, 1), (51, 'Discussion', 63, 1), (51, 'Discussion', 64, 2), (52, 'Discussion', 62, 2);
    DELETE FROM user WHERE id = 15;
    DELETE FROM "group" WHERE id = 64;
  `);
  const runner = source.createQueryRunner();
  let queryCount = 0;
  runner.query = async (sql, parameters) => {
    queryCount++;
    return { records: rows.prepare(sql).all(...parameters) };
  };
  const repository = entity => runner.manager.getRepository(entity);
  const userService = Object.assign(Object.create(UserService.prototype), { userRepository: repository(UserEntity) });
  const groupService = Object.assign(Object.create(GroupService.prototype), { groupRepository: repository(GroupEntity) });
  const permissionService = new PermissionService(
    source, repository(PermissionForUserEntity), repository(PermissionForGroupEntity), groupService
  );
  const resource = { id: 51, isPublic: true, type: "Traditional", locales: ["en_US"] };
  const lock = (_id, _mode, read) => read(resource);
  const problemService = Object.assign(Object.create(ProblemService.prototype), {
    permissionService, userService, groupService, findProblemById: async () => resource
  });
  const problem = Object.assign(Object.create(ProblemController.prototype), {
    problemService, problemAccess: { userHasPermission: async () => true }, problemLocks: { lockProblemById: lock },
    userService, groupService
  });
  const discussionService = Object.assign(Object.create(DiscussionService.prototype), {
    permissionService, userService, groupService, findDiscussionById: async () => resource,
    userHasPermission: async () => true, lockDiscussionById: lock
  });
  const discussion = Object.assign(Object.create(DiscussionController.prototype), {
    discussionService, userService, groupService
  });

  const views = [
    [() => problem.getProblem(null, { id: 51, permissions: true }), 1, [[61, "Graphs", 4, 2], [62, "Algebra", 2, 1]]],
    [() => discussion.getDiscussionPermissions(null, { id: 51 }), 2, [[61, "Graphs", 4, 1]]]
  ];
  for (const [read, userLevel, expectedGroups] of views) {
    queryCount = 0;
    const { permissions } = await read();
    assert.equal(queryCount, 2);
    assert.deepEqual(
      permissions.userPermissions.map(({ user, permissionLevel }) => [user.id, user.username, permissionLevel]),
      [[14, "reader", userLevel]]
    );
    const groups = permissions.groupPermissions.map(({ group, permissionLevel }) =>
      [group.id, group.name, group.memberCount, permissionLevel]);
    assert.deepEqual(groups.sort((a, b) => a[0] - b[0]), expectedGroups);
  }

  const admin = { id: 12, isAdmin: true };
  const request = {
    userPermissions: [],
    groupPermissions: [{ groupId: 63, permissionLevel: 1 }, { groupId: 61, permissionLevel: 2 }]
  };
  const missing = { error: "NO_SUCH_GROUP", errorObjectId: 63 };
  assert.deepEqual(await problem.setProblemPermissions(admin, { problemId: 51, ...request }), missing);
  assert.deepEqual(await discussion.setDiscussionPermissions(admin, { discussionId: 51, ...request }), missing);
});
