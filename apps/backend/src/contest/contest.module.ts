import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ContestEntity } from "./contest.entity";
import { ContestProblemEntity } from "./contest-problem.entity";
import { ContestSummaryEntity } from "./contest-summary.entity";
import { ContestService } from "./contest.service";
import { ContestAccessService } from "./contest-access.service";
import { ContestScoreService } from "./contest-score.service";
import { ContestProblemService } from "./contest-problem.service";
import { ContestSubmissionService } from "./contest-submission.service";
import { ContestController } from "./contest.controller";

import { ProblemModule } from "../problem/problem.module";
import { SubmissionModule } from "../submission/submission.module";
import { UserModule } from "../user/user.module";
import { FileModule } from "../file/file.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([ContestEntity, ContestProblemEntity, ContestSummaryEntity]),
    forwardRef(() => ProblemModule),
    forwardRef(() => SubmissionModule),
    forwardRef(() => UserModule),
    forwardRef(() => FileModule)
  ],
  providers: [
    ContestAccessService,
    ContestScoreService,
    ContestProblemService,
    ContestSubmissionService,
    ContestService
  ],
  controllers: [ContestController],
  exports: [ContestAccessService, ContestSubmissionService]
})
export class ContestModule {}
