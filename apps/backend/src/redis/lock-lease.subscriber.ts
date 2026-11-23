import { BeforeQueryEvent, EntitySubscriberInterface, EventSubscriber } from "typeorm";

import { assertLockLeasesCurrent, assertLockLeasesHeld } from "./lock-lease";

@EventSubscriber()
export class LockLeaseSubscriber implements EntitySubscriberInterface {
  async beforeTransactionCommit(): Promise<void> {
    await assertLockLeasesCurrent();
  }

  beforeQuery({ query, queryRunner }: BeforeQueryEvent<unknown>): void | Promise<void> {
    // TypeORM uses query() for rollback too. A rejected commit must be able to undo its writes before the
    // connection is returned to the pool, including rollback to a nested transaction's savepoint.
    if (query === "ROLLBACK" || /^ROLLBACK TO SAVEPOINT typeorm_\d+$/.test(query)) return undefined;
    assertLockLeasesHeld();
    return !queryRunner.isTransactionActive && !query.startsWith("SELECT ") ? assertLockLeasesCurrent() : undefined;
  }
}
