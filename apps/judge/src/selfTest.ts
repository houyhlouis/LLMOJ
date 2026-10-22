import "reflect-metadata";

import fs from "fs";

import { SandboxStatus } from "simple-sandbox";

import config, { updateServerSideConfig } from "./config";
import { compile, CompileResultSuccess } from "./compile";
import getLanguage from "./languages";
import { runSandbox, CpuAffinityStrategy, SANDBOX_INSIDE_PATH_BINARY, SANDBOX_INSIDE_PATH_WORKING } from "./sandbox";
import { runTaskQueued } from "./taskQueue";
import { ensureDirectoryEmpty, safelyJoinPath } from "./utils";
import { runBuiltinChecker } from "./checkers/builtin";
import { Checker } from "./checkers";

/**
 * Compiles and runs a program in every language and option the judge supports on this host, through the same code
 * as judging, and checks the sandbox's syscall filter. Started by `self-test.mjs`, which gives it a configuration of
 * its own (directories, no key), so it never touches a running judge.
 */

interface SelfTestCase {
  name: string;
  language: string;
  options: Record<string, string>;
  code: string;
  // Run with this many processes/threads instead of the language's own setting
  process?: number;
  // The output expected for the input "20 22"; a probe checks its own output instead
  expected?: string;
  probe?: boolean;
}

const INPUT = "20 22\n";
const SUM = "42";

const C_SUM = `#include <stdio.h>
int main(void) { long long a, b; if (scanf("%lld %lld", &a, &b) != 2) return 1; printf("%lld\\n", a + b); return 0; }
`;
const CPP_SUM = `#include <iostream>
int main() { long long a, b; std::cin >> a >> b; std::cout << a + b << std::endl; }
`;

// Tries calls the syscall filter refuses, and threads and processes, which must keep working. Compiled for 64 and
// 32 bits, so that both system call tables are checked.
const PROBE = `#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#ifndef SYS_clone3
#define SYS_clone3 435
#endif
#ifndef SYS_io_uring_setup
#define SYS_io_uring_setup 425
#endif
static const char *outcome(long result) {
  if (result >= 0) return "ok";
  return errno == EPERM ? "EPERM" : errno == ENOSYS ? "ENOSYS" : strerror(errno);
}
static void *thread_main(void *argument) { return argument; }
int main(void) {
  printf("unshare=%s\\n", outcome(unshare(CLONE_NEWUSER)));
  long child = syscall(SYS_clone, CLONE_NEWUSER | SIGCHLD, 0, 0, 0, 0);
  if (child == 0) _exit(0);
  if (child > 0) waitpid((pid_t)child, NULL, 0);
  printf("clone_newuser=%s\\n", outcome(child));
  printf("clone3=%s\\n", outcome(syscall(SYS_clone3, NULL, 0)));
  printf("ptrace=%s\\n", outcome(ptrace(PTRACE_TRACEME, 0, NULL, NULL)));
  printf("keyctl=%s\\n", outcome(syscall(SYS_keyctl, 0, -3, 0)));
  char params[256] = {0};
  long ring = syscall(SYS_io_uring_setup, 1, params);
  if (ring >= 0) close((int)ring);
  printf("io_uring=%s\\n", outcome(ring));
  printf("bpf=%s\\n", outcome(syscall(SYS_bpf, 0, NULL, 0)));
  pthread_t thread;
  void *joined = NULL;
  int created = pthread_create(&thread, NULL, thread_main, (void *)42);
  printf("thread=%s\\n", created == 0 && pthread_join(thread, &joined) == 0 && joined == (void *)42 ? "ok" : strerror(created));
  pid_t forked = fork();
  if (forked == 0) _exit(7);
  int status = 0;
  printf("fork=%s\\n", forked > 0 && waitpid(forked, &status, 0) == forked && WEXITSTATUS(status) == 7 ? "ok" : strerror(errno));
  return 0;
}
`;
const PROBE_EXPECTED = {
  unshare: "EPERM",
  clone_newuser: "EPERM",
  clone3: "ENOSYS",
  ptrace: "EPERM",
  keyctl: "EPERM",
  io_uring: "EPERM",
  bpf: "EPERM",
  thread: "ok",
  fork: "ok"
};

