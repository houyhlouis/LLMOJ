import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ContestEntity } from "./contest.entity";
import { ContestProblemEntity } from "./contest-problem.entity";
import { ContestSummaryEntity } from "./contest-summary.entity";
import { ContestService } from "./contest.service";
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
  providers: [ContestService],
  controllers: [ContestController],
  exports: [ContestService]
})
export class ContestModule {}
