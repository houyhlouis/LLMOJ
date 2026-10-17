/* Session lifetimes and the "session ended" signal: administrators' sessions end sooner, and a request whose session
   can never be used again is told so, while a storage failure is not mistaken for it. Storage is stubbed. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { AuthSessionService, RegistrationReviewService, controller } = require("./registration-test-helpers.cjs");
const { AuthMiddleware } = require("./auth.middleware.ts");

const DAY = 24 * 60 * 60 * 1000;
const secret = "synthetic-session-test-secret";
const approved = new RegistrationReviewService({ manager: { findOneBy: async () => null } });

function service({ security = {}, users = {}, access = 1, reviews = approved } = {}) {
  const calls = [];
  const redis = {
    defineCommand() {},
    async callSessionManager(...args) {
      calls.push(args);
      return args[0] === "access" ? access : [];
    }
  };
  const sessions = new AuthSessionService(
    { config: { security: { sessionSecret: secret, ...security } } },
    { findUserById: async id => users[id] ?? null },
    { getClient: () => redis },
    reviews
  );
  return { sessions, calls };
}

const admin = { id: 1, isAdmin: true };
const member = { id: 2, isAdmin: false };
const limits = calls => calls.filter(call => call[0] === "access").map(call => call.slice(4));

test("administrators' sessions get the stricter of the general and the administrator limits", async () => {
  const check = async (security, user) => {
    const { sessions, calls } = service({ security, users: { [user.id]: user } });
    await sessions.accessSessionById(user.id, 9);
    return limits(calls)[0].map(value => value / DAY);
  };
  assert.deepEqual(await check({}, member), [30, 90]);
  assert.deepEqual(await check({}, admin), [3, 30]);
  assert.deepEqual(await check({ sessionIdleTimeoutDays: 1, sessionMaxAgeDays: 10 }, admin), [1, 10]);
  assert.deepEqual(await check({ adminSessionIdleTimeoutDays: 0, adminSessionMaxAgeDays: 0 }, admin), [30, 90]);
  assert.deepEqual(
    await check({ sessionIdleTimeoutDays: 0, sessionMaxAgeDays: 0, adminSessionIdleTimeoutDays: 2 }, admin),
    [2, 30]
  );
  assert.deepEqual(await check({ adminSessionIdleTimeoutDays: 7 }, member), [30, 90]);
  // The list of a user's sessions applies the same limits.
  const { sessions, calls } = service({ users: { 1: admin } });
  await sessions.listUserSessions(1);
  assert.deepEqual(
    calls
      .find(call => call[0] === "list")
      .slice(3)
      .map(value => value / DAY),
    [3, 30]
  );
});

test("a session that can never be used again is reported as ended; a storage failure is not", async () => {
  const token = jwt.sign("2 9", secret);
  assert.deepEqual(await service({ users: { 2: member } }).sessions.resolveSession(token), {
    sessionId: 9,
    user: member
  });
  // Expired or revoked (the session manager refuses it), a forged token, or an account that no longer exists.
  assert.deepEqual(await service({ users: { 2: member }, access: 0 }).sessions.resolveSession(token), { ended: true });
  assert.deepEqual(await service({ users: { 2: member } }).sessions.resolveSession(jwt.sign("2 9", "other")), {
    ended: true
  });
  const gone = service();
  assert.deepEqual(await gone.sessions.resolveSession(token), { ended: true });
  assert.deepEqual(gone.calls, [["revoke", 2, 9]]);
  // A registration that is pending or rejected may not use its sessions.
  const pending = new RegistrationReviewService({ manager: { findOneBy: async () => ({ status: "pending" }) } });
  assert.deepEqual(await service({ users: { 2: member }, reviews: pending }).sessions.resolveSession(token), {
    ended: true
  });
  // A database or Redis failure leaves the request a visitor's without ending the session.
  const failing = service({ users: { 2: member } });
  failing.sessions.redis.callSessionManager = async () => {
    throw new Error("connection lost");
  };
  assert.deepEqual(await failing.sessions.resolveSession(token), {});
  const unreadable = new RegistrationReviewService({
    manager: {
      findOneBy: async () => {
        throw new Error("connection lost");
      }
    }
  });
  assert.deepEqual(await service({ users: { 2: member }, reviews: unreadable }).sessions.resolveSession(token), {});
});

test("the middleware tells the client when its session ended, and continues as a visitor", async () => {
  const run = async (resolved, authorization = "Bearer key") => {
    const headers = {};
    const req = { headers: { authorization } };
    const middleware = new AuthMiddleware({ resolveSession: async () => resolved }, {});
    await new Promise(resolve => middleware.use(req, { setHeader: (name, value) => (headers[name] = value) }, resolve));
    return { headers, user: req.session?.user };
  };
  assert.deepEqual(await run({ ended: true }), { headers: { "X-Session-Ended": "1" }, user: undefined });
  assert.deepEqual(await run({}), { headers: {}, user: undefined });
  assert.deepEqual(await run({ sessionId: 9, user: member }), { headers: {}, user: member });
  // Without a session key, sessions aren't consulted at all.
  assert.deepEqual(await run(null, null), { headers: {}, user: undefined });
});

test("page loads read the session from the Authorization header; JSONP still passes it in the URL", async () => {
  const looked = [];
  const auth = controller({
    authSessionService: {
      accessSession: async token => {
        looked.push(token);
        return [9, member];
      }
    },
    configService: { preferenceConfigToBeSentToUser: { security: {} } },
    registrationSettings: { getRegistrationMode: async () => "open" },
    userService: { getUserMeta: async user => ({ id: user.id }), getUserPreference: async () => ({}) },
    groupService: { getUserJoinedGroupsCount: async () => 0 },
    userPrivilegeService: { getUserPrivileges: async () => [] }
  });
  assert.deepEqual((await auth.getSessionInfo({}, {}, member)).userMeta, { id: 2 });
  assert.deepEqual(looked, []);
  assert.equal((await auth.getSessionInfo({}, {}, undefined)).userMeta, undefined);
  assert.deepEqual((await auth.getSessionInfo({ token: "jsonp-key" }, {}, undefined)).userMeta, { id: 2 });
  assert.deepEqual(looked, ["jsonp-key"]);
});
