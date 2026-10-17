/* This test accepts only an explicit isolated fixture database and local socket. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  crypto = require("node:crypto");
const { DataSource } = require("typeorm");
const {
  UserEntity,
  UserAuthEntity,
  UserInformationEntity,
  UserPreferenceEntity,
  UserPrivilegeEntity,
  UserPermissionRuleEntity,
  AuditLogEntity,
  RegistrationReviewEntity,
  RegistrationApplicationEntity,
  SettingsEntity,
  UserService,
  AuthService,
  RegistrationSettingsService,
  controller
} = require("../auth/registration-test-helpers.cjs");
const { SiteManagementController } = require("./site-management.controller.ts");
const entities = [
  UserEntity,
  UserAuthEntity,
  UserInformationEntity,
  UserPreferenceEntity,
  UserPrivilegeEntity,
  UserPermissionRuleEntity,
  AuditLogEntity,
  RegistrationReviewEntity,
  RegistrationApplicationEntity,
  SettingsEntity
];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

test(
  "registration policy persistence, authorization and atomic updates (real MariaDB)",
  {
    skip: !process.env.LLMOJ_REGISTRATION_TEST_DATABASE,
    timeout: 90000
  },
  async t => {
    const config = JSON.parse(fs.readFileSync(process.env.LLMOJ_REGISTRATION_TEST_DATABASE, "utf8"));
    assert.match(
      config.socketPath,
      /^(?:\/tmp\/llmoj-registration-[A-Za-z0-9_-]+\/data|\/var\/tmp\/llmoj-registration-[A-Za-z0-9_-]+)\/mariadb\/mysql\.sock$/
    );
    assert.match(config.database, /^(?:llmoj_registration_test|test_registration_v2)(?:_[a-z0-9_]+)?$/);
    assert.ok(!config.host && !config.port);
    const prefix = `policy_${crypto.randomBytes(6).toString("hex")}_`;
    const db = new DataSource({
      type: "mariadb",
      username: config.username,
      password: config.password || "",
      database: config.database,
      extra: { socketPath: config.socketPath },
      entityPrefix: prefix,
      entities,
      synchronize: true,
      logging: false
    });
    await db.initialize();
    try {
      const users = db.getRepository(UserEntity),
        applications = db.getRepository(RegistrationApplicationEntity),
        settingsRows = db.getRepository(SettingsEntity),
        audits = db.getRepository(AuditLogEntity);
      const configuration = {
        config: { preference: { security: { registrationMode: "open", requireEmailVerification: false } } }
      };
      const settings = new RegistrationSettingsService(db, configuration);
      const userService = Object.assign(Object.create(UserService.prototype), {
        connection: db,
        userRepository: users
      });
      const auth = new AuthService(db, db.getRepository(UserAuthEntity), userService, {}, configuration, settings);
      // Administrators here just signed in; the password confirmation itself is covered by step-up.test.cjs.
      const site = new SiteManagementController(settings, {}, { requireRecentAuthentication: async () => {} });
      const request = { ip: "127.0.0.1" };
      let serial = 0;
      const register = async () => {
        const username = `policyuser${++serial}`;
        return {
          username,
          result: await auth.register(username, `${username}@example.test`, null, "synthetic-policy-password")
        };
      };
      const admin = (await register()).result[1],
        reviewer = (await register()).result[1];
      await users.update(admin.id, { isAdmin: true });
      admin.isAdmin = true;
      for (const privilegeType of ["EditHomepage", "ManageRegistrationReviews"])
        await db.getRepository(UserPrivilegeEntity).save({ userId: reviewer.id, privilegeType });
      await settingsRows.save({ key: "homepage", value: { notice: "custom content remains untouched" } });
      const immutableConfiguration = JSON.stringify(configuration);
      const counts = async () =>
        Promise.all(
          [UserEntity, UserAuthEntity, UserInformationEntity, UserPreferenceEntity, RegistrationApplicationEntity].map(
            entity => db.getRepository(entity).count()
          )
        );
      const records = () => audits.find({ where: { action: "site.registration_mode.update" }, order: { id: "ASC" } });
      const policy = () => settingsRows.findOneBy({ key: "registration-policy" });
      const update = mode => site.updateRegistrationMode(admin, { registrationMode: mode }, request);

      await t.test("unsaved mode uses YAML and no settings are exposed to non-administrators", async () => {
        assert.deepEqual(await site.getSettings({ ...admin, isAdmin: false }), {
          registrationMode: "open",
          configuredRegistrationMode: "open",
          usesOverride: false
        });
        for (const actor of [null, reviewer, { ...reviewer, isAdmin: true }]) {
          await assert.rejects(site.getSettings(actor), error => error.getStatus() === 403);
          await assert.rejects(
            site.updateRegistrationMode(actor, { registrationMode: "closed" }, request),
            error => error.getStatus() === 403
          );
        }
        assert.equal((await records()).length, 0);
        assert.equal((await policy()).value.registrationMode, null);
      });

      for (const mode of ["approval", "closed", "open"])
        await t.test(
          `saving ${mode} immediately affects registration and a newly created service instance`,
          async () => {
            assert.deepEqual(await update(mode), {
              registrationMode: mode,
              configuredRegistrationMode: "open",
              usesOverride: true
            });
            assert.equal(await new RegistrationSettingsService(db, configuration).getRegistrationMode(), mode);
            const before = await counts();
            const { username, result } = await register();
            if (mode === "closed") {
              assert.deepEqual(result, ["REGISTRATION_CLOSED", null]);
              assert.deepEqual(await counts(), before);
            } else if (mode === "approval") {
              assert.deepEqual(result, [null, null]);
              assert.equal((await applications.findOneBy({ username })).status, "pending");
              assert.equal(await users.countBy({ username }), 0);
              assert.deepEqual(
                await counts(),
                before.map((n, i) => n + Number(i === 4))
              );
            } else {
              assert.equal(result[0], null);
              assert.ok(result[1].id);
              assert.deepEqual(
                await counts(),
                before.map((n, i) => n + Number(i < 4))
              );
            }
            assert.equal(JSON.stringify(configuration), immutableConfiguration);
            assert.deepEqual((await settingsRows.findOneBy({ key: "homepage" })).value, {
              notice: "custom content remains untouched"
            });
          }
        );

      await t.test(
        "reset stores the null marker and restores YAML without a process restart or file changes",
        async () => {
          assert.deepEqual(await update(null), {
            registrationMode: "open",
            configuredRegistrationMode: "open",
            usesOverride: false
          });
          assert.deepEqual((await policy()).value, { registrationMode: null });
          const nextConfiguration = { config: { preference: { security: { registrationMode: "approval" } } } };
          assert.deepEqual(await new RegistrationSettingsService(db, nextConfiguration).getSettings(), {
            registrationMode: "approval",
            configuredRegistrationMode: "approval",
            usesOverride: false
          });
          assert.equal(JSON.stringify(configuration), immutableConfiguration);
          assert.equal(
            (await applications.find()).every(application => application.status === "pending"),
            true
          );
        }
      );

      await t.test(
        "audit records the administrator, exact old/new modes and configuration/database source",
        async () => {
          const history = await records();
          assert.equal(history.length, 4);
          assert.equal(
            history.every(row => row.userId === admin.id && row.ip === request.ip),
            true
          );
          assert.deepEqual(history[0].details, {
            old: {
              registrationMode: "open",
              configuredRegistrationMode: "open",
              usesOverride: false,
              source: "configuration"
            },
            new: {
              registrationMode: "approval",
              configuredRegistrationMode: "open",
              usesOverride: true,
              source: "database"
            }
          });
          assert.equal(history[3].details.new.source, "configuration");
          for (let i = 1; i < history.length; i++) assert.deepEqual(history[i].details.old, history[i - 1].details.new);
        }
      );

      await t.test("audit failure rolls back the mode update and its source marker", async () => {
        const before = await policy(),
          auditCount = (await records()).length;
        const broken = new RegistrationSettingsService(
          {
            transaction: (isolation, callback) =>
              db.transaction(isolation, async manager => {
                const save = manager.save.bind(manager);
                manager.save = (...args) => {
                  if (args[0] === AuditLogEntity) throw Error("synthetic policy audit failure");
                  return save(...args);
                };
                return callback(manager);
              })
          },
          configuration
        );
        await assert.rejects(
          broken.updateRegistrationMode(admin, "closed", request.ip),
          /synthetic policy audit failure/
        );
        assert.deepEqual(await policy(), before);
        assert.equal((await records()).length, auditCount);
      });

      await t.test(
        "two simultaneous saves serialize their audit history and preserve the last committed mode",
        async () => {
          const auditCount = (await records()).length;
          const results = await Promise.all([update("approval"), update("closed")]);
          assert.deepEqual(results.map(result => result.registrationMode).sort(), ["approval", "closed"]);
          const history = (await records()).slice(auditCount);
          assert.equal(history.length, 2);
          assert.deepEqual(history[1].details.old, history[0].details.new);
          assert.equal(await settings.getRegistrationMode(), history[1].details.new.registrationMode);
        }
      );

      for (const finalMode of ["closed", "approval"])
        await t.test(
          `a request that started in open mode honors ${finalMode} saved during password hashing`,
          async () => {
            await update("open");
            const hashing = deferred(),
              releaseHash = deferred(),
              originalHash = auth.hashPassword.bind(auth);
            const before = await counts();
            auth.hashPassword = async password => {
              hashing.resolve();
              await releaseHash.promise;
              return originalHash(password);
            };
            let pending;
            try {
              pending = register();
              await hashing.promise;
              await update(finalMode);
              releaseHash.resolve();
              const { username, result } = await pending;
              assert.equal(await users.countBy({ username }), 0);
              if (finalMode === "closed") {
                assert.deepEqual(result, ["REGISTRATION_CLOSED", null]);
                assert.deepEqual(await counts(), before);
              } else {
                assert.deepEqual(result, [null, null]);
                assert.equal((await applications.findOneBy({ username })).status, "pending");
                assert.deepEqual(
                  await counts(),
                  before.map((n, i) => n + Number(i === 4))
                );
              }
            } finally {
              auth.hashPassword = originalHash;
              releaseHash.resolve();
              if (pending) await pending;
            }
          }
        );

      await t.test(
        "session preferences read the committed database policy without mutating static preferences",
        async () => {
          const preferences = { security: { registrationMode: "open" }, siteName: "Fixture" };
          const endpoint = controller({
            configService: { preferenceConfigToBeSentToUser: preferences },
            registrationSettings: settings,
            authSessionService: { accessSession: async () => [null, null] }
          });
          await update("closed");
          assert.equal((await endpoint.getSessionInfo({}, {})).serverPreference.security.registrationMode, "closed");
          await update(null);
          assert.equal((await endpoint.getSessionInfo({}, {})).serverPreference.security.registrationMode, "open");
          assert.equal(preferences.security.registrationMode, "open");
        }
      );

      await t.test("a demoted administrator cannot rely on a stale session flag", async () => {
        await users.update(admin.id, { isAdmin: false });
        const before = await policy(),
          auditCount = (await records()).length;
        try {
          await assert.rejects(site.getSettings(admin), error => error.getStatus() === 403);
          await assert.rejects(update("closed"), error => error.getStatus() === 403);
          assert.deepEqual(await policy(), before);
          assert.equal((await records()).length, auditCount);
        } finally {
          await users.update(admin.id, { isAdmin: true });
        }
      });

      await t.test("invalid service-level input is rejected before any transaction or policy change", async () => {
        const before = await policy(),
          auditCount = (await records()).length;
        for (const value of [undefined, "invalid", "", false, 0, {}, []])
          await assert.rejects(
            settings.updateRegistrationMode(admin, value, request.ip),
            error => error.getStatus() === 400
          );
        assert.deepEqual(await policy(), before);
        assert.equal((await records()).length, auditCount);
      });
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
