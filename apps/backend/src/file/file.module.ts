import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FileEntity } from "./file.entity";
import { FileService } from "./file.service";
import { FileContentHashService } from "./file-content-hash.service";

import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity]), RedisModule],
  providers: [FileService, FileContentHashService],
  exports: [FileService]
})
export class FileModule {}
