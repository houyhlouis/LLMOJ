import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

import { Locale } from "../common/locale.type";
import { JsonColumn } from "../database/json-column";

@Entity("problem_tag")
export class ProblemTagEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar", length: 20 })
  color: string;

  @JsonColumn()
  locales: Locale[];
}
