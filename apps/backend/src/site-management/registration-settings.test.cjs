const { test } = require("node:test");
const assert = require("node:assert/strict");
const { plainToInstance } = require("class-transformer");
const { validateSync } = require("class-validator");
const { RegistrationSettingsService, UserEntity, controller } = require("../auth/registration-test-helpers.cjs");
const { UpdateRegistrationModeRequestDto } = require("./site-management.dto.ts");
const { EmailVerificationCodeType } = require("../auth/auth-email-verification-code.service.ts");

const configuration = mode => ({
  config: { preference: { security: { registrationMode: mode, requireEmailVerification: true } } }
});

test("missing policy and reset marker use YAML, including the backward-compatible open fallback", async () => {
  for (const configured of [undefined, null, "open", "approval", "closed"])
    for (const row of [null, { value: { registrationMode: null } }]) {
      const service = new RegistrationSettingsService(
        { manager: { findOne: async () => row } },
        configuration(configured)
      );
      assert.deepEqual(await service.getSettings(), {
        registrationMode: configured || "open",
        configuredRegistrationMode: configured || "open",
        usesOverride: false
      });
    }
});

test("effective mode is read on each call without mutating configured preferences", async () => {
  let row = { value: { registrationMode: "approval" } };
  const config = configuration("closed");
  const service = new RegistrationSettingsService({ manager: { findOne: async () => row } }, config);
  assert.deepEqual(await service.getSettings(), {
    registrationMode: "approval",
    configuredRegistrationMode: "closed",
    usesOverride: true
  });
  row = { value: { registrationMode: "open" } };
  assert.equal(await service.getRegistrationMode(), "open");
  row = { value: { registrationMode: null } };
  assert.equal(await service.getRegistrationMode(), "closed");
  assert.equal(config.config.preference.security.registrationMode, "closed");
});

test("invalid stored policies fail closed instead of silently enabling registration", async () => {
  for (const value of [null, {}, [], "open", { registrationMode: "typo" }, { registrationMode: true }]) {
    const service = new RegistrationSettingsService(
      { manager: { findOne: async () => ({ value }) } },
      configuration("open")
    );
    await assert.rejects(service.getRegistrationMode(), /Invalid stored registration policy/);
  }
});

test("mode DTO permits only three exact strings or explicit null and rejects missing/unknown input", () => {
  const options = { whitelist: true, forbidNonWhitelisted: true };
  for (const registrationMode of ["open", "approval", "closed", null])
    assert.equal(
      validateSync(plainToInstance(UpdateRegistrationModeRequestDto, { registrationMode }), options).length,
      0
    );
  for (const body of [
    {},
    { registrationMode: "OPEN" },
    { registrationMode: "" },
    { registrationMode: false },
    { registrationMode: [] },
    { registrationMode: {} },
    { registrationMode: "open", isAdmin: true }
  ])
    assert.ok(validateSync(plainToInstance(UpdateRegistrationModeRequestDto, body), options).length);
});

test("session preferences reflect live policy through copies without changing shared configuration", async () => {
  let mode = "open";
  const publicPreference = Object.freeze({
    siteName: "Fixture",
    security: Object.freeze({ registrationMode: "approval", requireEmailVerification: true })
  });
  const auth = controller({
    configService: { preferenceConfigToBeSentToUser: publicPreference },
    registrationSettings: { getRegistrationMode: async () => mode },
    authSessionService: { accessSession: async () => [null, null] }
  });
  const first = await auth.getSessionInfo({}, {});
  mode = "closed";
  const second = await auth.getSessionInfo({}, {});
  assert.equal(first.serverPreference.security.registrationMode, "open");
  assert.equal(second.serverPreference.security.registrationMode, "closed");
  assert.equal(publicPreference.security.registrationMode, "approval");
  assert.notEqual(first.serverPreference, publicPreference);
  assert.notEqual(first.serverPreference.security, publicPreference.security);
});

test("closed database policy blocks registration codes without blocking existing-user recovery or change-email", async () => {
  let mode = "closed",
    sent = 0;
  const user = { id: 2, username: "existing", isAdmin: false };
  const auth = controller({
    configService: configuration("open"),
    registrationSettings: { getRegistrationMode: async () => mode },
    userService: { checkEmailAvailability: async () => true, findUserByEmail: async () => user },
    authEmailVerificationCodeService: { generate: async () => "fixture-code" },
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
  assert.equal(sent, 0);
  assert.deepEqual(
    await auth.sendEmailVerificationCode(null, {
      type: EmailVerificationCodeType.ResetPassword,
      email: "existing@example.test"
    }),
    {}
  );
  assert.deepEqual(
    await auth.sendEmailVerificationCode(user, {
      type: EmailVerificationCodeType.ChangeEmail,
      email: "changed@example.test"
    }),
    {}
  );
  mode = "approval";
  assert.deepEqual(
    await auth.sendEmailVerificationCode(null, { type: EmailVerificationCodeType.Register, email: "new@example.test" }),
    {}
  );
  assert.equal(sent, 3);
});

test("site management rereads administrator status and rejects delegated privileges and spoofed stale flags", async () => {
  const manager = {
    findOne: async (entity, options) => {
      assert.equal(entity, UserEntity);
      assert.equal(options.lock.mode, "pessimistic_read");
      return { id: 3, isAdmin: false };
    },
    save: () => assert.fail("unauthorized write")
  };
  const service = new RegistrationSettingsService(
    { transaction: async (_isolation, run) => run(manager) },
    configuration("open")
  );
  for (const actor of [
    null,
    { id: 3, isAdmin: false, privileges: ["EditHomepage", "ManageRegistrationReviews"] },
    { id: 3, isAdmin: true }
  ]) {
    await assert.rejects(service.getForAdministrator(actor), error => error.getStatus() === 403);
    await assert.rejects(
      service.updateRegistrationMode(actor, "closed", "127.0.0.1"),
      error => error.getStatus() === 403
    );
  }
});