const cases: SelfTestCase[] = [
  ...["g++", "clang++"].flatMap(compiler =>
    ["64", "32"].map(m => ({
      name: `C++ (${compiler}, ${m}-bit)`,
      language: "cpp",
      options: { compiler, std: "c++17", O: "2", m },
      code: CPP_SUM
    }))
  ),
  ...["gcc", "clang"].flatMap(compiler =>
    ["64", "32"].map(m => ({
      name: `C (${compiler}, ${m}-bit)`,
      language: "c",
      options: { compiler, std: "c11", O: "2", m },
      code: C_SUM
    }))
  ),
  {
    name: "Java",
    language: "java",
    options: {},
    code: `import java.util.Scanner;
public class Main { public static void main(String[] args) { Scanner in = new Scanner(System.in); System.out.println(in.nextLong() + in.nextLong()); } }
`
  },
  {
    name: "Kotlin",
    language: "kotlin",
    options: { version: "1.9", platform: "jvm" },
    code: `fun main() { val (a, b) = readLine()!!.trim().split(" ").map { it.toLong() }; println(a + b) }
`
  },
  {
    name: "Pascal",
    language: "pascal",
    options: { optimize: "2" },
    code: `var a, b: int64;
begin readln(a, b); writeln(a + b); end.
`
  },
  {
    name: "Python 2.7",
    language: "python",
    options: { version: "2.7" },
    code: `a, b = map(int, raw_input().split())
print a + b
`
  },
  ...["3.9", "3.10"].map(version => ({
    name: `Python ${version}`,
    language: "python",
    options: { version },
    code: `a, b = map(int, input().split())
print(a + b)
`
  })),
  {
    name: "Rust",
    language: "rust",
    options: { version: "2021", optimize: "2" },
    code: `use std::io::Read;
fn main() { let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap(); let v: Vec<i64> = s.split_whitespace().map(|x| x.parse().unwrap()).collect(); println!("{}", v[0] + v[1]); }
`
  },
  {
    name: "Swift",
    language: "swift",
    options: { version: "5", optimize: "O" },
    code: `let v = readLine()!.split(separator: " ").map { Int($0)! }
print(v[0] + v[1])
`
  },
  {
    name: "Go",
    language: "go",
    options: { version: "1.x" },
    code: `package main
import "fmt"
func main() { var a, b int64; fmt.Scan(&a, &b); fmt.Println(a + b) }
`
  },
  {
    name: "Haskell",
    language: "haskell",
    options: { version: "2010" },
    code: `main = do { [a, b] <- fmap (map read . words) getLine; print (a + b :: Integer) }
`
  },
  {
    name: "C#",
    language: "csharp",
    options: { version: "12" },
    code: `using System;
class Program { static void Main() { var p = Console.ReadLine().Split(' '); Console.WriteLine(long.Parse(p[0]) + long.Parse(p[1])); } }
`
  },
  {
    name: "F#",
    language: "fsharp",
    options: {},
    code: `let p = System.Console.ReadLine().Split(' ')
printfn "%d" (int64 p.[0] + int64 p.[1])
`
  }
].map(testCase => ({ ...testCase, expected: SUM }));

const probes: SelfTestCase[] = ["64", "32"].map(m => ({
  name: `Syscall filter (${m}-bit)`,
  language: "c",
  options: { compiler: "gcc", std: "gnu11", O: "1", m },
  code: PROBE,
  process: 8,
  probe: true
}));

const RUN_TIME_LIMIT = 10000;
const RUN_MEMORY_LIMIT = 1024; // MiB, enough for every runtime

async function runCase(testCase: SelfTestCase): Promise<string> {
  const compileResult = await compile({
    language: testCase.language,
    code: testCase.code,
    compileAndRunOptions: testCase.options
  });
  if (!(compileResult instanceof CompileResultSuccess)) {
    const { message } = compileResult;
    throw new Error(
      `compilation failed: ${(typeof message === "string" ? message : (message?.data ?? "")).trim().slice(0, 500)}`
    );
  }
  try {
    return await runTaskQueued({ memory: RUN_MEMORY_LIMIT }, async taskWorkingDirectory => {
      const binaryDirectory = { outside: compileResult.binaryDirectory, inside: SANDBOX_INSIDE_PATH_BINARY };
      const workingDirectory = {
        outside: safelyJoinPath(taskWorkingDirectory, "working"),
        inside: SANDBOX_INSIDE_PATH_WORKING
      };
      const tempDirectoryOutside = safelyJoinPath(taskWorkingDirectory, "temp");
      await Promise.all([ensureDirectoryEmpty(workingDirectory.outside), ensureDirectoryEmpty(tempDirectoryOutside)]);
      const input = safelyJoinPath(workingDirectory, "input.txt");
      const output = safelyJoinPath(workingDirectory, "output.txt");
      const error = safelyJoinPath(workingDirectory, "error.txt");
      await fs.promises.writeFile(input.outside, INPUT);

      const runConfig = getLanguage(testCase.language).run({
        binaryDirectoryInside: binaryDirectory.inside,
        workingDirectoryInside: workingDirectory.inside,
        compileAndRunOptions: testCase.options,
        time: RUN_TIME_LIMIT,
        memory: RUN_MEMORY_LIMIT,
        stdinFile: input.inside,
        stdoutFile: output.inside,
        stderrFile: error.inside,
        parameters: [],
        compileResultExtraInfo: compileResult.extraInfo
      });
      const result = await runSandbox(null, {
        ...runConfig,
        ...(testCase.process ? { process: testCase.process } : {}),
        time: RUN_TIME_LIMIT,
        memory: RUN_MEMORY_LIMIT * 1024 * 1024,
        workingDirectory: workingDirectory.inside,
        tempDirectoryOutside,
        extraMounts: [
          { mappedPath: binaryDirectory, readOnly: true },
          { mappedPath: workingDirectory, readOnly: false }
        ],
        cpuAffinity: CpuAffinityStrategy.UserProgram
      });
      const stdout = await fs.promises.readFile(output.outside, "utf-8").catch(() => "");
      if (result.status !== SandboxStatus.OK || result.code !== 0) {
        const stderr = await fs.promises.readFile(error.outside, "utf-8").catch(() => "");
        throw new Error(
          `run ended with ${SandboxStatus[result.status]} (code ${result.code}): ${stderr.trim().slice(0, 500)}`
        );
      }
      return stdout;
    });
  } finally {
    await compileResult.dereference();
  }
}

