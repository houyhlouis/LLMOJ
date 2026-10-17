import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { JudgeQueueService } from "./judge-queue.service";
import { JudgeGateway } from "./judge.gateway";
import { JudgeClientController } from "./judge-client.controller";
import { JudgeClientService } from "./judge-client.service";
import { JudgeClientEntity } from "./judge-client.entity";
import { JudgeJobAttemptEntity, JudgeJobEntity } from "./judge-job.entity";

import { MetricsModule } from "../metrics/metrics.module";
import { EventReportModule } from "../event-report/event-report.module";
import { FileModule } from "../file/file.module";
import { RedisModule } from "../redis/redis.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([JudgeClientEntity, JudgeJobEntity, JudgeJobAttemptEntity]),
    forwardRef(() => RedisModule),
    forwardRef(() => FileModule),
    forwardRef(() => EventReportModule),
    forwardRef(() => MetricsModule),
    forwardRef(() => AuditModule),
    forwardRef(() => AuthModule)
  ],
  controllers: [JudgeClientController],
  providers: [JudgeGateway, JudgeClientService, JudgeQueueService],
  exports: [JudgeGateway, JudgeQueueService]
})
export class JudgeModule {}
