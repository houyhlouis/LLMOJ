import { ApiProperty, ApiSchema } from "@nestjs/swagger";

const provenanceSchema = { description: "Source identity of a runtime artifact.", additionalProperties: false };

@ApiSchema(provenanceSchema)
export class BuildProvenanceDto {
  @ApiProperty({ enum: ["verified", "mismatch", "unknown"] })
  status: "verified" | "mismatch" | "unknown";

  @ApiProperty({ type: String, nullable: true, pattern: "^[0-9a-f]{40}$" })
  commit: string | null;

  @ApiProperty({ type: String, nullable: true, pattern: "^[0-9a-f]{64}$" })
  treeSha256: string | null;
}

@ApiSchema(provenanceSchema)
export class WorkerProvenanceDto {
  @ApiProperty({ enum: ["server_release", "unknown"] })
  status: "server_release" | "unknown";

  @ApiProperty({ type: String, nullable: true, pattern: "^[0-9a-f]{40}$" })
  commit: string | null;

  @ApiProperty({ type: String, nullable: true, pattern: "^[0-9a-f]{64}$" })
  treeSha256: string | null;
}
