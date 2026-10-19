import { Module, forwardRef } from "@nestjs/common";

import { StudyListController } from "./study-list.controller";
import { StudyListService } from "./study-list.service";

import { UserModule } from "../user/user.module";
import { ProblemModule } from "../problem/problem.module";
import { SubmissionModule } from "../submission/submission.module";

@Module({
  imports: [forwardRef(() => UserModule), forwardRef(() => ProblemModule), forwardRef(() => SubmissionModule)],
  providers: [StudyListService],
  controllers: [StudyListController]
})
export class StudyListModule {}
