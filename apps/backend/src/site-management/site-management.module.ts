import { Module, forwardRef } from "@nestjs/common";

import { SiteManagementController } from "./site-management.controller";

import { SettingsModule } from "../settings/settings.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [SettingsModule, forwardRef(() => AuthModule)],
  controllers: [SiteManagementController]
})
export class SiteManagementModule {}
