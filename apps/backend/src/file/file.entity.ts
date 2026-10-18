import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

@Entity("file")
export class FileEntity {
  @PrimaryGeneratedColumn()
  id: number;

  // I believe there's not so much overhead using text UUIDs
  @Column({ type: "char", length: 36 })
  @Index({ unique: true })
  uuid: string;

  // The size of the origin file, not the compressed file
  @Column({ type: "bigint", transformer: { to: (value: number) => value, from: (value: string) => Number(value) } })
  size: number;

  @Column({ type: "datetime" })
  uploadTime: Date;

  // SHA-256 of the content, recorded when the file is accepted; judges check the files they use against it. Null for
  // a file from before content hashes until the backend has computed it.
  @Column({ type: "char", length: 64, nullable: true })
  sha256: string;
}
