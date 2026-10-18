import { Controller, Get, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import { Response } from "express"; // eslint-disable-line import/no-extraneous-dependencies

import { HealthService, Readiness } from "./health.service";

/**
 * For the upgrader, `deploy/doctor.sh` and external monitors. Neither answer needs a session, and neither says more
 * than which dependency failed.
 */
@ApiExcludeController()
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** The process answers requests. */
  @Get("live")
  live(@Res({ passthrough: true }) response: Response): { status: "ok" } {
    response.setHeader("Cache-Control", "no-store");
    return { status: "ok" };
  }

  /** The process can serve requests: HTTP 200 when every dependency answers, 503 otherwise. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response): Promise<Readiness> {
    const readiness = await this.healthService.ready();
    response.setHeader("Cache-Control", "no-store");
    if (readiness.status !== "ready") response.status(503);
    return readiness;
  }
}
