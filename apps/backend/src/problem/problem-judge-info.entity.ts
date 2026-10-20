import { Entity, PrimaryColumn, OneToOne, Column, JoinColumn, Unique } from "typeorm";

import { ProblemEntity } from "./problem.entity";

import { JsonColumn } from "../database/json-column";

@Entity("problem_judge_info")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_86e8539b96ed22ce70416416b1", ["problemId"])
export class ProblemJudgeInfoEntity {
  @OneToOne(() => ProblemEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  problem: Promise<ProblemEntity>;

  @PrimaryColumn()
  problemId: number;

  @JsonColumn()
  judgeInfo: unknown;

  @Column({ type: "boolean", default: true })
  submittable: boolean;
}
