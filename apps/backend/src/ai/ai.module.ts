import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AiConfigurationEntity, AiJobEntity } from "./ai.entity";
import { AiUsageEntity, AiResponseCheckpointEntity } from "./ai-usage.entity";
import { AiUsageService } from "./ai-usage.service";
import { AiAdmissionService } from "./ai-admission.service";
import { AiReservationEntity } from "./ai-reservation.entity";
import { AiService } from "./ai.service";
import { AiExecutionEntity } from "./ai-execution.entity";
import { AiExecutionService } from "./ai-execution.service";
import { AiController } from "./ai.controller";

import { AuditModule } from "../audit/audit.module";
import { ProblemModule } from "../problem/problem.module";
import { UserModule } from "../user/user.module";
import { FileModule } from "../file/file.module";
import { DiscussionModule } from "../discussion/discussion.module";
import { SettingsModule } from "../settings/settings.module";
import { MetricsModule } from "../metrics/metrics.module";
import { JudgeModule } from "../judge/judge.module";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [
    AuditModule,
    SettingsModule,
    MetricsModule,
    TypeOrmModule.forFeature([
      AiConfigurationEntity,
      AiJobEntity,
      AiUsageEntity,
      AiResponseCheckpointEntity,
      AiReservationEntity,
      AiExecutionEntity
    ]),
    forwardRef(() => ProblemModule),
    forwardRef(() => UserModule),
    forwardRef(() => FileModule),
    forwardRef(() => DiscussionModule),
    forwardRef(() => JudgeModule),
    RedisModule
  ],
  providers: [AiService, AiUsageService, AiAdmissionService, AiExecutionService],
  controllers: [AiController],
  exports: [AiService]
})
export class AiModule {}
