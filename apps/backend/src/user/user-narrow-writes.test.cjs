const test = require("node:test");
const assert = require("node:assert/strict");
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
const { UserService } = require("./user.service.ts");
const { UserEntity } = require("./user.entity.ts");
const { UserInformationEntity } = require("./user-information.entity.ts");
const { EmailVerificationCodeType } = require("../auth/auth-email-verification-code.service.ts");
const securityDelay = require("../common/delay.ts");

const information = {
  organization: "Example group",
  location: "Example city",
  url: "https://example.test",
  telegram: "example",
  qq: "12345",
  github: "example"
};
const identity = () => ({
  id: 11,
  username: "before",
  email: "before@example.test",
  isAdmin: true,
  rating: 1000,
  submissionCount: 12,
  acceptedProblemCount: 7
});

function fixture(requireEmailVerification) {
  const writes = [];
  const service = Object.assign(Object.create(UserService.prototype), {
    configService: { config: { preference: { security: { requireEmailVerification } } } },
    connection: {
      transaction: async (level, callback) => {
        assert.equal(level, "READ COMMITTED");
        return callback({ update: async (...args) => writes.push(args) });
      }
    },
    userRepository: { update: async (...args) => writes.push(args) },
    checkUsernameAvailability: async () => true,
    checkEmailAvailability: async () => true
  });
  return { service, writes };
}

test("profile writes only owned fields and explicitly selects information fields", async () => {
  const { service, writes } = fixture(false);
  const user = identity();
  assert.equal(
    await service.updateUserProfile(user, "after", "after@example.test", true, "gravatar:", "Nick", "Bio", {
      ...information,
      userId: 99,
      isAdmin: true
    }),
    null
  );
  assert.deepEqual(writes, [
    [UserInformationEntity, { userId: 11 }, information],
    [
      UserEntity,
      { id: 11 },
      {
        publicEmail: true,
        avatarInfo: "gravatar:",
        nickname: "Nick",
        bio: "Bio",
        username: "after",
        email: "after@example.test"
      }
    ]
  ]);
});

test("null username and verification-required email are omitted from the profile patch", async () => {
  const { service, writes } = fixture(true);
  const user = identity();
  assert.equal(
    await service.updateUserProfile(user, null, "blocked@example.test", false, "", "Nick", "", information),
    null
  );
  assert.deepEqual(writes[1], [
    UserEntity,
    { id: 11 },
    { publicEmail: false, avatarInfo: "", nickname: "Nick", bio: "" }
  ]);
  assert.equal(user.username, "before");
  assert.equal(user.email, "before@example.test");
});

test("self email consumes the account-scoped code after the security delay and updates only email", async t => {
  const { service, writes } = fixture(true);
  const calls = [];
  t.mock.method(securityDelay, "delay", async ms => calls.push(["delay", ms]));
  service.authEmailVerificationCodeService = {
    consume: async (...args) => {
      calls.push(["consume", ...args]);
      return "used";
    }
  };
  assert.equal(await service.updateUserSelfEmail(identity(), "new@example.test", "fixture-code"), null);
  assert.deepEqual(calls, [
    ["delay", securityDelay.DELAY_FOR_SECURITY],
    ["consume", EmailVerificationCodeType.ChangeEmail, "new@example.test", "fixture-code", 11]
  ]);
  assert.deepEqual(writes, [[{ id: 11 }, { email: "new@example.test" }]]);
});

test("invalid email verification does not persist anything", async t => {
  const { service, writes } = fixture(true);
  t.mock.method(securityDelay, "delay", async () => {});
  service.authEmailVerificationCodeService = { consume: async () => "invalid" };
  assert.equal(
    await service.updateUserSelfEmail(identity(), "new@example.test", "bad-code"),
    "INVALID_EMAIL_VERIFICATION_CODE"
  );
  assert.deepEqual(writes, []);
});

test("self email without required verification still updates only email", async () => {
  const { service, writes } = fixture(false);
  assert.equal(await service.updateUserSelfEmail(identity(), "new@example.test", null), null);
  assert.deepEqual(writes, [[{ id: 11 }, { email: "new@example.test" }]]);
});

test("unrelated persistence errors are propagated", async () => {
  const { service } = fixture(false);
  const failure = new Error("fixture persistence failure");
  service.connection.transaction = async () => {
    throw failure;
  };
  service.userRepository.update = async () => {
    throw failure;
  };
  await assert.rejects(
    service.updateUserProfile(identity(), "after", "new@example.test", false, "", "", "", information),
    failure
  );
  await assert.rejects(service.updateUserSelfEmail(identity(), "new@example.test", null), failure);
});
