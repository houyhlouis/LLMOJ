import fs from "fs";
import path from "path";

import { LanguageConfig } from ".";

interface CompileAndRunOptionsPython {
  version: string;
}

const sourceFilename = "main.py";
function python(version: string) {
  if (!["2.7", "3.9", "3.10"].includes(version)) throw new Error("Unsupported LibreOJ sandbox Python version");
  return `/usr/local/bin/python${version}`;
}

// This script copies the source file to the binary directory and compile it to bytecode
const compileScript = fs.readFileSync(path.resolve(__dirname, "compile-python.sh"), "utf-8");

export const languageConfig: LanguageConfig<CompileAndRunOptionsPython> = {
  name: "python",
  getMetaOptions: () => ({
    sourceFilename,
    binarySizeLimit: 5 * 1024 * 1024 // 5 MiB
  }),
  compile: ({ sourceDirectoryInside, binaryDirectoryInside, compileAndRunOptions }) => ({
    script: compileScript,
    parameters: [python(compileAndRunOptions.version), sourceDirectoryInside, binaryDirectoryInside],
    time: 10000,
    memory: 1024 * 1024 * 1024 * 2,
    process: 20,
    stdout: `${binaryDirectoryInside}/message.txt`,
    stderr: `${binaryDirectoryInside}/message.txt`,
    messageFile: "message.txt",
    workingDirectory: binaryDirectoryInside
  }),
  run: ({ binaryDirectoryInside, compileAndRunOptions, stdinFile, stdoutFile, stderrFile, parameters }) => ({
    executable: python(compileAndRunOptions.version),
    // Python threads inherit the native stack default; a problem-sized stack
    // reservation can consume the address-space budget before a thread starts.
    stackSize: 8 * 1024 * 1024,
    parameters: [`${binaryDirectoryInside}/${sourceFilename}`, ...(parameters || [])],
    process: 20,
    stdin: stdinFile,
    stdout: stdoutFile,
    stderr: stderrFile
  })
};
