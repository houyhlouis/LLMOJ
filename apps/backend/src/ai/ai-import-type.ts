import { AiError, AiStatementText } from "./ai.types";

export type AiImportProblemType = "Traditional" | "Interaction" | "Communication";
interface AiImportExtracted {
  problemType?: AiImportProblemType | "SubmitAnswer";
  localizedContents?: Array<
    AiStatementText & { description?: string; input?: string; output?: string; limitsAndHints?: string }
  >;
}

function prose(value: string): string {
  let fence: { marker: string; length: number } | null = null;
  const lines: string[] = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim())
        fence = null;
      continue;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      continue;
    }
    lines.push(line.replace(/(`+)[\s\S]*?\1/g, "").replace(/\*\*|__/g, ""));
  }
  return lines.join("\n");
}
export function declaredAiProblemType(value: string): AiImportProblemType | "SubmitAnswer" | undefined {
  const text = prose(value);
  for (const [type, en, zh] of [
    ["SubmitAnswer", "(?:output[ -]only|submit[ -]answer)", "(?:提交答案|输出型)"],
    ["Communication", "(?:communication|run[ -]twice(?: communication)?)", "(?:通信|通讯)"],
    ["Interaction", "(?:interactive|interaction)", "交互(?:式)?"]
  ]) {
    if (
      new RegExp(
        `\\bthis\\s+is\\s+(?:(?:a|an)\\s+)?${en}\\s+(?:problem|task)\\b|\\b(?:this|the)\\s+(?:problem|task)\\s+is\\s+(?:(?:a|an)\\s+)?${en}\\b`,
        "i"
      ).test(text) ||
      new RegExp(`^\\s*#{0,6}\\s*(?:problem|task)\\s*type\\s*[:：]\\s*${en}\\b`, "im").test(text) ||
      new RegExp(`(?:本题|这道题|本问题)\\s*(?:是|为|属于)\\s*(?:一[道个]\\s*)?${zh}(?:题|问题)`).test(text) ||
      new RegExp(`^\\s*#{0,6}\\s*(?:题目类型|题型)\\s*[:：]\\s*${zh}`, "m").test(text) ||
      (type === "Interaction" && /^\s*#{1,6}\s*(?:Interaction|交互格式)\s*#*\s*$/im.test(text)) ||
      (type === "Communication" && /^\s*#{1,6}\s*(?:Communication|通信协议)\s*#*\s*$/im.test(text))
    )
      return type as AiImportProblemType | "SubmitAnswer";
  }
  return undefined;
}
export function resolveAiImportType(
  markdown: string,
  extracted?: AiImportExtracted,
  requested?: AiImportProblemType
): AiImportProblemType {
  const original = declaredAiProblemType(markdown);
  const parts = (Array.isArray(extracted?.localizedContents) ? extracted.localizedContents : []).flatMap(content => [
    content?.description,
    content?.input,
    content?.output,
    content?.limitsAndHints,
    ...(Array.isArray(content?.contentSections)
      ? content.contentSections.filter(s => s?.type === "Text").map(s => s.text)
      : [])
  ]);
  const extractedDeclaration = parts
    .map(value => (typeof value === "string" ? declaredAiProblemType(value) : undefined))
    .find(Boolean);
  const classified = extracted?.problemType;
  if (classified != null && !["Traditional", "Interaction", "Communication", "SubmitAnswer"].includes(classified))
    throw new AiError("AI_IMPORT_TYPE_UNSUPPORTED");
  if (original === "SubmitAnswer" || extractedDeclaration === "SubmitAnswer" || classified === "SubmitAnswer")
    throw new AiError("AI_IMPORT_TYPE_UNSUPPORTED");
  if (requested && original && requested !== original) throw new AiError("AI_PROBLEM_TYPE_MISMATCH");
  if (requested === "Traditional" && (extractedDeclaration || (classified && classified !== "Traditional")))
    throw new AiError("AI_PROBLEM_TYPE_MISMATCH");
  return requested || original || extractedDeclaration || classified || "Traditional";
}

/** Older callers can still explicitly require traditional-only behavior. */
export function hasUnsupportedAiImportType(value: string): boolean {
  return !!declaredAiProblemType(value);
}
export function assertTraditionalAiImport(markdown: string, extracted?: AiImportExtracted): void {
  if (resolveAiImportType(markdown, extracted) !== "Traditional") throw new AiError("AI_IMPORT_TRADITIONAL_ONLY");
}
