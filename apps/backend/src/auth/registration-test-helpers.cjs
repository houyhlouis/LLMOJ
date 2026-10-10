const fs = require("node:fs"),
  path = require("node:path"),
  ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const main = path.resolve(__dirname, "../main.ts");
require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
String.prototype.format ||= function (...args) {
  return require("node:util").format(this, ...args);
};
const { UserEntity } = require("../user/user.entity.ts");
const { UserAuthEntity } = require("./user-auth.entity.ts");
const { UserInformationEntity } = require("../user/user-information.entity.ts");
const { UserPreferenceEntity } = require("../user/user-preference.entity.ts");
const { AuditLogEntity } = require("../audit/audit-log.entity.ts");
const { RegistrationReviewEntity, RegistrationReviewStatus } = require("./registration-review.entity.ts");
const { RegistrationApplicationEntity } = require("./registration-application.entity.ts");
const { UserService } = require("../user/user.service.ts");
const { UserPrivilegeService } = require("../user/user-privilege.service.ts");
const { UserPrivilegeEntity, UserPrivilegeType } = require("../user/user-privilege.entity.ts");
const { UserPermissionRuleEntity } = require("../access/user-permission-rule.entity.ts");
const { AccessController } = require("../access/access.controller.ts");
const { RegistrationReviewService } = require("./registration-review.service.ts");
const { AuthService } = require("./auth.service.ts");
const { AuthSessionService } = require("./auth-session.service.ts");
const { AuthController } = require("./auth.controller.ts");
const { UserController } = require("../user/user.controller.ts");
function controller(values) {
  return Object.assign(Object.create(AuthController.prototype), values);
}
function sessionService(reviews, users) {
  const calls = [];
  const redis = {
    defineCommand() {},
    async callSessionManager(...args) {
      calls.push(args);
      return 1;
    }
  };
  const sessions = new AuthSessionService(
    { config: { security: { sessionSecret: "synthetic-registration-test-secret" } } },
    users,
    { getClient: () => redis },
    reviews
  );
  return { sessions, calls };
}
module.exports = {
  UserEntity,
  UserService,
  UserPrivilegeService,
  UserPrivilegeEntity,
  UserPrivilegeType,
  UserPermissionRuleEntity,
  AccessController,
  RegistrationApplicationEntity,
  UserAuthEntity,
  UserInformationEntity,
  UserPreferenceEntity,
  AuditLogEntity,
  RegistrationReviewEntity,
  RegistrationReviewStatus,
  RegistrationReviewService,
  AuthService,
  AuthSessionService,
  AuthController,
  UserController,
  controller,
  sessionService
};
