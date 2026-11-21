// Real TypeORM writes on random disposable tables, with separate request and concurrent-writer connections.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
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
const { DataSource, EntitySchema } = require("typeorm");
const { UserService } = require("./user.service.ts");
const { UserEntity } = require("./user.entity.ts");
const { UserInformationEntity } = require("./user-information.entity.ts");
const { RegistrationApplicationEntity } = require("../auth/registration-application.entity.ts");

const configPath = process.env.LLMOJ_NARROW_WRITES_TEST_DB_CONFIG;
const plain = value => JSON.parse(JSON.stringify(value));
const profileInformation = {
  organization: "New organization",
  location: "New location",
  url: "https://new.example.test",
  telegram: "newcontact",
  qq: "67890",
  github: "newcontact"
};
const originalInformation = Object.fromEntries(Object.keys(profileInformation).map(key => [key, ""]));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

test(
  "profile and email preserve concurrent account changes (real MariaDB)",
  {
    skip: !configPath && "needs LLMOJ_NARROW_WRITES_TEST_DB_CONFIG",
    timeout: 60000
  },
  async t => {
    const config = require("js-yaml").load(fs.readFileSync(configPath, "utf8")).services.database;
    const prefix = `qa_profile_${crypto.randomBytes(8).toString("hex")}_`;
    const number = { type: Number };
    const string = { type: String };
    const definitions = [
      [
        UserEntity,
        "user",
        {
          id: { ...number, primary: true },
          username: { ...string, unique: true, length: 24 },
          email: { ...string, unique: true },
          nickname: string,
          bio: string,
          avatarInfo: string,
          isAdmin: { type: Boolean },
          publicEmail: { type: Boolean },
          rating: number,
          submissionCount: number,
          acceptedProblemCount: number,
          registrationTime: { type: Date }
        }
      ],
      [
        UserInformationEntity,
        "information",
        {
          userId: { ...number, primary: true },
          ...Object.fromEntries(Object.keys(profileInformation).map(key => [key, string]))
        }
      ],
      [
        RegistrationApplicationEntity,
        "registration",
        {
          id: { ...number, primary: true },
          reservedUsername: { ...string, nullable: true },
          reservedEmail: { ...string, nullable: true }
        }
      ]
    ];
    const entities = definitions.map(
      ([target, name, columns]) =>
        new EntitySchema({
          name: target.name,
          target,
          tableName: prefix + name,
          columns
        })
    );
    const db = new DataSource({ ...config, entities, synchronize: true, logging: false });
    const writer = new DataSource({ ...config, entities, synchronize: false, logging: false });
    try {
      await db.initialize();
      await writer.initialize();
      const users = db.getRepository(UserEntity);
      const information = db.getRepository(UserInformationEntity);
      const consumed = [];
      const service = Object.assign(Object.create(UserService.prototype), {
        connection: db,
        userRepository: users,
        userInformationRepository: information,
        configService: { config: { preference: { security: { requireEmailVerification: false } } } },
        authEmailVerificationCodeService: {
          consume: async (...args) => {
            consumed.push(args);
            return "used";
          }
        }
      });
      async function reset() {
        await users.clear();
        await information.clear();
        consumed.length = 0;
        service.configService.config.preference.security.requireEmailVerification = false;
        await users.insert(
          [1, 2].map(id => ({
            id,
            username: `member${id}`,
            email: `member${id}@example.test`,
            nickname: "Before",
            bio: "Before",
            avatarInfo: "gravatar:",
            isAdmin: true,
            publicEmail: false,
            rating: 1200,
            submissionCount: 8,
            acceptedProblemCount: 3,
            registrationTime: new Date("2026-01-01T00:00:00Z")
          }))
        );
        await information.insert({ userId: 1, ...originalInformation });
      }
      const profile = (user, username = "renamed", email = "renamed@example.test") =>
        service.updateUserProfile(
          user,
          username,
          email,
          true,
          "github:example",
          "After",
          "New biography",
          profileInformation
        );

      for (const operation of ["profile", "email", "verified email"]) {
        await t.test(
          `${operation} changes only its columns after a concurrent demotion, rating and counter update`,
          async () => {
            await reset();
            const loaded = deferred();
            const resume = deferred();
            service.configService.config.preference.security.requireEmailVerification = operation === "verified email";
            const request = (async () => {
              const identity = await service.findUserById(1);
              loaded.resolve();
              await resume.promise;
              return operation === "profile"
                ? profile(identity)
                : service.updateUserSelfEmail(identity, "renamed@example.test", "fixture-email-code");
            })();
            await loaded.promise;
            try {
              await writer.transaction("READ COMMITTED", manager =>
                manager.update(
                  UserEntity,
                  { id: 1 },
                  {
                    isAdmin: false,
                    rating: 1450,
                    submissionCount: 9,
                    acceptedProblemCount: 4
                  }
                )
              );
            } finally {
              resume.resolve();
            }
            assert.equal(await request, null);
            const updated = await users.findOneByOrFail({ id: 1 });
            assert.deepEqual(
              {
                isAdmin: updated.isAdmin,
                rating: updated.rating,
                submissionCount: updated.submissionCount,
                acceptedProblemCount: updated.acceptedProblemCount
              },
              { isAdmin: false, rating: 1450, submissionCount: 9, acceptedProblemCount: 4 }
            );
            assert.equal(updated.email, "renamed@example.test");
            assert.equal(updated.username, operation === "profile" ? "renamed" : "member1");
            assert.equal(updated.nickname, operation === "profile" ? "After" : "Before");
            assert.equal(updated.bio, operation === "profile" ? "New biography" : "Before");
            assert.equal(updated.publicEmail, operation === "profile");
            assert.equal(updated.registrationTime.toISOString(), "2026-01-01T00:00:00.000Z");
            assert.deepEqual(plain(await information.findOneByOrFail({ userId: 1 })), {
              userId: 1,
              ...(operation === "profile" ? profileInformation : originalInformation)
            });
            assert.equal(consumed.length, operation === "verified email" ? 1 : 0);
            if (consumed.length) assert.equal(consumed[0][3], 1);
          }
        );
      }

      for (const conflict of ["username", "email"]) {
        await t.test(
          `duplicate profile ${conflict} retains the existing error and rolls back information`,
          async () => {
            await reset();
            const before = await users.findOneByOrFail({ id: 1 });
            assert.equal(
              await profile(
                { ...before },
                conflict === "username" ? "member2" : "renamed",
                conflict === "email" ? "member2@example.test" : "renamed@example.test"
              ),
              `DUPLICATE_${conflict.toUpperCase()}`
            );
            assert.deepEqual(await users.findOneByOrFail({ id: 1 }), before);
            assert.deepEqual(plain(await information.findOneByOrFail({ userId: 1 })), {
              userId: 1,
              ...originalInformation
            });
          }
        );
      }

      await t.test("duplicate verified self email consumes its code but does not update the account", async () => {
        await reset();
        service.configService.config.preference.security.requireEmailVerification = true;
        const before = await users.findOneByOrFail({ id: 1 });
        assert.equal(
          await service.updateUserSelfEmail({ ...before }, "member2@example.test", "fixture-email-code"),
          "DUPLICATE_EMAIL"
        );
        assert.deepEqual(await users.findOneByOrFail({ id: 1 }), before);
        assert.equal(consumed.length, 1);
      });
    } finally {
      if (writer.isInitialized) await writer.destroy();
      if (db.isInitialized) {
        for (const [, name] of definitions.slice().reverse())
          await db.query(`DROP TABLE IF EXISTS \`${prefix}${name}\``);
        await db.destroy();
      }
    }
  }
);
