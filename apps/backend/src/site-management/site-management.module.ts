import { Module, forwardRef } from "@nestjs/common";

import { SiteManagementController } from "./site-management.controller";

import { SettingsModule } from "../settings/settings.module";
import { AuthModule } from "../auth/auth.module";
import { ProblemModule } from "../problem/problem.module";

@Module({
  imports: [SettingsModule, forwardRef(() => AuthModule), forwardRef(() => ProblemModule)],
  controllers: [SiteManagementController]
})
export class SiteManagementModule {}
