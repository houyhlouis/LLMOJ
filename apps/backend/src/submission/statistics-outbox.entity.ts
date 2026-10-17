import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

export enum StatisticsOutboxKind {
  Problem = "Problem",
  User = "User"
}

/**
 * A change of the counts derived from non-contest submissions, recorded in the transaction that changes the
 * submission and applied once after it commits (see `StatisticsOutboxService`).
 */
@Entity("statistics_outbox")
export class StatisticsOutboxEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar", length: 8 })
  kind: StatisticsOutboxKind;

  // The problem's or the user's ID
  @Column({ type: "integer" })
  targetId: number;

  // Change of the submission count
  @Column({ type: "integer" })
  submissions: number;

  // Change of a problem's accepted submissions; for a user, non-zero means its accepted problems are counted again
  @Column({ type: "integer" })
  accepted: number;

  @Column({ type: "datetime", precision: 3 })
  createdAt: Date;
}
