import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, JoinColumn } from "typeorm";

import { ProblemEntity } from "./problem.entity";

import { JsonColumn } from "../database/json-column";

export interface ProblemDataVersionFile {
  filename: string;
  uuid: string;
  // The file's content hash when the version was taken, if it was recorded. Not part of the version's digest: a file
  // UUID always has the same content, and versions from before content hashes keep their identity.
  sha256?: string;
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

  @JsonColumn()
  judgeInfo: unknown;

  @JsonColumn()
  testData: ProblemDataVersionFile[];

  // The problem's samples, when its judge info runs them
  @JsonColumn({ nullable: true })
  samples: unknown;

  @Column({ type: "datetime" })
  createdAt: Date;
}
