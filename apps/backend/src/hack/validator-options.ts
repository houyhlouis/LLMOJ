import { CodeLanguage } from "../code-language/code-language.type";

export const validatorOptions: Record<CodeLanguage, Record<string, string>> = {
  cpp: { compiler: "g++", std: "c++17", O: "2", m: "64" },
  c: { compiler: "gcc", std: "c11", O: "2", m: "64" },
  java: {},
  kotlin: { version: "1.9", platform: "jvm" },
  pascal: { optimize: "2" },
  python: { version: "3.10" },
  rust: { version: "2024", optimize: "3" },
  swift: { version: "6", optimize: "O" },
  go: { version: "1.x" },
  haskell: { version: "GHC2021" },
  csharp: { version: "14" },
  fsharp: {}
};
