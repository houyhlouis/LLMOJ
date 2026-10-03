import { Module, forwardRef } from "@nestjs/common";

import { StudyListController } from "./study-list.controller";

import { UserModule } from "../user/user.module";
import { ProblemModule } from "../problem/problem.module";

@Module({
  imports: [forwardRef(() => UserModule), forwardRef(() => ProblemModule)],
  controllers: [StudyListController]
})
export class StudyListModule {}
