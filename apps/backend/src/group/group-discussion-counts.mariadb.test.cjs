/* Opt-in real MariaDB regression. The actual service methods run against random
   isolated tables; no production row is read or written. Tables are dropped in
   finally. HYHOJ_COUNT_TEST_DB_CONFIG points to the existing backend YAML. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ts = require("typescript");
require("reflect-metadata");
const baseline = process.env.HYHOJ_COUNT_TEST_SERVICE_BASELINE;
require.extensions[".ts"] = (module, filename) => {
  let source = filename;
  if (baseline && /\/(discussion|group)\/\1\.service\.ts$/.test(filename)) {
    source = path.join(baseline, path.relative(path.resolve(__dirname, "../../../.."), filename));
  }
  module._compile(ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
  }).outputText, filename);
};
String.prototype.format ||= function (...args) { return require("node:util").format(this, ...args); };
const { DataSource, EntitySchema } = require("typeorm");
const { DiscussionService } = require("../discussion/discussion.service.ts");
const { DiscussionEntity } = require("../discussion/discussion.entity.ts");
const { DiscussionContentEntity } = require("../discussion/discussion-content.entity.ts");
const { DiscussionReplyEntity } = require("../discussion/discussion-reply.entity.ts");
const { GroupService } = require("./group.service.ts");
const { GroupEntity } = require("./group.entity.ts");
const { GroupMembershipEntity } = require("./group-membership.entity.ts");
const { AddUserToGroupResponseError, RemoveUserFromGroupResponseError, SetGroupAdminResponseError } = require("./dto");
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
function overlap(db, participants = 2) {
  const ready = deferred();
  let entered = 0;
  return { transaction: (isolation, callback) => db.transaction(isolation, async manager => {
    if (++entered === participants) ready.resolve();
    await ready.promise;
    return callback(manager);
  }) };
}

test("discussion/group counters reflect committed child rows under concurrency (real MariaDB)",
  { skip: !process.env.HYHOJ_COUNT_TEST_DB_CONFIG, timeout: 45000 }, async t => {
  const config = require("js-yaml").load(fs.readFileSync(process.env.HYHOJ_COUNT_TEST_DB_CONFIG, "utf8")).services.database;
  const prefix = `qa_counts_${crypto.randomBytes(8).toString("hex")}_`;
  const integer = { type: Number }, datetime = { type: "datetime" };
  const definitions = [
    [DiscussionEntity, "discussion", { id: { ...integer, primary: true, generated: true },
      title: { type: String }, isPublic: { type: Boolean }, publisherId: integer, problemId: { ...integer, nullable: true },
      replyCount: integer, publishTime: datetime, editTime: { ...datetime, nullable: true }, sortTime: datetime }],
    [DiscussionContentEntity, "content", { discussionId: { ...integer, primary: true }, content: { type: "text" } }],
    [DiscussionReplyEntity, "reply", { id: { ...integer, primary: true, generated: true }, discussionId: integer,
      content: { type: "text" }, publishTime: datetime, editTime: { ...datetime, nullable: true },
      isPublic: { type: Boolean }, publisherId: integer }],
    [GroupEntity, "group", { id: { ...integer, primary: true, generated: true }, name: { type: String }, memberCount: integer }],
    [GroupMembershipEntity, "member", { id: { ...integer, primary: true, generated: true },
      userId: integer, groupId: integer, isGroupAdmin: { type: Boolean } }]
  ];
  const entities = definitions.map(([target, name, columns]) => new EntitySchema({ name: target.name, target,
    tableName: prefix + name, columns,
    indices: target === GroupMembershipEntity ? [{ columns: ["userId", "groupId"], unique: true }]
      : target === GroupEntity ? [{ columns: ["name"], unique: true }] : [] }));
  const db = new DataSource({ ...config, entities, synchronize: true, logging: false,
    extra: { ...config.extra, connectionLimit: 20 } });
  const evidence = [];
  let initialized = false, remainingTables;
  try {
    await db.initialize(); initialized = true;
    const discussionRepository = db.getRepository(DiscussionEntity), replyRepository = db.getRepository(DiscussionReplyEntity);
    const groupRepository = db.getRepository(GroupEntity), memberRepository = db.getRepository(GroupMembershipEntity);
    async function discussionFixture() {
      const discussion = await discussionRepository.save({ title: "Initial title", isPublic: true, publisherId: 99, problemId: null,
        replyCount: 2, publishTime: new Date("2026-01-01T00:00:00Z"),
        editTime: null, sortTime: new Date("2026-01-03T00:00:00Z") });
      await db.getRepository(DiscussionContentEntity).save({ discussionId: discussion.id, content: "Initial content" });
      const replies = await replyRepository.save([1, 2].map(day => ({ discussionId: discussion.id,
        publisherId: 99, content: `reply ${day}`, isPublic: true,
        publishTime: new Date(`2026-01-0${day + 1}T00:00:00Z`), editTime: null })));
      const service = Object.create(DiscussionService.prototype);
      Object.assign(service, { connection: db, discussionRepository, discussionReplyRepository: replyRepository,
        configService: { config: { preference: { security: { discussionReplyDefaultPublic: true } } } } });
      return { discussion, replies, service };
    }
    async function groupFixture() {
      const group = await groupRepository.save({ name: crypto.randomUUID(), memberCount: 2 });
      const members = await memberRepository.save([{ userId: 1, groupId: group.id, isGroupAdmin: true },
        { userId: 2, groupId: group.id, isGroupAdmin: false }]);
      const service = Object.create(GroupService.prototype);
      Object.assign(service, { connection: db, groupRepository, groupMembershipRepository: memberRepository,
        userService: { userExists: async userId => userId > 0 } });
      return { group, members, service };
    }
    async function assertDiscussionCount(f, expected, name) {
      const stored = await discussionRepository.findOneBy({ id: f.discussion.id });
      const actual = await replyRepository.countBy({ discussionId: f.discussion.id });
      evidence.push({ name, stored: stored.replyCount, actual });
      assert.equal(stored.replyCount, actual); assert.equal(actual, expected);
    }
    async function assertGroupCount(f, expected, name) {
      const stored = await groupRepository.findOneBy({ id: f.group.id });
      const actual = await memberRepository.countBy({ groupId: f.group.id });
      evidence.push({ name, stored: stored.memberCount, actual });
      assert.equal(stored.memberCount, actual); assert.equal(actual, expected);
    }
    for (const mode of ["title-and-content", "visibility"]) {
      for (const change of ["addition", "deletion"]) {
        await t.test(`T01: stale discussion ${mode} preserves a committed reply ${change}`, async () => {
          const f = await discussionFixture();
          const stale = await discussionRepository.findOneBy({ id: f.discussion.id });
          if (change === "addition") await f.service.addReply({ id: 99 }, f.discussion, "committed concurrent reply");
          else await f.service.deleteReply({ ...f.replies[1] });
          const expected = change === "addition" ? 3 : 1;
          const committed = await discussionRepository.findOneBy({ id: f.discussion.id });
          assert.equal(stale.replyCount, 2); assert.equal(committed.replyCount, expected);
          if (mode === "title-and-content") await f.service.updateDiscussionTitleAndContent(stale, "Edited title", "Edited content");
          else await f.service.setDiscussionPublic(stale, false);
          evidence.push({ name: `T01 ${mode} after reply ${change}`, cachedCount: stale.replyCount,
            committedBeforeParentWrite: committed.replyCount });
          await assertDiscussionCount(f, expected, `T01 ${mode} after reply ${change}`);
          if (mode === "title-and-content") {
            assert.equal(stale.title, "Edited title"); assert.ok(stale.editTime instanceof Date);
            const stored = await discussionRepository.findOneBy({ id: stale.id });
            assert.equal(stored.title, "Edited title");
            assert.equal(Math.floor(+stored.editTime / 1000), Math.floor(+stale.editTime / 1000));
            assert.equal((await db.getRepository(DiscussionContentEntity).findOneBy({ discussionId: stale.id })).content, "Edited content");
            assert.equal(+stored.sortTime, Math.max(Math.floor(+stale.editTime / 1000) * 1000, +committed.sortTime));
          } else {
            const stored = await discussionRepository.findOneBy({ id: stale.id });
            assert.equal(stale.isPublic, false); assert.equal(stored.isPublic, false);
            assert.equal(+stored.sortTime, +committed.sortTime);
          }
        });
      }
    }
    for (const change of ["addition", "removal"]) {
      await t.test(`T02: stale group rename preserves a committed member ${change}`, async () => {
        const f = await groupFixture();
        const stale = await groupRepository.findOneBy({ id: f.group.id });
        assert.equal(change === "addition" ? await f.service.addUserToGroup(3, f.group)
          : await f.service.removeUserFromGroup(2, f.group), null);
        const expected = change === "addition" ? 3 : 1;
        const committed = await groupRepository.findOneBy({ id: f.group.id });
        assert.equal(stale.memberCount, 2); assert.equal(committed.memberCount, expected);
        const name = crypto.randomUUID();
        assert.equal(await f.service.renameGroup(stale, name), true);
        assert.equal(stale.name, name);
        assert.equal((await groupRepository.findOneBy({ id: stale.id })).name, name);
        evidence.push({ name: `T02 rename after member ${change}`, cachedCount: stale.memberCount,
          committedBeforeParentWrite: committed.memberCount });
        await assertGroupCount(f, expected, `T02 rename after member ${change}`);
      });
    }
    await t.test("title/content and publicness updates from stale parents preserve each other's fields", async () => {
      const f = await discussionFixture();
      const editor = await discussionRepository.findOneBy({ id: f.discussion.id });
      const moderator = await discussionRepository.findOneBy({ id: f.discussion.id });
      await f.service.updateDiscussionTitleAndContent(editor, "Concurrent title", "Concurrent content");
      await f.service.setDiscussionPublic(moderator, false);
      let stored = await discussionRepository.findOneBy({ id: f.discussion.id });
      assert.equal(stored.title, "Concurrent title"); assert.equal(stored.isPublic, false);
      assert.equal(Math.floor(+stored.editTime / 1000), Math.floor(+editor.editTime / 1000));
      await f.service.updateDiscussionTitleAndContent(editor, "Second title", "Second content");
      stored = await discussionRepository.findOneBy({ id: f.discussion.id });
      assert.equal(stored.title, "Second title"); assert.equal(stored.isPublic, false);
      assert.equal((await db.getRepository(DiscussionContentEntity).findOneBy({ discussionId: stored.id })).content, "Second content");
      await assertDiscussionCount(f, 2, "independent discussion updates");
    });
    await t.test("discussion parent/content/sort changes roll back together after a content write failure", async () => {
      const f = await discussionFixture();
      const discussion = await discussionRepository.findOneBy({ id: f.discussion.id });
      f.service.connection = { transaction: (isolation, callback) => db.transaction(isolation, manager => {
        const save = manager.save.bind(manager);
        manager.save = async entity => {
          if (entity instanceof DiscussionContentEntity) throw Error("forced content write failure");
          return save(entity);
        };
        return callback(manager);
      }) };
      await assert.rejects(f.service.updateDiscussionTitleAndContent(discussion, "Rejected title", "Rejected content"), /forced content write failure/);
      const stored = await discussionRepository.findOneBy({ id: f.discussion.id });
      assert.equal(stored.title, "Initial title"); assert.equal(stored.editTime, null);
      assert.equal(+stored.sortTime, +new Date("2026-01-03T00:00:00Z"));
      assert.equal((await db.getRepository(DiscussionContentEntity).findOneBy({ discussionId: stored.id })).content, "Initial content");
      await assertDiscussionCount(f, 2, "discussion edit transaction rollback");
    });
    await t.test("group rename preserves duplicate-name rejection and leaves stored count/name intact", async () => {
      const f = await groupFixture(), other = await groupFixture();
      assert.equal(await f.service.renameGroup(f.group, other.group.name), false);
      const stored = await groupRepository.findOneBy({ id: f.group.id });
      assert.notEqual(stored.name, other.group.name);
      await assertGroupCount(f, 2, "duplicate group name guard");
    });
    await t.test("N01: two overlapping deletes of the same cached reply decrement once", async () => {
      const f = await discussionFixture(); f.service.connection = overlap(db);
      await Promise.all([f.service.deleteReply({ ...f.replies[1] }), f.service.deleteReply({ ...f.replies[1] })]);
      await assertDiscussionCount(f, 1, "N01 duplicate reply deletion");
      assert.equal(+(await discussionRepository.findOneBy({ id: f.discussion.id })).sortTime, +f.replies[0].publishTime);
    });
    await t.test("deleting an already removed cached reply does not reduce the count", async () => {
      const f = await discussionFixture();
      await f.service.deleteReply({ ...f.replies[0] }); await f.service.deleteReply({ ...f.replies[0] });
      await assertDiscussionCount(f, 1, "sequential stale reply deletion");
    });
    await t.test("normal reply edits preserve the response editTime and publicness", async () => {
      const f = await discussionFixture(), reply = f.replies[0];
      await f.service.updateReplyContent(reply, "edited content");
      assert.equal(reply.content, "edited content");
      assert.ok(reply.editTime instanceof Date);
      await f.service.setReplyPublic(reply, false);
      assert.equal(reply.isPublic, false);
      const stored = await replyRepository.findOneBy({ id: reply.id });
      assert.equal(stored.content, "edited content"); assert.equal(stored.isPublic, false);
      assert.equal(Math.floor(+stored.editTime / 1000), Math.floor(+reply.editTime / 1000));
      await assertDiscussionCount(f, 2, "normal reply edits");
    });
    await t.test("reply edits/publicness cannot resurrect an already deleted reply", async () => {
      const f = await discussionFixture();
      await f.service.deleteReply({ ...f.replies[0] });
      await f.service.updateReplyContent({ ...f.replies[0] }, "late edit");
      await f.service.setReplyPublic({ ...f.replies[0] }, false);
      assert.equal(await replyRepository.countBy({ id: f.replies[0].id }), 0);
      await assertDiscussionCount(f, 1, "stale reply edits");
    });
    await t.test("concurrent reply additions and deletion keep the stored count exact", async () => {
      const f = await discussionFixture();
      await Promise.all([f.service.deleteReply({ ...f.replies[0] }),
        ...Array.from({ length: 4 }, (_, i) => f.service.addReply({ id: 99 }, f.discussion, `new ${i}`))]);
      await assertDiscussionCount(f, 5, "reply add/delete concurrency");
    });
    await t.test("reply deletion/count/sort update all roll back after an increment failure", async () => {
      const f = await discussionFixture();
      f.service.connection = { transaction: (isolation, callback) => db.transaction(isolation, manager => {
        manager.increment = async () => { throw Error("forced count write failure"); }; return callback(manager);
      }) };
      await assert.rejects(f.service.deleteReply({ ...f.replies[1] }), /forced count write failure/);
      await assertDiscussionCount(f, 2, "reply transaction rollback");
      assert.equal(+(await discussionRepository.findOneBy({ id: f.discussion.id })).sortTime, +f.discussion.sortTime);
    });
    await t.test("N02: two overlapping removals of one member decrement once", async () => {
      const f = await groupFixture(); f.service.connection = overlap(db);
      const results = await Promise.all([f.service.removeUserFromGroup(2, f.group), f.service.removeUserFromGroup(2, f.group)]);
      await assertGroupCount(f, 1, "N02 duplicate member removal");
      assert.deepEqual(results.sort(), [null, RemoveUserFromGroupResponseError.USER_NOT_IN_GROUP].sort());
    });
    await t.test("sequential removals preserve the absent-member error and exact count", async () => {
      const f = await groupFixture();
      assert.equal(await f.service.removeUserFromGroup(2, f.group), null);
      assert.equal(await f.service.removeUserFromGroup(2, f.group), RemoveUserFromGroupResponseError.USER_NOT_IN_GROUP);
      await assertGroupCount(f, 1, "sequential member removal");
    });
    await t.test("a member promoted before the transaction read cannot be removed", async () => {
      const f = await groupFixture(), ready = deferred(), release = deferred();
      f.service.connection = { transaction: (isolation, callback) => db.transaction(isolation, async manager => {
        ready.resolve(); await release.promise; return callback(manager);
      }) };
      const removing = f.service.removeUserFromGroup(2, f.group);
      await ready.promise;
      assert.equal(await f.service.setIsGroupAdmin(2, f.group.id, true), null);
      release.resolve();
      assert.equal(await removing, RemoveUserFromGroupResponseError.GROUP_ADMIN_CAN_NOT_BE_REMOVED);
      await assertGroupCount(f, 2, "promotion before removal");
    });
    await t.test("admin flag update cannot resurrect a concurrently deleted membership", async () => {
      const f = await groupFixture(), read = memberRepository.findOneBy.bind(memberRepository);
      const ready = deferred(), release = deferred();
      let reads = 0;
      f.service.groupMembershipRepository = { ...memberRepository,
        update: memberRepository.update.bind(memberRepository),
        findOneBy: async criteria => {
          const member = await read(criteria);
          if (++reads === 1) { ready.resolve(); await release.promise; }
          return member;
        } };
      f.service.groupMembershipRepository.update = async (...args) => {
        ready.resolve(); await release.promise; return memberRepository.update(...args);
      };
      f.service.groupMembershipRepository.save = memberRepository.save.bind(memberRepository);
      const updating = f.service.setIsGroupAdmin(2, f.group.id, true);
      await ready.promise;
      await f.service.removeUserFromGroup(2, f.group);
      release.resolve();
      const result = await updating;
      assert.equal(await memberRepository.countBy({ userId: 2, groupId: f.group.id }), 0);
      assert.equal(result, SetGroupAdminResponseError.USER_NOT_IN_GROUP);
      await assertGroupCount(f, 1, "admin update after removal");
    });
    await t.test("two concurrent additions of the same user only increment once", async () => {
      const f = await groupFixture(); f.service.connection = overlap(db);
      const results = await Promise.all([f.service.addUserToGroup(3, f.group), f.service.addUserToGroup(3, f.group)]);
      assert.deepEqual(results.sort(), [null, AddUserToGroupResponseError.USER_ALREADY_IN_GROUP].sort());
      await assertGroupCount(f, 3, "duplicate member addition");
    });
    await t.test("simultaneous member additions/removal keep the stored count exact", async () => {
      const f = await groupFixture();
      await Promise.all([f.service.removeUserFromGroup(2, f.group),
        ...[3, 4, 5, 6].map(userId => f.service.addUserToGroup(userId, f.group))]);
      await assertGroupCount(f, 5, "member add/remove concurrency");
    });
    await t.test("member deletion and its count roll back after an increment failure", async () => {
      const f = await groupFixture();
      f.service.connection = { transaction: (isolation, callback) => db.transaction(isolation, manager => {
        manager.increment = async () => { throw Error("forced count write failure"); }; return callback(manager);
      }) };
      await assert.rejects(f.service.removeUserFromGroup(2, f.group), /forced count write failure/);
      await assertGroupCount(f, 2, "member transaction rollback");
    });
    await t.test("existing admins remain protected and setting the same admin flag succeeds", async () => {
      const f = await groupFixture();
      assert.equal(await f.service.setIsGroupAdmin(1, f.group.id, true), null);
      assert.equal(await f.service.removeUserFromGroup(1, f.group), RemoveUserFromGroupResponseError.GROUP_ADMIN_CAN_NOT_BE_REMOVED);
      assert.equal(await f.service.removeUserFromGroup(0, f.group), RemoveUserFromGroupResponseError.NO_SUCH_USER);
      assert.equal(await f.service.setIsGroupAdmin(0, f.group.id, true), SetGroupAdminResponseError.NO_SUCH_USER);
      await assertGroupCount(f, 2, "administrator and unknown-user guards");
    });
  } finally {
    if (initialized) {
      for (const [, name] of [...definitions].reverse()) await db.query(`DROP TABLE IF EXISTS \`${prefix + name}\``);
      remainingTables = await db.query(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${definitions.map(() => "?").join(",")})`,
        definitions.map(([, name]) => prefix + name));
      await db.destroy();
    }
    if (process.env.HYHOJ_COUNT_TEST_RESULTS) {
      fs.writeFileSync(process.env.HYHOJ_COUNT_TEST_RESULTS, JSON.stringify({
        isolatedTables: definitions.map(([, name]) => prefix + name),
        isolatedTablesDropped: initialized && remainingTables.length === 0, remainingTables, evidence
      }, null, 2) + "\n");
    }
    if (initialized) assert.deepEqual(remainingTables, []);
  }
});
