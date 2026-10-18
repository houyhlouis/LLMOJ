import { createHash } from "crypto";

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { In, Repository } from "typeorm";

import { JudgeRuntimeInfo } from "@libreoj/judge-protocol";

import { JudgeRuntimeEntity } from "./judge-runtime.entity";
import { JudgeClientEntity } from "./judge-client.entity";
import { JudgeRuntimeDto } from "./dto/judge-runtime.dto";

/** A recorded runtime, with the name its judge machine has now (null if it was deleted). */
export interface JudgeRuntimeDescription extends JudgeRuntimeDto {
  judgeMachine: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DETAIL_LENGTH = 200;

const isDuplicateEntry = (error: unknown) =>
  (error as { code?: string })?.code === "ER_DUP_ENTRY" ||
  (error as { driverError?: { code?: string } })?.driverError?.code === "ER_DUP_ENTRY";

/** The runtime a judge client announced, or `null` if it announced none or an invalid one. */
export function parseJudgeRuntime(value: unknown): JudgeRuntimeInfo {
  const runtime = value as JudgeRuntimeInfo;
  if (!runtime || typeof runtime !== "object") return null;
  if (!SHA256_PATTERN.test(String(runtime.judgeProgram)) || !SHA256_PATTERN.test(String(runtime.sandboxImage)))
    return null;
  const details = [runtime.node, runtime.os, runtime.kernel, runtime.arch, runtime.cpu];
  if (!details.every(detail => typeof detail === "string" && detail.length <= MAX_DETAIL_LENGTH)) return null;
  return {
    judgeProgram: runtime.judgeProgram,
    sandboxImage: runtime.sandboxImage,
    node: runtime.node,
    os: runtime.os,
    kernel: runtime.kernel,
    arch: runtime.arch,
    cpu: runtime.cpu
  };
}

@Injectable()
export class JudgeRuntimeService {
  // Digest to ID, for the runtimes recorded or found by this process
  private readonly ids = new Map<string, number>();

  constructor(
    @InjectRepository(JudgeRuntimeEntity)
    private readonly judgeRuntimeRepository: Repository<JudgeRuntimeEntity>,
    @InjectRepository(JudgeClientEntity)
    private readonly judgeClientRepository: Repository<JudgeClientEntity>
  ) {}

  /** The ID of the record of a judge machine's runtime, recorded if it's new. */
  async record(judgeClientId: number, runtime: JudgeRuntimeInfo): Promise<number> {
    const { judgeProgram, sandboxImage, node, os, kernel, arch, cpu } = runtime;
    const digest = createHash("sha256")
      .update(JSON.stringify([judgeClientId, judgeProgram, sandboxImage, node, os, kernel, arch, cpu]))
      .digest("hex");
    if (this.ids.has(digest)) return this.ids.get(digest);
    for (let attempt = 1; ; attempt++) {
      // eslint-disable-next-line no-await-in-loop -- Retried after a concurrent insert.
      const existing = await this.judgeRuntimeRepository.findOneBy({ digest });
      if (existing) {
        this.ids.set(digest, existing.id);
        return existing.id;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- Retried after a concurrent insert.
        const { identifiers } = await this.judgeRuntimeRepository.insert({
          digest,
          judgeClientId,
          judgeProgram,
          sandboxImage,
          details: { node, os, kernel, arch, cpu },
          firstSeenAt: new Date()
        });
        const id = Number(identifiers[0].id);
        this.ids.set(digest, id);
        return id;
      } catch (e) {
        // Another backend process recorded it at the same time
        if (attempt >= 3 || !isDuplicateEntry(e)) throw e;
      }
    }
  }

  /** The recorded runtimes with these IDs, to show. */
  async describe(ids: number[]): Promise<Map<number, JudgeRuntimeDescription>> {
    const unique = [...new Set(ids.filter(id => id))];
    if (unique.length === 0) return new Map();
    const runtimes = await this.judgeRuntimeRepository.findBy({ id: In(unique) });
    const machines = runtimes.length
      ? await this.judgeClientRepository.find({
          select: ["id", "name"],
          where: { id: In([...new Set(runtimes.map(runtime => runtime.judgeClientId))]) }
        })
      : [];
    const names = new Map(machines.map(machine => [machine.id, machine.name]));
    return new Map(
      runtimes.map(runtime => [
        runtime.id,
        {
          judgeMachine: names.get(runtime.judgeClientId) ?? null,
          judgeProgram: runtime.judgeProgram,
          sandboxImage: runtime.sandboxImage,
          node: runtime.details?.node ?? "",
          os: runtime.details?.os ?? "",
          kernel: runtime.details?.kernel ?? "",
          arch: runtime.details?.arch ?? "",
          cpu: runtime.details?.cpu ?? ""
        }
      ])
    );
  }
}
