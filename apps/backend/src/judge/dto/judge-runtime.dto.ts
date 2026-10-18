import { ApiProperty } from "@nestjs/swagger";

export class JudgeRuntimeDto {
  @ApiProperty({ description: "SHA-256 of the judge program's source files" })
  judgeProgram: string;

  @ApiProperty({ description: "The sandbox image (rootfs) ID, which identifies its compilers and interpreters" })
  sandboxImage: string;

  @ApiProperty({ description: "The Node.js version" })
  node: string;

  @ApiProperty()
  os: string;

  @ApiProperty()
  kernel: string;

  @ApiProperty()
  arch: string;

  @ApiProperty()
  cpu: string;
}
