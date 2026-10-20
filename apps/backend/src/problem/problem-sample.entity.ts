import { Entity, PrimaryColumn, OneToOne, JoinColumn, Unique } from "typeorm";

import { ProblemEntity } from "./problem.entity";

import { ProblemSampleData } from "./problem-sample-data.interface";

import { JsonColumn } from "../database/json-column";

@Entity("problem_sample")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_267ae957142251696652533e7d", ["problemId"])
export class ProblemSampleEntity {
  @OneToOne(() => ProblemEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  problem: Promise<ProblemEntity>;

  @PrimaryColumn()
  problemId: number;

  @JsonColumn()
  data: ProblemSampleData;
}
