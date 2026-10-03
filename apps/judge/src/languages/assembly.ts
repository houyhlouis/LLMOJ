import { LanguageConfig } from ".";

export const languageConfig: LanguageConfig<Record<string, never>> = {
  name: "assembly",
  getMetaOptions: () => ({ sourceFilename: "main.s", binarySizeLimit: 5 * 1024 * 1024 }),
  compile: ({ sourcePathInside, binaryDirectoryInside }) => ({
    script: 'set -e\n/usr/bin/as --64 -o "$2/main.o" "$1"\n/usr/bin/ld -o "$2/a.out" "$2/main.o"\nrm -- "$2/main.o"',
    parameters: [sourcePathInside, binaryDirectoryInside],
    time: 10000,
    memory: 512 * 1024 * 1024,
    stackSize: 8 * 1024 * 1024,
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
