/* "Confirm it's you" for administrative changes: each one is refused, and changes nothing, unless this session
   entered the password in the last few minutes. Real controllers and session service; storage is stubbed. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { UserController, AccessController, AuthSessionService } = require("./registration-test-helpers.cjs");
const { SiteManagementController } = require("../site-management/site-management.controller.ts");
const { JudgeClientController } = require("../judge/judge-client.controller.ts");
const { JudgeClientService } = require("../judge/judge-client.service.ts");

const admin = { id: 1, username: "admin", isAdmin: true };
const member = { id: 2, username: "member", email: "member@example.test", isAdmin: false };
const req = { ip: "127.0.0.1", session: { sessionId: 5 } };

/** The real session service; `recent` holds the "user:session" pairs that entered the password recently. */
function sessions(recent) {
  const redis = {
    defineCommand() {},
    async exists(key) {
      const [, userId, sessionId] = key.split(":");
      return recent.has(`${userId}:${sessionId}`) ? 1 : 0;
    }
  };
  return new AuthSessionService({ config: { security: {} } }, {}, { getClient: () => redis }, {});
}

const reauthenticationRequired = error =>
  error.getStatus() === 403 && error.getResponse().error === "REAUTHENTICATION_REQUIRED";

/** Each case: perform the change as `user` (with `recent` sessions), and count the changes that reached storage. */
const cases = {
  "user privileges": async (user, recent) => {
    let changes = 0;
    const users = Object.assign(Object.create(UserController.prototype), {
      authSessionService: sessions(recent),
      userPrivilegeService: {
        getUserPrivileges: async () => [],
        setUserPrivileges: async () => {
          changes++;
          return null;
        }
      },
      auditService: { log: async () => {} }
    });
    const result = await users.setUserPrivileges(req, user, { userId: 2, privileges: [] });
    return { refused: result.error ?? undefined, changes };
  },
  "detailed permissions": async (user, recent) => {
    let changes = 0;
    const db = {
      getRepository: () => ({ countBy: async () => 1, findOneBy: async () => member, findBy: async () => [] }),
      transaction: async () => {
        changes++;
        return {};
      }
    };
    const privileges = { forgetRequestCapabilities() {}, getUserPrivileges: async () => [] };
    const access = new AccessController(db, privileges, sessions(recent), { log: async () => {} });
    try {
      await access.set(user, { userId: 2, overrides: { ViewSite: false } }, req);
      return { changes };
    } catch (error) {
      return { refused: reauthenticationRequired(error) ? "REAUTHENTICATION_REQUIRED" : error.getStatus(), changes };
    }
  },
  ...Object.fromEntries(
    [
      "updateRegistrationMode",
      "updateAiPolicy",
      "updateJudgePolicy",
      "updateAiEndpointPolicy",
      "updateTestDataRetention"
    ].map(route => [
      `site setting ${route}`,
      async (user, recent) => {
        let changes = 0;
        const change = async () => {
          // The settings services refuse non-administrators themselves.
          if (!user.isAdmin)
            throw Object.assign(new Error("Forbidden"), { getStatus: () => 403, getResponse: () => ({}) });
          changes++;
          return {};
        };
        const site = new SiteManagementController(
          { updateRegistrationMode: change },
          { update: change },
          { update: change },
          { update: change },
          sessions(recent),
          { update: change },
          {}
        );
        try {
          await site[route](user, route === "updateRegistrationMode" ? { registrationMode: "closed" } : {}, req);
          return { changes };
        } catch (error) {
          return {
            refused: reauthenticationRequired(error) ? "REAUTHENTICATION_REQUIRED" : "PERMISSION_DENIED",
            changes
          };
        }
      }
    ])
  ),
  ...Object.fromEntries(
    ["addJudgeClient", "deleteJudgeClient", "resetJudgeClientKey", "getJudgeClientKey"].map(route => [
      `judge machine ${route}`,
      async (user, recent) => {
        let changes = 0;
        const machine = { id: 7, name: "judge", key: "k".repeat(40), allowedHosts: [] };
        const count = async () => {
          changes++;
          return machine;
        };
        const judges = Object.assign(Object.create(JudgeClientController.prototype), {
          authSessionService: sessions(recent),
          auditService: { log: async () => {} },
          judgeClientService: {
            findJudgeClientById: async () => machine,
            addJudgeClient: count,
            deleteJudgeClient: count,
            resetJudgeClientKey: count,
            getJudgeClientInfo: async () => ({})
          }
        });
        const result = await judges[route](req, user, { id: 7, name: "judge", allowedHosts: [] });
        // Showing a key changes nothing, but must not reveal it either.
        if (route === "getJudgeClientKey" && result.key) changes++;
        return { refused: result.error, changes };
      }
    ])
  ),
  "a user's email address in the profile editor": async (user, recent) => {
    let changes = 0;
    const users = Object.assign(Object.create(UserController.prototype), {
      authSessionService: sessions(recent),
      configService: { config: { preference: { security: { requireEmailVerification: false } } } },
      userService: {
        findUserById: async () => ({ ...member }),
        updateUserProfile: async () => {
          changes++;
          return null;
        }
      },
      userPrivilegeService: { userHasPrivilege: async () => true },
      auditService: { log: async () => {} }
    });
    const profile = { userId: 2, username: "member", email: "new@example.test", information: {} };
    const result = await users.updateUserProfile(req, user, profile);
    return { refused: result.error ?? undefined, changes };
  }
};

