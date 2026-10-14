import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { ContestRule, ContestRuleOptions } from "./contest-rules";

export type { ContestRule } from "./contest-rules";

@Entity("contest")
export class ContestEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column({ length: 160 }) title: string;

  @Column({ type: "text" }) subtitle: string;

  @Column({ type: "mediumtext" }) description: string;

  @Column({ type: "varchar", length: 16 }) rule: ContestRule;

  @Column({ type: "json", nullable: true }) ruleOptions: ContestRuleOptions;

  @Column({ type: "datetime" }) @Index() startTime: Date;

  @Column({ type: "datetime" }) endTime: Date;

  @Column() ownerId: number;

  @Column({ type: "json" }) adminIds: number[];

  @Column({ default: false }) @Index() isPublic: boolean;

  @Column({ default: false }) hideStatistics: boolean;

  @Column({ type: "json" }) languages: string[];

  @Column({ type: "datetime" }) createdAt: Date;
}
