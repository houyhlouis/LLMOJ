import { createHash } from "crypto";

import type { AiStatementText } from "./ai.types";

export interface AiReferenceCandidate {
  code: string;
  sha256: string;
  discussionId?: number;
}

/** Only complete, explicitly labelled C++ fences are programs; prose and incomplete blocks are not. */
export function tutorialCppCandidates(markdown: unknown, allowLibrary = false): AiReferenceCandidate[] {
  if (typeof markdown !== "string" || markdown.length > 500000) return [];
  const candidates: AiReferenceCandidate[] = [];
  const seen = new Set<string>();
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})(?:cpp|c\+\+|cxx|cc|c)\s*$/i);
    if (!opening) continue;
    const body: string[] = [];
    let closed = false;
    while (++index < lines.length) {
      const close = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === opening[1][0] && close[1].length >= opening[1].length) {
        closed = true;
        break;
      }
      body.push(lines[index]);
    }
    const code = body.join("\n").trim();
    if (!closed || !code || Buffer.byteLength(code) > 256 * 1024 || (!allowLibrary && !/\bmain\s*\(/.test(code)))
      continue;
    const sha256 = createHash("sha256").update(code).digest("hex");
    if (!seen.has(sha256)) {
      seen.add(sha256);
      candidates.push({ code, sha256 });
    }
    if (candidates.length === 4) break;
  }
  return candidates;
}

/** Preserve valid empty/whitespace-only sample bytes; sample existence is structural, not trim(). */
export function inlineReferenceSamples(
  samples: Array<{ inputData?: string; outputData?: string }>
): Array<{ input: string; output: string }> {
  return (samples || [])
    .filter(sample => typeof sample?.inputData === "string" && typeof sample?.outputData === "string")
    .map(sample => ({ input: sample.inputData, output: sample.outputData }));
}

/** Explicit numeric error acceptance requires an actual checker, never exact token equality. */
export function hasFloatingOutputTolerance(statements: AiStatementText[]): boolean {
  return (statements || []).some(statement =>
    (statement.contentSections || []).some(section => {
      if (section.type !== "Text") return false;
      const text = String(section.text || "").replace(/(`{3,}|~{3,})[\s\S]*?\1/g, "");
      const output =
        /output|输出/i.test(section.sectionTitle || "") || /\b(?:answer|output|print)\b|答案|输出/i.test(text);
      return (
        output &&
        /(?:absolute|relative)\s+(?:or\s+(?:absolute|relative)\s+)?error|(?:absolute|relative)\s+(?:and\s+(?:absolute|relative)\s+)?tolerance|浮点.*误差|(?:绝对|相对)误差/i.test(
          text
        )
      );
    })
  );
}
