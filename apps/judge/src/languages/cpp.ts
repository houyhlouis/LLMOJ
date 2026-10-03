import { LanguageConfig } from ".";

interface CompileAndRunOptionsCpp {
  compiler: string;
  std: string;
  O: string;
  m: string;
}

function cppStandard(value: string): string {
  if (
    ![
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
    ].includes(value)
  )
    throw new Error("Unsupported C++ standard");
  return value;
}

export const languageConfig: LanguageConfig<CompileAndRunOptionsCpp> = {
  name: "cpp",
  getMetaOptions: () => ({
    sourceFilename: "main.cpp",
    binarySizeLimit: 5 * 1024 * 1024 // 5 MiB, enough unless someone initlizes globals badly
  }),
  compile: ({ sourcePathInside, additionalSourcePathsInside = [], binaryDirectoryInside, compileAndRunOptions }) => ({
    executable: compileAndRunOptions.compiler === "g++" ? "g++" : "clang++",
    parameters: [
      "-o",
      `${binaryDirectoryInside}/a.out`,
      `-std=${cppStandard(compileAndRunOptions.std)}`,
      `-O${compileAndRunOptions.O}`,
      "-fdiagnostics-color=always",
      "-DONLINE_JUDGE",
      "-Wall",
      "-Wextra",
      "-Wno-unused-result",
      compileAndRunOptions.compiler === "clang++" && compileAndRunOptions.m === "64" ? "-stdlib=libc++" : null,
      `-m${compileAndRunOptions.m}`,
      "-march=native",
      sourcePathInside,
      ...additionalSourcePathsInside
    ],
    time: 10000,
    memory: 1024 * 1024 * 1024 * 2,
    process: 20,
    stdout: `${binaryDirectoryInside}/message.txt`,
    stderr: `${binaryDirectoryInside}/message.txt`,
    messageFile: "message.txt",
    workingDirectory: binaryDirectoryInside
  }),
  run: ({ binaryDirectoryInside, stdinFile, stdoutFile, stderrFile, parameters }) => ({
    executable: `${binaryDirectoryInside}/a.out`,
    parameters,
    process: 1,
    stdin: stdinFile,
    stdout: stdoutFile,
    stderr: stderrFile
  })
};
