import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

import { FileModule } from "../file/file.module";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [FileModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService]
})
export class HealthModule {}
