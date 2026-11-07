import type { AiTaskInterface } from "./ai-task-contract";

/** Forces the linker to resolve every public entry point, including callbacks a grader forgot to call. */
export function aiAbiProbe(contract: AiTaskInterface): string {
  if (
    contract.headers.some(h => !/^[\w-][\w.-]*\.(h|hpp)$/.test(h.name) || h.name.includes("..")) ||
    contract.functions.some(
      fn =>
        !/^[A-Za-z_]\w*$/.test(fn.name) ||
        typeof fn.signature !== "string" ||
        fn.signature.length > 4096 ||
        /[{}#]/.test(fn.signature)
    )
  )
    throw new Error("Invalid ABI probe identifiers");
  return [
    ...contract.headers.map(h => `#include "${h.name}"`),
    ...contract.functions.map(fn => `${fn.signature.replace(/;\s*$/, "")};`),
    ...contract.functions.map((fn, i) => `__attribute__((used)) auto __ai_entry_${i} = &${fn.name};`)
  ].join("\n");
}
