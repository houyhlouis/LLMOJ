import { Entity, PrimaryColumn, Column } from "typeorm";

/**
 * A test data file removed from its problem, kept until no waiting submission is pinned to a data version that uses
 * it (see `ProblemDataVersionService`).
 */
@Entity("deferred_file_deletion")
export class DeferredFileDeletionEntity {
  @PrimaryColumn({ type: "char", length: 36 })
  uuid: string;

  @Column({ type: "datetime" })
  requestedAt: Date;
}
