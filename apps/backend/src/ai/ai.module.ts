import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AiConfigurationEntity, AiJobEntity } from "./ai.entity";
import { AiUsageEntity, AiResponseCheckpointEntity } from "./ai-usage.entity";
import { AiUsageService } from "./ai-usage.service";
import { AiService } from "./ai.service";
import { AiController } from "./ai.controller";

import { AuditModule } from "../audit/audit.module";
import { ProblemModule } from "../problem/problem.module";
import { UserModule } from "../user/user.module";
import { FileModule } from "../file/file.module";
import { DiscussionModule } from "../discussion/discussion.module";

@Module({
  imports: [
    AuditModule,
    TypeOrmModule.forFeature([AiConfigurationEntity, AiJobEntity, AiUsageEntity, AiResponseCheckpointEntity]),
    forwardRef(() => ProblemModule),
    forwardRef(() => UserModule),
    forwardRef(() => FileModule),
    forwardRef(() => DiscussionModule)
  ],
  providers: [AiService, AiUsageService],
  controllers: [AiController],
  exports: [AiService]
})
export class AiModule {}
