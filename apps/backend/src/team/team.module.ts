import { Module, forwardRef } from "@nestjs/common";

import { TeamService } from "./team.service";
import { TeamController } from "./team.controller";

import { UserModule } from "../user/user.module";
import { ProblemModule } from "../problem/problem.module";
import { DiscussionModule } from "../discussion/discussion.module";
import { FileModule } from "../file/file.module";
import { AuditModule } from "../audit/audit.module";
import { ContestModule } from "../contest/contest.module";

@Module({
  imports: [
    forwardRef(() => UserModule),
    forwardRef(() => ProblemModule),
    forwardRef(() => DiscussionModule),
    forwardRef(() => FileModule),
    forwardRef(() => AuditModule),
    forwardRef(() => ContestModule)
  ],
  providers: [TeamService],
  controllers: [TeamController]
})
export class TeamModule {}
