import { Module } from "@nestjs/common";

import { SiteManagementController } from "./site-management.controller";

import { SettingsModule } from "../settings/settings.module";

@Module({
  imports: [SettingsModule],
  controllers: [SiteManagementController]
})
export class SiteManagementModule {}
