import { Entity, Column, PrimaryColumn, Index, CreateDateColumn } from "typeorm";

@Entity("ai_usage")
@Index(["ownerId", "createdAt"])
@Index(["ownerId", "responseHash"])
export class AiUsageEntity {
  @PrimaryColumn({ type: "varchar", length: 36 }) id: string;

  @Column() ownerId: number;

  @Column({ type: "varchar", length: 36, nullable: true }) jobId: string;

  @Column({ type: "varchar", length: 10 }) target: "llm" | "search";

  @Column({ type: "varchar", length: 20 }) provider: string;

  @Column({ type: "varchar", length: 255 }) host: string;

  @Column({ type: "varchar", length: 200, default: "" }) model: string;

  @Column({ type: "varchar", length: 50 }) operation: string;

  @Column() success: boolean;

  @Column({ type: "varchar", length: 80, nullable: true }) errorCode: string;

  @Column() elapsedMs: number;

  @Column({ type: "bigint", nullable: true }) inputTokens: number;

  @Column({ type: "bigint", nullable: true }) outputTokens: number;

  @Column({ type: "bigint", nullable: true }) cachedTokens: number;

  @Column({ type: "bigint", nullable: true }) reasoningTokens: number;

  @Column({ type: "double", nullable: true }) searchCredits: number;

  @Column() usageReported: boolean;

  @Column({ type: "varchar", length: 64, nullable: true }) responseHash: string;

  @CreateDateColumn() createdAt: Date;
}

/** Only the opaque response handle needed to resume; never request/response text or credentials. */
@Entity("ai_response_checkpoint")
export class AiResponseCheckpointEntity {
  @PrimaryColumn() ownerId: number;

  @PrimaryColumn({ type: "varchar", length: 36 }) jobId: string;

  @PrimaryColumn({ type: "varchar", length: 64 }) requestHash: string;

  @Column({ type: "varchar", length: 255 }) responseId: string;

  @CreateDateColumn() createdAt: Date;
}
