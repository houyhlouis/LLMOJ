import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { SettingsEntity } from "./settings.entity";
import { SettingsService } from "./settings.service";
import { RegistrationSettingsService } from "./registration-settings.service";
import { AiPolicyService } from "./ai-policy.service";
import { JudgePolicyService } from "./judge-policy.service";
import { AiEndpointPolicyService } from "./ai-endpoint-policy.service";

import { ConfigModule } from "../config/config.module";

@Module({
  imports: [TypeOrmModule.forFeature([SettingsEntity]), ConfigModule],
  providers: [
    SettingsService,
    RegistrationSettingsService,
    AiPolicyService,
    JudgePolicyService,
    AiEndpointPolicyService
  ],
  exports: [SettingsService, RegistrationSettingsService, AiPolicyService, JudgePolicyService, AiEndpointPolicyService]
})
export class SettingsModule {}
