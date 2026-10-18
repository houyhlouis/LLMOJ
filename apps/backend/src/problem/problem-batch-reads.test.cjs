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

const { EntityManager } = require("typeorm");
const { LocalizedContentService } = require("../localized-content/localized-content.service.ts");
const { LocalizedContentType } = require("../localized-content/localized-content.entity.ts");
const { ProblemService } = require("./problem.service.ts");
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
  const service = Object.assign(Object.create(ProblemService.prototype), {
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
