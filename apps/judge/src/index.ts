import "reflect-metadata";
import * as winston from "winston";

import config from "./config";
import rpc from "./rpc";
import { startAiRunner } from "./aiRunner";
import { launcher } from "./launcherClient";
import { LAUNCHER_DESCRIPTOR_VARIABLE } from "./launcher/protocol";

// Started by the sandbox launcher (index.mjs) as the account libreoj-judge: only the launcher runs as root
if (process.getuid() === 0 || !process.env[LAUNCHER_DESCRIPTOR_VARIABLE]) {
  winston.error("Start the judge with index.mjs: it runs the judge without privileges and its sandboxes as root");
  process.exit(1);
}
launcher();

startAiRunner()
  .then(() => rpc.connect())
  .then(() => {
    for (let i = 0; i < config.taskConsumingThreads; i++) rpc.startTaskConsumerThread(i);
  });
