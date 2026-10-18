import util from "util";
import cluster from "cluster";

import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Logger, ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";

import getGitRepoInfo from "git-repo-info";
import moment from "moment";
import { Request, Response, json } from "express"; // eslint-disable-line import/no-extraneous-dependencies
import {
  RateLimiterClusterMaster,
  RateLimiterCluster,
  RateLimiterMemory,
  RateLimiterAbstract,
  IRateLimiterOptions
} from "rate-limiter-flexible";

import { AppModule } from "./app.module";
import { ConfigService } from "./config/config.service";
import { MigrationService } from "./migration/migration.service";
import { ErrorFilter } from "./error.filter";
import { ClusterService } from "./cluster/cluster.service";
import { RequestLogger } from "./common/request-logger";

// eslint-disable-next-line no-extend-native
String.prototype.format = function format(...args) {
  return util.format.call(undefined, this, ...args);
};

export const appGitRepoInfo = getGitRepoInfo();

const JSON_BODY_LIMIT = "32mb";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initialize(): Promise<[packageInfo: any, configService: ConfigService, app: NestExpressApplication]> {
  // Get package info
  // eslint-disable-next-line @typescript-eslint/no-var-requires, import/extensions
  const packageInfo = require("../package.json");
  const appVersion = `v${packageInfo.version}`;
  const gitRepoVersion = appGitRepoInfo.abbreviatedSha
    ? ` (Git revision ${appGitRepoInfo.abbreviatedSha} on ${moment(appGitRepoInfo.committerDate).format(
        "YYYY-MM-DD H:mm:ss"
      )})`
    : "";

  if (cluster.isMaster) Logger.log(`Starting ${packageInfo.name} version ${appVersion}${gitRepoVersion}`, "Bootstrap");

  // Create nestjs app
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new RequestLogger(undefined, {
      ...(process.env.NODE_ENV === "production" ? { logLevels: ["warn", "error"] } : {})
    })
  });
  const configService = app.get(ConfigService);
  app.setGlobalPrefix("api");
  app.useGlobalFilters(app.get(ErrorFilter));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  // Rate limiting is registered before body parsing so rejected requests are never buffered or parsed.
  if (configService.config.security.rateLimit) {
    const clusterService = app.get(ClusterService);
    const rateLimiterConfig: IRateLimiterOptions = {
      points: configService.config.security.rateLimit.maxRequests,
      duration: configService.config.security.rateLimit.durationSeconds
    };

    let rateLimiter: RateLimiterAbstract;

    if (clusterService.enabled) {
      // eslint-disable-next-line no-new
      if (clusterService.isMaster) new RateLimiterClusterMaster();
      else {
        rateLimiter = new RateLimiterCluster(rateLimiterConfig);
      }
    } else rateLimiter = new RateLimiterMemory(rateLimiterConfig);

    app.use((req: Request, res: Response, next: () => void) => {
      rateLimiter
        .consume(req.ip)
        .then(() => {
          next();
        })
        .catch(() => {
          res.status(429).send("Too Many Requests");
        });
    });
  }
  // File contents go to object storage through signed uploads. The largest JSON body is an AI import
  // image (at most 15 MB of base64, see StartAiJobDto), so keep a margin without exposing the heap.
  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.set("trust proxy", configService.config.server.trustProxy);

  const options = new DocumentBuilder()
    .setTitle("LLMOJ API")
    .setDescription(packageInfo.description)
    .setVersion(appVersion)
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup("/docs", app, document);

  return [packageInfo, configService, app];
}

async function runMigration(app: NestExpressApplication, migrationConfigFile: string) {
  const migrationService = app.get(MigrationService);
  await migrationService.migrate(migrationConfigFile, app);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function startApp(packageInfo: any, configService: ConfigService, app: NestExpressApplication) {
  await app.listen(configService.config.server.port, configService.config.server.hostname);
  Logger.log(
    `${packageInfo.name} is listening on ${configService.config.server.hostname}:${configService.config.server.port}`,
    "Bootstrap"
  );
}

async function bootstrap() {
  const [packageInfo, configService, app] = await initialize();

  const migrationConfigFile = process.env.LIBREOJ_MIGRATION_CONFIG_FILE;
  if (migrationConfigFile)
    // Start migration
    await runMigration(app, migrationConfigFile);
  // Start Nest.js app
  else {
    const clusterService = app.get(ClusterService);
    await clusterService.initialization(async () => await startApp(packageInfo, configService, app));
  }
}

bootstrap().catch(err => {
  console.error(err); // eslint-disable-line no-console
  console.error("Error bootstrapping the application, exiting..."); // eslint-disable-line no-console
  process.exit(1);
});
