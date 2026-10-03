/* Real MariaDB: actual service methods, randomized isolated tables, verified
   parent FK, and cleanup in finally. Opt in with HYHOJ_DISCUSSION_TEST_DB_CONFIG. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), crypto = require("node:crypto");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true,
    emitDecoratorMetadata: true } }).outputText, filename);
String.prototype.format ||= function (...args) { return require("node:util").format(this, ...args); };
const { DataSource, EntitySchema } = require("typeorm");
const { DiscussionService } = require("./discussion.service.ts");
const { DiscussionEntity } = require("./discussion.entity.ts");
const { DiscussionReplyEntity } = require("./discussion-reply.entity.ts");
const { DiscussionContentEntity } = require("./discussion-content.entity.ts");
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Pause immediately after the real aggregate read. The second transaction has
// entered before it waits for the parent's lock, so this does not depend on sleep
// to order the relevant operations.
function pauseAfterReplyMax(db, base) {
  const ready = deferred(), release = deferred();
  const paused = Object.assign(Object.create(DiscussionService.prototype), base);
  paused.connection = { transaction: (isolation, callback) => db.transaction(isolation, async manager => {
    const create = manager.createQueryBuilder.bind(manager);
    manager.createQueryBuilder = (...args) => {
      const qb = create(...args), read = qb.getRawOne.bind(qb);
      qb.getRawOne = async (...args) => {
        const row = await read(...args);
        if (qb.getQuery().includes("MAX(")) { ready.resolve(); await release.promise; }
        return row;
      };
      return qb;
    };
    return callback(manager);
  }) };
  return { service: paused, ready: ready.promise, release: release.resolve };
}

function enteredConnection(db, base) {
  const entered = deferred();
  const service = Object.assign(Object.create(DiscussionService.prototype), base);
  service.connection = { transaction: (isolation, callback) => db.transaction(isolation, async manager => {
    entered.resolve(); return callback(manager);
  }) };
  return { service, entered: entered.promise };
}

test("discussion pagination and serialized sort/count mutations (real MariaDB)",
  { skip: !process.env.HYHOJ_DISCUSSION_TEST_DB_CONFIG, timeout: 60000 }, async t => {
  const config = require("js-yaml").load(fs.readFileSync(process.env.HYHOJ_DISCUSSION_TEST_DB_CONFIG, "utf8")).services.database;
  const prefix = `qa_discussion_final_${crypto.randomBytes(8).toString("hex")}_`;
  const integer = { type: Number }, dt = { type: "datetime" };
  const definitions = [
    [DiscussionEntity, "discussion", { id: { ...integer, primary: true, generated: true }, title: { type: String },
      isPublic: { type: Boolean }, publisherId: integer, problemId: { ...integer, nullable: true },
      replyCount: integer, publishTime: dt, editTime: { ...dt, nullable: true }, sortTime: dt }],
    [DiscussionReplyEntity, "reply", { id: { ...integer, primary: true, generated: true }, discussionId: integer,
      content: { type: "text" }, publishTime: dt, editTime: { ...dt, nullable: true }, isPublic: { type: Boolean }, publisherId: integer }],
    [DiscussionContentEntity, "content", { discussionId: { ...integer, primary: true }, content: { type: "text" } }]
  ];
  const db = new DataSource({ ...config, entities: definitions.map(([target, name, columns]) =>
    new EntitySchema({ name: target.name, target, tableName: prefix + name, columns })), synchronize: true,
    dropSchema: false, migrationsRun: false, logging: false, extra: { ...config.extra, connectionLimit: 20 } });
  let initialized = false, parentForeignKeyVerified = false;
  const evidence = [];
  try {
    await db.initialize(); initialized = true;
    await db.query(`ALTER TABLE \`${prefix}reply\` ADD CONSTRAINT \`${prefix}parent_fk\` FOREIGN KEY (discussionId) REFERENCES \`${prefix}discussion\` (id) ON DELETE CASCADE`);
    const fks = await db.query("SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=?", [prefix + "reply"]);
    assert.equal(fks.length, 1); parentForeignKeyVerified = true;
    const dr = db.getRepository(DiscussionEntity), rr = db.getRepository(DiscussionReplyEntity), cr = db.getRepository(DiscussionContentEntity);
    const base = { connection: db, discussionRepository: dr, discussionReplyRepository: rr,
      configService: { config: { preference: { security: { discussionReplyDefaultPublic: true } } } } };
    const service = Object.assign(Object.create(DiscussionService.prototype), base);
    async function fixture(days = [2, 3]) {
      const discussion = await dr.save({ title: "QA discussion", isPublic: true, publisherId: 1, problemId: null,
        replyCount: days.length, publishTime: new Date("2026-01-01"), editTime: null,
        sortTime: new Date(`2026-01-0${Math.max(1, ...days)}`) });
      await cr.save({ discussionId: discussion.id, content: "QA discussion content" });
      const replies = await rr.save(days.map(day => ({ discussionId: discussion.id, content: `reply ${day}`,
        publishTime: new Date(`2026-01-0${day}`), editTime: null, isPublic: true, publisherId: 1 })));
      return { discussion, replies };
    }
    async function check(f, name) {
      const discussion = await dr.findOneBy({ id: f.discussion.id }), replies = await rr.findBy({ discussionId: f.discussion.id });
      const expected = Math.max(+(discussion.editTime || discussion.publishTime), ...replies.map(reply => +reply.publishTime));
      assert.equal(+discussion.sortTime, expected); assert.equal(discussion.replyCount, replies.length);
      evidence.push({ name, sortTime: discussion.sortTime, expectedSortTime: new Date(expected),
        storedCount: discussion.replyCount, actualCount: replies.length });
      return { discussion, replies };
    }
    await t.test("F08: omitted head/tail counts never invoke unbounded retrieval, across moderator/user/anonymous visibility", async () => {
      const f = await fixture([2, 3, 4, 5, 6, 7]);
      await rr.update(f.replies[1].id, { isPublic: false });
      await rr.update(f.replies[2].id, { isPublic: false, publisherId: 2 });
      for (const role of [{ user: { id: 1 }, manage: true, count: 6 }, { user: { id: 2 }, manage: false, count: 5 }, { user: null, manage: false, count: 4 }]) {
        const visible = f.replies.filter((reply, index) => role.manage || ![1, 2].includes(index) || (index === 2 && role.user?.id === 2));
        for (const [headCount, tailCount] of [[1, 0], [0, 1], [0, 0], [1, 1], [10, 10], [2, 3]]) {
          const [head, tail, count] = await service.queryDiscussionRepliesByHeadTail(role.user, f.discussion, role.manage, headCount, tailCount);
          assert.equal(count, role.count);
          const expectedHead = visible.slice(0, headCount), expectedTail = tailCount ? visible.slice(expectedHead.length).slice(-tailCount) : [];
          assert.deepEqual(head.map(reply => reply.id), expectedHead.map(reply => reply.id));
          assert.deepEqual(tail.map(reply => reply.id), expectedTail.map(reply => reply.id));
          assert.equal(new Set([...head, ...tail].map(reply => reply.id)).size, head.length + tail.length);
          evidence.push({ name: "HeadTail visibility/count boundary", role: role.user?.id ?? "anonymous", manage: role.manage,
            headCount, tailCount, head: head.map(reply => reply.id), tail: tail.map(reply => reply.id), count });
        }
        const before = f.replies.at(-1).id, after = f.replies[0].id;
        for (const takeCount of [0, 1, 20]) {
          const [replies, count] = await service.queryDiscussionRepliesInIdRange(role.user, f.discussion, role.manage, before, after, takeCount);
          const inRange = visible.filter(reply => reply.id > after && reply.id < before);
          assert.equal(count, inRange.length);
          assert.deepEqual(replies.map(reply => reply.id), inRange.slice(0, takeCount).map(reply => reply.id));
          evidence.push({ name: "IdRange visibility/count boundary", role: role.user?.id ?? "anonymous", takeCount,
            replies: replies.map(reply => reply.id), count });
        }
      }
      const empty = await service.queryDiscussionRepliesByHeadTail(null, { id: -1 }, false, 0, 1);
      assert.deepEqual(empty, [[], [], 0]);
      assert.deepEqual(await service.queryDiscussionRepliesInIdRange(null, f.discussion, false, 0, 999, 0), [[], 0]);
    });
    for (let repetition = 0; repetition < 3; repetition++) {
      await t.test(`F09: delete MAX followed by concurrent add (${repetition + 1})`, async () => {
        const f = await fixture(), paused = pauseAfterReplyMax(db, base), next = enteredConnection(db, base);
        const deleting = paused.service.deleteReply({ ...f.replies[1] });
        await paused.ready;
        let adding;
        try {
          adding = next.service.addReply({ id: 1 }, f.discussion, "new reply during paused deletion");
          await next.entered;
          const committed = await Promise.race([adding.then(() => true), delay(100).then(() => false)]);
          assert.equal(committed, false, "add must wait until the deleting transaction commits");
        } finally { paused.release(); }
        await Promise.all([deleting, adding]);
        const result = await check(f, "delete MAX then add");
        assert.equal(result.replies.length, 2);
      });
    }
    await t.test("F09: add MAX followed by concurrent delete", async () => {
      const f = await fixture(), paused = pauseAfterReplyMax(db, base), next = enteredConnection(db, base);
      const adding = paused.service.addReply({ id: 1 }, f.discussion, "new reply during deletion");
      await paused.ready;
      let deleting;
      try {
        deleting = next.service.deleteReply({ ...f.replies[1] }); await next.entered;
        assert.equal(await Promise.race([deleting.then(() => true), delay(100).then(() => false)]), false);
      } finally { paused.release(); }
      await Promise.all([adding, deleting]); await check(f, "add MAX then delete");
    });
    await t.test("F09: deletion MAX followed by concurrent parent edit", async () => {
      const f = await fixture(), paused = pauseAfterReplyMax(db, base), next = enteredConnection(db, base);
      const deleting = paused.service.deleteReply({ ...f.replies[1] }); await paused.ready;
      let editing;
      try {
        editing = next.service.updateDiscussionTitleAndContent({ ...f.discussion }, "new title", "new content"); await next.entered;
        assert.equal(await Promise.race([editing.then(() => true), delay(100).then(() => false)]), false);
      } finally { paused.release(); }
      await Promise.all([deleting, editing]); const result = await check(f, "delete MAX then parent edit");
      assert.equal(result.discussion.title, "new title");
    });
    await t.test("F09: parallel additions with parent FK avoid lock upgrades/deadlocks", async () => {
      const f = await fixture([]);
      await Promise.all(Array.from({ length: 12 }, (_, index) => service.addReply({ id: 1 }, { ...f.discussion }, `parallel ${index}`)));
      const result = await check(f, "12 simultaneous additions with parent FK"); assert.equal(result.replies.length, 12);
    });
    await t.test("F09: simultaneous duplicate deletion and deletion of last reply", async () => {
      const f = await fixture([2]);
      await Promise.all([service.deleteReply({ ...f.replies[0] }), service.deleteReply({ ...f.replies[0] })]);
      const result = await check(f, "duplicate last-reply deletion"); assert.equal(result.replies.length, 0);
      assert.equal(+result.discussion.sortTime, +result.discussion.publishTime);
    });
    await t.test("F09: sequential deletion preserves latest reply and falls back to parent edit", async () => {
      const f = await fixture();
      await service.addReply({ id: 1 }, f.discussion, "latest reply");
      await service.deleteReply({ ...f.replies[1] }); await check(f, "sequential delete keeps latest reply");
      await service.updateDiscussionTitleAndContent({ ...f.discussion }, "edited", "edited content");
      for (const reply of await rr.findBy({ discussionId: f.discussion.id })) await service.deleteReply({ ...reply });
      const result = await check(f, "no replies falls back to parent edit");
      assert.equal(+result.discussion.sortTime, +result.discussion.editTime);
    });
  } finally {
    if (initialized) {
      for (const name of ["reply", "content", "discussion"]) await db.query(`DROP TABLE IF EXISTS \`${prefix + name}\``);
      const remaining = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?)",
        [prefix + "reply", prefix + "content", prefix + "discussion"]);
      assert.equal(remaining.length, 0); evidence.push({ cleanup: "all randomized tables removed", remaining });
      await db.destroy();
    }
    if (process.env.HYHOJ_DISCUSSION_TEST_EVIDENCE) fs.writeFileSync(process.env.HYHOJ_DISCUSSION_TEST_EVIDENCE,
      JSON.stringify({ prefix, parentForeignKeyVerified, evidence }, null, 2));
  }
});
