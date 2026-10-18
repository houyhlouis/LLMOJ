import { ApiProperty } from "@nestjs/swagger";

import { JudgeClientSystemInfo } from "@libreoj/judge-protocol";

import { JudgeRuntimeDto } from "./judge-runtime.dto";

export class JudgeClientCapabilitiesDto {
  @ApiProperty()
  protocolVersion: number;

  @ApiProperty({ type: [String], description: "The task types it is sent" })
  taskTypes: string[];

  @ApiProperty()
  consumerThreads: number;

  @ApiProperty()
  executionSlots: number;

  @ApiProperty({ description: "MiB the sandboxes of concurrent work may reserve together" })
  memoryBudget: number;

  @ApiProperty()
  aiExecutionSlots: number;

  @ApiProperty({
    type: JudgeRuntimeDto,
    required: false,
    description: "What it judges with; absent for judge clients older than protocol version 3"
  })
  runtime?: JudgeRuntimeDto;
}

export class JudgeClientInfoDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  name: string;

  @ApiProperty()
  key: string;

  @ApiProperty({ type: [String] })
  allowedHosts: string[];

  @ApiProperty()
  online: boolean;

  @ApiProperty()
  systemInfo?: JudgeClientSystemInfo;

  @ApiProperty({ description: "Sent no new tasks; finishes the ones it has" })
  draining: boolean;

  @ApiProperty({ description: "Tasks it is judging now" })
  runningTasks: number;

  @ApiProperty({
    type: JudgeClientCapabilitiesDto,
    required: false,
    description: "What it announced when it last connected; absent for judge clients older than protocol version 2"
  })
  capabilities?: JudgeClientCapabilitiesDto;
}