for (const [name, change] of Object.entries(cases)) {
  test(`${name}: needs the password entered recently in this session`, async () => {
    // The password was entered in another session of the same administrator, not this one.
    assert.deepEqual(await change(admin, new Set(["1:6"])), { refused: "REAUTHENTICATION_REQUIRED", changes: 0 });
    const confirmed = await change(admin, new Set(["1:5"]));
    assert.equal(confirmed.refused, undefined);
    assert.equal(confirmed.changes, 1);
  });
}

test("users who may not make a change are refused without being asked for a password", async () => {
  for (const name of [
    "user privileges",
    "site setting updateRegistrationMode",
    "site setting updateAiPolicy",
    "site setting updateJudgePolicy",
    "site setting updateAiEndpointPolicy",
    "site setting updateTestDataRetention",
    "judge machine addJudgeClient",
    "judge machine resetJudgeClientKey",
    "judge machine getJudgeClientKey"
  ]) {
    const result = await cases[name](member, new Set());
    assert.equal(result.refused, "PERMISSION_DENIED", name);
    assert.equal(result.changes, 0, name);
  }
});

test("a user's own email change in the profile editor also needs the password, other edits don't", async () => {
  let saved = 0;
  const users = recent =>
    Object.assign(Object.create(UserController.prototype), {
      authSessionService: sessions(recent),
      configService: { config: { preference: { security: { requireEmailVerification: false } } } },
      userService: {
        findUserById: async () => ({ ...member }),
        updateUserProfile: async () => {
          saved++;
          return null;
        }
      },
      // An ordinary user: edits their own profile, doesn't manage users.
      userPrivilegeService: { userHasPrivilege: async (user, privilege) => privilege === "EditOwnProfile" },
      auditService: { log: async () => {} }
    });
  const profile = email => ({ userId: 2, username: "member", email, bio: "new bio", information: {} });
  assert.deepEqual(await users(new Set()).updateUserProfile(req, member, profile("thief@example.test")), {
    error: "REAUTHENTICATION_REQUIRED"
  });
  assert.equal(saved, 0);
  assert.deepEqual(await users(new Set()).updateUserProfile(req, member, profile(member.email)), { error: null });
  assert.equal(saved, 1);
  assert.deepEqual(await users(new Set(["2:5"])).updateUserProfile(req, member, profile("new@example.test")), {
    error: null
  });
  assert.equal(saved, 2);
});

test("the judge machine list never includes keys; they are shown one at a time", async () => {
  const machine = { id: 7, name: "judge", key: "k".repeat(40), allowedHosts: ["10.0.0.2"], draining: false };
  const service = Object.assign(Object.create(JudgeClientService.prototype), {
    listJudgeClients: async () => [machine],
    isJudgeClientOnline: async () => true,
    getJudgeClientSystemInfo: async () => null,
    getJudgeClientCapabilities: async () => null,
    judgeJobRepository: { countBy: async () => 0 }
  });
  const judges = Object.assign(Object.create(JudgeClientController.prototype), { judgeClientService: service });
  const listed = await judges.listJudgeClients(admin);
  assert.equal(listed.judgeClients[0].key, null);
  assert.deepEqual(listed.judgeClients[0].allowedHosts, ["10.0.0.2"]);
  assert.equal((await judges.listJudgeClients(member)).judgeClients[0].allowedHosts, null);
  // Adding a machine still shows its new key once, to the administrator who confirmed.
  assert.equal((await service.getJudgeClientInfo(machine, true)).key, machine.key);
});
