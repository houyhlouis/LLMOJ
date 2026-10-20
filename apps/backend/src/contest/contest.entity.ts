import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { ContestRule, ContestRuleOptions } from "./contest-rules";

import { JsonColumn } from "../database/json-column";

export type { ContestRule } from "./contest-rules";

@Entity("contest")
export class ContestEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column({ length: 160 }) title: string;

  @Column({ type: "text" }) subtitle: string;

  @Column({ type: "mediumtext" }) description: string;

  @Column({ type: "varchar", length: 16 }) rule: ContestRule;

  @JsonColumn({ nullable: true }) ruleOptions: ContestRuleOptions;

  @Column({ type: "datetime" }) @Index() startTime: Date;

  @Column({ type: "datetime" }) endTime: Date;

  @Column() ownerId: number;

  @JsonColumn() adminIds: number[];

  @Column({ default: false }) @Index() isPublic: boolean;

  @Column({ default: false }) hideStatistics: boolean;

  @JsonColumn() languages: string[];

  @Column({ type: "datetime" }) createdAt: Date;
}
