import type { AiStatementText } from "./ai.types";

/** Formatting restrictions belong to the statement, not a generated judge's preferred spelling. */
export const AI_OUTPUT_FORMAT_RULES =
  "Preserve every legal output representation. When the protocol asks for an integer value without an explicit lexical restriction, parse the complete signed decimal token by value: accept leading zeros and an optional plus sign (and minus zero where zero is legal). Do not require canonical decimal spelling or invent bans on leading zeros/plus signs. Reject malformed tokens, overflow/out-of-range values and excess tokens. Use whitespace-separated tokens and accept legal spaces, CRLF, line wrapping and trailing whitespace unless the statement explicitly requires exact line structure or byte spelling. Apply strict formatting ONLY to explicitly stated exact syntax; do not weaken required literal protocol commands, binary-string alphabets, or message length limits.";

/** A deterministic override is allowed only for an explicit output-case instruction. */
export function outputCaseRule(statements: AiStatementText[]): { caseSensitive?: boolean; uncertain: boolean } {
  const outputClauses: string[] = [];
  let sawCaseMention = false;
  const caseMention =
    /case[ -]+(?:in)?sensitive|(?:letter\s+)?case\s+(?:is\s+)?ignored|ignore\s+(?:letter\s+)?case|regardless\s+of\s+(?:letter\s+)?case|大小写/i;
  for (const content of statements || [])
    for (const section of content.contentSections || []) {
      if (section.type !== "Text") continue;
      const title = String(section.sectionTitle || "");
      const text = String(section.text || "");
      if (caseMention.test(text)) sawCaseMention = true;
      const outputSection = /\boutput\b|输出/.test(title.toLowerCase()) && !/\binput\b|输入/.test(title.toLowerCase());
      let previousOutput = false;
      for (const clause of text.split(/[.!?。！？;；\n]+/)) {
        const explicitOutput = /\b(?:output|print|answer|verdict)\b|输出|答案/i.test(clause);
        const explicitInput = /\b(?:input|read|lookup|search|match(?:ing)?)\b|输入|读入|查找|搜索|匹配/i.test(clause);
        if (outputSection || explicitOutput || (previousOutput && !explicitInput && caseMention.test(clause)))
          outputClauses.push(clause);
        previousOutput = explicitOutput && !explicitInput;
      }
    }
  let insensitive = false;
  let sensitive = false;
  for (const clause of outputClauses) {
    // Explicit sensitivity and prohibitions take priority over an insensitive phrase.
    const negatedSensitivity = /\bnot\s+case[ -]+sensitive\b/i.test(clause);
    const affirmativeClause = clause.replace(/\bnot\s+case[ -]+sensitive\b/gi, "");
    if (
      /\bcase[ -]+sensitive\b|\b(?:not|never)\s+(?:be\s+)?case[ -]+insensitive\b|\b(?:do\s+not|never|cannot|must\s+not)\s+ignore\s+(?:letter\s+)?case|(?:^|[^不])区分大小写|大小写(?:必须|需要|应当)?(?:一致|相同|严格)|不是不区分|并非不区分|不允许忽略大小写/i.test(
        affirmativeClause
      )
    ) {
      sensitive = true;
      continue;
    }
    if (negatedSensitivity) {
      insensitive = true;
      continue;
    }
    if (
      /case[ -]+insensitive|(?:letter\s+)?case\s+(?:is\s+)?ignored|ignore\s+(?:letter\s+)?case|regardless\s+of\s+(?:letter\s+)?case|不区分大小写|大小写(?:均可|不限|不敏感|无关)/i.test(
        clause
      )
    ) {
      if (/\b(?:not|never)\b|不能|不可|不得|禁止|不要/i.test(clause)) sensitive = true;
      else insensitive = true;
    }
  }
  if (sensitive) return { caseSensitive: true, uncertain: false };
  if (insensitive) return { caseSensitive: false, uncertain: false };
  return { uncertain: sawCaseMention };
}
