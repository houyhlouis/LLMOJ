import { JudgeClientCapabilities } from "@libreoj/judge-protocol";

/**
 * The values of the C and C++ option `m`: "64" builds for the judge machine's own 64-bit architecture (x86-64 or
 * AArch64), "32" for 32-bit x86, which only x86-64 judge machines build.
 */
export const C_ARCHITECTURES = ["64", "32"];

/** The architectures a judge client builds C and C++ programs for, by what it announced (null: nothing). */
export function judgeClientArchitectures(capabilities: JudgeClientCapabilities): string[] {
  if (Array.isArray(capabilities?.architectures)) return capabilities.architectures;
  // Before protocol version 5 judges were installed on x86-64 only, unless the runtime they announced says otherwise
  const arch = capabilities?.runtime?.arch;
  return !arch || arch === "x64" ? [...C_ARCHITECTURES] : ["64"];
}

/** The announced architectures, or undefined if they aren't valid. */
export function parseArchitectures(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  return C_ARCHITECTURES.filter(architecture => value.includes(architecture));
}

// Deeper than any task's payload nests its programs
const MAX_DEPTH = 16;

/**
 * The architectures other than "64" that a task's C and C++ programs are built for: its submission's, checker's,
 * interactor's, validator's... each is a `{ language, compileAndRunOptions }` somewhere in its payload.
 */
export function taskArchitectures(extraInfo: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const options = record.compileAndRunOptions as Record<string, unknown>;
    if ((record.language === "c" || record.language === "cpp") && options && typeof options.m === "string")
      found.add(options.m);
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(extraInfo, 0);
  found.delete("64");
  return [...found];
}
