import { Module, forwardRef } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AccessController } from "./access.controller";
import { AccessGuard } from "./access.guard";

import { UserModule } from "../user/user.module";

@Module({
  imports: [forwardRef(() => UserModule)],
  controllers: [AccessController],
  providers: [{ provide: APP_GUARD, useClass: AccessGuard }]
})
export class AccessModule {}
