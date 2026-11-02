/**
 * The machine architecture C and C++ programs are built for. Their option `m` names one: "64" is the judge machine's
 * own 64-bit architecture (x86-64 on amd64, AArch64 on arm64), "32" is 32-bit x86 (i386), which only x86-64 machines
 * run and only the amd64 rootfs has a toolchain for.
 */
export const C_ARCHITECTURES: readonly string[] = process.arch === "x64" ? ["64", "32"] : ["64"];

const MACHINES: Record<string, string> = { x64: "x86-64", arm64: "AArch64" };
const MACHINE = MACHINES[process.arch] || process.arch;

/** Compiler flags for the architecture `m`, which must be one of C_ARCHITECTURES. */
export function cArchitectureFlags(m: string): string[] {
  if (process.arch === "x64") return [`-m${m}`, "-march=native"];
  // GCC and Clang have no -m64 for AArch64. There `char` is unsigned by default, unlike on x86-64, where most
  // solutions were written: `char c = getchar(); if (c == EOF)` would never end.
  return ["-march=native", "-fsigned-char"];
}

/** Why a C or C++ program can't be built for `m` on this judge machine, or null if it can. */
export function cArchitectureUnavailable(m: string): string | null {
  if (C_ARCHITECTURES.includes(m)) return null;
  return (
    `This judge machine (${MACHINE}) can't build ${m}-bit programs: ` +
    `32-bit programs need an x86-64 judge machine. Submit it as 64-bit instead.\n`
  );
}
