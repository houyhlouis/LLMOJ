import { IsIn } from "class-validator";

export const CPP_STANDARDS = [
  "c++03",
  "c++11",
  "c++14",
  "c++17",
  "c++20",
  "c++23",
  "c++26",
  "gnu++03",
  "gnu++11",
  "gnu++14",
  "gnu++17",
  "gnu++20",
  "gnu++23",
  "gnu++26"
];

export default class CompileAndRunOptionsCpp {
  @IsIn(["g++", "clang++"])
  compiler: string;

  @IsIn(CPP_STANDARDS)
  std: string;

  @IsIn(["0", "1", "2", "3", "fast"])
  O: string;

  @IsIn(["64", "32"])
  m: string;
}
