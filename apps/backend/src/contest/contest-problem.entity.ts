import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { ContestEntity } from "./contest.entity";

import { ProblemEntity } from "../problem/problem.entity";

@Entity("contest_problem")
@Index(["contestId", "problemId"], { unique: true })
export class ContestProblemEntity {
  @PrimaryGeneratedColumn() id: number;

  @ManyToOne(() => ContestEntity, { onDelete: "CASCADE" }) @JoinColumn() contest: Promise<ContestEntity>;

  @Column() contestId: number;

  @ManyToOne(() => ProblemEntity, { onDelete: "CASCADE" }) @JoinColumn() problem: Promise<ProblemEntity>;

  @Column() problemId: number;

  @Column() position: number;

  @Column({ length: 160, default: "" }) title: string;

  @Column({ type: "double", default: 1 }) weight: number;

  @Column({ default: false }) subtaskAllOrNothing: boolean;

  // An explicit override: standard IO in this contest does not inherit public file IO.
  @Column({ length: 120, default: "" }) inputFilename: string;

  @Column({ length: 120, default: "" }) outputFilename: string;

  @Column({ type: "json" }) attachments: { filename: string; uuid: string; size: number }[];
}
