import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from "typeorm";

import { ProblemDataVersionEntity } from "./problem-data-version.entity";

/**
 * A data version whose test data a problem manager chose to keep, so that results judged with it can be judged again
 * with the same data later, for example to settle a dispute. Its files stay until it's released, whatever the
 * retention policy (see `TestDataRetentionService`).
 */
@Entity("problem_data_version_keep")
export class ProblemDataVersionKeepEntity {
  @PrimaryColumn()
  problemDataVersionId: number;

  @ManyToOne(() => ProblemDataVersionEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  problemDataVersion: Promise<ProblemDataVersionEntity>;

  // Who kept it; null if the account was deleted
  @Column({ type: "integer", nullable: true })
  keptBy: number;

  @Column({ type: "datetime" })
  keptAt: Date;
}