function checkProbe(output: string): string {
  const results = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map(line => line.split("="))
  );
  const wrong = Object.entries(PROBE_EXPECTED).filter(([name, expected]) => results[name] !== expected);
  if (wrong.length)
    throw new Error(wrong.map(([name, expected]) => `${name} gave ${results[name]}, expected ${expected}`).join("; "));
  return "namespaces, ptrace, keyrings, io_uring and bpf refused; threads and processes work";
}

// Each built-in checker on an accepted and a wrong output, in the program the judge starts for them
const BUILTIN_CHECKERS: [Checker, string, string, string][] = [
  [{ type: "integers" }, "1 2 3\n", "1 2 3", "1 2 4"],
  [{ type: "floats", precision: 6 }, "0.5 1e3\n", "0.5000001 1000", "0.51 1000"],
  [{ type: "tokens", caseSensitive: false }, "Yes no\n", "YES\nNO", "yes yes"],
  [{ type: "lines", caseSensitive: true }, "a b\nc\n", "a b  \nc", "a  b\nc"],
  [{ type: "binary" }, "\u0000\u0001", "\u0000\u0001", "\u0000\u0002"]
];

async function checkBuiltinCheckers(): Promise<string> {
  return await runTaskQueued({ memory: 0 }, async taskWorkingDirectory => {
    const answer = safelyJoinPath(taskWorkingDirectory, "answer.txt");
    const output = safelyJoinPath(taskWorkingDirectory, "output.txt");
    for (const [checker, answerText, accepted, wrong] of BUILTIN_CHECKERS) {
      await fs.promises.writeFile(answer, answerText);
      for (const [text, score] of [
        [accepted, 100],
        [wrong, 0]
      ] as const) {
        await fs.promises.writeFile(output, text);
        const result = await runBuiltinChecker(output, answer, checker);
        if (typeof result === "string" || "data" in result)
          throw new Error(`${checker.type}: ${JSON.stringify(result)}`);
        if (result.score !== score)
          throw new Error(`${checker.type} gave ${result.score} for ${JSON.stringify(text)}: ${result.checkerMessage}`);
      }
    }
    return BUILTIN_CHECKERS.map(([checker]) => checker.type).join(", ");
  });
}

/** @return Whether every case passed. */
export async function runSelfTest(only?: string[]): Promise<boolean> {
  // Limits the server sends judges when they connect, at their defaults
  updateServerSideConfig({
    limit: {
      compilerMessage: 64 * 1024,
      outputSize: Math.min(config.binaryCacheMaxSize, 100 * 1024 * 1024),
      dataDisplay: 128,
      dataDisplayForSubmitAnswer: 128,
      stderrDisplay: 5120
    }
  });
  const filter = config.sandbox.syscallFilter !== false;
  process.stdout.write(`Syscall filter: ${filter ? "on" : "off (sandbox.syscallFilter: false)"}\n`);
  const selected = [...cases, ...(filter ? probes : [])].filter(
    testCase => !only || only.includes(testCase.language) || only.includes(testCase.name)
  );
  let failed = 0;
  const checkers = !only || only.includes("checkers");
  await Promise.all([
    checkers &&
      (async () => {
        const started = Date.now();
        try {
          const detail = await checkBuiltinCheckers();
          process.stdout.write(`✔ Built-in checkers: ${detail} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
        } catch (e) {
          failed++;
          process.stdout.write(`✖ Built-in checkers: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      })(),
    ...selected.map(async testCase => {
      const started = Date.now();
      try {
        const output = await runCase(testCase);
        const detail = testCase.probe ? checkProbe(output) : output.trim();
        if (!testCase.probe && detail !== testCase.expected)
          throw new Error(`printed ${JSON.stringify(output.slice(0, 100))}, expected ${testCase.expected}`);
        process.stdout.write(`✔ ${testCase.name}: ${detail} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
      } catch (e) {
        failed++;
        process.stdout.write(`✖ ${testCase.name}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    })
  ]);
  const total = selected.length + (checkers ? 1 : 0);
  process.stdout.write(failed ? `${failed} of ${total} checks failed\n` : `All ${total} checks passed\n`);
  return failed === 0;
}
