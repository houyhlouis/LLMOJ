import { Module, forwardRef } from "@nestjs/common";

import { StudyListController } from "./study-list.controller";
import { StudyListService } from "./study-list.service";

import { UserModule } from "../user/user.module";
import { ProblemModule } from "../problem/problem.module";
import { SubmissionModule } from "../submission/submission.module";
import { ConfigModule } from "../config/config.module";

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => UserModule),
    forwardRef(() => ProblemModule),
    forwardRef(() => SubmissionModule)
  ],
  providers: [StudyListService],
  controllers: [StudyListController]
})
export class StudyListModule {}
