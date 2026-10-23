/* Email verification codes (review N09) on a temporary redis-server; skipped when redis-server is unavailable. */
// A code is for one purpose, one address and (to change it or reset a password) one account; it works once, also
// when many requests from several backend processes bring it at the same time; wrong answers are budgeted per code
// and per address; a newer code replaces the earlier one.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const Redis = require("ioredis");
const { AuthService, UserController, UserService, controller } = require("./registration-test-helpers.cjs");
const { AuthEmailVerificationCodeService, EmailVerificationCodeType: Type } = require("./auth-email-verification-code.service.ts");

const available = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;
const skip = !available && "redis-server is not installed";
let port, server, directory;
const clients = [];

before(async () => {
  if (!available) return;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-email-code-test-"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  server = spawn(
    "redis-server",
    ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", directory],
    { stdio: "ignore" }
  );
  for (let attempt = 0; ; attempt++) {
    const listening = await new Promise(resolve => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (listening) break;
    if (attempt > 50) throw new Error("redis-server did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});
after(() => {
  for (const client of clients) client.disconnect();
  server?.kill();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

// Each "process" has its own connection and service, as separate backend processes would.
function newProcess() {
  const client = new Redis({ port, host: "127.0.0.1" });
  clients.push(client);
  return { redis: client, codes: new AuthEmailVerificationCodeService({ getClient: () => client }) };
}
let main;
beforeEach(async () => {
  if (!available) return;
  main ||= newProcess();
  await main.redis.flushdb();
});
// Lets the next code for an address be sent at once.
const unthrottle = async address => await main.redis.del(`email-verification-code-rate-limit:${address}`);

test("a code works once, and only for its purpose, its address and its account", { skip }, async () => {
  const { codes } = main;
  const code = await codes.generate(Type.ResetPassword, "Alice@Example.test", 7);
  assert.match(code, /^\d{6}$/);
  assert.equal(await codes.consume(Type.Register, "alice@example.test", code), "wrong", "another purpose");
  assert.equal(await codes.consume(Type.ChangeEmail, "alice@example.test", code, 7), "wrong", "another purpose");
  assert.equal(await codes.consume(Type.ResetPassword, "bob@example.test", code, 7), "wrong", "another address");
  assert.equal(await codes.consume(Type.ResetPassword, "alice@example.test", code, 8), "wrong", "another account");
  assert.equal(await codes.consume(Type.ResetPassword, "alice@example.test", code), "wrong", "no account");
  assert.equal(await codes.consume(Type.ResetPassword, " ALICE@example.test ", code, 7), "used", "address in any case");
  assert.equal(await codes.consume(Type.ResetPassword, "alice@example.test", code, 7), "wrong", "used up");
  for (const malformed of [undefined, null, 123456, "", ["x"]])
    assert.equal(await codes.consume(Type.ResetPassword, "alice@example.test", malformed, 7), "wrong");

  // A registration code is for anyone with the address, but only to register.
  await unthrottle("alice@example.test");
  const registration = await codes.generate(Type.Register, "alice@example.test");
  assert.equal(await codes.consume(Type.ResetPassword, "alice@example.test", registration, 7), "wrong");
  assert.equal(await codes.consume(Type.Register, "alice@example.test", registration), "used");
});

test("a newer code replaces the earlier one; one code a minute per address; codes expire", { skip }, async () => {
  const { codes, redis } = main;
  const first = await codes.generate(Type.Register, "carol@example.test");
  assert.equal(await codes.generate(Type.ChangeEmail, "CAROL@example.test", 3), null, "one code a minute");
  const throttle = await redis.ttl("email-verification-code-rate-limit:carol@example.test");
  assert(throttle > 50 && throttle <= 60, String(throttle));
  await unthrottle("carol@example.test");
  const second = await codes.generate(Type.Register, "carol@example.test");
  const ttl = await redis.ttl("email-verification-challenge:Register:carol@example.test");
  assert(ttl > 890 && ttl <= 900, String(ttl));
  if (second !== first) assert.equal(await codes.consume(Type.Register, "carol@example.test", first), "wrong", "replaced");
  assert.equal(await codes.consume(Type.Register, "carol@example.test", second), "used");
  // Codes of other purposes are separate: a registration code does not replace a password reset code.
  await unthrottle("carol@example.test");
  const reset = await codes.generate(Type.ResetPassword, "carol@example.test", 3);
  await unthrottle("carol@example.test");
  await codes.generate(Type.Register, "carol@example.test");
  assert.equal(await codes.consume(Type.ResetPassword, "carol@example.test", reset, 3), "used");
  const keys = await redis.keys("*");
  assert(!keys.some(key => key.startsWith("email-verification-code:")), "the old one-key-per-code layout is gone");
});

test("of many simultaneous answers with one code, from several processes, exactly one is accepted", { skip }, async () => {
  const processes = Array.from({ length: 6 }, newProcess);
  for (let round = 0; round < 20; round++) {
    await unthrottle("dave@example.test");
    const code = await main.codes.generate(Type.ResetPassword, "dave@example.test", 11);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        processes[i % processes.length].codes.consume(Type.ResetPassword, "dave@example.test", code, 11)
      )
    );
    // The others count as wrong answers (a used code is no code), so some reach the address's budget.
    assert.equal(results.filter(result => result === "used").length, 1, `round ${round}`);
    assert.equal(results.filter(result => result === "wrong").length, 20, `round ${round}`);
    assert.equal(results.filter(result => result === "limited").length, 9, `round ${round}`);
    await main.redis.del("email-verification-failures:ResetPassword:dave@example.test");
  }
});

test("five wrong answers end a code; twenty an hour stop guessing for an address and purpose", { skip }, async () => {
  const { codes, redis } = main;
  const code = await codes.generate(Type.ChangeEmail, "erin@example.test", 5);
  const wrong = code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 4; i++) assert.equal(await codes.consume(Type.ChangeEmail, "erin@example.test", wrong, 5), "wrong");
  assert.equal(await codes.consume(Type.ChangeEmail, "erin@example.test", code, 6), "wrong", "the fifth: another account");
  assert.equal(await codes.consume(Type.ChangeEmail, "erin@example.test", code, 5), "wrong", "the code has ended");

  // New codes do not reset the address's budget: guesses spread over many codes are counted together.
  let failures = 6;
  while (failures < 20) {
    await unthrottle("erin@example.test");
    const next = await codes.generate(Type.ChangeEmail, "erin@example.test", 5);
    const guess = next === "123456" ? "654321" : "123456";
    assert.equal(await codes.consume(Type.ChangeEmail, "erin@example.test", guess, 5), "wrong");
    failures++;
  }
  await unthrottle("erin@example.test");
  const last = await codes.generate(Type.ChangeEmail, "erin@example.test", 5);
  assert.equal(await codes.consume(Type.ChangeEmail, "erin@example.test", last, 5), "limited", "even the right code");
  const window = await redis.ttl("email-verification-failures:ChangeEmail:erin@example.test");
  assert(window > 3500 && window <= 3600, String(window));
  // Other purposes for the address have their own budget.
  await unthrottle("erin@example.test");
  const register = await codes.generate(Type.Register, "erin@example.test");
  assert.equal(await codes.consume(Type.Register, "erin@example.test", register), "used");
  // After the window, the right code works again.
  await redis.del("email-verification-failures:ChangeEmail:erin@example.test");
  assert.equal(await codes.consume(Type.ChangeEmail, "erin@example.test", last, 5), "used");
});

test("the address budget holds under simultaneous guesses from several processes", { skip }, async () => {
  const processes = Array.from({ length: 4 }, newProcess);
  const code = await main.codes.generate(Type.ResetPassword, "frank@example.test", 2);
  const guesses = Array.from({ length: 60 }, (_, i) => String(i).padStart(6, "9")).filter(guess => guess !== code);
  const results = await Promise.all(
    guesses.map((guess, i) => processes[i % processes.length].codes.consume(Type.ResetPassword, "frank@example.test", guess, 2))
  );
  assert.equal(results.filter(result => result === "wrong").length, 20);
  assert.equal(results.filter(result => result === "limited").length, guesses.length - 20);
  assert.equal(await main.redis.get("email-verification-failures:ResetPassword:frank@example.test"), "20");
});

// The API: password reset, registration and email change with the real code service.
const resetUser = { id: 21, username: "grace", email: "grace@example.test", isAdmin: false };
function authApi(overrides = {}) {
  const calls = { audit: [], passwordChanges: 0, endedChallenges: 0, revokedSessions: 0, mails: [] };
  const auth = controller({
    configService: { config: { preference: { security: { requireEmailVerification: true } } } },
    registrationSettings: { getRegistrationMode: async () => "open" },
    registrationReviews: { status: async () => "approved", applicationStatusByEmail: async () => null },
    userService: {
      findUserByEmail: async email => (email.toLowerCase() === resetUser.email ? resetUser : null),
      checkEmailAvailability: async () => true
    },
    authService: {
      findUserAuthByUserId: async () => ({ password: "old hash" }),
      checkUserMigrated: () => true,
      changePassword: async () => {
        calls.passwordChanges++;
      }
    },
    authEmailVerificationCodeService: main.codes,
    mailService: {
      sendMail: async (template, locale, data, to) => {
        calls.mails.push({ template, to, code: data.code });
        return null;
      }
    },
    twoFactorService: {
      endPendingChallenges: async userId => {
        assert.equal(userId, resetUser.id);
        calls.endedChallenges++;
      },
      isEnabled: async () => true,
      createChallenge: async () => ({ token: "second-factor", methods: ["totp"] })
    },
    authSessionService: {
      revokeAllSessionsExcept: async () => {
        calls.revokedSessions++;
      },
      issueSession: async () => assert.fail("a reset with a second factor must not sign in by itself")
    },
    auditService: {
      log: async (...args) => {
        calls.audit.push(args.find(arg => typeof arg === "string" && arg.startsWith("auth.")));
      }
    },
    ...overrides
  });
  return { auth, calls };
}
const req = { ip: "127.0.0.1", headers: { "user-agent": "email code test", origin: "https://oj.example.test" } };

test("two simultaneous password resets with one code change the password once, and the second factor stays", { skip }, async () => {
  const { auth, calls } = authApi();
  assert.deepEqual(
    await auth.sendEmailVerificationCode(null, { type: Type.ResetPassword, email: "Grace@example.test", locale: "en_US" }),
    {}
  );
  const [{ code }] = calls.mails;
  const reset = password =>
    auth.resetPassword(req, null, { email: "grace@example.test", emailVerificationCode: code, newPassword: password });
  const results = await Promise.all([reset("first new password"), reset("second new password")]);
  assert.equal(results.filter(result => result.twoFactorChallenge?.token === "second-factor").length, 1);
  assert.equal(results.filter(result => result.error === "INVALID_EMAIL_VERIFICATION_CODE").length, 1);
  assert(results.every(result => !result.token), "no session without the second factor");
  assert.equal(calls.passwordChanges, 1);
  assert.equal(calls.endedChallenges, 1, "challenges started with the old password end");
  assert.equal(calls.revokedSessions, 1);
  assert.deepEqual(calls.audit.filter(action => action !== "auth.request_reset_password").sort(), [
    "auth.reset_password",
    "auth.reset_password_failed.wrong_code"
  ]);
});

test("a registration code cannot reset a password, and a reset code works only for its account", { skip }, async () => {
  const { auth, calls } = authApi();
  await auth.sendEmailVerificationCode(null, { type: Type.Register, email: "henry@example.test", locale: "en_US" });
  const registration = calls.mails.pop().code;
  // The address now belongs to an account (say it registered with another code meanwhile).
  const owner = { id: 22, username: "henry", email: "henry@example.test" };
  const { auth: later, calls: laterCalls } = authApi({
    userService: { findUserByEmail: async () => owner, checkEmailAvailability: async () => false },
    twoFactorService: { endPendingChallenges: async () => {}, isEnabled: async () => false }
  });
  assert.deepEqual(
    await later.resetPassword(req, null, {
      email: "henry@example.test",
      emailVerificationCode: registration,
      newPassword: "new password"
    }),
    { error: "INVALID_EMAIL_VERIFICATION_CODE" }
  );
  assert.equal(laterCalls.passwordChanges, 0);

  // A reset code sent while the address was Grace's does not reset the account that has the address later.
  await unthrottle("grace@example.test");
  await auth.sendEmailVerificationCode(null, { type: Type.ResetPassword, email: "grace@example.test", locale: "en_US" });
  const graceCode = calls.mails.pop().code;
  const { auth: moved, calls: movedCalls } = authApi({
    userService: { findUserByEmail: async () => owner, checkEmailAvailability: async () => false },
    twoFactorService: { endPendingChallenges: async () => {}, isEnabled: async () => false }
  });
  assert.deepEqual(
    await moved.resetPassword(req, null, {
      email: "grace@example.test",
      emailVerificationCode: graceCode,
      newPassword: "new password"
    }),
    { error: "INVALID_EMAIL_VERIFICATION_CODE" }
  );
  assert.equal(movedCalls.passwordChanges, 0);
});

test("registration checks the username and address before it uses the code", { skip }, async () => {
  const code = await main.codes.generate(Type.Register, "ivy@example.test");
  let available = false;
  const auth = new AuthService(
    {
      transaction: async (_isolation, callback) =>
        callback({ save: async () => {}, findOne: async () => null, query: async () => [] })
    },
    null,
    {
      checkUsernameAvailability: async () => available,
      checkEmailAvailability: async () => true
    },
    main.codes,
    { config: { preference: { security: { requireEmailVerification: true } } } },
    { getRegistrationMode: async () => "approval", lockRegistrationMode: async () => "approval" }
  );
  assert.deepEqual(await auth.register("ivy", "ivy@example.test", code, "password"), ["DUPLICATE_USERNAME", null]);
  available = true;
  assert.deepEqual(await auth.register("ivy2", "ivy@example.test", "000000" === code ? "000001" : "000000", "pw"), [
    "INVALID_EMAIL_VERIFICATION_CODE",
    null
  ]);
  assert.deepEqual(await auth.register("ivy2", "ivy@example.test", code, "password"), [null, null], "an application");
  assert.deepEqual(await auth.register("ivy3", "ivy@example.test", code, "password"), [
    "INVALID_EMAIL_VERIFICATION_CODE",
    null
  ]);
});

test("an email change code works for the account that asked for it, and failures are audited as failures", { skip }, async () => {
  const saved = [];
  const users = Object.assign(Object.create(UserService.prototype), {
    configService: { config: { preference: { security: { requireEmailVerification: true } } } },
    authEmailVerificationCodeService: main.codes,
    userRepository: { save: async user => saved.push({ id: user.id, email: user.email }) }
  });
  const audit = [];
  const api = Object.assign(Object.create(UserController.prototype), {
    userService: users,
    userPrivilegeService: { userHasPrivilege: async () => true },
    authSessionService: { isRecentlyAuthenticated: async () => true },
    auditService: { log: async action => audit.push(action) }
  });
  const jack = { id: 31, email: "jack@example.test" };
  const kate = { id: 32, email: "kate@example.test" };
  const code = await main.codes.generate(Type.ChangeEmail, "new@example.test", jack.id);
  const change = (user, emailVerificationCode) =>
    api.updateUserSelfEmail({ session: { sessionId: 1 } }, user, { email: "new@example.test", emailVerificationCode });
  assert.deepEqual(await change(kate, code), { error: "INVALID_EMAIL_VERIFICATION_CODE" });
  assert.deepEqual(audit, ["auth.change_email_failed.wrong_code"], "a failed change is not recorded as a change");
  assert.deepEqual(await change(jack, code), {});
  assert.deepEqual(saved, [{ id: 31, email: "new@example.test" }]);
  assert.deepEqual(audit.slice(1), ["auth.change_email"]);
  assert.deepEqual(await change({ id: 31, email: "new@example.test" }, code), { error: "INVALID_EMAIL_VERIFICATION_CODE" });
});
