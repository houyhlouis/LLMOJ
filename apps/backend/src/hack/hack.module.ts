import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { HackEntity, HackProblemEntity } from "./hack.entity";
import { HackService } from "./hack.service";
import { HackController } from "./hack.controller";

import { UserModule } from "../user/user.module";
import { ProblemModule } from "../problem/problem.module";
import { SubmissionModule } from "../submission/submission.module";
import { ContestModule } from "../contest/contest.module";
import { JudgeModule } from "../judge/judge.module";
import { FileModule } from "../file/file.module";
import { CodeLanguageModule } from "../code-language/code-language.module";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([HackEntity, HackProblemEntity]),
    forwardRef(() => UserModule),
    forwardRef(() => ProblemModule),
    forwardRef(() => SubmissionModule),
    forwardRef(() => ContestModule),
    forwardRef(() => JudgeModule),
    forwardRef(() => RedisModule),
    FileModule,
    CodeLanguageModule
  ],
  providers: [HackService],
  controllers: [HackController],
  exports: [HackService]
})
export class HackModule {}
