const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  jwt = require("jsonwebtoken");
const {
  UserController,
  AuthService,
  RegistrationReviewService,
  controller,
  sessionService
} = require("./registration-test-helpers.cjs");
const { ConfigService } = require("../config/config.service.ts");
const { validateSync } = require("class-validator"),
  { plainToInstance } = require("class-transformer");
const { ListRegistrationReviewsRequestDto, ReviewRegistrationRequestDto } = require("./dto/registration-review.dto.ts");
const { UpdateUserProfileRequestDto } = require("../user/dto/update-user-profile-request.dto.ts");
const { EmailVerificationCodeType } = require("./auth-email-verification-code.service.ts");
const req = { ip: "127.0.0.1", headers: { "user-agent": "registration regression" } };
const user = { id: 2, username: "applicant", isAdmin: false };
for (const status of ["pending", "rejected"]) {
  test(`${status} blocks session creation, token access and subscription credentials`, async () => {
    const reviews = new RegistrationReviewService({ manager: { findOneBy: async () => ({ status }) } });
    const { sessions, calls } = sessionService(reviews, { findUserById: async () => user });
    await assert.rejects(
      sessions.newSession(user, req.ip, "test"),
      e => e.getStatus() === 403 && e.getResponse().error === `REGISTRATION_${status.toUpperCase()}`
    );
    assert.equal(calls.length, 0);
    const token = jwt.sign("2 1", "synthetic-registration-test-secret");
    assert.deepEqual(await sessions.accessSession(token), [null, null]);
    assert.equal(await sessions.accessSessionById(2, 1), null);
  });
  test(`${status} login and verified password reset cannot issue a token or change the password`, async () => {
    let changes = 0,
      sessions = 0;
    const auth = controller({
      userService: { findUserByUsername: async () => user, findUserByEmail: async () => user },
      authService: {
        findUserAuthByUserId: async () => ({ password: "fixture" }),
        checkUserMigrated: () => true,
        checkPassword: async () => true,
        changePassword: async () => {
          changes++;
        }
      },
      registrationReviews: { status: async () => status },
      authEmailVerificationCodeService: { verify: async () => true },
      authSessionService: {
        newSession: async () => {
          sessions++;
          return "unexpected";
        }
      },
      auditService: { log: async () => {} }
    });
    assert.equal(
      (await auth.login(req, null, { username: "applicant", password: "synthetic" })).error,
      `REGISTRATION_${status.toUpperCase()}`
    );
    assert.equal(
      (
        await auth.resetPassword(req, null, {
          email: "applicant@example.test",
          emailVerificationCode: "fixture",
          newPassword: "synthetic"
        })
      ).error,
      `REGISTRATION_${status.toUpperCase()}`
    );
    assert.equal(changes, 0);
    assert.equal(sessions, 0);
  });
}
test("approval registration has no user and never issues a token", async () => {
  const auth = controller({
    configService: { config: { preference: { security: { registrationMode: "approval" } } } },
    authService: { register: async () => [null, null] },
    auditService: { log: async () => {} },
    registrationReviews: { status: async () => "approved" },
    authSessionService: { newSession: async () => assert.fail("pending session issued") }
  });
  assert.deepEqual(await auth.register(req, null, {}), { registrationStatus: "pending" });
});
test("closed registration is rejected before email codes or database writes", async () => {
  const auth = new AuthService(
    { transaction: () => assert.fail("database written") },
    null,
    null,
    { verify: () => assert.fail("email code checked") },
    { config: { preference: { security: { registrationMode: "closed", requireEmailVerification: true } } } }
  );
  assert.deepEqual(await auth.register("newuser", "new@example.test", "code", "secret"), ["REGISTRATION_CLOSED", null]);
});
test("closed mode blocks registration mail but retains change-email/reset-password mail", async () => {
  let generated = 0,
    sent = 0;
  const auth = controller({
    configService: {
      config: { preference: { security: { registrationMode: "closed", requireEmailVerification: true } } }
    },
    userService: { checkEmailAvailability: async () => true, findUserByEmail: async () => user },
    authEmailVerificationCodeService: {
      generate: async () => {
        generated++;
        return "fixture-code";
      }
    },
    mailService: {
      sendMail: async () => {
        sent++;
        return null;
      }
    },
    auditService: { log: async () => {} }
  });
  assert.deepEqual(
    await auth.sendEmailVerificationCode(null, { type: EmailVerificationCodeType.Register, email: "new@example.test" }),
    { error: "REGISTRATION_CLOSED" }
  );
  assert.equal(generated, 0);
  assert.deepEqual(
    await auth.sendEmailVerificationCode(user, {
      type: EmailVerificationCodeType.ChangeEmail,
      email: "new@example.test"
    }),
    {}
  );
  assert.deepEqual(
    await auth.sendEmailVerificationCode(null, {
      type: EmailVerificationCodeType.ResetPassword,
      email: "old@example.test"
    }),
    {}
  );
  assert.equal(generated, 2);
  assert.equal(sent, 2);
});
test("legacy accounts without review rows and real administrators remain active", async () => {
  const reviews = new RegistrationReviewService({ manager: { findOneBy: async () => null } });
  assert.equal(await reviews.status(user), "approved");
  const { sessions } = sessionService(reviews, { findUserById: async () => user });
  const token = await sessions.newSession(user, req.ip, "test");
  assert.equal((await sessions.accessSession(token))[1].id, 2);
  const blockedRows = new RegistrationReviewService({ manager: { findOneBy: () => assert.fail("admin exempt") } });
  assert.equal(await blockedRows.status({ id: 1, isAdmin: true }), "approved");
});
test("review authorization rereads the actor and passes the transaction manager to current permissions", async () => {
  const current = { id: 2, isAdmin: false },
    calls = [];
  const transaction = {
    findOne: async (_entity, options) => {
      assert.equal(options.where.id, current.id);
      assert.equal(options.lock.mode, "pessimistic_read");
      return current;
    },
    getRepository: () => assert.fail("unauthorized application query")
  };
  const reviews = new RegistrationReviewService(
    { transaction: async (_isolation, callback) => callback(transaction) },
    {
      userHasPrivilege: async (actor, permission, manager) => {
        assert.equal(actor, current);
        assert.ok(["ViewSite", "ManageRegistrationReviews"].includes(permission));
        assert.equal(manager, transaction);
        calls.push(permission);
        return permission === "ViewSite";
      }
    }
  );
  for (const actor of [null, { ...current, privileges: ["ManageUser"] }, { ...current, isAdmin: true }]) {
    assert.deepEqual(await reviews.list(actor, {}), { error: "PERMISSION_DENIED" });
    assert.deepEqual(await reviews.review(actor, { applicationId: 3, decision: "approved" }, req.ip), {
      error: "PERMISSION_DENIED"
    });
  }
  assert.deepEqual(calls, Array(4).fill(["ViewSite", "ManageRegistrationReviews"]).flat());
});
test("ManageUser cannot replace an administrator password or recovery email", async () => {
  const users = Object.assign(Object.create(UserController.prototype), {
    userService: { findUserById: async () => ({ id: 1, isAdmin: true }) },
    userPrivilegeService: { userHasPrivilege: async () => true },
    authService: { changePassword: () => assert.fail("admin password changed") }
  });
  const manager = { id: 2, isAdmin: false };
  assert.deepEqual(await users.updateUserPassword(manager, { userId: 1, password: "synthetic" }), {
    error: "PERMISSION_DENIED"
  });
  assert.deepEqual(await users.updateUserProfile(manager, { userId: 1, email: "attacker@example.test" }), {
    error: "PERMISSION_DENIED"
  });
});
test("DTOs reject isAdmin injection, invalid review decisions, oversized reasons and invalid pagination", () => {
  const profile = plainToInstance(UpdateUserProfileRequestDto, { isAdmin: true });
  assert.ok(
    validateSync(profile, { whitelist: true, forbidNonWhitelisted: true }).some(error => error.property === "isAdmin")
  );
  for (const input of [
    { applicationId: 1, decision: "pending" },
    { applicationId: 0, decision: "approved" },
    { applicationId: 2, decision: "approved", reason: "x".repeat(501) }
  ])
    assert.ok(validateSync(plainToInstance(ReviewRegistrationRequestDto, input)).length);
  for (const input of [{ takeCount: 101 }, { skipCount: -1 }, { status: "arbitrary" }])
    assert.ok(validateSync(plainToInstance(ListRegistrationReviewsRequestDto, input)).length);
});
test("config mode is optional/open by default and rejects unsupported values", () => {
  const yaml = require("js-yaml"),
    example = path.resolve(__dirname, "../../../../config/backend.yaml.example");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-registration-config-"));
  const filename = path.join(directory, "backend.yaml"),
    previous = process.env.LIBREOJ_CONFIG_FILE;
  try {
    process.env.LIBREOJ_CONFIG_FILE = filename;
    for (const mode of [undefined, "open", "approval", "closed"]) {
      const config = yaml.load(fs.readFileSync(example, "utf8"));
      if (mode === undefined) delete config.preference.security.registrationMode;
      else config.preference.security.registrationMode = mode;
      fs.writeFileSync(filename, yaml.dump(config));
      assert.equal(new ConfigService().preferenceConfigToBeSentToUser.security.registrationMode, mode || "open");
    }
    const config = yaml.load(fs.readFileSync(example, "utf8"));
    config.preference.security.registrationMode = "invite";
    fs.writeFileSync(filename, yaml.dump(config));
    assert.throws(() => new ConfigService(), /Config validation error/);
  } finally {
    if (previous === undefined) delete process.env.LIBREOJ_CONFIG_FILE;
    else process.env.LIBREOJ_CONFIG_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup refuses unmigrated legacy applications without deleting any users", async () => {
  for (const count of [0, 1]) {
    const reviews = new RegistrationReviewService({ manager: { countBy: async () => count } });
    if (count) await assert.rejects(reviews.onModuleInit(), /Unmigrated legacy registration reviews/);
    else await reviews.onModuleInit();
  }
});
for (const status of ["pending", "rejected"])
  test(`${status} application login and reset never create a user or session`, async () => {
    const auth = controller({
      userService: { findUserByUsername: async () => null, findUserByEmail: async () => null },
      registrationReviews: {
        checkApplicationPassword: async () => status,
        applicationStatusByEmail: async () => status
      },
      authService: { changePassword: () => assert.fail("changed unapproved password") },
      authSessionService: { newSession: () => assert.fail("created application session") }
    });
    assert.equal(
      (await auth.login(req, null, { username: "application", password: "synthetic" })).error,
      `REGISTRATION_${status.toUpperCase()}`
    );
    assert.equal(
      (await auth.resetPassword(req, null, { email: "application@example.test", newPassword: "synthetic" })).error,
      `REGISTRATION_${status.toUpperCase()}`
    );
    assert.equal(
      (
        await auth.sendEmailVerificationCode(null, {
          type: EmailVerificationCodeType.ResetPassword,
          email: "application@example.test"
        })
      ).error,
      `REGISTRATION_${status.toUpperCase()}`
    );
  });
