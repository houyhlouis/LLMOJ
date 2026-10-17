/* Permission matrix on a disposable MariaDB database (tables from the real entities; never a production database):
   for visitors, ordinary users, owners, users with explicit allows and denials, problem managers, team members,
   blocked members and administrators, the problem list, problem pages, submission lists, submission pages and live
   progress agree. Opt in with LLMOJ_ACCESS_MATRIX_TEST_DB_CONFIG. Problem ACLs (user/group grants) are stubbed. */
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
const main = require("node:path").resolve(__dirname, "../main.ts");
require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
String.prototype.format ||= function (...args) {
  return require("node:util").format(String(this), ...args);
};
require("@nestjs/common").Logger.overrideLogger(false);
const { DataSource } = require("typeorm");
const { UserEntity } = require("../user/user.entity.ts");
const { UserAuthEntity } = require("../auth/user-auth.entity.ts");
const { UserPrivilegeService } = require("../user/user-privilege.service.ts");
const { UserPrivilegeEntity, UserPrivilegeType: P } = require("../user/user-privilege.entity.ts");
const { UserPermissionRuleEntity } = require("./user-permission-rule.entity.ts");
const { ProblemEntity, ProblemType } = require("../problem/problem.entity.ts");
const { ProblemSampleEntity } = require("../problem/problem-sample.entity.ts");
const { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts");
const { ProblemService, ProblemPermissionType } = require("../problem/problem.service.ts");
const { SubmissionEntity } = require("../submission/submission.entity.ts");
const { SubmissionDetailEntity } = require("../submission/submission-detail.entity.ts");
const { SubmissionStatus } = require("@libreoj/judge-protocol");
const { SubmissionService, SubmissionPermissionType } = require("../submission/submission.service.ts");
const {
  SubmissionProgressGateway,
  SubmissionProgressSubscriptionType
} = require("../submission/submission-progress.gateway.ts");

const { TeamEntity, TeamMemberEntity, TeamResourceEntity } = require("../team/team.entity.ts");
const { requestContext } = require("../common/request-context.ts");

const configPath = process.env.LLMOJ_ACCESS_MATRIX_TEST_DB_CONFIG;

test(
  "site and team permissions agree across lists, pages and live progress (real MariaDB)",
  {
    skip: !configPath && "needs LLMOJ_ACCESS_MATRIX_TEST_DB_CONFIG",
    timeout: 120000
  },
  async t => {
    const config = require("js-yaml").load(fs.readFileSync(configPath, "utf8")).services.database;
    const db = new DataSource({
      ...config,
      entities: [
        UserEntity,
        UserAuthEntity,
        UserPrivilegeEntity,
        UserPermissionRuleEntity,
        ProblemEntity,
        ProblemSampleEntity,
        ProblemJudgeInfoEntity,
        SubmissionEntity,
        SubmissionDetailEntity,
        TeamEntity,
        TeamMemberEntity,
        TeamResourceEntity
      ],
      synchronize: false,
      logging: false
    });
    await db.initialize();
    try {
      const [{ count }] = await db.query(
        "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
      );
      assert.equal(Number(count), 0, "the test database must start empty");
      await db.synchronize();

      // People
      const names = [
        "admin",
        "member",
        "owner",
        "denied",
        "hiddenViewer",
        "aclReader",
        "manager",
        "deniedManager",
        "teamMember",
        "blocked",
        "noSubmissions"
      ];
      const users = { visitor: null };
      for (const [index, name] of names.entries())
        users[name] = await db.getRepository(UserEntity).save({
          id: index + 1,
          username: name,
          email: `${name}@example.test`,
          publicEmail: false,
          avatarInfo: "",
          nickname: "",
          bio: "",
          isAdmin: name === "admin",
          acceptedProblemCount: 0,
          submissionCount: 0,
          rating: 0,
          registrationTime: new Date()
        });
      const rule = (name, permission, allowed) =>
        db.getRepository(UserPermissionRuleEntity).save({ userId: users[name].id, permission, allowed });
      const grant = (name, privilegeType) =>
        db.getRepository(UserPrivilegeEntity).save({ userId: users[name].id, privilegeType });
      await rule("denied", P.ViewProblem, false);
      await rule("hiddenViewer", P.ViewHiddenProblem, true);
      await grant("manager", P.ManageProblem);
      await grant("deniedManager", P.ManageProblem);
      await rule("deniedManager", P.ViewHiddenProblem, false);
      await rule("noSubmissions", P.ViewSubmission, false);

      // Problems: public, hidden (owned by "owner", readable by "aclReader" through its ACL) and a private team's.
      const problem = (id, isPublic) =>
        db.getRepository(ProblemEntity).save({
          id,
          displayId: id,
          type: ProblemType.Traditional,
          isPublic,
          publicTime: null,
          ownerId: users.owner.id,
          locales: ["en_US"],
          submissionCount: 0,
          acceptedSubmissionCount: 0
        });
      const problems = {
        public: await problem(1, true),
        hidden: await problem(2, false),
        team: await problem(3, true)
      };
      await db.getRepository(TeamEntity).save({
        id: 10,
        name: "private team",
        description: "",
        announcement: "",
        ownerId: users.owner.id,
        permissionGroupId: 100,
        createdAt: new Date()
      });
      for (const [id, name, status] of [
        [1, "teamMember", "member"],
        [2, "blocked", "blocked"]
      ])
        await db.getRepository(TeamMemberEntity).save({
          id,
          teamId: 10,
          userId: users[name].id,
          status,
          groupId: null,
          permissions: [],
          joinedAt: new Date()
        });
      await db.getRepository(TeamResourceEntity).save({
        id: 1,
        teamId: 10,
        kind: "problem",
        resourceId: problems.team.id,
        visibility: "private",
        invitedUserIds: [],
        archived: false
      });

      // Submissions: public, a hidden problem's (not public), another user's private one, and a team problem's.
      const submission = (id, problemId, submitterId, isPublic) =>
        db.getRepository(SubmissionEntity).save({
          id,
          problemId,
          submitterId,
          isPublic,
          codeLanguage: "cpp",
          score: 100,
          status: SubmissionStatus.Accepted,
          submitTime: new Date()
        });
      const submissions = {
        public: await submission(1, 1, users.member.id, true),
        hidden: await submission(2, 2, users.owner.id, false),
        privateOnPublic: await submission(3, 1, users.teamMember.id, false),
        team: await submission(4, 3, users.teamMember.id, true)
      };

      const privileges = new UserPrivilegeService(db, db.getRepository(UserPrivilegeEntity), {});
      const acl = new Set([`${users.aclReader.id}:${problems.hidden.id}`]);
      const problemService = Object.assign(Object.create(ProblemService.prototype), {
        connection: db,
        problemRepository: db.getRepository(ProblemEntity),
        userPrivilegeService: privileges,
        permissionService: {
          userOrItsGroupsHavePermission: async (user, problemId) => !!user && acl.has(`${user.id}:${problemId}`)
        },
        configService: { config: { preference: { security: { allowNonPrivilegedUserEditPublicProblem: false } } } }
      });
      const submissionService = Object.assign(Object.create(SubmissionService.prototype), {
        connection: db,
        submissionRepository: db.getRepository(SubmissionEntity),
        problemService,
        userPrivilegeService: privileges
      });
      const gateway = Object.assign(Object.create(SubmissionProgressGateway.prototype), {
        authSessionService: { accessSessionById: async userId => Object.values(users).find(u => u?.id === userId) },
        userPrivilegeService: privileges,
        submissionService,
        problemService
      });

      // What each route shows, computed as its controller does (AccessGuard capabilities included).
      const can = (user, privilege) => privileges.userHasPrivilege(user, privilege);
      const problemPage = async (user, p) =>
        (await can(user, P.ViewProblem)) && problemService.userHasPermission(user, p, ProblemPermissionType.View);
      async function problemList(user) {
        if (!(await can(user, P.ViewSite)) || !(await can(user, P.ViewProblem))) return [];
        const hasPrivilege = await privileges.permissionDecision(
          user,
          P.ViewHiddenProblem,
          await can(user, P.ManageProblem)
        );
        const [listed] = await problemService.queryProblemsAndCount(user, hasPrivilege, null, [], null, false, 0, 100);
        return listed.map(p => p.id);
      }
      async function submissionList(user, filters = {}) {
        if (!(await can(user, P.ViewSubmission))) return [];
        const manager = await can(user, P.ManageProblem);
        const viewsProblem =
          manager || (filters.problem && (await problemService.userHasPermission(user, filters.problem, "View")));
        const own = filters.submitter && user && filters.submitter.id === user.id;
        const { result } = await submissionService.querySubmissions(
          filters.problem?.id ?? null,
          filters.submitter?.id ?? null,
          null,
          null,
          null,
          null,
          !(manager || viewsProblem || own),
          100,
          user
        );
        return result.map(s => s.id);
      }
      const submissionPage = (user, s) => submissionService.userHasPermission(user, s, SubmissionPermissionType.View);
      const liveProgress = async (user, s, type = SubmissionProgressSubscriptionType.Meta) =>
        (
          await gateway.authorize({
            type,
            submissionIds: [s.id],
            userId: user?.id ?? null,
            sessionId: 1,
            exp: Date.now() / 1000 + 60
          })
        )(s);

      // The matrix: who may open each problem.
      const expectedProblemPages = {
        visitor: ["public"],
        admin: ["public", "hidden", "team"],
        member: ["public"],
        owner: ["public", "hidden", "team"],
        denied: [],
        hiddenViewer: ["public", "hidden"],
        aclReader: ["public", "hidden"],
        manager: ["public", "hidden"],
        deniedManager: ["public"],
        teamMember: ["public", "team"],
        blocked: ["public"],
        noSubmissions: ["public"]
      };

      // Each check runs both outside a request and inside one (where permission reads are shared).
      for (const context of ["background work", "an HTTP request"]) {
        const within = work =>
          context === "an HTTP request" ? requestContext.run({ res: { writableEnded: false } }, work) : work();

        await t.test(`problem pages follow the matrix, and lists show only what can be opened (${context})`, () =>
          within(async () => {
            for (const [name, user] of Object.entries(users)) {
              const opened = [];
              for (const [kind, p] of Object.entries(problems)) if (await problemPage(user, p)) opened.push(kind);
              assert.deepEqual(opened, expectedProblemPages[name], `${name} opens`);
              const listed = await problemList(user);
              const openedIds = opened.map(kind => problems[kind].id);
              assert.deepEqual(
                listed.filter(id => !openedIds.includes(id)),
                [],
                `${name} sees problems in the list it can't open`
              );
              // A problem anyone may open is always listed.
              if (openedIds.includes(problems.public.id)) assert(listed.includes(problems.public.id), name);
            }
          })
        );

        await t.test(`submission lists, pages and live progress agree (${context})`, () =>
          within(async () => {
            for (const [name, user] of Object.entries(users)) {
              for (const [kind, s] of Object.entries(submissions)) {
                const p = await problemService.findProblemById(s.problemId);
                const lists = [
                  await submissionList(user),
                  await submissionList(user, { problem: p }),
                  await submissionList(user, {
                    submitter: await db.getRepository(UserEntity).findOneBy({ id: s.submitterId })
                  })
                ];
                const listed = lists.some(list => list.includes(s.id));
                const live = await liveProgress(user, s);
                assert.equal(live, listed, `${name}: live progress and lists disagree on the ${kind} submission`);
                if (await submissionPage(user, s)) assert(listed, `${name} opens the ${kind} submission it can't find`);
                // Detailed progress is never sent for a submission that can't be opened.
                if (await liveProgress(user, s, SubmissionProgressSubscriptionType.Detail))
                  assert(await submissionPage(user, s), `${name} gets details of the ${kind} submission`);
              }
            }
            // Spot checks of the expected results.
            assert.equal(await liveProgress(users.visitor, submissions.public), true);
            assert.equal(await liveProgress(users.visitor, submissions.hidden), false);
            assert.equal(await liveProgress(users.noSubmissions, submissions.public), false);
            assert.equal(await liveProgress(users.blocked, submissions.team), false);
            assert.equal(await liveProgress(users.teamMember, submissions.team), true);
            assert.equal(await submissionPage(users.member, submissions.privateOnPublic), false);
            assert.equal(await submissionPage(users.teamMember, submissions.privateOnPublic), true);
            assert.equal(await submissionPage(users.manager, submissions.hidden), true);
          })
        );
      }

      await t.test("a permission change applies to the next check, in and out of a request", async () => {
        assert.equal(await problemPage(users.member, problems.public), true);
        await rule("member", P.ViewProblem, false);
        assert.equal(await problemPage(users.member, problems.public), false);
        await requestContext.run({ res: { writableEnded: false } }, async () => {
          assert.equal(await problemPage(users.member, problems.public), false);
          await db
            .getRepository(UserPermissionRuleEntity)
            .delete({ userId: users.member.id, permission: P.ViewProblem });
          privileges.forgetRequestCapabilities(users.member.id);
          assert.equal(await problemPage(users.member, problems.public), true);
        });
      });
    } finally {
      await db.dropDatabase();
      await db.destroy();
    }
  }
);
