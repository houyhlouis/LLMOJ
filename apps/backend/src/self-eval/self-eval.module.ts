import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { SelfEvalEntity, SelfEvalQuotaEntity, SelfEvalSetEntity } from "./self-eval.entity";
import { SelfEvalService } from "./self-eval.service";
import { SelfEvalController } from "./self-eval.controller";

import { UserModule } from "../user/user.module";
import { ProblemModule } from "../problem/problem.module";
import { SubmissionModule } from "../submission/submission.module";
import { ContestModule } from "../contest/contest.module";
import { JudgeModule } from "../judge/judge.module";
import { RedisModule } from "../redis/redis.module";
import { FileModule } from "../file/file.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([SelfEvalEntity, SelfEvalQuotaEntity, SelfEvalSetEntity]),
    forwardRef(() => UserModule),
    forwardRef(() => ProblemModule),
    forwardRef(() => SubmissionModule),
    forwardRef(() => ContestModule),
    forwardRef(() => JudgeModule),
    forwardRef(() => RedisModule),
    forwardRef(() => FileModule)
  ],
  providers: [SelfEvalService],
  controllers: [SelfEvalController],
  exports: [SelfEvalService]
})
export class SelfEvalModule {}
