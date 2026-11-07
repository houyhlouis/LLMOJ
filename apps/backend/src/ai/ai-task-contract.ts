import { aiContractDigest, type AiTaskContract, type AiTaskInterface } from "@libreoj/judge-protocol";

import { AiError } from "./ai.types";

export const TASK_CONTRACT_PROMPT = `Extract the exact PUBLIC task contract, not a proposed implementation. Return JSON {"version":1,"mode":"batch|interactive_stdio|sequential_communication|persistent_duplex","lifetime":"single_process|single_session|two_fresh_processes|two_live_isolated_roles","interface":{"headers":[{"name":"api.h","identity":"exact published header/version identity"}],"functions":[{"name":"Encode","signature":"exact C++ declaration","owner":"contestant|grader","role":"role name"}]},"roles":[{"name":"role name","permittedInformation":["exact information legally available to this role"]}],"framing":"exact public framing, typed values, limits and EOF rules","scoring":{"scope":"case|subtask","reduction":"binary|sum|min|max","metric":"exact scoring metric"}}. Select ONE enum value, never the pipe-separated alternatives. Include every callback with its true owner. A callback into the first role after the second role starts, or state retained by both roles across scenarios, requires persistent_duplex. Do not convert it into sequential runs. Sequential communication means the sender terminates before a fresh decoder starts. Preserve subtask-wide maxima of message lengths. Empty interface arrays are allowed for stdio tasks. Do not infer support from the problem type or the available runner.`;

const boundedText = (x: unknown, max = 4096): x is string =>
  typeof x === "string" && !!x.trim() && x.trim().length <= max;

export function parseTaskContract(value: unknown): AiTaskContract {
  const c = value as AiTaskContract;
  const lifetimes = {
    batch: "single_process",
    interactive_stdio: "single_session",
    sequential_communication: "two_fresh_processes",
    persistent_duplex: "two_live_isolated_roles"
  };
  if (
    !c ||
    c.version !== 1 ||
    !Object.prototype.hasOwnProperty.call(lifetimes, c.mode) ||
    lifetimes[c.mode] !== c.lifetime ||
    !boundedText(c.framing, 16000) ||
    !Array.isArray(c.roles) ||
    !c.roles.length ||
    c.roles.length > 8 ||
    c.roles.some(
      r =>
        !boundedText(r?.name, 80) ||
        !Array.isArray(r.permittedInformation) ||
        !r.permittedInformation.length ||
        r.permittedInformation.length > 32 ||
        !r.permittedInformation.every(x => boundedText(x))
    ) ||
    new Set(c.roles.map(r => r.name)).size !== c.roles.length ||
    !["case", "subtask"].includes(c.scoring?.scope) ||
    !["binary", "sum", "min", "max"].includes(c.scoring?.reduction) ||
    !boundedText(c.scoring?.metric) ||
    !Array.isArray(c.interface?.headers) ||
    c.interface.headers.length > 16 ||
    c.interface.headers.some(
      h => !/^[\w-][\w.-]*\.(h|hpp)$/.test(h?.name || "") || h.name.includes("..") || !boundedText(h.identity)
    ) ||
    new Set(c.interface.headers.map(h => h.name)).size !== c.interface.headers.length ||
    !Array.isArray(c.interface?.functions) ||
    c.interface.functions.length > 64 ||
    c.interface.functions.some(
      f =>
        !/^[A-Za-z_]\w*$/.test(f?.name || "") ||
        !boundedText(f.signature) ||
        (!f.signature.includes(`${f.name}(`) && !f.signature.includes(`${f.name} (`)) ||
        !["contestant", "grader"].includes(f.owner) ||
        !c.roles.some(r => r.name === f.role)
    ) ||
    (c.mode === "persistent_duplex" && (c.roles.length < 2 || !c.interface.functions.length))
  )
    throw new AiError("INVALID_AI_TASK_CONTRACT");
  return JSON.parse(JSON.stringify(c));
}

export function batchTaskContract(): AiTaskContract {
  return {
    version: 1,
    mode: "batch",
    lifetime: "single_process",
    interface: { headers: [], functions: [] },
    roles: [{ name: "contestant", permittedInformation: ["The public input specified by the statement."] }],
    framing: "Statement input and output format; one complete instance per process.",
    scoring: { scope: "case", reduction: "binary", metric: "Acceptance by the declared checker." }
  };
}

/** Fast diagnostics only. Compilation AND linking against pinned sources is the authority. */
export function interfaceProposal(source: string, expected: AiTaskInterface) {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
  const main = /\bmain\s*\(/.test(code);
  const missing = expected.functions
    .filter(f => f.owner === "contestant" && !new RegExp(`\\b${f.name}\\s*\\(`).test(code))
    .map(f => f.signature);
  return { main, missing, accepted: !main && !missing.length };
}

export const interfacePin = (grader: string, headers: Record<string, string>) => aiContractDigest({ grader, headers });
