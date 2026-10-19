import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { ProblemEntity } from "./problem.entity";

import { LockService } from "../redis/lock.service";

/** The lock that keeps a problem in place while it's read or changed, and that deleting it waits for. */
@Injectable()
export class ProblemLockService {
  constructor(
    @InjectRepository(ProblemEntity)
    private readonly problemRepository: Repository<ProblemEntity>,
    private readonly lockService: LockService
  ) {}

  /**
   * Lock a problem by ID with Read/Write Lock.
   * @param type `"Read"` to ensure the problem exists while holding the lock, `"Write"` is for deleting the problem.
   */
  async lockProblemById<T>(
    id: number,
    type: "Read" | "Write",
    callback: (problem: ProblemEntity) => Promise<T>
  ): Promise<T> {
    return await this.lockService.lockReadWrite(
      `AcquireProblem_${id}`,
      type,
      async () => await callback(await this.problemRepository.findOneBy({ id }))
    );
  }
}
