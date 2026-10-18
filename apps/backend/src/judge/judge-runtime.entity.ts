import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export interface JudgeRuntimeDetails {
  node: string;
  os: string;
  kernel: string;
  arch: string;
  cpu: string;
}

/**
 * What a judge machine judged with, as it announced when it connected: its judge program, its sandbox image (which
 * identifies its compilers and interpreters) and its host. Recorded once for each distinct runtime; each lease of a
 * judge job and each result refers to it.
 */
@Entity("judge_runtime")
export class JudgeRuntimeEntity {
  @PrimaryGeneratedColumn()
  id: number;

  // SHA-256 of the judge machine and all the fields below
  @Column({ type: "char", length: 64 })
  @Index({ unique: true })
  digest: string;

  // No foreign key: the record stays when the judge machine is deleted
  @Column({ type: "integer" })
  judgeClientId: number;

  // SHA-256 of the judge program's source files
  @Column({ type: "char", length: 64 })
  judgeProgram: string;

  // The sandbox image (rootfs) ID
  @Column({ type: "char", length: 64 })
  sandboxImage: string;

  @Column({ type: "json" })
  details: JudgeRuntimeDetails;

  @Column({ type: "datetime" })
  firstSeenAt: Date;
}
