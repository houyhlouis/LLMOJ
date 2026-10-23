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

  // The upload this file was sealed from (see FileService.sealUpload): its form wrote staging/<uploadUuid>, which the
  // file was copied from and is never read again. Unique, so an upload becomes at most one file. Null for files the
  // backend stored itself, and for files from before sealing, which were registered under their upload's own UUID.
  @Column({ type: "char", length: 36, nullable: true })
  @Index({ unique: true })
  uploadUuid: string;
}
