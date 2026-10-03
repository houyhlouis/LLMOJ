import { IsIn } from "class-validator";

export const PYTHON_VERSIONS = ["2.7", "3.9", "3.10"];

export default class CompileAndRunOptionsPython {
  @IsIn(PYTHON_VERSIONS)
  version: string;
}
