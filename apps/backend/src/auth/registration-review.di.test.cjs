const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  UserService,
  UserPrivilegeService,
  UserPrivilegeEntity,
  RegistrationReviewService
} = require("./registration-test-helpers.cjs");
const { Module } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { getRepositoryToken } = require("@nestjs/typeorm");
const { DataSource } = require("typeorm");

test("Nest resolves the reviewer privilege dependency and runs the legacy startup gate", async () => {
  let gateChecks = 0;
  const database = {
    manager: {
      countBy: async () => {
        gateChecks++;
        return 0;
      }
    }
  };
  class RegistrationReviewDependencyModule {}
  Module({
    providers: [
      RegistrationReviewService,
      UserPrivilegeService,
      { provide: DataSource, useValue: database },
      { provide: UserService, useValue: {} },
      { provide: getRepositoryToken(UserPrivilegeEntity), useValue: {} }
    ]
  })(RegistrationReviewDependencyModule);
  const app = await NestFactory.createApplicationContext(RegistrationReviewDependencyModule, {
    logger: false,
    abortOnError: false
  });
  try {
    assert.equal(app.get(RegistrationReviewService).privileges, app.get(UserPrivilegeService));
    assert.equal(gateChecks, 1);
  } finally {
    await app.close();
  }
});
