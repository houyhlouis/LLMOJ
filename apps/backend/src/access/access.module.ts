import { Module, forwardRef } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AccessController } from "./access.controller";
import { AccessGuard } from "./access.guard";

import { UserModule } from "../user/user.module";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [forwardRef(() => UserModule), forwardRef(() => AuthModule), AuditModule],
  controllers: [AccessController],
  providers: [{ provide: APP_GUARD, useClass: AccessGuard }]
})
export class AccessModule {}
