import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, JoinColumn } from "typeorm";

import { ProblemEntity } from "./problem.entity";

export interface ProblemDataVersionFile {
  filename: string;
  uuid: string;
}

/**
 * An immutable snapshot of what a problem is judged with: its type, preprocessed judge info, test data files and the
 * samples it runs. A submission is pinned to the version current when it was submitted or rejudged, so editing the
 * problem afterwards doesn't change how it's judged. Versions are numbered per problem and shared by equal content.
 */
@Entity("problem_data_version")
@Index(["problemId", "version"], { unique: true })
@Index(["problemId", "digest"], { unique: true })
export class ProblemDataVersionEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ProblemEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  problem: Promise<ProblemEntity>;

  @Column()
  problemId: number;

  @Column({ type: "integer" })
  version: number;

  // SHA-256 of the canonical JSON of the content
  @Column({ type: "char", length: 64 })
  digest: string;

  @Column({ type: "varchar", length: 24 })
  problemType: string;

  @Column({ type: "json" })
  judgeInfo: unknown;

  @Column({ type: "json" })
  testData: ProblemDataVersionFile[];

  // The problem's samples, when its judge info runs them
  @Column({ type: "json", nullable: true })
  samples: unknown;

  @Column({ type: "datetime" })
  createdAt: Date;
}
