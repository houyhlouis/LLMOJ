import { TypeOrmModule } from "@nestjs/typeorm";

import { ConfigService } from "../config/config.service";

/**
 * Whether the backend may change the database schema at startup. Production never does so implicitly:
 * a fresh installation creates its schema with `deploy/initialize-schema.mjs` and upgrades apply reviewed
 * migrations. `LIBREOJ_SCHEMA_SYNC=1` enables it explicitly (e.g. for development against a production
 * build); `LIBREOJ_SCHEMA_SYNC=0` disables it everywhere.
 */
export function isSchemaSyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.LIBREOJ_SCHEMA_SYNC === "1") return true;
  if (env.LIBREOJ_SCHEMA_SYNC === "0") return false;
  return env.NODE_ENV !== "production";
}

export const databaseProviders = [
  TypeOrmModule.forRootAsync({
    useFactory: (configService: ConfigService) => ({
      type: configService.config.services.database.type,
      host: configService.config.services.database.host,
      port: configService.config.services.database.port,
      username: configService.config.services.database.username,
      password: configService.config.services.database.password,
      database: configService.config.services.database.database,
      entities: [`${__dirname}/../**/*.entity{.ts,.js}`],
      logging: !!process.env.LIBREOJ_LOG_SQL,
      synchronize: isSchemaSyncEnabled()
    }),
    inject: [ConfigService]
  })
];
