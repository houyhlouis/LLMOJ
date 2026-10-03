import { Entity, Column, PrimaryColumn, Index, CreateDateColumn, UpdateDateColumn } from "typeorm";

@Entity("ai_configuration")
export class AiConfigurationEntity {
  @PrimaryColumn() userId: number;

  @Column({ type: "longtext" }) encrypted: string;

  @UpdateDateColumn() updatedAt: Date;
}

export type AiAction =
  | "metadata"
  | "tags"
  | "source"
  | "difficulty"
  | "translate"
  | "tutorial"
  | "testdata"
  | "all"
  | "import";
export type AiJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

@Entity("ai_job")
@Index(["ownerId", "createdAt"])
@Index(["problemId", "status"])
export class AiJobEntity {
  @PrimaryColumn({ type: "varchar", length: 36 }) id: string;

  @Column() ownerId: number;

  @Column({ nullable: true }) problemId: number;

  @Column({ type: "varchar", length: 20 }) action: AiAction;

  @Column({ type: "varchar", length: 20, default: "queued" }) status: AiJobStatus;

  @Column({ type: "varchar", length: 36, nullable: true }) runToken: string;

  @Column({ default: 0 }) progress: number;

  @Column({ type: "varchar", length: 80, default: "queued" }) step: string;

  @Column({ type: "json" }) input: {
    count: number;
    markdown?: string;
    image?: string;
    attachmentToken?: string;
    problemType?: "Traditional" | "Interaction" | "Communication";
    communicationMode?: "run-twice" | "grader";
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Persisted AI checkpoints contain versioned model and runner payloads; keep backward compatibility.
  @Column({ type: "json" }) state: Record<string, any>;

  @Column({ type: "text", nullable: true }) error: string;

  @CreateDateColumn() createdAt: Date;

  @UpdateDateColumn() updatedAt: Date;
}
