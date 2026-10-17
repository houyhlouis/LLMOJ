import { Entity, Column, PrimaryColumn, Index, CreateDateColumn } from "typeorm";

/**
 * Tokens held against an account's AI budget for a billable provider request whose usage is not yet confirmed:
 * held while the request runs (settledAt null), and kept after it when the provider reported no usage, so that
 * unknown spending counts at its reserved maximum. Deleted once the provider reports the real usage.
 */
@Entity("ai_reservation")
@Index(["ownerId", "createdAt"])
@Index(["ownerId", "responseHash"])
export class AiReservationEntity {
  @PrimaryColumn({ type: "varchar", length: 36 }) id: string;

  @Column() ownerId: number;

  @Column({ type: "varchar", length: 36, nullable: true }) jobId: string;

  @Column({ type: "bigint" }) tokens: number;

  /** A background response whose usage arrives with a later poll; matches the usage row's responseHash. */
  @Column({ type: "varchar", length: 64, nullable: true }) responseHash: string;

  @CreateDateColumn() createdAt: Date;

  @Column({ type: "datetime", nullable: true }) settledAt: Date;
}
