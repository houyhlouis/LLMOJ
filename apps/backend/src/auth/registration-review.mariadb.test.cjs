/* Opt in only for an isolated fixture MariaDB socket; never a production DB. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  crypto = require("node:crypto"),
  jwt = require("jsonwebtoken"),
  bcrypt = require("bcrypt");
const { DataSource } = require("typeorm");
const {
  UserEntity,
  UserService,
  UserPrivilegeService,
  UserPrivilegeEntity,
  UserPrivilegeType,
  UserPermissionRuleEntity,
  AccessController,
  UserAuthEntity,
  UserInformationEntity,
  UserPreferenceEntity,
  AuditLogEntity,
  RegistrationReviewEntity,
  RegistrationApplicationEntity,
  RegistrationReviewService,
  AuthService,
  controller,
  sessionService
} = require("./registration-test-helpers.cjs");
const { AuditService } = require("../audit/audit.service.ts");
const { EmailVerificationCodeType } = require("./auth-email-verification-code.service.ts");

test(
  "private registration applications and transactional approval (real MariaDB)",
  { skip: !process.env.LLMOJ_REGISTRATION_TEST_DATABASE, timeout: 90000 },
  async t => {
    const config = JSON.parse(fs.readFileSync(process.env.LLMOJ_REGISTRATION_TEST_DATABASE, "utf8"));
    assert.match(
      config.socketPath,
      /^(?:\/tmp\/llmoj-registration-[A-Za-z0-9_-]+\/data|\/var\/tmp\/llmoj-registration-[A-Za-z0-9_-]+)\/mariadb\/mysql\.sock$/
    );
    assert.match(config.database, /^(?:llmoj_registration_test|test_registration_v2)(?:_[a-z0-9_]+)?$/);
    assert.ok(!config.host && !config.port);
    const prefix = `rr_${crypto.randomBytes(6).toString("hex")}_`;
    const db = new DataSource({
      type: "mariadb",
      username: config.username,
      password: config.password || "",
      database: config.database,
      extra: { socketPath: config.socketPath },
      entityPrefix: prefix,
      entities: [
        UserEntity,
        UserPrivilegeEntity,
        UserPermissionRuleEntity,
        UserAuthEntity,
        UserInformationEntity,
        UserPreferenceEntity,
        AuditLogEntity,
        RegistrationReviewEntity,
        RegistrationApplicationEntity
      ],
      synchronize: true,
      logging: false
    });
    await db.initialize();
    try {
      const users = db.getRepository(UserEntity),
        applications = db.getRepository(RegistrationApplicationEntity),
        legacyReviews = db.getRepository(RegistrationReviewEntity),
        audits = db.getRepository(AuditLogEntity);
      const settings = {
        config: { preference: { security: { registrationMode: "open", requireEmailVerification: false } } }
      };
      const userService = Object.assign(Object.create(UserService.prototype), {
        connection: db,
        userRepository: users
      });
      const auth = new AuthService(db, db.getRepository(UserAuthEntity), userService, {}, settings);
      const privileges = new UserPrivilegeService(db, db.getRepository(UserPrivilegeEntity), userService);
      const permissions = new AccessController(db, privileges);
      const reviews = new RegistrationReviewService(db, privileges),
        { sessions } = sessionService(reviews, userService);
      const api = controller({
        authService: auth,
        registrationReviews: reviews,
        authSessionService: sessions,
        userService,
        auditService: new AuditService(audits),
        configService: settings,
        userMigrationService: { findUserMigrationInfoByOldUsername: async () => null },
        authEmailVerificationCodeService: { verify: async () => true }
      });
      const req = { ip: "127.0.0.1", headers: { "user-agent": "isolated test" } };
      let n = 0;
      const signup = async mode => {
        settings.config.preference.security.registrationMode = mode;
        const username = `fixture${++n}`;
        const [error, user] = await auth.register(username, `${username}@example.test`, null, "fixture-password");
        assert.equal(error, null);
        if (mode === "approval") {
          assert.equal(user, null);
          return await applications.findOneBy({ username });
        }
        return user;
      };
      const legacy = await signup(undefined),
        admin = await signup("open"),
        manager = await signup("open");
      await users.update(admin.id, { isAdmin: true });
      admin.isAdmin = true;
      const decide = (candidate, decision, reason) =>
        reviews.review(admin, { applicationId: candidate.id, decision, reason }, req.ip);
      const login = (candidate, password = "fixture-password") =>
        api.login(req, null, { username: candidate.username, password });
      const counts = async () =>
        Promise.all(
          [UserEntity, UserAuthEntity, UserInformationEntity, UserPreferenceEntity].map(e =>
            db.getRepository(e).count()
          )
        );
      const nextUserId = async () =>
        String(
          (
            await db.query(
              "SELECT AUTO_INCREMENT AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
              [config.database, prefix + "user"]
            )
          )[0].n
        );
      const auditFor = async id => (await audits.find()).filter(a => a.details?.applicationId === id);
      let pending;
      await t.test(
        "approval creates only a private application; all user tables and AUTO_INCREMENT remain unchanged",
        async () => {
          const before = await counts(),
            sequence = await nextUserId();
          pending = await signup("approval");
          assert.deepEqual(await counts(), before);
          assert.equal(await nextUserId(), sequence);
          assert.equal(await users.findOneBy({ username: pending.username }), null);
          assert.equal(pending.userId, null);
          assert.equal(pending.status, "pending");
          assert.equal(pending.passwordHash, undefined);
          const privateApp = await applications
            .createQueryBuilder("a")
            .addSelect("a.passwordHash")
            .where("a.id=:id", { id: pending.id })
            .getOne();
          assert.match(privateApp.passwordHash, /^\$2[aby]\$/);
          assert.ok(await bcrypt.compare("fixture-password", privateApp.passwordHash));
          assert.equal(await legacyReviews.count(), 0);
          await reviews.onModuleInit();
          const token = await sessions.newSession(legacy, req.ip, "test");
          assert.equal((await sessions.accessSession(token))[1].id, legacy.id);
        }
      );
      await t.test(
        "handler emits no token; pending login checks credentials and reset never activates it",
        async () => {
          const before = await counts(),
            sequence = await nextUserId();
          assert.deepEqual(
            await api.register(req, null, {
              username: "controllerpending",
              email: "controller@example.test",
              password: "fixture-password"
            }),
            { registrationStatus: "pending" }
          );
          assert.deepEqual(await counts(), before);
          assert.equal(await nextUserId(), sequence);
          assert.deepEqual(await login(pending), { error: "REGISTRATION_PENDING" });
          assert.equal((await login(pending, "wrong-password")).error, "NO_SUCH_USER");
          assert.deepEqual(
            await api.resetPassword(req, null, {
              email: pending.email,
              newPassword: "changed",
              emailVerificationCode: "fixture"
            }),
            { error: "REGISTRATION_PENDING" }
          );
          assert.deepEqual(
            await api.sendEmailVerificationCode(null, {
              email: pending.email,
              type: EmailVerificationCodeType.ResetPassword
            }),
            { error: "REGISTRATION_PENDING" }
          );
        }
      );
      await t.test("pending applications reserve names and emails, even after changing mode to open", async () => {
        assert.equal(await userService.checkUsernameAvailability(pending.username), false);
        assert.equal(await userService.checkEmailAvailability(pending.email), false);
        settings.config.preference.security.registrationMode = "open";
        const before = await counts(),
          sequence = await nextUserId();
        assert.equal(
          (await auth.register(pending.username, "other@example.test", null, "fixture-password"))[0],
          "DUPLICATE_USERNAME"
        );
        assert.equal((await auth.register("othername", pending.email, null, "fixture-password"))[0], "DUPLICATE_EMAIL");
        assert.deepEqual(await login(pending), { error: "REGISTRATION_PENDING" });
        assert.deepEqual(await counts(), before);
        assert.equal(await nextUserId(), sequence);
        const noUserId = 999999;
        assert.deepEqual(
          await sessions.accessSession(jwt.sign(`${noUserId} 1`, "synthetic-registration-test-secret")),
          [null, null]
        );
        assert.equal(await sessions.accessSessionById(noUserId, 1), null);
      });
      await t.test("duplicate checks honor the database case-insensitive username/email collation", async () => {
        const before = await counts(),
          sequence = await nextUserId();
        assert.equal(await userService.checkUsernameAvailability(pending.username.toUpperCase()), false);
        assert.equal(await userService.checkEmailAvailability(pending.email.toUpperCase()), false);
        settings.config.preference.security.registrationMode = "approval";
        assert.equal(
          (await auth.register(pending.username.toUpperCase(), "caseother@example.test", null, "fixture-password"))[0],
          "DUPLICATE_USERNAME"
        );
        assert.equal(
          (await auth.register("caseother", pending.email.toUpperCase(), null, "fixture-password"))[0],
          "DUPLICATE_EMAIL"
        );
        assert.deepEqual(await counts(), before);
        assert.equal(await nextUserId(), sequence);
      });
      await t.test("closed and failed hashing leave users and applications unchanged", async () => {
        settings.config.preference.security.registrationMode = "closed";
        const before = [...(await counts()), await applications.count()],
          sequence = await nextUserId();
        assert.deepEqual(await auth.register("closedfixture", "closed@example.test", null, "fixture-password"), [
          "REGISTRATION_CLOSED",
          null
        ]);
        settings.config.preference.security.registrationMode = "approval";
        const hash = auth.hashPassword;
        auth.hashPassword = async () => {
          throw Error("fixture hashing failure");
        };
        try {
          await assert.rejects(auth.register("hashfail", "hashfail@example.test", null, "fixture"), /fixture hashing/);
        } finally {
          auth.hashPassword = hash;
        }
        assert.deepEqual([...(await counts()), await applications.count()], before);
        assert.equal(await nextUserId(), sequence);
      });
      await t.test("concurrent duplicate applications create one private row and no user allocation", async () => {
        const before = await counts(),
          sequence = await nextUserId();
        const results = await Promise.all(
          [1, 2].map(() => auth.register("simultaneous", "simultaneous@example.test", null, "fixture-password"))
        );
        assert.equal(results.filter(([error]) => error === null).length, 1);
        assert.equal(results.filter(([error]) => error === "DUPLICATE_USERNAME").length, 1);
        assert.deepEqual(await counts(), before);
        assert.equal(await nextUserId(), sequence);
      });
      await t.test(
        "only current authorized actors can list/review; DTOs contain application IDs and never hashes",
        async () => {
          await privileges.setUserPrivileges(manager.id, [UserPrivilegeType.ManageUser]);
          for (const actor of [manager, { ...manager, isAdmin: true }]) {
            assert.deepEqual(await reviews.list(actor, {}), { error: "PERMISSION_DENIED" });
            assert.deepEqual(await reviews.review(actor, { applicationId: pending.id, decision: "approved" }, req.ip), {
              error: "PERMISSION_DENIED"
            });
          }
          const first = await reviews.list(
              { ...admin, isAdmin: false },
              { status: "pending", skipCount: 0, takeCount: 1 }
            ),
            second = await reviews.list(admin, { status: "pending", skipCount: 1, takeCount: 1 });
          assert.equal(first.reviews.length, 1);
          assert.equal(first.count, 3);
          assert.notEqual(first.reviews[0].applicationId, second.reviews[0].applicationId);
          for (const item of [...first.reviews, ...second.reviews]) {
            assert.equal(item.userId, null);
            assert.equal(item.passwordHash, undefined);
            assert.equal(item.legacyAccountAudit, undefined);
            assert.equal(item.reservedUsername, undefined);
          }
        }
      );
      await t.test("concurrent approvals create exactly one complete user, one audit and a working login", async () => {
        const before = await counts();
        const results = await Promise.all([
          decide(pending, "approved", "first"),
          decide(pending, "approved", "second")
        ]);
        assert.ok(results.every(x => x.review.status === "approved"));
        assert.equal(results[0].review.userId, results[1].review.userId);
        assert.equal(results[0].review.reason, results[1].review.reason);
        assert.deepEqual(
          await counts(),
          before.map(x => x + 1)
        );
        assert.equal((await auditFor(pending.id)).length, 1);
        const actual = await users.findOneBy({ id: results[0].review.userId });
        assert.equal(actual.username, pending.username);
        assert.equal(actual.publicEmail, false);
        const app = await applications
          .createQueryBuilder("a")
          .addSelect("a.passwordHash")
          .where("a.id=:id", { id: pending.id })
          .getOne();
        assert.equal(app.passwordHash, null);
        assert.equal(app.reservedUsername, null);
        assert.equal(app.reservedEmail, null);
        assert.ok((await login(pending)).token);
      });
      await t.test(
        "rejection creates no user and consumes no user ID; credentials stay denied in open mode",
        async () => {
          const candidate = await signup("approval"),
            before = await counts(),
            sequence = await nextUserId();
          assert.equal((await decide(candidate, "rejected", "Incomplete application")).review.userId, null);
          assert.deepEqual(await counts(), before);
          assert.equal(await nextUserId(), sequence);
          settings.config.preference.security.registrationMode = "open";
          assert.deepEqual(await login(candidate), { error: "REGISTRATION_REJECTED" });
          assert.deepEqual(await api.resetPassword(req, null, { email: candidate.email, newPassword: "changed" }), {
            error: "REGISTRATION_REJECTED"
          });
          assert.equal((await auditFor(candidate.id)).length, 1);
          assert.equal((await auditFor(candidate.id))[0].firstObjectId, null);
          assert.equal(await users.findOneBy({ username: candidate.username }), null);
        }
      );
      await t.test("concurrent approve/reject decisions never downgrade or duplicate an approved account", async () => {
        const candidate = await signup("approval"),
          before = await counts();
        const results = await Promise.all([decide(candidate, "approved"), decide(candidate, "rejected")]);
        assert.equal(results[0].review.status, "approved");
        assert.ok(results[1].review?.status === "rejected" || results[1].error === "ALREADY_REVIEWED");
        assert.equal((await applications.findOneBy({ id: candidate.id })).status, "approved");
        assert.deepEqual(
          await counts(),
          before.map(n => n + 1)
        );
        const records = await auditFor(candidate.id);
        assert.equal(records.filter(record => record.action === "auth.registration_approved").length, 1);
        assert.ok(records.length === 1 || records.length === 2);
        const approved = records.find(record => record.action === "auth.registration_approved");
        assert.equal(approved.details.from, records.length === 2 ? "rejected" : "pending");
        assert.deepEqual(await decide(candidate, "rejected"), { error: "ALREADY_REVIEWED" });
      });
      await t.test("audit failure rolls back all four account rows and leaves the application pending", async () => {
        const candidate = await signup("approval"),
          before = await counts();
        const failing = new RegistrationReviewService(
          {
            transaction: (isolation, callback) =>
              db.transaction(isolation, async transaction => {
                const save = transaction.save.bind(transaction);
                transaction.save = (...args) => {
                  if (args[0] === AuditLogEntity) throw Error("fixture audit unavailable");
                  return save(...args);
                };
                return callback(transaction);
              })
          },
          privileges
        );
        await assert.rejects(
          failing.review(admin, { applicationId: candidate.id, decision: "approved" }, req.ip),
          /fixture audit/
        );
        assert.deepEqual(await counts(), before);
        assert.equal((await applications.findOneBy({ id: candidate.id })).status, "pending");
        assert.equal((await auditFor(candidate.id)).length, 0);
        assert.deepEqual(await login(candidate), { error: "REGISTRATION_PENDING" });
      });
      await t.test("real-user naming conflicts are reported without creating or approving an application", async () => {
        const candidate = await signup("approval");
        await users.update(manager.id, { username: candidate.username });
        const before = await counts();
        assert.deepEqual(await decide(candidate, "approved"), { error: "DUPLICATE_USERNAME" });
        assert.deepEqual(await counts(), before);
        await users.update(manager.id, { username: manager.username, email: candidate.email });
        assert.deepEqual(await decide(candidate, "approved"), { error: "DUPLICATE_EMAIL" });
        await users.update(manager.id, { email: manager.email });
        assert.equal((await applications.findOneBy({ id: candidate.id })).status, "pending");
      });
      await t.test(
        "delegated reviewer can approve a rejected application without losing its rejection audit",
        async () => {
          const candidate = await signup("approval");
          await decide(candidate, "rejected", "Please clarify the application");
          const rejected = await applications.findOneBy({ id: candidate.id }),
            originalAudit = await auditFor(candidate.id),
            before = await counts();
          await permissions.set(admin, {
            userId: manager.id,
            overrides: { ManageRegistrationReviews: true, ViewSite: true }
          });
          assert.equal(await privileges.userHasPrivilege(manager, UserPrivilegeType.ManageRegistrationReviews), true);
          assert.equal(await privileges.userHasPrivilege(manager, UserPrivilegeType.ManagePermissions), false);
          const list = await reviews.list(manager, { status: "rejected" });
          assert.ok(list.reviews.some(item => item.applicationId === candidate.id && item.userId === null));
          assert.throws(
            () => permissions.catalog(manager),
            error => error.getStatus() === 403
          );
          const repeatReject = await reviews.review(
            manager,
            { applicationId: candidate.id, decision: "rejected", reason: "ignored duplicate" },
            req.ip
          );
          assert.equal(repeatReject.review.reason, rejected.reason);
          assert.equal(repeatReject.review.reviewedBy, admin.id);
          const approved = await reviews.review(
            manager,
            { applicationId: candidate.id, decision: "approved", reason: "Clarification accepted" },
            req.ip
          );
          assert.equal(approved.review.status, "approved");
          assert.equal(approved.review.reviewedBy, manager.id);
          assert.ok(approved.review.userId);
          assert.deepEqual(
            await counts(),
            before.map(n => n + 1)
          );
          assert.ok((await login(candidate)).token);
          const stored = await applications
            .createQueryBuilder("a")
            .addSelect("a.passwordHash")
            .where("a.id=:id", { id: candidate.id })
            .getOne();
          assert.equal(stored.passwordHash, null);
          assert.equal(stored.reservedUsername, null);
          assert.equal(stored.reservedEmail, null);
          const history = await auditFor(candidate.id);
          assert.equal(history.length, 2);
          assert.deepEqual(
            history.find(row => row.id === originalAudit[0].id),
            originalAudit[0]
          );
          const approval = history.find(row => row.action === "auth.registration_approved");
          assert.deepEqual(approval.details, {
            applicationId: candidate.id,
            from: "rejected",
            to: "approved",
            reason: "Clarification accepted"
          });
          assert.equal(approval.userId, manager.id);
          assert.equal(approval.firstObjectId, approved.review.userId);
          const repeated = await reviews.review(
            manager,
            { applicationId: candidate.id, decision: "approved", reason: "must not replace" },
            req.ip
          );
          // MariaDB DATETIME persists seconds; compare against the stored review timestamp.
          assert.deepEqual(repeated.review, { ...approved.review, reviewedAt: stored.reviewedAt });
          assert.deepEqual(
            await reviews.review(manager, { applicationId: candidate.id, decision: "rejected" }, req.ip),
            { error: "ALREADY_REVIEWED" }
          );
          assert.deepEqual(
            await counts(),
            before.map(n => n + 1)
          );
          assert.equal((await auditFor(candidate.id)).length, 2);
          await permissions.set(admin, { userId: manager.id, overrides: { ManageRegistrationReviews: false } });
          assert.deepEqual(await reviews.list(manager, {}), { error: "PERMISSION_DENIED" });
          assert.deepEqual(
            await reviews.review(manager, { applicationId: candidate.id, decision: "approved" }, req.ip),
            { error: "PERMISSION_DENIED" }
          );
        }
      );
      await t.test("legacy privilege delegation works and unchecking it revokes both list and review", async () => {
        await privileges.setUserPrivileges(manager.id, [
          UserPrivilegeType.ViewSite,
          UserPrivilegeType.ManageRegistrationReviews
        ]);
        assert.equal(
          await db
            .getRepository(UserPermissionRuleEntity)
            .countBy({ userId: manager.id, permission: "ManageRegistrationReviews" }),
          0
        );
        assert.ok(Array.isArray((await reviews.list(manager, {})).reviews));
        const candidate = await signup("approval");
        assert.equal(
          (await reviews.review(manager, { applicationId: candidate.id, decision: "rejected" }, req.ip)).review.status,
          "rejected"
        );
        await privileges.setUserPrivileges(manager.id, []);
        const rejected = await applications.findOneBy({ id: candidate.id });
        assert.deepEqual(await reviews.list(manager, {}), { error: "PERMISSION_DENIED" });
        assert.deepEqual(await reviews.review(manager, { applicationId: candidate.id, decision: "approved" }, req.ip), {
          error: "PERMISSION_DENIED"
        });
        assert.deepEqual(await applications.findOneBy({ id: candidate.id }), rejected);
      });
      await t.test("explicit ViewSite denial blocks a delegated reviewer on both auth endpoints", async () => {
        const candidate = await signup("approval");
        await permissions.set(admin, {
          userId: manager.id,
          overrides: { ManageRegistrationReviews: true, ViewSite: false }
        });
        assert.equal(await privileges.userHasPrivilege(manager, UserPrivilegeType.ManageRegistrationReviews), true);
        const before = await counts();
        assert.deepEqual(await reviews.list(manager, {}), { error: "PERMISSION_DENIED" });
        assert.deepEqual(await reviews.review(manager, { applicationId: candidate.id, decision: "approved" }, req.ip), {
          error: "PERMISSION_DENIED"
        });
        assert.deepEqual(await counts(), before);
        assert.equal((await applications.findOneBy({ id: candidate.id })).status, "pending");
        assert.equal((await auditFor(candidate.id)).length, 0);
      });
      await t.test(
        "concurrent approvals of a rejected application create one account and preserve both transitions",
        async () => {
          const candidate = await signup("approval");
          await decide(candidate, "rejected", "Initial rejection");
          const before = await counts();
          const responses = await Promise.all([
            decide(candidate, "approved", "accepted"),
            decide(candidate, "approved", "second")
          ]);
          assert.equal(responses[0].review.userId, responses[1].review.userId);
          assert.deepEqual(
            await counts(),
            before.map(n => n + 1)
          );
          const records = await auditFor(candidate.id);
          assert.equal(records.length, 2);
          assert.equal(records.find(record => record.action === "auth.registration_approved").details.from, "rejected");
        }
      );
      await t.test(
        "approval conflict and audit failure leave an existing rejection and its credentials unchanged",
        async () => {
          const candidate = await signup("approval");
          await decide(candidate, "rejected", "Original rejection");
          const privateApplication = () =>
            applications
              .createQueryBuilder("a")
              .addSelect("a.passwordHash")
              .where("a.id=:id", { id: candidate.id })
              .getOne();
          const original = await privateApplication(),
            originalAudit = await auditFor(candidate.id),
            before = await counts();
          await users.update(manager.id, { username: candidate.username.toUpperCase() });
          assert.deepEqual(await decide(candidate, "approved"), { error: "DUPLICATE_USERNAME" });
          await users.update(manager.id, { username: manager.username, email: candidate.email.toUpperCase() });
          assert.deepEqual(await decide(candidate, "approved"), { error: "DUPLICATE_EMAIL" });
          await users.update(manager.id, { email: manager.email });
          const failing = new RegistrationReviewService(
            {
              transaction: (isolation, callback) =>
                db.transaction(isolation, async transaction => {
                  const save = transaction.save.bind(transaction);
                  transaction.save = (...args) => {
                    if (args[0] === AuditLogEntity) throw Error("fixture rejected-approval audit unavailable");
                    return save(...args);
                  };
                  return callback(transaction);
                })
            },
            privileges
          );
          await assert.rejects(
            failing.review(admin, { applicationId: candidate.id, decision: "approved" }, req.ip),
            /fixture rejected-approval audit/
          );
          assert.deepEqual(await counts(), before);
          assert.deepEqual(await privateApplication(), original);
          assert.deepEqual(await auditFor(candidate.id), originalAudit);
          assert.deepEqual(await login(candidate), { error: "REGISTRATION_REJECTED" });
        }
      );
      const deferred = () => {
        let resolve;
        const promise = new Promise(done => {
          resolve = done;
        });
        return { promise, resolve };
      };
      await t.test("approval rereads a revocation committed while it waits for the actor lock", async () => {
        const candidate = await signup("approval");
        await privileges.setUserPrivileges(manager.id, [
          UserPrivilegeType.ViewSite,
          UserPrivilegeType.ManageRegistrationReviews
        ]);
        const runner = db.createQueryRunner();
        await runner.connect();
        await runner.startTransaction("READ COMMITTED");
        const attempted = deferred();
        let pendingReview;
        try {
          await runner.manager.findOne(UserEntity, { where: { id: manager.id }, lock: { mode: "pessimistic_write" } });
          await runner.manager.save(UserPermissionRuleEntity, {
            userId: manager.id,
            permission: "ManageRegistrationReviews",
            allowed: false
          });
          const waiting = new RegistrationReviewService(
            {
              transaction: (isolation, callback) =>
                db.transaction(isolation, async transaction => {
                  const find = transaction.findOne.bind(transaction);
                  transaction.findOne = (...args) => {
                    attempted.resolve();
                    return find(...args);
                  };
                  return callback(transaction);
                })
            },
            privileges
          );
          pendingReview = waiting.review(manager, { applicationId: candidate.id, decision: "approved" }, req.ip);
          await attempted.promise;
          await runner.commitTransaction();
          assert.deepEqual(await pendingReview, { error: "PERMISSION_DENIED" });
          assert.equal((await applications.findOneBy({ id: candidate.id })).status, "pending");
          assert.equal(await users.countBy({ username: candidate.username }), 0);
          assert.equal((await auditFor(candidate.id)).length, 0);
        } finally {
          if (runner.isTransactionActive) await runner.rollbackTransaction();
          await runner.release();
          if (pendingReview) await pendingReview;
        }
      });
      for (const writer of ["detailed override", "legacy checkboxes"])
        await t.test(`${writer} revocation waits for an authorized approval transaction to finish`, async () => {
          const candidate = await signup("approval");
          await privileges.setUserPrivileges(manager.id, [
            UserPrivilegeType.ViewSite,
            UserPrivilegeType.ManageRegistrationReviews
          ]);
          const authorized = deferred(),
            releaseApproval = deferred(),
            writerAttempt = deferred();
          const heldPermissions = {
            userHasPrivilege: async (...args) => {
              const allowed = await privileges.userHasPrivilege(...args);
              if (args[1] === UserPrivilegeType.ManageRegistrationReviews) {
                authorized.resolve();
                await releaseApproval.promise;
              }
              return allowed;
            }
          };
          const heldReviews = new RegistrationReviewService(db, heldPermissions);
          const observedDb = Object.create(db);
          observedDb.transaction = (...args) =>
            db.transaction("READ COMMITTED", async transaction => {
              const [{ id }] = await transaction.query("SELECT CONNECTION_ID() AS id");
              const find = transaction.findOne.bind(transaction);
              transaction.findOne = (...findArgs) => {
                writerAttempt.resolve(id);
                return find(...findArgs);
              };
              return args.at(-1)(transaction);
            });
          let approval, revocation;
          try {
            approval = heldReviews.review(manager, { applicationId: candidate.id, decision: "approved" }, req.ip);
            await authorized.promise;
            revocation =
              writer === "detailed override"
                ? new AccessController(observedDb, privileges).set(admin, {
                    userId: manager.id,
                    overrides: { ManageRegistrationReviews: false }
                  })
                : new UserPrivilegeService(
                    observedDb,
                    db.getRepository(UserPrivilegeEntity),
                    userService
                  ).setUserPrivileges(manager.id, []);
            const connectionId = await writerAttempt.promise;
            let blocked = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const [{ n: waits }] = await db.query(
                "SELECT COUNT(*) AS n FROM information_schema.INNODB_LOCK_WAITS w JOIN information_schema.INNODB_TRX t ON t.trx_id = w.requesting_trx_id WHERE t.trx_mysql_thread_id = ?",
                [connectionId]
              );
              if (Number(waits)) {
                blocked = true;
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(blocked, true, "real MariaDB must block the permission writer behind the review's actor lock");
            releaseApproval.resolve();
            assert.equal((await approval).review.status, "approved");
            await revocation;
            assert.deepEqual(await reviews.list(manager, {}), { error: "PERMISSION_DENIED" });
            assert.deepEqual(
              await reviews.review(manager, { applicationId: candidate.id, decision: "approved" }, req.ip),
              { error: "PERMISSION_DENIED" }
            );
            assert.equal((await auditFor(candidate.id)).length, 1);
          } finally {
            releaseApproval.resolve();
            await Promise.allSettled([approval, revocation].filter(Boolean));
          }
        });
      await t.test("approved history does not permanently reserve an old username/email", async () => {
        const actual = await users.findOneBy({ username: pending.username });
        await users.update(actual.id, { username: "renamedfixture", email: "renamed@example.test" });
        assert.equal(await userService.checkUsernameAvailability(pending.username), true);
        assert.equal(await userService.checkEmailAvailability(pending.email), true);
        settings.config.preference.security.registrationMode = "approval";
        assert.equal((await auth.register(pending.username, pending.email, null, "new-password"))[0], null);
        assert.equal(await applications.countBy({ username: pending.username }), 2);
      });
      await t.test(
        "unmigrated old blocking rows refuse startup without deleting accounts; old approved users stay active",
        async () => {
          await legacyReviews.save({ userId: legacy.id, status: "pending", createdAt: new Date() });
          const before = await counts();
          await assert.rejects(reviews.onModuleInit(), /Unmigrated legacy/);
          assert.deepEqual(await counts(), before);
          assert.deepEqual(await login(legacy), { error: "REGISTRATION_PENDING" });
          await assert.rejects(
            sessions.newSession(legacy, req.ip, "test"),
            e => e.getResponse().error === "REGISTRATION_PENDING"
          );
          await legacyReviews.update(legacy.id, { status: "approved" });
          await reviews.onModuleInit();
          assert.ok((await login(legacy)).token);
          assert.deepEqual(await reviews.review(admin, { applicationId: 999999, decision: "approved" }, req.ip), {
            error: "NO_SUCH_APPLICATION"
          });
        }
      );
    } finally {
      const runner = db.createQueryRunner();
      await runner.connect();
      try {
        await runner.query("SET FOREIGN_KEY_CHECKS=0");
        for (const metadata of db.entityMetadatas) {
          assert.ok(metadata.tableName.startsWith(prefix));
          await runner.query(`DROP TABLE IF EXISTS \`${metadata.tableName}\``);
        }
        await runner.query("SET FOREIGN_KEY_CHECKS=1");
      } finally {
        await runner.release();
        await db.destroy();
      }
    }
  }
);
