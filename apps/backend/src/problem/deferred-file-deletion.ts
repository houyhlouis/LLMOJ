import { EntityManager } from "typeorm";

import { DeferredFileDeletionEntity } from "./deferred-file-deletion.entity";

/**
 * Marks removed test data files for deletion once no waiting submission's data version uses them, instead of
 * deleting them now. Call it in the transaction that removes them from their problem.
 */
export async function deferTestDataDeletion(uuids: string[], manager: EntityManager): Promise<void> {
  if (uuids.length === 0) return;
  await manager
    .createQueryBuilder()
    .insert()
    .into(DeferredFileDeletionEntity)
    .values(uuids.map(uuid => ({ uuid, requestedAt: new Date() })))
    .orIgnore()
    .execute();
}
