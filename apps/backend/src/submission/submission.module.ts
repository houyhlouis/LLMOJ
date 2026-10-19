import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { SubmissionEntity } from "./submission.entity";

import { SubmissionDetailEntity } from "./submission-detail.entity";

import { SubmissionService } from "./submission.service";
import { SubmissionAccessService } from "./submission-access.service";
import { SubmissionJudgingService } from "./submission-judging.service";

import { SubmissionController } from "./submission.controller";

import { SubmissionProgressService } from "./submission-progress.service";

import { SubmissionProgressGateway } from "./submission-progress.gateway";

import { StatisticsOutboxService } from "./statistics-outbox.service";
import { ContestScoreRevisionService } from "./contest-score-revision.service";
import { SubmissionStatisticsService } from "./submission-statistics.service";

import { AuthModule } from "../auth/auth.module";

import { RedisModule } from "../redis/redis.module";
import { ProblemModule } from "../problem/problem.module";
import { ProblemTypeModule } from "../problem-type/problem-type.module";
import { JudgeModule } from "../judge/judge.module";
import { UserModule } from "../user/user.module";
import { AuditModule } from "../audit/audit.module";
import { FileModule } from "../file/file.module";
import { MetricsModule } from "../metrics/metrics.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([SubmissionEntity]),
    TypeOrmModule.forFeature([SubmissionDetailEntity]),
    forwardRef(() => RedisModule),
    forwardRef(() => ProblemModule),
    forwardRef(() => ProblemTypeModule),
    forwardRef(() => JudgeModule),
    forwardRef(() => UserModule),
    forwardRef(() => AuthModule),
    forwardRef(() => AuditModule),
    forwardRef(() => FileModule),
    forwardRef(() => MetricsModule)
  ],
  providers: [
    SubmissionService,
    SubmissionAccessService,
    SubmissionJudgingService,
    SubmissionProgressService,
    SubmissionProgressGateway,
    SubmissionStatisticsService,
    StatisticsOutboxService,
    ContestScoreRevisionService
  ],
  controllers: [SubmissionController],
  exports: [SubmissionService, SubmissionAccessService, SubmissionJudgingService, ContestScoreRevisionService]
})
export class SubmissionModule {}
