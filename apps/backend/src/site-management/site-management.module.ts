import { Module, forwardRef } from "@nestjs/common";

import { DiagnosticBundleService } from "./diagnostic-bundle.service";
import { SiteManagementController } from "./site-management.controller";

import { SettingsModule } from "../settings/settings.module";
import { AuthModule } from "../auth/auth.module";
import { HealthModule } from "../health/health.module";
import { JudgeModule } from "../judge/judge.module";
import { AuditModule } from "../audit/audit.module";
import { ProblemModule } from "../problem/problem.module";

@Module({
  imports: [
    SettingsModule,
    HealthModule,
    AuditModule,
    forwardRef(() => JudgeModule),
    forwardRef(() => AuthModule),
    forwardRef(() => ProblemModule)
  ],
  controllers: [SiteManagementController],
  providers: [DiagnosticBundleService]
})
export class SiteManagementModule {}
