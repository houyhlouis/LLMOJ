/* Site permission checks within one HTTP request share one read of the user's rules and privileges. They must give
   the same answers as reading every time, see the request's own changes, and never outlive the response: background
   work a request starts (an AI job) inherits its context but must see later revocations. Storage is stubbed. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { UserPrivilegeService } = require("../auth/registration-test-helpers.cjs");
const { requestContext } = require("../common/request-context.ts");
const { permissionCatalog } = require("./permission-catalog.ts");

const keys = [...permissionCatalog.map(item => item.key), "ManageUser", "ManageProblem", "SkipRecaptcha"];

/** Rules and privileges in memory, counting the reads of each kind. */
function storage() {
  const rules = new Map(),
    privileges = new Set(),
    reads = { batch: 0, single: 0 };
  const ruleRepository = {
    findBy: async ({ userId }) => {
      reads.batch++;
      return [...rules]
        .filter(([key]) => key.startsWith(userId + ":"))
        .map(([key, allowed]) => ({
          permission: key.split(":")[1],
          allowed
        }));
    },
    findOneBy: async ({ userId, permission }) => {
      reads.single++;
      const key = userId + ":" + permission;
      return rules.has(key) ? { allowed: rules.get(key) } : null;
    }
  };
  const privilegeRepository = {
    findBy: async ({ userId }) => {
      reads.batch++;
      return [...privileges]
        .filter(key => key.startsWith(userId + ":"))
        .map(key => ({ privilegeType: key.split(":")[1] }));
    },
    countBy: async ({ userId, privilegeType }) => {
      reads.single++;
      return privileges.has(userId + ":" + privilegeType) ? 1 : 0;
    }
  };
  const service = new UserPrivilegeService({ getRepository: () => ruleRepository }, privilegeRepository, {});
  return { rules, privileges, reads, service };
}

const user = { id: 2, isAdmin: false };
const request = () => ({ res: { writableEnded: false } });

test("one read per request gives the same answers as reading for every check", async () => {
  const { rules, privileges, reads, service } = storage();
  rules.set("2:ViewProblem", false);
  rules.set("2:CreateProblem", true);
  rules.set("2:ViewHiddenProblem", true);
  privileges.add("2:ManageUser");
  privileges.add("2:ViewSubmission");
  rules.set("2:ViewSubmission", false); // an explicit denial wins over a grant
  const expected = [];
  for (const key of keys) {
    expected.push(await service.userHasPrivilege(user, key));
    expected.push(await service.permissionDecision(user, key, true));
  }
  const uncached = reads.single;
  reads.single = 0;
  const shared = await requestContext.run(request(), async () => {
    const answers = [];
    for (const key of keys) {
      answers.push(await service.userHasPrivilege(user, key));
      answers.push(await service.permissionDecision(user, key, true));
    }
    return answers;
  });
  assert.deepEqual(shared, expected);
  assert(uncached >= keys.length * 2);
  assert.deepEqual(reads, { batch: 2, single: 0 });
  // Guests and administrators never read rules.
  await requestContext.run(request(), async () => {
    assert.equal(await service.userHasPrivilege(null, "ViewProblem"), true);
    assert.equal(await service.userHasPrivilege({ id: 1, isAdmin: true }, "ManageUser"), true);
  });
  assert.deepEqual(reads, { batch: 2, single: 0 });
});

test("a request sees its own permission changes", async () => {
  const { rules, reads, service } = storage();
  await requestContext.run(request(), async () => {
    assert.equal(await service.userHasPrivilege(user, "ViewProblem"), true);
    rules.set("2:ViewProblem", false);
    service.forgetRequestCapabilities(2);
    assert.equal(await service.userHasPrivilege(user, "ViewProblem"), false);
  });
  assert.equal(reads.batch, 4);
});

test("transactions, work outside requests and work after the response read the current rows", async () => {
  const { rules, reads, service } = storage();
  const answering = request();
  await requestContext.run(answering, async () => {
    assert.equal(await service.userHasPrivilege(user, "EditProblemData"), true);
    rules.set("2:EditProblemData", false);
    // A locking read in a transaction sees the change at once.
    const manager = {
      findOne: async (entity, { where }) => {
        const key = where.userId + ":" + where.permission;
        return rules.has(key) ? { allowed: rules.get(key) } : null;
      }
    };
    assert.equal(await service.permissionDecision(user, "EditProblemData", true, manager), false);
    // An AI job started by this request keeps its context after the response is sent.
    answering.res.writableEnded = true;
    assert.equal(await service.permissionDecision(user, "EditProblemData", true), false);
  });
  assert.equal(await service.permissionDecision(user, "EditProblemData", true), false);
  assert.equal(reads.batch, 2);
});

test("a failed read is not kept for the rest of the request", async () => {
  const { service } = storage();
  let fail = true;
  const original = service.userPrivilegeRepository.findBy;
  service.userPrivilegeRepository.findBy = async query => {
    if (fail) throw new Error("connection lost");
    return original(query);
  };
  await requestContext.run(request(), async () => {
    await assert.rejects(service.userHasPrivilege(user, "ViewProblem"), /connection lost/);
    fail = false;
    assert.equal(await service.userHasPrivilege(user, "ViewProblem"), true);
  });
});
