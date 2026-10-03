import { LanguageConfig } from ".";

// Optional interpreter adapters are not enabled by the default LibreOJ rootfs profile.
// Verify/install their executables in a custom rootfs before registering them.
// Compilation and execution always pass through the existing sandbox and queue.
export function interpreted(
  name: string,
  executable: string,
  extension: string,
  argumentsBeforeFile?: string[],
  syntaxArguments?: string[]
): LanguageConfig<Record<string, never>> {
  const filename = `main.${extension}`;
  return {
    name,
    getMetaOptions: () => ({ sourceFilename: filename, binarySizeLimit: 5 * 1024 * 1024 }),
    compile: ({ sourceDirectoryInside, binaryDirectoryInside }) => ({
      script: `set -e\ncp -- "$1" "$2"\n${
        syntaxArguments ? `exec ${executable} ${syntaxArguments.join(" ")} "$2"` : ":"
      }`,
      parameters: [`${sourceDirectoryInside}/${filename}`, `${binaryDirectoryInside}/${filename}`],
      time: 10000,
      memory: 512 * 1024 * 1024,
      // Ruby sizes GC stack metadata from RLIMIT_STACK; keep the image default.
      stackSize: 8 * 1024 * 1024,
      process: 20,
      stdout: `${binaryDirectoryInside}/message.txt`,
      stderr: `${binaryDirectoryInside}/message.txt`,
      messageFile: "message.txt",
      workingDirectory: binaryDirectoryInside
    }),
    run: ({ binaryDirectoryInside, stdinFile, stdoutFile, stderrFile, parameters }) => ({
      executable,
      // Interpreters may size pthread stacks or GC metadata from RLIMIT_STACK.
      // Retain the image default so those reservations fit within RLIMIT_AS.
      stackSize: 8 * 1024 * 1024,
      parameters: [...(argumentsBeforeFile ?? []), `${binaryDirectoryInside}/${filename}`, ...(parameters || [])],
      process: 20,
      stdin: stdinFile,
      stdout: stdoutFile,
      stderr: stderrFile
    })
  };
}
